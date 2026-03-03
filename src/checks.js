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
function checkReserves(aubraiReserve, bioReserve) {
  const issues = [];
  if (aubraiReserve < config.minReserveAubrai) {
    issues.push(`AUBRAI reserve dangerously low: ${aubraiReserve.toFixed(2)}`);
  }
  if (bioReserve < config.minReserveBio) {
    issues.push(`BIO reserve dangerously low: ${bioReserve.toFixed(2)}`);
  }
  return {
    ok: issues.length === 0,
    details: issues,
    severity: 'critical',
  };
}

/**
 * Check if spot price (BIO per AUBRAI) is in a sane range.
 * Expected: ~50-70 BIO per AUBRAI.
 */
function checkSpotPriceSanity(spotPrice) {
  if (spotPrice < config.minSanePrice) {
    return {
      ok: false,
      detail: `Spot price near zero: ${spotPrice}`,
      severity: 'critical',
    };
  }
  if (spotPrice > config.maxSanePrice) {
    return {
      ok: false,
      detail: `Spot price absurdly high: ${spotPrice}`,
      severity: 'critical',
    };
  }
  return { ok: true };
}

/**
 * Check if raw pool liquidity is above minimum threshold.
 */
function checkLiquidity(liquidity) {
  if (liquidity < config.minLiquidity) {
    return {
      ok: false,
      detail: `Pool liquidity very low: ${liquidity.toString()}`,
      severity: 'critical',
    };
  }
  return { ok: true };
}

/**
 * Check if a real swap's slippage exceeds the threshold.
 */
function checkSwapSlippage(swapData) {
  if (swapData.slippage > config.swapSlippageThreshold) {
    return {
      ok: false,
      detail: `${swapData.direction}: ${swapData.slippage}% slippage (${fmt(swapData.aubraiAmount)} AUBRAI / ${fmt(swapData.bioAmount)} BIO)`,
      severity: swapData.slippage > config.swapSlippageThreshold * 2 ? 'critical' : 'warning',
    };
  }
  return { ok: true };
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Cross-reference pool price with DexScreener.
 */
async function checkDexScreenerDeviation(spotPrice) {
  const dexPrice = await getDexScreenerPrice();
  if (dexPrice === null) {
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

  // 4. Liquidity check
  const liq = checkLiquidity(currentState.liquidity);
  if (!liq.ok) {
    issues.push({ check: 'Liquidity', ...liq });
  }

  // 5. DexScreener cross-reference
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

module.exports = { checkPriceStability, checkReserves, checkSpotPriceSanity, checkLiquidity, checkSwapSlippage, checkDexScreenerDeviation, checkAllHealth };
