const { ethers } = require('ethers');
const config = require('./config');
const { loadCursorsFromDisk, registerCursorGetter } = require('./stats');

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

// Per-chain VITA runtime state: { provider, pools: [{contract, vitaIsToken0, address, name}], cursors: {} }
const vitaChainState = {};

async function initVitaChain(chainConfig) {
  const chainProvider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
  const vitaAddress = chainConfig.token.address.toLowerCase();
  // Set state early so cursors can be restored even on partial init failure
  vitaChainState[chainConfig.id] = { provider: chainProvider, pools: [], cursors: {} };
  const state = vitaChainState[chainConfig.id];

  for (const poolCfg of chainConfig.pools) {
    try {
      const contract = new ethers.Contract(poolCfg.address, CL_POOL_ABI, chainProvider);
      const token0 = (await contract.token0()).toLowerCase();
      const token1 = (await contract.token1()).toLowerCase();
      if (token0 !== vitaAddress && token1 !== vitaAddress) {
        console.error(`[init] Skipping ${chainConfig.label} pool ${poolCfg.address} (${poolCfg.name}): VITA not found in pool tokens`);
        continue;
      }
      const vitaIsToken0 = token0 === vitaAddress;
      state.pools.push({ contract, vitaIsToken0, address: poolCfg.address, name: poolCfg.name });
      console.log(`[init] ${chainConfig.label} ${poolCfg.name} pool ${poolCfg.address}: VITA is token${vitaIsToken0 ? '0' : '1'}`);
    } catch (err) {
      console.warn(`[init] Failed to init ${chainConfig.label} pool ${poolCfg.address} (${poolCfg.name}):`, err.message);
    }
  }
}

