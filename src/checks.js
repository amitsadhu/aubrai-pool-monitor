const config = require('./config');
const { getDexScreenerPrice } = require('./pool');

// Rolling price history for trend detection
const priceHistory = [];

/**
 * Check if price changed more than threshold% since last poll.
 */
function checkPriceStability(currentPrice, previousPrice, threshold = config.priceChangeThreshold) {
  if (!previousPrice || previousPrice === 0) {
    return { ok: true, deviation: 0 };
  }
  const deviation = Math.abs((currentPrice - previousPrice) / previousPrice) * 100;
  return {
    ok: deviation <= threshold,
    deviation: Math.round(deviation * 100) / 100,
    severity: deviation > threshold * 2 ? 'critical' : 'warning',
  };
}

/**
 * Check that both reserves are above minimum thresholds.
 */
function checkReserves(aubraiReserve, bioReserve, minThreshold = config.minReserveThreshold) {
  const issues = [];
  if (aubraiReserve < minThreshold) {
    issues.push(`AUBRAI reserve dangerously low: ${aubraiReserve.toFixed(2)}`);
  }
  if (bioReserve < minThreshold) {
    issues.push(`BIO reserve dangerously low: ${bioReserve.toFixed(2)}`);
  }
  return {
    ok: issues.length === 0,
    details: issues,
    severity: 'critical',
  };
}

/**
 * Check if spot price is in a sane range.
 * Expected: ~60 BIO per AUBRAI. Flag anything wildly off.
 */
function checkSpotPriceSanity(spotPrice) {
  // If price is effectively zero or absurdly high, something is wrong
  if (spotPrice < 0.001) {
    return {
      ok: false,
      detail: `Spot price near zero: ${spotPrice}`,
      severity: 'critical',
    };
  }
  if (spotPrice > 1_000_000) {
    return {
      ok: false,
      detail: `Spot price absurdly high: ${spotPrice}`,
      severity: 'critical',
    };
  }
  return { ok: true };
}

/**
 * Cross-reference pool price with DexScreener.
 */
async function checkDexScreenerDeviation(spotPrice) {
  const dexPrice = await getDexScreenerPrice();
  if (dexPrice === null) {
    // API unavailable — not an alert, just skip
    return { ok: true, skipped: true };
  }
  if (dexPrice === 0) {
    return { ok: true, skipped: true };
  }
  const deviation = Math.abs((spotPrice - dexPrice) / dexPrice) * 100;
  return {
    ok: deviation <= config.dexscreenerDeviation,
    deviation: Math.round(deviation * 100) / 100,
    dexPrice,
    severity: 'warning',
  };
}

/**
 * Run all health checks. Returns an array of issue objects.
 */
async function checkAllHealth(currentState, previousState) {
  const issues = [];

  // 1. Spot price sanity
  const sanity = checkSpotPriceSanity(currentState.spotPrice);
  if (!sanity.ok) {
    issues.push({ check: 'Spot Price Sanity', ...sanity });
  }

  // 2. Price stability vs previous poll
  if (previousState) {
    const stability = checkPriceStability(currentState.spotPrice, previousState.spotPrice);
    if (!stability.ok) {
      issues.push({ check: 'Price Stability', ...stability });
    }
  }

  // 3. Reserve levels
  const reserves = checkReserves(currentState.aubraiReserve, currentState.bioReserve);
  if (!reserves.ok) {
    issues.push({ check: 'Reserve Levels', ...reserves });
  }

  // 4. DexScreener cross-reference
  const dexCheck = await checkDexScreenerDeviation(currentState.spotPrice);
  if (!dexCheck.ok) {
    issues.push({ check: 'DexScreener Deviation', ...dexCheck });
  }

  // Update rolling history
  priceHistory.push(currentState.spotPrice);
  if (priceHistory.length > config.priceHistorySize) {
    priceHistory.shift();
  }

  return issues;
}

module.exports = { checkPriceStability, checkReserves, checkSpotPriceSanity, checkDexScreenerDeviation, checkAllHealth };
