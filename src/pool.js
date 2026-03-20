const { ethers } = require('ethers');
const config = require('./config');

const CL_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

let provider;
let poolContract;      // AUBRAI/BIO CL pool
let aubraiToken;
let bioToken;
let aubraiIsToken0;

// VITA CL pools
const vitaPools = []; // { contract, vitaIsToken0, address }

async function init() {
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  poolContract = new ethers.Contract(config.poolAddress, CL_POOL_ABI, provider);

  aubraiToken = new ethers.Contract(config.aubrai.address, ERC20_ABI, provider);
  bioToken = new ethers.Contract(config.bio.address, ERC20_ABI, provider);

  // Determine token ordering for AUBRAI CL pool
  const token0 = (await poolContract.token0()).toLowerCase();
  aubraiIsToken0 = token0 === config.aubrai.address.toLowerCase();

  // Initialize VITA CL pool contracts
  for (const poolCfg of config.vitaPools) {
    const contract = new ethers.Contract(poolCfg.address, CL_POOL_ABI, provider);
    const vitaToken0 = (await contract.token0()).toLowerCase();
    const vitaIsToken0 = vitaToken0 === config.vita.address.toLowerCase();
    vitaPools.push({ contract, vitaIsToken0, address: poolCfg.address });
    console.log(`[init] VITA/BIO CL pool ${poolCfg.address}: VITA is token${vitaIsToken0 ? '0' : '1'}`);
  }
}

/**
 * Compute price from sqrtPriceX96.
 * Returns bioPerAubrai (the spot price we display).
 */
function priceFromSqrtX96(sqrtPriceX96Raw) {
  const sqrtPriceX96 = BigInt(sqrtPriceX96Raw);
  const SCALE = 10n ** 18n;
  const Q192 = 2n ** 192n;
  const token1PerToken0 = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / Q192;
  const price = Number(token1PerToken0) / 1e18;

  if (aubraiIsToken0) {
    return price;
  } else {
    return price === 0 ? 0 : 1 / price;
  }
}

/**
 * Fetch current AUBRAI pool state from on-chain.
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

  const spotPrice = priceFromSqrtX96(sqrtPriceX96);
  const aubraiPerBio = spotPrice === 0 ? 0 : 1 / spotPrice;

  const aubraiReserve = Number(ethers.formatUnits(aubraiBalRaw, 18));
  const bioReserve = Number(ethers.formatUnits(bioBalRaw, 18));

  return {
    aubraiReserve,
    bioReserve,
    spotPrice,
    aubraiPerBio,
    liquidity,
    tick,
    sqrtPriceX96,
    timestamp: Date.now(),
  };
}

/**
 * Fetch price from DexScreener API for AUBRAI.
 */
async function getDexScreenerData() {
  try {
    const res = await fetch(config.dexscreenerApiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    return {
      priceNative: parseFloat(pair.priceNative),
      priceUsd: parseFloat(pair.priceUsd) || null,
    };
  } catch {
    return null;
  }
}

async function getDexScreenerPrice() {
  const data = await getDexScreenerData();
  return data ? data.priceNative : null;
}

/**
 * Fetch VITA USD price from DexScreener.
 */
async function getVitaDexScreenerData() {
  try {
    const res = await fetch(config.vitaPools[0].dexscreenerApiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    return {
      priceNative: parseFloat(pair.priceNative),
      priceUsd: parseFloat(pair.priceUsd) || null,
    };
  } catch {
    return null;
  }
}

// --- Block tracking ---
let lastKnownPrice = null;
let lastCheckedBlock = null;        // AUBRAI swap events
let lastCLMintBurnBlock = null;     // AUBRAI mint/burn events
let lastVitaCheckedBlock = null;    // VITA swap/mint/burn events

function setLastKnownPrice(price) {
  lastKnownPrice = price;
}

const MAX_BLOCK_RANGE = 10;

// --- AUBRAI CL event parsers ---

function parseSwapEvent(log) {
  const event = poolContract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1, sqrtPriceX96, tick } = event.args;

  const newPrice = priceFromSqrtX96(sqrtPriceX96);
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
    aubraiAmount, bioAmount, direction, prePrice, newPrice,
    slippage: Math.round(slippage * 100) / 100,
    tick: Number(tick),
    txHash: log.transactionHash, blockNumber: log.blockNumber,
  };
}

function parseCLMintEvent(log) {
  const event = poolContract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;
  const amt0 = Number(ethers.formatUnits(amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1, 18));
  const [aubraiAmount, bioAmount] = aubraiIsToken0 ? [amt0, amt1] : [amt1, amt0];
  return { aubraiAmount, bioAmount, txHash: log.transactionHash, blockNumber: log.blockNumber };
}

function parseCLBurnEvent(log) {
  const event = poolContract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;
  const amt0 = Number(ethers.formatUnits(amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1, 18));
  const [aubraiAmount, bioAmount] = aubraiIsToken0 ? [amt0, amt1] : [amt1, amt0];
  return { aubraiAmount, bioAmount, txHash: log.transactionHash, blockNumber: log.blockNumber };
}

// --- VITA CL event parsers ---

