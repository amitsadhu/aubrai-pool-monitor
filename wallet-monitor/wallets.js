const { ethers } = require('ethers');
const config = require('./config');

const PRIMARY_REPROBE_MS = 10 * 60 * 1000; // try primary again every 10 minutes

let primaryProvider;
let fallbackProvider;
let activeProvider;
let usingFallback = false;
let failoverAt = null; // timestamp when we switched to fallback

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

// USDC Transfer event signature
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// Per-wallet transfer stats accumulator
let transferStats = {};

// Block cursor for transfer polling
let lastTransferBlock = null;

function isAuthError(err) {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.error?.code || err?.code;
  if (code === 401 || code === 403) return true;
  if (msg.includes('401') || msg.includes('403')) return true;
  if (msg.includes('unauthorized') || msg.includes('forbidden')) return true;
  if (msg.includes('quota')) return true;
  return false;
}

function initWallets() {
  primaryProvider = new ethers.JsonRpcProvider(config.rpcUrl, 8453, { staticNetwork: true });
  activeProvider = primaryProvider;
  if (config.alchemyBaseUrl) {
    fallbackProvider = new ethers.JsonRpcProvider(config.alchemyBaseUrl, 8453, { staticNetwork: true });
    console.log(`[wallets] Primary + fallback RPC configured`);
  } else {
    console.log(`[wallets] Primary RPC only (no fallback)`);
  }
  console.log(`[wallets] Provider connected to ${config.rpcUrl.replace(/\/[^/]*$/, '/***')}`);
  console.log(`[wallets] USDC contract: ${config.usdc.address}`);
  console.log(`[wallets] Monitoring ${config.wallets.length} wallet(s)`);
}

async function fetchBalance(walletAddress) {
  const contract = new ethers.Contract(config.usdc.address, ERC20_BALANCE_ABI, activeProvider);
  return contract.balanceOf(walletAddress);
}

async function fetchBalanceWithFailover(walletAddress) {
  // Periodically reprobe primary to auto-recover when credits renew
  if (usingFallback && failoverAt && Date.now() - failoverAt >= PRIMARY_REPROBE_MS) {
    try {
      const contract = new ethers.Contract(config.usdc.address, ERC20_BALANCE_ABI, primaryProvider);
      const result = await contract.balanceOf(walletAddress);
      console.log(`[wallets] Primary RPC recovered, switching back`);
      activeProvider = primaryProvider;
      usingFallback = false;
      failoverAt = null;
      return result;
    } catch {
      // Primary still down — reset timer and continue with fallback
      failoverAt = Date.now();
    }
  }

  try {
    return await fetchBalance(walletAddress);
  } catch (err) {
    if (isAuthError(err) && fallbackProvider && !usingFallback) {
      console.warn(`[wallets] Primary RPC auth failed, switching to fallback`);
      activeProvider = fallbackProvider;
      usingFallback = true;
      failoverAt = Date.now();
      return await fetchBalance(walletAddress);
    }
    throw err;
  }
}

async function checkWalletBalances() {
  const results = [];
  for (const wallet of config.wallets) {
    try {
      const raw = await fetchBalanceWithFailover(wallet.address);
      const balance = Number(ethers.formatUnits(raw, config.usdc.decimals));
      results.push({
        label: wallet.label,
        address: wallet.address,
        balance,
        belowThreshold: balance < config.alertThreshold,
      });
    } catch (err) {
      console.error(`[wallets] Failed to fetch balance for ${wallet.label} (${wallet.address}):`, err.message);
      results.push({
        label: wallet.label,
        address: wallet.address,
        balance: null,
        belowThreshold: false,
        error: err.message,
      });
    }
  }
  return results;
}

function getBlockRange() {
  return usingFallback ? config.maxBlockRange.alchemy : config.maxBlockRange.ankr;
}

function initTransferStats() {
  const stats = {};
  for (const w of config.wallets) {
    stats[w.address.toLowerCase()] = { outCount: 0, outTotal: 0, inCount: 0, inTotal: 0 };
  }
  return stats;
}

// Initialize stats on load
transferStats = initTransferStats();

function getTransferBlockCursor() {
  return lastTransferBlock;
}

function setTransferBlockCursor(block) {
  lastTransferBlock = block;
}

function getTransferStats() {
  return transferStats;
}

function setTransferStats(stats) {
  // Merge loaded stats, keeping any new wallets that were added to config
  const fresh = initTransferStats();
  for (const addr of Object.keys(fresh)) {
    if (stats[addr]) {
      fresh[addr] = stats[addr];
    }
  }
  transferStats = fresh;
}

// Build padded 32-byte topic values for monitored wallet addresses
function buildAddressTopics() {
  return config.wallets.map((w) => '0x' + w.address.toLowerCase().slice(2).padStart(64, '0'));
}

