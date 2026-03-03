const config = require('./config');
const { init, getPoolState, setLastKnownPrice, pollSwapEvents } = require('./pool');
const { checkAllHealth, checkSwapSlippage } = require('./checks');
const { sendTelegramAlert, sendSwapAlert } = require('./alerts');

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

let previousState = null;
let pollTimer = null;

async function poll() {
  try {
    // Check for new swaps since last poll
    const swaps = await pollSwapEvents();
    for (const swap of swaps) {
      console.log(`[swap] ${swap.direction} | ${fmt(swap.aubraiAmount)} AUBRAI / ${fmt(swap.bioAmount)} BIO | slippage: ${swap.slippage}% | tx: ${swap.txHash}`);
      const result = checkSwapSlippage(swap);
      if (!result.ok) {
        console.log(`[!] Swap slippage alert: ${swap.slippage}%`);
        await sendSwapAlert(swap);
      }
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
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});

start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
