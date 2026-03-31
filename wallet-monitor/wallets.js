const { ethers } = require('ethers');
const config = require('./config');

let provider;
let usdcContract;

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

function initWallets() {
  provider = new ethers.JsonRpcProvider(config.rpcUrl, 8453, { staticNetwork: true });
  usdcContract = new ethers.Contract(config.usdc.address, ERC20_BALANCE_ABI, provider);
  console.log(`[wallets] Provider connected to ${config.rpcUrl.replace(/\/[^/]*$/, '/***')}`);
  console.log(`[wallets] USDC contract: ${config.usdc.address}`);
  console.log(`[wallets] Monitoring ${config.wallets.length} wallet(s)`);
}

async function checkWalletBalances() {
  const results = [];
  for (const wallet of config.wallets) {
    try {
      const raw = await usdcContract.balanceOf(wallet.address);
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
