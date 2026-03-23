require('dotenv').config();

const config = {
  // RPC
  rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
  ethereumRpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramThreadId: process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined,
  telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID,  // DM for bot health errors
  telegramStatsThreadId: process.env.TELEGRAM_STATS_THREAD_ID ? Number(process.env.TELEGRAM_STATS_THREAD_ID) : undefined,

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
  vita: {
    address: '0x490a4B510d0Ea9f835D2dF29Eb73b4FcA5071937',
    decimals: 18,
    symbol: 'VITA',
  },
  vitaEthereum: {
    address: '0x81f8f0bb1cb2a06649e51913a151f0e7ef6fa321',
    decimals: 18,
    symbol: 'VITA',
  },

  // VITA/BIO V2 CPMM pools on Aerodrome
  vitaPools: [
    {
      address: '0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd',
      dexscreenerUrl: 'https://dexscreener.com/base/0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd',
      dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/base/0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd',
    },
    {
      address: '0xa81b95635682295cbd25129199420ae195dcef89',
      dexscreenerUrl: 'https://dexscreener.com/base/0xa81b95635682295cbd25129199420ae195dcef89',
      dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/base/0xa81b95635682295cbd25129199420ae195dcef89',
    },
  ],

  // Ethereum VITA pools (Uniswap v3)
  ethereumVitaPools: [
    {
      address: '0x2DC8FbaFc10da100F2f12807b93CBb3E5Ff7e6b0',
      name: 'VITA/BIO',
      dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/ethereum/0x2DC8FbaFc10da100F2f12807b93CBb3E5Ff7e6b0',
    },
    {
      address: '0xa28b1854a654e35e94d51eA2F4F34208D9BA79A2',
      name: 'VITARNA/VITA #1',
      dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/ethereum/0xa28b1854a654e35e94d51eA2F4F34208D9BA79A2',
    },
    {
      address: '0x6aeB5A2974902717ee01d33B6F999eDBc4Ab4C7a',
      name: 'VITARNA/VITA #2',
      dexscreenerApiUrl: 'https://api.dexscreener.com/latest/dex/pairs/ethereum/0x6aeB5A2974902717ee01d33B6F999eDBc4Ab4C7a',
    },
  ],

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
