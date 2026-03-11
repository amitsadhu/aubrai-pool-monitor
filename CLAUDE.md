# AUBRAI/BIO Pool Health Monitor

## What This Is
Bot monitoring the AUBRAI/BIO Aerodrome SlipStream (concentrated liquidity) pool on Base chain. Polls on-chain state every 30s, monitors real swap events, sends Telegram alerts when thresholds are breached. Daily status report at 9:00 CET.

## Commands
- `npm start` — run locally
- `railway up --detach` — deploy to Railway (no GitHub integration)
- `railway logs -n 50` — check deployment logs

## Key Addresses (Base chain)
- Pool: `0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067` (Aerodrome SlipStream)
- AUBRAI: `0x9d56c29e820Dd13b0580B185d0e0Dc301d27581d` (18 decimals)
- BIO: `0x226A2FA2556C48245E57cd1cbA4C6c9e67077DD2` (18 decimals)

## Environment Variables (set on Railway, not in code)
- `RPC_URL` — Alchemy Base endpoint (free tier, 10-block getLogs limit)
- `TELEGRAM_BOT_TOKEN` — @AubraiPoolMonitorBot
- `TELEGRAM_CHAT_ID` — VitaSwarm HQ supergroup
- `TELEGRAM_THREAD_ID` — "AUBRAI Pool Monitor" topic
- `TELEGRAM_ADMIN_CHAT_ID` — Amit's personal DM for bot errors

## Architecture
```
src/
├── index.js    — Entry point, 30s poll loop, daily status scheduler
├── pool.js     — On-chain reads (slot0, liquidity, balanceOf), sqrtPriceX96 math, swap event polling
├── checks.js   — 6 health checks (sanity, stability, reserves, liquidity, dexscreener, swap slippage)
├── alerts.js   — Telegram Bot API (pool alerts, swap alerts, admin DM, daily status)
└── config.js   — All thresholds, addresses, env vars
```

## Health Checks & Thresholds (configurable in config.js)
- Price sanity: 1–10,000 BIO per AUBRAI
- Price stability: <20% change between polls
- Reserves: AUBRAI >100, BIO >1,000
- Pool liquidity: >1,000
- DexScreener deviation: <30%
- Swap slippage: <10% per real swap

## Important Constraints
- Alchemy free tier limits `eth_getLogs` to 10-block range — swap polling chunks requests
- Etherscan API free tier does NOT support Base chain (paid only)
- Public Base RPC doesn't support event filters — must use Alchemy
- Telegram MarkdownV2 requires escaping: `_*[]()~>#+\-=|{}.!`
- Pool uses sqrtPriceX96 math: `price = (sqrtPriceX96 / 2^96)^2`, token0/token1 ordering auto-detected

## Deployment
- Railway project: `aubrai-pool-monitor` in VitaDAO workspace
- Deploy via `railway up` (not GitHub integration — Railway can't see collaborator repos)
- GitHub: `amitsadhu/aubrai-pool-monitor` (public)