function parseVitaSwapEvent(log, pool) {
  const event = pool.contract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;

  const amt0 = Number(ethers.formatUnits(amount0 < 0n ? -amount0 : amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1 < 0n ? -amount1 : amount1, 18));

  let vitaAmount, bioAmount, direction;
  if (pool.vitaIsToken0) {
    vitaAmount = amt0;
    bioAmount = amt1;
    // negative amount0 = pool sends VITA out = someone bought VITA
    direction = amount0 < 0n ? 'BIO → VITA' : 'VITA → BIO';
  } else {
    vitaAmount = amt1;
    bioAmount = amt0;
    direction = amount1 < 0n ? 'BIO → VITA' : 'VITA → BIO';
  }

  return {
    vitaAmount, bioAmount, direction,
    txHash: log.transactionHash, blockNumber: log.blockNumber,
    poolAddress: pool.address,
  };
}

function parseVitaMintEvent(log, pool) {
  const event = pool.contract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;
  const amt0 = Number(ethers.formatUnits(amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1, 18));
  const [vitaAmount, bioAmount] = pool.vitaIsToken0 ? [amt0, amt1] : [amt1, amt0];
  return { vitaAmount, bioAmount, txHash: log.transactionHash, blockNumber: log.blockNumber, poolAddress: pool.address };
}

function parseVitaBurnEvent(log, pool) {
  const event = pool.contract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;
  const amt0 = Number(ethers.formatUnits(amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1, 18));
  const [vitaAmount, bioAmount] = pool.vitaIsToken0 ? [amt0, amt1] : [amt1, amt0];
  return { vitaAmount, bioAmount, txHash: log.transactionHash, blockNumber: log.blockNumber, poolAddress: pool.address };
}

// --- Polling functions ---

async function pollSwapEvents() {
  if (!poolContract) await init();

  const currentBlock = await provider.getBlockNumber();

  if (lastCheckedBlock === null) {
    lastCheckedBlock = currentBlock;
    return [];
  }
  if (currentBlock <= lastCheckedBlock) return [];

  const swapTopicHash = poolContract.interface.getEvent('Swap').topicHash;
  const allLogs = [];
  let from = lastCheckedBlock + 1;

  while (from <= currentBlock) {
    const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: config.poolAddress,
        topics: [swapTopicHash],
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

async function pollCLMintBurnEvents() {
  if (!poolContract) await init();

  const currentBlock = await provider.getBlockNumber();

  if (lastCLMintBurnBlock === null) {
    lastCLMintBurnBlock = currentBlock;
    return { mints: [], burns: [] };
  }
  if (currentBlock <= lastCLMintBurnBlock) return { mints: [], burns: [] };

  const mintTopic = poolContract.interface.getEvent('Mint').topicHash;
  const burnTopic = poolContract.interface.getEvent('Burn').topicHash;

  const allMintLogs = [];
  const allBurnLogs = [];
  let from = lastCLMintBurnBlock + 1;

  while (from <= currentBlock) {
    const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: config.poolAddress,
        topics: [[mintTopic, burnTopic]],
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        if (log.topics[0] === mintTopic) allMintLogs.push(log);
        else allBurnLogs.push(log);
      }
    } catch (err) {
      console.error(`[cl-lp] getLogs failed for blocks ${from}-${to}: ${err.message}`);
    }
    from = to + 1;
  }

  lastCLMintBurnBlock = currentBlock;
  return {
    mints: allMintLogs.map(parseCLMintEvent),
    burns: allBurnLogs.map(parseCLBurnEvent),
  };
}

/**
 * Poll for VITA CL Swap/Mint/Burn events across all VITA pools.
 */
async function pollVitaEvents() {
  if (vitaPools.length === 0) return { swaps: [], mints: [], burns: [] };

  const currentBlock = await provider.getBlockNumber();

  if (lastVitaCheckedBlock === null) {
    lastVitaCheckedBlock = currentBlock;
    return { swaps: [], mints: [], burns: [] };
  }
  if (currentBlock <= lastVitaCheckedBlock) return { swaps: [], mints: [], burns: [] };

  // All VITA pools use the same CL ABI, so topic hashes are the same
  const swapTopic = vitaPools[0].contract.interface.getEvent('Swap').topicHash;
  const mintTopic = vitaPools[0].contract.interface.getEvent('Mint').topicHash;
  const burnTopic = vitaPools[0].contract.interface.getEvent('Burn').topicHash;

  const allSwaps = [];
  const allMints = [];
  const allBurns = [];

  for (const pool of vitaPools) {
    let from = lastVitaCheckedBlock + 1;

    while (from <= currentBlock) {
      const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
      try {
        const logs = await provider.getLogs({
          address: pool.address,
          topics: [[swapTopic, mintTopic, burnTopic]],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          if (log.topics[0] === swapTopic) allSwaps.push(parseVitaSwapEvent(log, pool));
          else if (log.topics[0] === mintTopic) allMints.push(parseVitaMintEvent(log, pool));
          else allBurns.push(parseVitaBurnEvent(log, pool));
        }
      } catch (err) {
        console.error(`[vita] getLogs failed for ${pool.address} blocks ${from}-${to}: ${err.message}`);
      }
      from = to + 1;
    }
  }

  lastVitaCheckedBlock = currentBlock;
  return { swaps: allSwaps, mints: allMints, burns: allBurns };
}

module.exports = {
  init, getPoolState, priceFromSqrtX96,
  getDexScreenerPrice, getDexScreenerData, getVitaDexScreenerData,
  setLastKnownPrice, pollSwapEvents,
  pollCLMintBurnEvents, pollVitaEvents,
};
