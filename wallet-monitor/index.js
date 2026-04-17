const fs = require('fs');
const path = require('path');
const config = require('./config');
const { initWallets, checkWalletBalances, pollTransferEvents, snapshotAndResetStats, getTransferBlockCursor, setTransferBlockCursor, getTransferStats, setTransferStats } = require('./wallets');
const { sendWalletAlert, sendDailyWalletReport, sendAdminAlert, sendAdminDM } = require('./alerts');

const CURSORS_DIR = '/data';
const CURSORS_FILE = path.join(CURSORS_DIR, 'wallet-cursors.json');

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

let pollTimer = null;
let dailyTimer = null;
let polling = false;
let dailyReportDue = false;
let firstPoll = true;

function loadState() {
  try {
    if (fs.existsSync(CURSORS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CURSORS_FILE, 'utf8'));
      if (data.lastTransferBlock) {
        setTransferBlockCursor(data.lastTransferBlock);
        console.log(`[state] Loaded transfer cursor: block ${data.lastTransferBlock}`);
      }
      if (data.transferStats) {
        setTransferStats(data.transferStats);
        console.log(`[state] Loaded transfer stats from disk`);
      }
    }
  } catch (err) {
    console.warn('[state] Failed to load state:', err.message);
  }
}

function saveState() {
  try {
    if (!fs.existsSync(CURSORS_DIR)) return; // volume not mounted (local dev)
    const cursor = getTransferBlockCursor();
    if (cursor !== null) {
      fs.writeFileSync(CURSORS_FILE, JSON.stringify({
        lastTransferBlock: cursor,
        transferStats: getTransferStats(),
      }), 'utf8');
    }
  } catch (err) {
    console.warn('[state] Failed to save state:', err.message);
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const balances = await checkWalletBalances();

    for (const w of balances) {
      if (w.error) {
        console.log(`[poll] ${w.label}: ERROR — ${w.error}`);
      } else {
        console.log(`[poll] ${w.label}: ${fmt(w.balance)} USDC${w.belowThreshold ? ' [BELOW THRESHOLD]' : ''}`);
      }
    }

    const issues = balances.filter((w) => w.belowThreshold);
    if (issues.length > 0 && !firstPoll) {
      await sendWalletAlert(issues);
    }
    firstPoll = false;

    // Poll USDC transfer events
    await pollTransferEvents();
    saveState();

    if (dailyReportDue) {
      dailyReportDue = false;
      try {
        const deltaStats = snapshotAndResetStats();
        saveState(); // persist zeroed stats so restart doesn't re-report
        await sendDailyWalletReport(balances, deltaStats);
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

/**
 * Compute ms until next 9:00 in Europe/Berlin (CET/CEST).
 */
function msUntilNext9CET() {
  const now = new Date();
  const berlinNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const offsetMs = berlinNow.getTime() - now.getTime();
  const target = new Date(berlinNow);
  target.setHours(9, 0, 0, 0);
  let targetUtc = new Date(target.getTime() - offsetMs);
  if (targetUtc <= now) {
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
  console.log(`[daily] Next wallet report in ${hours}h (9:00 CET/CEST)`);
}

async function start() {
  console.log('USDC Wallet Balance Monitor');
  console.log(`Monitoring ${config.wallets.length} wallet(s)`);
  console.log(`Alert threshold: ${fmt(config.alertThreshold)} USDC`);
  console.log(`Polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`Telegram alerts: ${config.telegramBotToken && config.telegramChatId ? 'enabled' : 'disabled (missing bot token or chat ID)'}`);
  console.log(`Telegram wallet topic: ${config.telegramWalletThreadId ? 'enabled' : 'disabled (TELEGRAM_WALLET_THREAD_ID not set)'}`);
  console.log('---');

  initWallets();
  loadState();

  await sendAdminDM('\u2705 *Wallet Monitor started*\\. Polling is active\\.');

  await poll();
  pollTimer = setInterval(poll, config.pollIntervalMs);

  scheduleDailyReport();
}

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
