require('dotenv').config();

const config = {
  // RPC (Base)
  rpcUrl: process.env.RPC_URL || 'https://rpc.ankr.com/base',

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID,
  telegramWalletThreadId: process.env.TELEGRAM_WALLET_THREAD_ID ? Number(process.env.TELEGRAM_WALLET_THREAD_ID) : undefined,

  // USDC on Base
  usdc: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },

  // Wallets to monitor
  wallets: [
    { address: '0xfB457EF697F21bf374abf72Cae52f75ab7702064', label: 'Test Wallet' },
  ],

  // Thresholds
  alertThreshold: 1000,              // USDC — alert when balance drops below
  pollIntervalMs: 60_000,            // 60 seconds
  alertCooldownMs: 30 * 60 * 1000,   // 30 minutes between repeated alerts per wallet
};

module.exports = config;