async function init() {
  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  poolContract = new ethers.Contract(config.poolAddress, CL_POOL_ABI, provider);

  aubraiToken = new ethers.Contract(config.aubrai.address, ERC20_ABI, provider);
  bioToken = new ethers.Contract(config.bio.address, ERC20_ABI, provider);

  // Determine token ordering for AUBRAI CL pool
  const token0 = (await poolContract.token0()).toLowerCase();
  aubraiIsToken0 = token0 === config.aubrai.address.toLowerCase();

  // Initialize all VITA chains
  for (const chain of config.vitaChains) {
    try {
      await initVitaChain(chain);
    } catch (err) {
      console.warn(`[init] Failed to initialize ${chain.label} pools:`, err.message);
    }
  }

  // Load persisted block cursors (so we don't skip events after restart)
  const savedCursors = loadCursorsFromDisk();
  if (savedCursors) {
    if (savedCursors.lastCheckedBlock) lastCheckedBlock = savedCursors.lastCheckedBlock;
    if (savedCursors.lastCLMintBurnBlock) lastCLMintBurnBlock = savedCursors.lastCLMintBurnBlock;
    for (const chain of config.vitaChains) {
      if (savedCursors[chain.cursorKey]) {
        Object.assign(vitaChainState[chain.id].cursors, savedCursors[chain.cursorKey]);
      }
    }
    console.log(`[init] Restored block cursors — AUBRAI swap: ${lastCheckedBlock}, AUBRAI LP: ${lastCLMintBurnBlock}`);
  }

  // Register cursor getter so stats.js saves cursors atomically with stats
  registerCursorGetter(getCursors);
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
 * Verifies the returned pair matches our pool address.
 */
async function getDexScreenerData() {
  try {
    const res = await fetch(config.dexscreenerApiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    // Verify pair matches our pool
    if (pair.pairAddress && pair.pairAddress.toLowerCase() !== config.poolAddress.toLowerCase()) {
      console.warn(`[dex] DexScreener pair mismatch: expected ${config.poolAddress}, got ${pair.pairAddress}`);
      return null;
    }
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
 * Fetch VITA USD price from DexScreener for a given chain.
 * Checks base/quote ordering to ensure we return VITA's price, not counter token's.
 */
async function getVitaDexScreenerData(chainConfig) {
  if (!chainConfig.pools?.length) return null;
  try {
    const res = await fetch(chainConfig.pools[0].dexscreenerApiUrl);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    // Verify pair matches our pool
    if (pair.pairAddress && pair.pairAddress.toLowerCase() !== chainConfig.pools[0].address.toLowerCase()) {
      console.warn(`[dex] DexScreener VITA pair mismatch (${chainConfig.label}): expected ${chainConfig.pools[0].address}, got ${pair.pairAddress}`);
      return null;
    }
    const vitaAddr = chainConfig.token.address.toLowerCase();
    const basePriceUsd = parseFloat(pair.priceUsd);
    if (!basePriceUsd) return null;
    // If VITA is the base token, priceUsd is VITA's price
    if (pair.baseToken?.address?.toLowerCase() === vitaAddr) {
      return {
        priceNative: parseFloat(pair.priceNative),
        priceUsd: basePriceUsd,
      };
    }
    // VITA is the quote token — compute: VITA_USD = base_USD / priceNative
    const priceNative = parseFloat(pair.priceNative);
    if (!priceNative) return null;
    return {
      priceNative: 1 / priceNative,
      priceUsd: basePriceUsd / priceNative,
    };
  } catch {
    return null;
  }
}

// --- Block tracking ---
let lastKnownPrice = null;
let lastCheckedBlock = null;        // AUBRAI swap events
let lastCLMintBurnBlock = null;     // AUBRAI mint/burn events

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

  let vitaAmount, counterAmount, direction;
  if (pool.vitaIsToken0) {
    vitaAmount = amt0;
    counterAmount = amt1;
    // negative amount0 = pool sends VITA out = someone bought VITA
    direction = amount0 < 0n ? 'bought' : 'sold';
  } else {
    vitaAmount = amt1;
    counterAmount = amt0;
    direction = amount1 < 0n ? 'bought' : 'sold';
  }

  return {
    vitaAmount, counterAmount, direction,
    txHash: log.transactionHash, blockNumber: log.blockNumber,
    poolAddress: pool.address,
  };
}

function parseVitaMintEvent(log, pool) {
  const event = pool.contract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;
  const amt0 = Number(ethers.formatUnits(amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1, 18));
  const [vitaAmount, counterAmount] = pool.vitaIsToken0 ? [amt0, amt1] : [amt1, amt0];
  return { vitaAmount, counterAmount, txHash: log.transactionHash, blockNumber: log.blockNumber, poolAddress: pool.address };
}

function parseVitaBurnEvent(log, pool) {
  const event = pool.contract.interface.parseLog({ topics: log.topics, data: log.data });
  const { amount0, amount1 } = event.args;
  const amt0 = Number(ethers.formatUnits(amount0, 18));
  const amt1 = Number(ethers.formatUnits(amount1, 18));
  const [vitaAmount, counterAmount] = pool.vitaIsToken0 ? [amt0, amt1] : [amt1, amt0];
  return { vitaAmount, counterAmount, txHash: log.transactionHash, blockNumber: log.blockNumber, poolAddress: pool.address };
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
  const allSwaps = [];
  let from = lastCheckedBlock + 1;
  let lastSuccessBlock = lastCheckedBlock;

  while (from <= currentBlock) {
    const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: config.poolAddress,
        topics: [swapTopicHash],
        fromBlock: from,
        toBlock: to,
      });
      const parsed = logs.map(parseSwapEvent);
      allSwaps.push(...parsed);
      lastSuccessBlock = to;
    } catch (err) {
      console.error(`[swaps] getLogs failed for blocks ${from}-${to}: ${err.message}`);
      break;
    }
    from = to + 1;
  }

  lastCheckedBlock = lastSuccessBlock;
  return allSwaps;
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

  const allMints = [];
  const allBurns = [];
  let from = lastCLMintBurnBlock + 1;
  let lastSuccessBlock = lastCLMintBurnBlock;

  while (from <= currentBlock) {
    const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
    try {
      const logs = await provider.getLogs({
        address: config.poolAddress,
        topics: [[mintTopic, burnTopic]],
        fromBlock: from,
        toBlock: to,
      });
      const chunkMints = [];
      const chunkBurns = [];
      for (const log of logs) {
        if (log.topics[0] === mintTopic) chunkMints.push(parseCLMintEvent(log));
        else chunkBurns.push(parseCLBurnEvent(log));
      }
      allMints.push(...chunkMints);
      allBurns.push(...chunkBurns);
      lastSuccessBlock = to;
    } catch (err) {
      console.error(`[cl-lp] getLogs failed for blocks ${from}-${to}: ${err.message}`);
      break;
    }
    from = to + 1;
  }

  lastCLMintBurnBlock = lastSuccessBlock;
  return { mints: allMints, burns: allBurns };
}

