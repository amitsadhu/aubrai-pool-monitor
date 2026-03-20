const config = require('./config');
const { init, getPoolState, setLastKnownPrice, pollSwapEvents, pollCLMintBurnEvents, pollVitaEvents } = require('./pool');
const { checkAllHealth, checkSwapSlippage } = require('./checks');
const { sendTelegramAlert, sendSwapAlert, sendAdminAlert, sendDailyStatus, sendDailyStats } = require('./alerts');
const { recordAubraiSwap, recordAubraiMint, recordAubraiBurn, recordVitaSwap, recordVitaMint, recordVitaBurn, snapshotAndReset } = require('./stats');

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

let previousState = null;
let pollTimer = null;

async function poll() {
  try {
    // Check for new AUBRAI swaps since last poll
    try {
      const swaps = await pollSwapEvents();
      for (const swap of swaps) {
        console.log(`[swap] ${swap.direction} | ${fmt(swap.aubraiAmount)} AUBRAI / ${fmt(swap.bioAmount)} BIO | slippage: ${swap.slippage}% | tx: ${swap.txHash}`);
        recordAubraiSwap(swap);
        const result = checkSwapSlippage(swap);
        if (!result.ok) {
          console.log(`[!] Swap slippage alert: ${swap.slippage}%`);
          await sendSwapAlert(swap);
        }
      }
    } catch (swapErr) {
      console.warn('[swaps] Swap polling failed (health checks continue):', swapErr.message);
      await sendAdminAlert(`Swap polling failed: ${swapErr.message}`);
    }

    // Poll CL Mint/Burn events for AUBRAI pool
    try {
      const { mints, burns } = await pollCLMintBurnEvents();
      for (const mint of mints) {
        console.log(`[cl-lp] Mint | ${fmt(mint.aubraiAmount)} AUBRAI + ${fmt(mint.bioAmount)} BIO | tx: ${mint.txHash}`);
        recordAubraiMint(mint);
      }
      for (const burn of burns) {
        console.log(`[cl-lp] Burn | ${fmt(burn.aubraiAmount)} AUBRAI + ${fmt(burn.bioAmount)} BIO | tx: ${burn.txHash}`);
        recordAubraiBurn(burn);
      }
    } catch (err) {
      console.warn('[cl-lp] CL Mint/Burn polling failed:', err.message);
    }

    // Poll VITA CL events
    try {
      const { swaps: vitaSwaps, mints: vitaMints, burns: vitaBurns } = await pollVitaEvents();
      for (const swap of vitaSwaps) {
        console.log(`[vita-swap] ${swap.direction} | ${fmt(swap.vitaAmount)} VITA / ${fmt(swap.bioAmount)} BIO | tx: ${swap.txHash}`);
        recordVitaSwap(swap);
      }
      for (const mint of vitaMints) {
        console.log(`[vita-lp] Mint | ${fmt(mint.vitaAmount)} VITA + ${fmt(mint.bioAmount)} BIO | tx: ${mint.txHash}`);
        recordVitaMint(mint);
      }
      for (const burn of vitaBurns) {
        console.log(`[vita-lp] Burn | ${fmt(burn.vitaAmount)} VITA + ${fmt(burn.bioAmount)} BIO | tx: ${burn.txHash}`);
        recordVitaBurn(burn);
      }
    } catch (err) {
      console.warn('[vita] VITA CL polling failed:', err.message);
    }

    // Fetch pool state and run health checks
    const state = await getPoolState();
    setLastKnownPrice(state.spotPrice);

    const issues = await checkAllHealth(state, previousState);

    if (issues.length > 0) {
      console.log(`[!] ${issues.length} issue(s) detected:`);
      for (const issue of issues) {
        console.log(`    - ${issue.check}: ${issue.detail || issue.details?.join(', ') || `${issue.deviation}% deviation`}`);
      }
      await sendTelegramAlert(issues, state);
    } else {
      console.log(
        `Pool OK | 1 AUBRAI = ${fmt(state.spotPrice)} BIO (${fmt(state.aubraiPerBio, 4)} AUBRAI/BIO) | Reserves: ${fmt(state.aubraiReserve)} AUBRAI / ${fmt(state.bioReserve)} BIO | tick ${state.tick}`
      );
    }

    previousState = state;
  } catch (err) {
    console.error('[error] Poll failed:', err.message);
    await sendAdminAlert(`Poll failed: ${err.message}`);
  }
}

async function start() {
  console.log('AUBRAI/BIO + VITA/BIO Pool Health Monitor');
  console.log(`AUBRAI/BIO CL Pool: ${config.poolAddress}`);
  for (const p of config.vitaPools) {
    console.log(`VITA/BIO CL Pool: ${p.address}`);
  }
  console.log(`Polling every ${config.pollIntervalMs / 1000}s | Swap slippage threshold: ${config.swapSlippageThreshold}%`);
  console.log(`Telegram alerts: ${config.telegramBotToken && config.telegramChatId ? 'enabled' : 'disabled (missing bot token or chat ID)'}`);
  console.log(`Telegram stats topic: ${config.telegramStatsThreadId ? 'enabled' : 'disabled (TELEGRAM_STATS_THREAD_ID not set)'}`);
  console.log('---');

  await init();

  await poll();
  pollTimer = setInterval(poll, config.pollIntervalMs);

  // Schedule daily status at 9:00 CET (8:00 UTC)
  scheduleDailyStatus();
}

let dailyTimer = null;

function scheduleDailyStatus() {
  const DAILY_HOUR_UTC = 8; // 9:00 CET = 8:00 UTC

  function msUntilNextRun() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(DAILY_HOUR_UTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function run() {
    // Send daily health status
    getPoolState().then((state) => {
      sendDailyStatus(state);
    }).catch((err) => {
      console.error('[daily] Failed to send daily status:', err.message);
    });

    // Send daily swap/LP stats (snapshot and reset accumulator)
    try {
      const snapshot = snapshotAndReset();
      sendDailyStats(snapshot).catch((err) => {
        console.error('[daily] Failed to send daily stats:', err.message);
      });
    } catch (err) {
      console.error('[daily] Failed to snapshot stats:', err.message);
    }

    dailyTimer = setTimeout(run, msUntilNextRun());
  }

  dailyTimer = setTimeout(run, msUntilNextRun());
  const hours = Math.round(msUntilNextRun() / 3600000 * 10) / 10;
  console.log(`[daily] Next status report in ${hours}h (9:00 CET)`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (pollTimer) clearInterval(pollTimer);
  if (dailyTimer) clearTimeout(dailyTimer);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  if (pollTimer) clearInterval(pollTimer);
  if (dailyTimer) clearTimeout(dailyTimer);
  process.exit(0);
});

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
