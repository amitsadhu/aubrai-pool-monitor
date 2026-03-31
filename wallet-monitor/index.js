const config = require('./config');
const { initWallets, checkWalletBalances } = require('./wallets');
const { sendWalletAlert, sendDailyWalletReport, sendAdminAlert, sendAdminDM } = require('./alerts');

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

let pollTimer = null;
let dailyTimer = null;
let polling = false;
let dailyReportDue = false;

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
    if (issues.length > 0) {
      await sendWalletAlert(issues);
    }

    if (dailyReportDue) {
      dailyReportDue = false;
      try {
        await sendDailyWalletReport(balances);
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
