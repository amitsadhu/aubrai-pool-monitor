const config = require('./config');
const { getDexScreenerData, getVitaDexScreenerData } = require('./pool');

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

/**
 * Send a bot health error to the admin's personal DM.
 * Uses a 5-minute cooldown to avoid spamming.
 */
let lastAdminAlertTime = 0;

async function sendAdminAlert(errorMessage) {
  if (!config.telegramBotToken || !config.telegramAdminChatId) return;

  // 5-minute cooldown for admin alerts
  if (Date.now() - lastAdminAlertTime < config.alertCooldownMs) return;

  const text = `\u{1F527} *Bot Health Error*\n\n${escTg(errorMessage)}`;
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
      lastAdminAlertTime = Date.now();
      console.log('[alerts] Admin DM sent for bot error');
    }
  } catch (err) {
    console.error('[alerts] Failed to send admin DM:', err.message);
  }
}

/**
 * Send a daily "Pool OK" status report to the group topic.
 */
async function sendDailyStatus(poolState) {
  if (!config.telegramBotToken || !config.telegramChatId) return;

  // Fetch USD prices from DexScreener
  const dexData = await getDexScreenerData();
  const aubraiUsd = dexData?.priceUsd || null;
  const bioUsd = aubraiUsd && poolState.spotPrice ? aubraiUsd / poolState.spotPrice : null;

  const aubraiReserveUsd = aubraiUsd ? poolState.aubraiReserve * aubraiUsd : null;
  const bioReserveUsd = bioUsd ? poolState.bioReserve * bioUsd : null;
  const totalTvl = aubraiReserveUsd && bioReserveUsd ? aubraiReserveUsd + bioReserveUsd : null;

  const usdTag = (usd) => usd !== null ? ` \\(\\~\\$${escTg(fmt(usd))}\\)` : '';

  const lines = [
    `\u2705 *AUBRAI/BIO Daily Status*`,
    '',
    `*Pool State:*`,
    `\\- 1 AUBRAI \\= ${escTg(fmt(poolState.spotPrice))} BIO${aubraiUsd ? ` \\(\\$${escTg(fmt(aubraiUsd, 4))}\\)` : ''}`,
    `\\- 1 BIO \\= ${escTg(fmt(poolState.aubraiPerBio, 4))} AUBRAI${bioUsd ? ` \\(\\$${escTg(fmt(bioUsd, 4))}\\)` : ''}`,
    `\\- AUBRAI Reserve: ${escTg(fmt(poolState.aubraiReserve))}${usdTag(aubraiReserveUsd)}`,
    `\\- BIO Reserve: ${escTg(fmt(poolState.bioReserve))}${usdTag(bioReserveUsd)}`,
  ];

  if (totalTvl) {
    lines.push(`\\- Total TVL: \\~\\$${escTg(fmt(totalTvl))}`);
  }

  lines.push(
    `\\- Tick: ${escTg(poolState.tick)}`,
    '',
    `*Checks \\(all passing\\):*`,
    `\\- Price sanity: within ${escTg(config.minSanePrice)}–${escTg(fmt(config.maxSanePrice))} BIO/AUBRAI \\u2713`,
    `\\- Price stability: \\<${escTg(config.priceChangeThreshold)}% change \\u2713`,
    `\\- Reserves: AUBRAI \\>${escTg(fmt(config.minReserveAubrai))}, BIO \\>${escTg(fmt(config.minReserveBio))} \\u2713`,
    `\\- Liquidity: \\>${escTg(fmt(Number(config.minLiquidity)))} \\u2713`,
    `\\- DexScreener deviation: \\<${escTg(config.dexscreenerDeviation)}% \\u2713`,
    `\\- Swap slippage: \\<${escTg(config.swapSlippageThreshold)}% \\u2713`,
    '',
    `[Aerodrome](${config.aerodromePoolUrl}) \\| [BaseScan](${config.basescanPoolUrl}) \\| [DexScreener](${config.dexscreenerPoolUrl})`,
  );

  const text = lines.join('\n');

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

    if (res.ok) {
      console.log('[alerts] Daily status sent to topic');
    } else {
      const body = await res.text();
      console.error(`[alerts] Daily status failed: ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error('[alerts] Failed to send daily status:', err.message);
  }
}

/**
 * Send daily swap/LP stats for both AUBRAI and VITA pools.
 * Sends two separate messages (one per token) to the "Pool Stats" topic.
 */
async function sendDailyStats(snapshot) {
  if (!config.telegramBotToken || !config.telegramChatId || !config.telegramStatsThreadId) {
    console.warn('[stats] Missing Telegram config for stats — skipping');
    return;
  }

  // Fetch USD prices
  const aubraiDex = await getDexScreenerData();
  const vitaDex = await getVitaDexScreenerData();

  const aubraiUsd = aubraiDex?.priceUsd || null;
  const vitaUsd = vitaDex?.priceUsd || null;

  let bioUsd = null;
  if (aubraiUsd && aubraiDex?.priceNative) {
    bioUsd = aubraiUsd / aubraiDex.priceNative;
  } else if (vitaUsd && vitaDex?.priceNative) {
    bioUsd = vitaUsd / vitaDex.priceNative;
  }

  const windowMs = (snapshot.periodEnd || Date.now()) - snapshot.periodStart;
  const windowHours = Math.round(windowMs / 3600000 * 10) / 10;

  function $(amount, price) {
    if (!price || amount === 0) return '';
    return ` \\($${escTg(fmt(amount * price))}\\)`;
  }

  // --- AUBRAI message ---
  const a = snapshot.aubrai;
  const aubraiLines = [
    `\u{1F7EA} *AUBRAI/BIO \\| Daily Stats* \\(${escTg(windowHours)}h\\)`,
    `_SlipStream CL pool_`,
    '',
    `*Swaps* \\(${escTg(a.swaps.count)}\\)`,
  ];
  if (a.swaps.count === 0) {
    aubraiLines.push(`No swaps`);
  } else {
    aubraiLines.push(`\u{1F7E2} Bought: ${escTg(fmt(a.swaps.bought.tokens))} AUBRAI${$(a.swaps.bought.tokens, aubraiUsd)}`);
    aubraiLines.push(`   ${escTg(fmt(a.swaps.bought.bio))} BIO spent`);
    aubraiLines.push(`\u{1F534} Sold: ${escTg(fmt(a.swaps.sold.tokens))} AUBRAI${$(a.swaps.sold.tokens, aubraiUsd)}`);
    aubraiLines.push(`   ${escTg(fmt(a.swaps.sold.bio))} BIO received`);
  }
  aubraiLines.push('');
  aubraiLines.push(`*Liquidity* \\(${escTg(a.lp.mintCount)} adds, ${escTg(a.lp.burnCount)} removes\\)`);
  if (a.lp.mintCount + a.lp.burnCount === 0) {
    aubraiLines.push(`No LP changes`);
  } else {
    if (a.lp.mintCount > 0) {
      aubraiLines.push(`\u2795 Added: ${escTg(fmt(a.lp.added.tokens))} AUBRAI${$(a.lp.added.tokens, aubraiUsd)} \\+ ${escTg(fmt(a.lp.added.bio))} BIO${$(a.lp.added.bio, bioUsd)}`);
    }
    if (a.lp.burnCount > 0) {
      aubraiLines.push(`\u2796 Removed: ${escTg(fmt(a.lp.withdrawn.tokens))} AUBRAI${$(a.lp.withdrawn.tokens, aubraiUsd)} \\+ ${escTg(fmt(a.lp.withdrawn.bio))} BIO${$(a.lp.withdrawn.bio, bioUsd)}`);
    }
  }
  aubraiLines.push('');
  aubraiLines.push(`AUBRAI $${escTg(fmt(aubraiUsd || 0, 4))} \\| BIO $${escTg(fmt(bioUsd || 0, 4))}`);

  // --- VITA message ---
  const v = snapshot.vita;
  const vitaLines = [
    `\u{1F7E1} *VITA/BIO \\| Daily Stats* \\(${escTg(windowHours)}h\\)`,
    `_SlipStream CL \\(2 pools\\)_`,
    '',
    `*Swaps* \\(${escTg(v.swaps.count)}\\)`,
  ];
  if (v.swaps.count === 0) {
    vitaLines.push(`No swaps`);
  } else {
    vitaLines.push(`\u{1F7E2} Bought: ${escTg(fmt(v.swaps.bought.tokens))} VITA${$(v.swaps.bought.tokens, vitaUsd)}`);
    vitaLines.push(`   ${escTg(fmt(v.swaps.bought.bio))} BIO spent`);
    vitaLines.push(`\u{1F534} Sold: ${escTg(fmt(v.swaps.sold.tokens))} VITA${$(v.swaps.sold.tokens, vitaUsd)}`);
    vitaLines.push(`   ${escTg(fmt(v.swaps.sold.bio))} BIO received`);
  }
  vitaLines.push('');
  vitaLines.push(`*Liquidity* \\(${escTg(v.lp.mintCount)} adds, ${escTg(v.lp.burnCount)} removes\\)`);
  if (v.lp.mintCount + v.lp.burnCount === 0) {
    vitaLines.push(`No LP changes`);
  } else {
    if (v.lp.mintCount > 0) {
      vitaLines.push(`\u2795 Added: ${escTg(fmt(v.lp.added.tokens))} VITA${$(v.lp.added.tokens, vitaUsd)} \\+ ${escTg(fmt(v.lp.added.bio))} BIO${$(v.lp.added.bio, bioUsd)}`);
    }
    if (v.lp.burnCount > 0) {
      vitaLines.push(`\u2796 Removed: ${escTg(fmt(v.lp.withdrawn.tokens))} VITA${$(v.lp.withdrawn.tokens, vitaUsd)} \\+ ${escTg(fmt(v.lp.withdrawn.bio))} BIO${$(v.lp.withdrawn.bio, bioUsd)}`);
    }
  }
  vitaLines.push('');
  vitaLines.push(`VITA $${escTg(fmt(vitaUsd || 0, 4))} \\| BIO $${escTg(fmt(bioUsd || 0, 4))}`);

  // --- Verify swap counts against DexScreener before sending ---
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  async function verifyAndSend(label, swapCount, dexUrls, messageText) {
    let dexSwapCount = 0;
    let verified = false;
    try {
      for (const dexUrl of dexUrls) {
        const res = await fetch(dexUrl);
        const data = await res.json();
        const pair = data.pairs?.[0];
        if (pair) {
          dexSwapCount += (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
        }
      }
      verified = (swapCount === dexSwapCount);
      console.log(`[stats] ${label} verification: bot=${swapCount} dex=${dexSwapCount} → ${verified ? 'MATCH' : 'MISMATCH'}`);
    } catch (err) {
      console.error(`[stats] ${label} DexScreener verification failed:`, err.message);
    }

    if (verified) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.telegramChatId,
            message_thread_id: config.telegramStatsThreadId,
            text: messageText,
            parse_mode: 'MarkdownV2',
          }),
        });
        if (res.ok) {
          console.log(`[stats] ${label} daily stats sent`);
        } else {
          const body = await res.text();
          console.error(`[stats] ${label} daily stats failed: ${res.status}: ${body}`);
        }
      } catch (err) {
        console.error(`[stats] Failed to send ${label} daily stats:`, err.message);
      }
    } else {
      console.warn(`[stats] ${label} stats mismatch — skipping topic report`);
      if (config.telegramAdminChatId) {
        const mismatchText = `\u26A0\uFE0F *${escTg(label)} Stats Mismatch*\n\nBot counted: ${escTg(swapCount)} swaps\nDexScreener 24h: ${escTg(dexSwapCount)} swaps\n\n${escTg(label)} daily stats report was *not sent* to the topic\\.`;
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.telegramAdminChatId,
              text: mismatchText,
              parse_mode: 'MarkdownV2',
            }),
          });
          console.log(`[stats] ${label} mismatch alert sent to admin DM`);
        } catch (err) {
          console.error(`[stats] Failed to send ${label} mismatch alert:`, err.message);
        }
      }
    }
  }

  await verifyAndSend('AUBRAI', a.swaps.count, [config.dexscreenerApiUrl], aubraiLines.join('\n'));
  await verifyAndSend('VITA', v.swaps.count, config.vitaPools.map(p => p.dexscreenerApiUrl), vitaLines.join('\n'));
}

module.exports = { sendTelegramAlert, sendSwapAlert, sendAdminAlert, sendDailyStatus, sendDailyStats };
