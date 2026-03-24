const config = require('./config');
const { init, getPoolState, setLastKnownPrice, pollSwapEvents, pollCLMintBurnEvents, pollVitaEvents, pollEthVitaEvents } = require('./pool');
const { checkAllHealth, checkSwapSlippage } = require('./checks');
const { sendTelegramAlert, sendSwapAlert, sendAdminAlert, sendAdminDM, sendDailyStatus, sendDailyStats } = require('./alerts');
const { recordAubraiSwap, recordAubraiMint, recordAubraiBurn, recordVitaSwap, recordVitaMint, recordVitaBurn, recordEthVitaSwap, recordEthVitaMint, recordEthVitaBurn, snapshotAndReset, saveToDisk } = require('./stats');

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

let previousState = null;
let pollTimer = null;
let polling = false;
let dailyReportDue = false;

async function poll() {
  if (polling) return;
  polling = true;
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
        console.log(`[vita-swap] VITA ${swap.direction} | ${fmt(swap.vitaAmount)} VITA / ${fmt(swap.counterAmount)} BIO | tx: ${swap.txHash}`);
        recordVitaSwap(swap);
      }
      for (const mint of vitaMints) {
        console.log(`[vita-lp] Mint | ${fmt(mint.vitaAmount)} VITA + ${fmt(mint.counterAmount)} BIO | tx: ${mint.txHash}`);
        recordVitaMint(mint);
      }
      for (const burn of vitaBurns) {
        console.log(`[vita-lp] Burn | ${fmt(burn.vitaAmount)} VITA + ${fmt(burn.counterAmount)} BIO | tx: ${burn.txHash}`);
        recordVitaBurn(burn);
      }
    } catch (err) {
      console.warn('[vita] VITA CL polling failed:', err.message);
    }

    // Poll Ethereum VITA events
    try {
      const { swaps: ethVitaSwaps, mints: ethVitaMints, burns: ethVitaBurns } = await pollEthVitaEvents();
      for (const swap of ethVitaSwaps) {
        console.log(`[eth-vita-swap] ${swap.direction} | ${fmt(swap.vitaAmount)} VITA | tx: ${swap.txHash}`);
        recordEthVitaSwap(swap);
      }
      for (const mint of ethVitaMints) {
        console.log(`[eth-vita-lp] Mint | ${fmt(mint.vitaAmount)} VITA | tx: ${mint.txHash}`);
        recordEthVitaMint(mint);
      }
      for (const burn of ethVitaBurns) {
        console.log(`[eth-vita-lp] Burn | ${fmt(burn.vitaAmount)} VITA | tx: ${burn.txHash}`);
        recordEthVitaBurn(burn);
      }
    } catch (err) {
      console.warn('[eth-vita] Ethereum VITA polling failed:', err.message);
    }

    // Save stats + cursors atomically after all events are recorded
    saveToDisk();

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

    // Daily report — triggered by timer flag, executed here so it never races with event recording
    if (dailyReportDue) {
      dailyReportDue = false;
      try {
        const snapshot = snapshotAndReset();
        await sendDailyStatus(state);
        await sendDailyStats(snapshot);
      } catch (err) {
        console.error('[daily] Failed to send daily report:', err.message);
      }
    }
  } catch (err) {
    console.error('[error] Poll failed:', err.message);
    await sendAdminAlert(`Poll failed: ${err.message}`);
  } finally {
    polling = false;
  }
}

async function start() {
  console.log('AUBRAI/BIO + VITA/BIO Pool Health Monitor');
  console.log(`AUBRAI/BIO CL Pool: ${config.poolAddress}`);
  for (const p of config.vitaPools) {
    console.log(`VITA/BIO CL Pool (Base): ${p.address}`);
  }
  for (const p of config.ethereumVitaPools) {
    console.log(`${p.name} Pool (Ethereum): ${p.address}`);
  }
  console.log(`Polling every ${config.pollIntervalMs / 1000}s | Swap slippage threshold: ${config.swapSlippageThreshold}%`);
  console.log(`Telegram alerts: ${config.telegramBotToken && config.telegramChatId ? 'enabled' : 'disabled (missing bot token or chat ID)'}`);
  console.log(`Telegram stats topic: ${config.telegramStatsThreadId ? 'enabled' : 'disabled (TELEGRAM_STATS_THREAD_ID not set)'}`);
  console.log('---');

  await init();

  // Notify admin that bot (re)started
  await sendAdminDM('\u2705 *Bot started*\\. Polling is active\\.');

  await poll();
  pollTimer = setInterval(poll, config.pollIntervalMs);

  // Schedule daily report at 9:00 CET/CEST
  scheduleDailyReport();
}

let dailyTimer = null;

/**
 * Compute ms until next 9:00 in Europe/Berlin (CET/CEST).
 * Uses Intl to get the correct UTC offset regardless of DST.
 */
function msUntilNext9CET() {
  const now = new Date();
  // Get Berlin's current UTC offset in hours
  const berlinNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const offsetMs = berlinNow.getTime() - now.getTime();
  // Target: 9:00 Berlin time today, converted to UTC
  const target = new Date(berlinNow);
  target.setHours(9, 0, 0, 0);
  let targetUtc = new Date(target.getTime() - offsetMs);
  if (targetUtc <= now) {
    // Tomorrow — recompute offset (could cross DST boundary, though 9 AM is far from the 2-3 AM transition)
    targetUtc.setDate(targetUtc.getDate() + 1);
    const tomorrowBerlin = new Date(targetUtc.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const tomorrowOffsetMs = tomorrowBerlin.getTime() - targetUtc.getTime();
    const tomorrowTarget = new Date(tomorrowBerlin);
    tomorrowTarget.setHours(9, 0, 0, 0);
    targetUtc = new Date(tomorrowTarget.getTime() - tomorrowOffsetMs);
  }
  return targetUtc - now;
}

function scheduleDailyReport() {
  function schedule() {
    dailyTimer = setTimeout(() => {
      dailyReportDue = true;
      console.log('[daily] Daily report flag set — will execute after current poll cycle');
      schedule();
    }, msUntilNext9CET());
  }
  schedule();
  const hours = Math.round(msUntilNext9CET() / 3600000 * 10) / 10;
  console.log(`[daily] Next status report in ${hours}h (9:00 CET/CEST)`);
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
