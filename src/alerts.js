const config = require('./config');

// Track last alert time per check type for cooldown
const lastAlertTimes = {};

/**
 * Check if we're still in cooldown for a given check type.
 */
function isInCooldown(checkType) {
  const lastTime = lastAlertTimes[checkType];
  if (!lastTime) return false;
  return Date.now() - lastTime < config.alertCooldownMs;
}

/**
 * Format a number with commas for readability.
 */
function fmt(n, digits = 2) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
function escTg(str) {
  return String(str).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Build the Telegram message text from issues and pool state.
 */
function buildTelegramMessage(issues, poolState) {
  const hasCritical = issues.some((i) => i.severity === 'critical');
  const icon = hasCritical ? '\u{1F6A8}' : '\u26A0\uFE0F';
  const level = hasCritical ? 'CRITICAL' : 'WARNING';

  const issueLines = issues
    .map((issue) => {
      let line = `\\- *${escTg(issue.check)}*`;
      if (issue.deviation !== undefined) line += ` — ${escTg(issue.deviation)}% deviation`;
      if (issue.detail) line += ` — ${escTg(issue.detail)}`;
      if (issue.details) line += ` — ${escTg(issue.details.join(', '))}`;
      if (issue.dexPrice !== undefined) line += ` \\(DexScreener: ${escTg(fmt(issue.dexPrice))} BIO\\)`;
      return line;
    })
    .join('\n');

  const text = [
    `${icon} *AUBRAI/BIO Pool ${level}* ${icon}`,
    '',
    '*Issues:*',
    issueLines,
    '',
    '*Current Pool State:*',
    `\\- 1 AUBRAI \\= ${escTg(fmt(poolState.spotPrice))} BIO`,
    `\\- 1 BIO \\= ${escTg(fmt(poolState.aubraiPerBio, 4))} AUBRAI`,
    `\\- AUBRAI Reserve: ${escTg(fmt(poolState.aubraiReserve))}`,
    `\\- BIO Reserve: ${escTg(fmt(poolState.bioReserve))}`,
    `\\- Tick: ${escTg(poolState.tick)}`,
    '',
    `[Aerodrome](${config.aerodromePoolUrl}) \\| [BaseScan](${config.basescanPoolUrl}) \\| [DexScreener](${config.dexscreenerPoolUrl})`,
  ].join('\n');

  return text;
}

/**
 * Send a Telegram alert for the given issues.
 * Respects per-check cooldowns to avoid spamming.
 */
async function sendTelegramAlert(issues, poolState) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn('[alerts] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert');
    return;
  }

  // Filter out issues still in cooldown
  const alertableIssues = issues.filter((issue) => !isInCooldown(issue.check));
  if (alertableIssues.length === 0) return;

  const text = buildTelegramMessage(alertableIssues, poolState);
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        ...(config.telegramThreadId && { message_thread_id: config.telegramThreadId }),
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[alerts] Telegram API returned ${res.status}: ${body}`);
      return;
    }

    // Update cooldown timestamps
    for (const issue of alertableIssues) {
      lastAlertTimes[issue.check] = Date.now();
    }

    console.log(`[alerts] Telegram alert sent for: ${alertableIssues.map((i) => i.check).join(', ')}`);
  } catch (err) {
    console.error('[alerts] Failed to send Telegram alert:', err.message);
  }
}

/**
 * Build a Telegram message for a real swap that exceeded the slippage threshold.
 */
function buildSwapAlertMessage(swapData) {
  const icon = swapData.slippage > 20 ? '\u{1F6A8}' : '\u26A0\uFE0F';
  const level = swapData.slippage > 20 ? 'HIGH SLIPPAGE' : 'SLIPPAGE ALERT';

  const text = [
    `${icon} *AUBRAI/BIO ${level}* ${icon}`,
    '',
    `*Swap Detected:* ${escTg(swapData.direction)}`,
    `\\- AUBRAI: ${escTg(fmt(swapData.aubraiAmount))}`,
    `\\- BIO: ${escTg(fmt(swapData.bioAmount))}`,
    `\\- Slippage: ${escTg(swapData.slippage)}%`,
    '',
    `*Price:*`,
    `\\- Before: ${escTg(fmt(swapData.prePrice || 0, 4))} BIO/AUBRAI`,
    `\\- After: ${escTg(fmt(swapData.newPrice, 4))} BIO/AUBRAI`,
    '',
    `[Tx on BaseScan](https://basescan.org/tx/${swapData.txHash}) \\| [DexScreener](${config.dexscreenerPoolUrl})`,
  ].join('\n');

  return text;
}

/**
 * Send a Telegram alert for a real swap exceeding slippage threshold.
 * No cooldown — every high-slippage swap is worth knowing about.
 */
async function sendSwapAlert(swapData) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn('[alerts] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping swap alert');
    return;
  }

  const text = buildSwapAlertMessage(swapData);
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        ...(config.telegramThreadId && { message_thread_id: config.telegramThreadId }),
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[alerts] Telegram swap alert returned ${res.status}: ${body}`);
      return;
    }

    console.log(`[alerts] Telegram swap alert sent: ${swapData.direction} — ${swapData.slippage}% slippage`);
  } catch (err) {
    console.error('[alerts] Failed to send swap alert:', err.message);
  }
}

module.exports = { sendTelegramAlert, sendSwapAlert };
