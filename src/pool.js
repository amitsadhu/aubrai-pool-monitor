const { ethers } = require('ethers');
const config = require('./config');

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

let provider;
let pairContract;
let token0Address;

async function init() {
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  pairContract = new ethers.Contract(config.poolAddress, PAIR_ABI, provider);

  // Determine token ordering — only need to do this once
  token0Address = (await pairContract.token0()).toLowerCase();
}

/**
 * Returns which reserve index corresponds to AUBRAI and BIO.
 */
function getTokenOrder() {
  const aubraiIsToken0 = token0Address === config.aubrai.address.toLowerCase();
  return { aubraiIsToken0 };
}

/**
 * Calculate spot price: 1 AUBRAI = ? BIO
 * Both tokens are 18 decimals so no decimal adjustment needed.
 */
function getSpotPrice(aubraiReserve, bioReserve) {
  if (aubraiReserve === 0n) return 0;
  // Use BigInt arithmetic scaled to 18 decimals for precision
  const scaled = (bioReserve * 10n ** 18n) / aubraiReserve;
  return Number(scaled) / 1e18;
}

/**
 * Fetch current pool state from on-chain.
 */
async function getPoolState() {
  if (!pairContract) await init();

  const [reserve0, reserve1] = await pairContract.getReserves();
  const { aubraiIsToken0 } = getTokenOrder();

  const aubraiReserve = aubraiIsToken0 ? reserve0 : reserve1;
  const bioReserve = aubraiIsToken0 ? reserve1 : reserve0;

  const spotPrice = getSpotPrice(aubraiReserve, bioReserve);

  // Convert to human-readable numbers (both 18 decimals)
  const aubraiReserveNum = Number(ethers.formatUnits(aubraiReserve, 18));
  const bioReserveNum = Number(ethers.formatUnits(bioReserve, 18));

  return {
    aubraiReserve: aubraiReserveNum,
    bioReserve: bioReserveNum,
    spotPrice,
    timestamp: Date.now(),
  };
}

/**
 * Fetch price from DexScreener API for cross-reference.
 * Returns the price ratio (AUBRAI priced in BIO) or null on failure.
 */
async function getDexScreenerPrice() {
  try {
    const res = await fetch(config.dexscreenerApiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    // priceNative is the price of the base token in the quote token
    return parseFloat(pair.priceNative);
  } catch {
    return null;
  }
}

module.exports = { init, getPoolState, getSpotPrice, getDexScreenerPrice };
