const config = require('./config');
const { init, getPoolState, setLastKnownPrice, pollSwapEvents } = require('./pool');
const { checkAllHealth, checkSwapSlippage } = require('./checks');
const { sendTelegramAlert, sendSwapAlert, sendAdminAlert, sendDailyStatus } = require('./alerts');

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

let previousState = null;
let pollTimer = null;

async function poll() {
  try {
    // Check for new swaps since last poll (non-blocking — health checks run regardless)
    try {
      const swaps = await pollSwapEvents();
      for (const swap of swaps) {
        console.log(`[swap] ${swap.direction} | ${fmt(swap.aubraiAmount)} AUBRAI / ${fmt(swap.bioAmount)} BIO | slippage: ${swap.slippage}% | tx: ${swap.txHash}`);
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
  console.log('AUBRAI/BIO Aerodrome SlipStream Pool Health Monitor');
  console.log(`Pool: ${config.poolAddress}`);
  console.log(`Polling every ${config.pollIntervalMs / 1000}s | Swap slippage threshold: ${config.swapSlippageThreshold}%`);
  console.log(`Telegram alerts: ${config.telegramBotToken && config.telegramChatId ? 'enabled' : 'disabled (missing bot token or chat ID)'}`);
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
    getPoolState().then((state) => {
      sendDailyStatus(state);
    }).catch((err) => {
      console.error('[daily] Failed to send daily status:', err.message);
    });
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
