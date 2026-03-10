const { ethers } = require('ethers');
const config = require('./config');

const CL_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

let provider;
let poolContract;
let aubraiToken;
let bioToken;
let aubraiIsToken0;

async function init() {
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  poolContract = new ethers.Contract(config.poolAddress, CL_POOL_ABI, provider);

  aubraiToken = new ethers.Contract(config.aubrai.address, ERC20_ABI, provider);
  bioToken = new ethers.Contract(config.bio.address, ERC20_ABI, provider);

  // Determine token ordering
  const token0 = (await poolContract.token0()).toLowerCase();
  aubraiIsToken0 = token0 === config.aubrai.address.toLowerCase();
}

/**
 * Compute price from sqrtPriceX96.
 * sqrtPriceX96 = sqrt(token1/token0) * 2^96
 * price (token1 per token0) = (sqrtPriceX96 / 2^96)^2
 *
 * Returns bioPerAubrai (the spot price we display).
 */
function priceFromSqrtX96(sqrtPriceX96Raw) {
  const sqrtPriceX96 = BigInt(sqrtPriceX96Raw);
  const SCALE = 10n ** 18n;
  const Q192 = 2n ** 192n;
  const token1PerToken0 = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / Q192;
  const price = Number(token1PerToken0) / 1e18;

  if (aubraiIsToken0) {
    // token1PerToken0 = BIO per AUBRAI (what we want)
    return price;
  } else {
    // token1PerToken0 = AUBRAI per BIO, invert
    return price === 0 ? 0 : 1 / price;
  }
}

/**
 * Fetch current pool state from on-chain.
 */
async function getPoolState() {
  if (!poolContract) await init();

  const [slot0, liquidity, aubraiBalRaw, bioBalRaw] = await Promise.all([
    poolContract.slot0(),
    poolContract.liquidity(),
    aubraiToken.balanceOf(config.poolAddress),
    bioToken.balanceOf(config.poolAddress),
  ]);

  const sqrtPriceX96 = slot0[0];
  const tick = Number(slot0[1]);

  const spotPrice = priceFromSqrtX96(sqrtPriceX96); // BIO per AUBRAI
  const aubraiPerBio = spotPrice === 0 ? 0 : 1 / spotPrice;

  const aubraiReserve = Number(ethers.formatUnits(aubraiBalRaw, 18));
  const bioReserve = Number(ethers.formatUnits(bioBalRaw, 18));

  return {
    aubraiReserve,
    bioReserve,
    spotPrice,       // BIO per AUBRAI
    aubraiPerBio,    // AUBRAI per BIO
    liquidity,       // raw uint128
    tick,
    sqrtPriceX96,
    timestamp: Date.now(),
  };
}

/**
 * Fetch price from DexScreener API for cross-reference.
 * Returns the price ratio (BIO per AUBRAI) or null on failure.
 */
async function getDexScreenerPrice() {
  try {
    const res = await fetch(config.dexscreenerApiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    return parseFloat(pair.priceNative);
  } catch {
    return null;
  }
}

// Track last known price for slippage calculation on swap events
let lastKnownPrice = null;
let lastCheckedBlock = null;

function setLastKnownPrice(price) {
  lastKnownPrice = price;
}

/**
 * Parse a raw Swap event log into a structured swap object.
 */
function parseSwapEvent(log) {
  const event = poolContract.interface.parseLog({ topics: log.topics, data: log.data });
  const { sender, recipient, amount0, amount1, sqrtPriceX96, tick } = event.args;

  const newPrice = priceFromSqrtX96(sqrtPriceX96); // BIO per AUBRAI
  const prePrice = lastKnownPrice;

  const amt0 = Number(ethers.formatUnits(amount0 < 0n ? -amount0 : amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1 < 0n ? -amount1 : amount1, 18));

  let aubraiAmount, bioAmount, direction;
  if (aubraiIsToken0) {
    aubraiAmount = amt0;
    bioAmount = amt1;
    direction = amount0 < 0n ? 'BIO → AUBRAI' : 'AUBRAI → BIO';
  } else {
    aubraiAmount = amt1;
    bioAmount = amt0;
    direction = amount1 < 0n ? 'BIO → AUBRAI' : 'AUBRAI → BIO';
  }

  let slippage = 0;
  if (prePrice && prePrice > 0) {
    slippage = Math.abs((newPrice - prePrice) / prePrice) * 100;
  }

  lastKnownPrice = newPrice;

  return {
    sender,
    recipient,
    aubraiAmount,
    bioAmount,
    direction,
    prePrice,
    newPrice,
    slippage: Math.round(slippage * 100) / 100,
    tick: Number(tick),
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
  };
}

/**
 * Poll for new Swap events since lastCheckedBlock.
 * Chunks requests to max 10 blocks to stay within Alchemy free tier limits.
 * Returns an array of parsed swap objects.
 */
const MAX_BLOCK_RANGE = 10;

async function pollSwapEvents() {
  if (!poolContract) await init();

  const currentBlock = await provider.getBlockNumber();

  if (lastCheckedBlock === null) {
    // First run — start from current block (don't replay history)
    lastCheckedBlock = currentBlock;
    return [];
  }

  if (currentBlock <= lastCheckedBlock) return [];

  const swapFilter = poolContract.filters.Swap();
  const allLogs = [];
  let from = lastCheckedBlock + 1;

  while (from <= currentBlock) {
    const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
    try {
      const logs = await provider.getLogs({
        ...swapFilter,
        address: config.poolAddress,
        fromBlock: from,
        toBlock: to,
      });
      allLogs.push(...logs);
    } catch (err) {
      console.error(`[swaps] getLogs failed for blocks ${from}-${to}: ${err.message}`);
    }
    from = to + 1;
  }

  lastCheckedBlock = currentBlock;

  return allLogs.map(parseSwapEvent);
}

module.exports = { init, getPoolState, priceFromSqrtX96, getDexScreenerPrice, setLastKnownPrice, pollSwapEvents };
