const config = require('./config');
const { init, getPoolState } = require('./pool');
const { checkAllHealth } = require('./checks');
const { sendSlackAlert } = require('./alerts');

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

let previousState = null;
let pollTimer = null;

async function poll() {
  try {
    const state = await getPoolState();

    // Run health checks
    const issues = await checkAllHealth(state, previousState);

    if (issues.length > 0) {
      console.log(`[!] ${issues.length} issue(s) detected:`);
      for (const issue of issues) {
        console.log(`    - ${issue.check}: ${issue.detail || issue.details?.join(', ') || `${issue.deviation}% deviation`}`);
      }
      await sendSlackAlert(issues, state);
    } else {
      console.log(
        `Pool OK | 1 AUBRAI = ${fmt(state.spotPrice)} BIO | Reserves: ${fmt(state.aubraiReserve)} AUBRAI / ${fmt(state.bioReserve)} BIO`
      );
    }

    previousState = state;
  } catch (err) {
    console.error('[error] Poll failed:', err.message);
  }
}

async function start() {
  console.log('AUBRAI/BIO Pool Health Monitor');
  console.log(`Pool: ${config.poolAddress}`);
  console.log(`Polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`Slack alerts: ${config.slackWebhookUrl ? 'enabled' : 'disabled (no webhook URL)'}`);
  console.log('---');

  // Initialize provider and detect token ordering
  await init();

  // First poll immediately
  await poll();

  // Then poll on interval
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