/**
 * Poll for VITA Swap/Mint/Burn events across all pools on a given chain.
 */
async function pollVitaChainEvents(chainId) {
  const state = vitaChainState[chainId];
  if (!state || state.pools.length === 0) return { swaps: [], mints: [], burns: [] };

  const currentBlock = await state.provider.getBlockNumber();

  // All pools use the same CL ABI, so topic hashes are the same
  const swapTopic = state.pools[0].contract.interface.getEvent('Swap').topicHash;
  const mintTopic = state.pools[0].contract.interface.getEvent('Mint').topicHash;
  const burnTopic = state.pools[0].contract.interface.getEvent('Burn').topicHash;

  const allSwaps = [];
  const allMints = [];
  const allBurns = [];

  for (const pool of state.pools) {
    // Per-pool cursor: first call initializes, subsequent calls poll from last success
    if (!(pool.address in state.cursors)) {
      state.cursors[pool.address] = currentBlock;
      continue;
    }

    const lastBlock = state.cursors[pool.address];
    if (currentBlock <= lastBlock) continue;

    let from = lastBlock + 1;
    let lastSuccessBlock = lastBlock;

    while (from <= currentBlock) {
      const to = Math.min(from + MAX_BLOCK_RANGE - 1, currentBlock);
      try {
        const logs = await state.provider.getLogs({
          address: pool.address,
          topics: [[swapTopic, mintTopic, burnTopic]],
          fromBlock: from,
          toBlock: to,
        });
        const chunkSwaps = [], chunkMints = [], chunkBurns = [];
        for (const log of logs) {
          if (log.topics[0] === swapTopic) chunkSwaps.push(parseVitaSwapEvent(log, pool));
          else if (log.topics[0] === mintTopic) chunkMints.push(parseVitaMintEvent(log, pool));
          else chunkBurns.push(parseVitaBurnEvent(log, pool));
        }
        allSwaps.push(...chunkSwaps);
        allMints.push(...chunkMints);
        allBurns.push(...chunkBurns);
        lastSuccessBlock = to;
      } catch (err) {
        console.error(`[${chainId}-vita] getLogs failed for ${pool.address} blocks ${from}-${to}: ${err.message}`);
        break;
      }
      from = to + 1;
    }

    state.cursors[pool.address] = lastSuccessBlock;
  }
  return { swaps: allSwaps, mints: allMints, burns: allBurns };
}

function getCursors() {
  const cursors = { lastCheckedBlock, lastCLMintBurnBlock };
  for (const chain of config.vitaChains) {
    cursors[chain.cursorKey] = { ...vitaChainState[chain.id]?.cursors };
  }
  return cursors;
}

module.exports = {
  init, getPoolState, priceFromSqrtX96,
  getDexScreenerPrice, getDexScreenerData, getVitaDexScreenerData,
  setLastKnownPrice, pollSwapEvents,
  pollCLMintBurnEvents, pollVitaChainEvents,
  getCursors,
};
