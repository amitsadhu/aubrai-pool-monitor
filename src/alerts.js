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
function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Build the Slack message payload from issues and pool state.
 */
function buildSlackPayload(issues, poolState) {
  const hasCritical = issues.some((i) => i.severity === 'critical');
  const emoji = hasCritical ? ':rotating_light:' : ':warning:';
  const level = hasCritical ? 'CRITICAL' : 'WARNING';

  const issueLines = issues
    .map((issue) => {
      let line = `- *${issue.check}*`;
      if (issue.deviation !== undefined) line += ` — ${issue.deviation}% deviation`;
      if (issue.detail) line += ` — ${issue.detail}`;
      if (issue.details) line += ` — ${issue.details.join(', ')}`;
      if (issue.dexPrice !== undefined) line += ` (DexScreener: ${fmt(issue.dexPrice)} BIO)`;
      return line;
    })
    .join('\n');

  const text = [
    `${emoji} *AUBRAI/BIO Pool ${level}* ${emoji}`,
    '',
    '*Issues:*',
    issueLines,
    '',
    '*Current Pool State:*',
    `- 1 AUBRAI = ${fmt(poolState.spotPrice)} BIO`,
    `- AUBRAI Reserve: ${fmt(poolState.aubraiReserve)}`,
    `- BIO Reserve: ${fmt(poolState.bioReserve)}`,
    '',
    `<${config.uniswapPoolUrl}|Uniswap> | <${config.basescanPoolUrl}|BaseScan> | <${config.dexscreenerPoolUrl}|DexScreener>`,
  ].join('\n');

  return { text };
}

/**
 * Send a Slack alert for the given issues.
 * Respects per-check cooldowns to avoid spamming.
 */
async function sendSlackAlert(issues, poolState) {
  if (!config.slackWebhookUrl) {
    console.warn('[alerts] SLACK_WEBHOOK_URL not set — skipping alert');
    return;
  }

  // Filter out issues still in cooldown
  const alertableIssues = issues.filter((issue) => !isInCooldown(issue.check));
  if (alertableIssues.length === 0) return;

  const payload = buildSlackPayload(alertableIssues, poolState);

  try {
    const res = await fetch(config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`[alerts] Slack webhook returned ${res.status}: ${await res.text()}`);
      return;
    }

    // Update cooldown timestamps
    for (const issue of alertableIssues) {
      lastAlertTimes[issue.check] = Date.now();
    }

    console.log(`[alerts] Slack alert sent for: ${alertableIssues.map((i) => i.check).join(', ')}`);
  } catch (err) {
    console.error('[alerts] Failed to send Slack alert:', err.message);
  }
}

module.exports = { sendSlackAlert };