async function withTransferFailover(fn) {
  // Periodically reprobe primary
  if (usingFallback && failoverAt && Date.now() - failoverAt >= PRIMARY_REPROBE_MS) {
    try {
      const result = await fn(primaryProvider);
      console.log(`[transfers] Primary RPC recovered, switching back`);
      activeProvider = primaryProvider;
      usingFallback = false;
      failoverAt = null;
      return result;
    } catch {
      failoverAt = Date.now();
    }
  }

  try {
    return await fn(activeProvider);
  } catch (err) {
    if (isAuthError(err) && fallbackProvider && !usingFallback) {
      console.warn(`[transfers] Primary RPC auth failed, switching to fallback`);
      activeProvider = fallbackProvider;
      usingFallback = true;
      failoverAt = Date.now();
      return await fn(activeProvider);
    }
    throw err;
  }
}

async function pollTransferEvents() {
  if (!activeProvider) return;

  try {
    const currentBlock = await withTransferFailover((p) => p.getBlockNumber());

    // First poll: initialize cursor to current block (no backfill)
    if (lastTransferBlock === null) {
      lastTransferBlock = currentBlock;
      console.log(`[transfers] Initialized cursor to block ${currentBlock}`);
      return;
    }

    if (currentBlock <= lastTransferBlock) return;

    const addressTopics = buildAddressTopics();
    const monitoredAddresses = new Set(config.wallets.map((w) => w.address.toLowerCase()));
    let from = lastTransferBlock + 1;
    let lastSuccessBlock = lastTransferBlock;

    while (from <= currentBlock) {
      // Recalculate block range each iteration (may change after failover)
      const to = Math.min(from + getBlockRange() - 1, currentBlock);
      try {
        // Two targeted queries: outgoing (from monitored) + incoming (to monitored)
        const [outLogs, inLogs] = await Promise.all([
          withTransferFailover((p) => p.getLogs({
            address: config.usdc.address,
            topics: [TRANSFER_TOPIC, addressTopics],
            fromBlock: from,
            toBlock: to,
          })),
          withTransferFailover((p) => p.getLogs({
            address: config.usdc.address,
            topics: [TRANSFER_TOPIC, null, addressTopics],
            fromBlock: from,
            toBlock: to,
          })),
        ]);

        // Process outgoing transfers
        for (const log of outLogs) {
          const fromAddr = ('0x' + log.topics[1].slice(26)).toLowerCase();
          const value = Number(ethers.formatUnits(BigInt(log.data), config.usdc.decimals));
          if (monitoredAddresses.has(fromAddr)) {
            transferStats[fromAddr].outCount++;
            transferStats[fromAddr].outTotal += value;
          }
        }

        // Process incoming transfers (deduplicate self-transfers counted in outLogs)
        const outTxSet = new Set(outLogs.map((l) => `${l.transactionHash}:${l.index}`));
        for (const log of inLogs) {
          if (outTxSet.has(`${log.transactionHash}:${log.index}`)) continue; // already counted
          const toAddr = ('0x' + log.topics[2].slice(26)).toLowerCase();
          const value = Number(ethers.formatUnits(BigInt(log.data), config.usdc.decimals));
          if (monitoredAddresses.has(toAddr)) {
            transferStats[toAddr].inCount++;
            transferStats[toAddr].inTotal += value;
          }
        }

        // Also count incoming side of outLogs (self-transfer between monitored wallets)
        for (const log of outLogs) {
          const toAddr = ('0x' + log.topics[2].slice(26)).toLowerCase();
          if (monitoredAddresses.has(toAddr)) {
            const value = Number(ethers.formatUnits(BigInt(log.data), config.usdc.decimals));
            transferStats[toAddr].inCount++;
            transferStats[toAddr].inTotal += value;
          }
        }

        if (outLogs.length > 0 || inLogs.length > 0) {
          console.log(`[transfers] Blocks ${from}-${to}: ${outLogs.length} out + ${inLogs.length} in USDC transfer(s)`);
        }

        lastSuccessBlock = to;
      } catch (err) {
        console.error(`[transfers] getLogs failed for blocks ${from}-${to}: ${err.message}`);
        break;
      }
      from = to + 1;
    }

    lastTransferBlock = lastSuccessBlock;
  } catch (err) {
    console.error('[transfers] Poll failed:', err.message);
  }
}

function snapshotAndResetStats() {
  const snapshot = transferStats;
  transferStats = initTransferStats();
  return snapshot;
}

module.exports = {
  initWallets, checkWalletBalances,
  pollTransferEvents, snapshotAndResetStats,
  getTransferBlockCursor, setTransferBlockCursor,
  getTransferStats, setTransferStats,
};
