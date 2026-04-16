const { ethers } = require('ethers');
const config = require('./config');

const PRIMARY_REPROBE_MS = 10 * 60 * 1000; // try primary again every 10 minutes

let primaryProvider;
let fallbackProvider;
let activeProvider;
let failoverAt = null; // timestamp when we switched to fallback

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

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
  if (activeProvider === fallbackProvider && failoverAt && Date.now() - failoverAt >= PRIMARY_REPROBE_MS) {
    try {
      const contract = new ethers.Contract(config.usdc.address, ERC20_BALANCE_ABI, primaryProvider);
      const result = await contract.balanceOf(walletAddress);
      console.log(`[wallets] Primary RPC recovered, switching back`);
      activeProvider = primaryProvider;
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
    if (isAuthError(err) && fallbackProvider && activeProvider === primaryProvider) {
      console.warn(`[wallets] Primary RPC auth failed, switching to fallback`);
      activeProvider = fallbackProvider;
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

module.exports = { initWallets, checkWalletBalances };
