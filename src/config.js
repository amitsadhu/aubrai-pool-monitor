require('dotenv').config();

const config = {
  // RPC
  rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramThreadId: process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined,

  // Pool — Aerodrome SlipStream (concentrated liquidity)
  poolAddress: '0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067',

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
  minReserveAubrai: 100,          // minimum AUBRAI reserve before alert
  minReserveBio: 1000,            // minimum BIO reserve before alert
  minLiquidity: 1000n,            // minimum raw pool liquidity before alert
  dexscreenerDeviation: 30,       // % deviation from DexScreener triggers alert
  swapSlippageThreshold: 10,      // % slippage on a real swap triggers alert
  alertCooldownMs: 5 * 60 * 1000, // 5 minutes between duplicate alerts
  pollIntervalMs: 30_000,         // 30 seconds
  priceHistorySize: 10,           // rolling window of price readings

  // Spot price sanity bounds (BIO per AUBRAI — expect ~50-70)
  minSanePrice: 1,
  maxSanePrice: 10_000,

  // Links
  aerodromePoolUrl: 'https://aerodrome.finance/deposit?token0=0x9d56c29e820Dd13b0580B185d0e0Dc301d27581d&token1=0x226A2FA2556C48245E57cd1cbA4C6c9e67077DD2&type=-1',
  basescanPoolUrl: 'https://basescan.org/address/0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067',
  dexscreenerPoolUrl: 'https://dexscreener.com/base/0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067',
  dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/base/0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067',
};

module.exports = config;
