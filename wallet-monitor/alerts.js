const config = require('./config');

// Per-wallet cooldown tracking
const lastAlertTimes = {};

function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function escTg(str) {
  return String(str).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function isInCooldown(walletAddress) {
  const lastTime = lastAlertTimes[walletAddress];
  if (!lastTime) return false;
  return Date.now() - lastTime < config.alertCooldownMs;
}

/**
 * Send alert when wallets are below threshold. Respects per-wallet cooldown.
 */
async function sendWalletAlert(issues) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const alertable = issues.filter((w) => !isInCooldown(w.address));
  if (alertable.length === 0) return;

  const lines = [
    `\u26A0\uFE0F *USDC Balance Alert*`,
    '',
  ];
  for (const w of alertable) {
    lines.push(`\\- *${escTg(w.label)}*: ${escTg(fmt(w.balance))} USDC \\(threshold: ${escTg(fmt(config.alertThreshold))}\\)`);
    lines.push(`  \`${escTg(w.address)}\``);
  }

  const text = lines.join('\n');
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        ...(config.telegramWalletThreadId && { message_thread_id: config.telegramWalletThreadId }),
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[alerts] Telegram alert returned ${res.status}: ${body}`);
      return;
    }

    for (const w of alertable) {
      lastAlertTimes[w.address] = Date.now();
    }
    console.log(`[alerts] Wallet alert sent for: ${alertable.map((w) => w.label).join(', ')}`);
  } catch (err) {
    console.error('[alerts] Failed to send wallet alert:', err.message);
  }
}

/**
 * Send daily report with all wallet balances + transfer delta stats.
 */
async function sendDailyWalletReport(balances, deltaStats) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  const lines = [
    `\u{1F4B0} *USDC Wallet Balances \\| Daily Report*`,
    '',
  ];

  for (const w of balances) {
    const status = w.error ? '\u274C' : w.belowThreshold ? '\u{1F534}' : '\u{1F7E2}';
    if (w.error) {
      lines.push(`${status} *${escTg(w.label)}*: error fetching balance`);
    } else {
      lines.push(`${status} *${escTg(w.label)}*: ${escTg(fmt(w.balance))} USDC`);
    }
    lines.push(`  \`${escTg(w.address)}\``);

    // Add daily delta stats if available
    if (deltaStats) {
      const stats = deltaStats[w.address.toLowerCase()];
      if (stats && (stats.outCount > 0 || stats.inCount > 0)) {
        if (stats.outCount > 0) {
          const txLabel = stats.outCount === 1 ? 'tx' : 'txs';
          lines.push(`  \u2198 Spent: ${escTg(fmt(stats.outTotal))} USDC \\(${escTg(stats.outCount)} ${escTg(txLabel)}\\)`);
        }
        if (stats.inCount > 0) {
          const txLabel = stats.inCount === 1 ? 'tx' : 'txs';
          lines.push(`  \u2197 Received: ${escTg(fmt(stats.inTotal))} USDC \\(${escTg(stats.inCount)} ${escTg(txLabel)}\\)`);
        }
      } else {
        lines.push(`  _No activity_`);
      }
    }
  }

  lines.push('');
  lines.push(`_Threshold: ${escTg(fmt(config.alertThreshold))} USDC_`);

  const text = lines.join('\n');
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        ...(config.telegramWalletThreadId && { message_thread_id: config.telegramWalletThreadId }),
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    if (res.ok) {
      console.log('[alerts] Daily wallet report sent');
    } else {
      const body = await res.text();
      console.error(`[alerts] Daily wallet report failed: ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[alerts] Failed to send daily wallet report:', err.message);
  }
}

/**
 * Send error to admin DM (with cooldown).
 */
let lastAdminAlertTime = 0;

async function sendAdminAlert(errorMessage) {
  if (!config.telegramBotToken || !config.telegramAdminChatId) return;

  if (Date.now() - lastAdminAlertTime < 5 * 60 * 1000) return;
  lastAdminAlertTime = Date.now();

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramAdminChatId,
        text: `\u{1F527} *Wallet Monitor Error*\n\n${escTg(errorMessage)}`,
        parse_mode: 'MarkdownV2',
      }),
    });
    if (res.ok) {
      console.log('[alerts] Admin alert sent');
    }
  } catch (err) {
    console.error('[alerts] Failed to send admin alert:', err.message);
  }
}

/**
 * Send a direct message to admin (no cooldown).
 */
async function sendAdminDM(text) {
  if (!config.telegramBotToken || !config.telegramAdminChatId) return;

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramAdminChatId,
        text,
        parse_mode: 'MarkdownV2',
      }),
    });
    if (res.ok) {
      console.log('[alerts] Admin DM sent');
    }
  } catch (err) {
    console.error('[alerts] Failed to send admin DM:', err.message);
  }
}

module.exports = { sendWalletAlert, sendDailyWalletReport, sendAdminAlert, sendAdminDM };
