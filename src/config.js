require('dotenv').config();

const config = {
  // RPC
  rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',

  // Slack
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,

  // Pool
  poolAddress: '0x49970c044424e71d7f528ea60cf6329b4cf40786',

  // Tokens
  aubrai: {
    address: '0x9d56c29e820Dd13b0580B185d0e0Dc301d27581d',
    decimals: 18,
    symbol: 'AUBRAI',
  },
  bio: {
    address: '0x226A2FA2556C48245E57cd1cbA4C6c9e67077DD2',
    decimals: 18,
    symbol: 'BIO',
  },

  // Thresholds
  priceChangeThreshold: 20,       // % change between polls triggers alert
  minReserveThreshold: 100,       // minimum reserve (in token units) before alert
  dexscreenerDeviation: 30,       // % deviation from DexScreener triggers alert
  priceImpactThreshold: 10,          // % slippage that triggers alert
  priceImpactTestAmounts: [100, 1000, 10000], // BIO trade sizes to test
  alertCooldownMs: 5 * 60 * 1000, // 5 minutes between duplicate alerts
  pollIntervalMs: 30_000,         // 30 seconds
  priceHistorySize: 10,           // rolling window of price readings

  // Links
  uniswapPoolUrl: 'https://app.uniswap.org/explore/pools/base/0x49970c044424e71d7f528ea60cf6329b4cf40786',
  basescanPoolUrl: 'https://basescan.org/address/0x49970c044424e71d7f528ea60cf6329b4cf40786',
  dexscreenerPoolUrl: 'https://dexscreener.com/base/0x49970c044424e71d7f528ea60cf6329b4cf40786',
  dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/base/0x49970c044424e71d7f528ea60cf6329b4cf40786',
};

module.exports = config;
