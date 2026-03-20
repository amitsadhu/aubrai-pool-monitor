# AUBRAI/BIO + VITA/BIO Pool Health Monitor

## What This Is
Bot monitoring Aerodrome pools on Base chain:
- **AUBRAI/BIO** SlipStream CL pool — health checks + alerts
- **VITA/BIO** two V2 CPMM pools — swap/LP event tracking

Polls on-chain state every 30s, monitors real swap + mint/burn events, sends Telegram alerts when thresholds are breached. Daily status report at 9:00 CET. Daily swap/LP stats report to a separate "Pool Stats" topic.

## Commands
- `npm start` — run locally
- `railway up --detach` — deploy to Railway (no GitHub integration)
- `railway logs -n 50` — check deployment logs

## Key Addresses (Base chain)
- AUBRAI/BIO CL Pool: `0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067` (Aerodrome SlipStream)
- VITA/BIO V2 Pool 1: `0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd` (Aerodrome V2 CPMM)
- VITA/BIO V2 Pool 2: `0xa81b95635682295cbd25129199420ae195dcef89` (Aerodrome V2 CPMM)
- AUBRAI: `0x9d56c29e820Dd13b0580B185d0e0Dc301d27581d` (18 decimals)
- BIO: `0x226A2FA2556C48245E57cd1cbA4C6c9e67077DD2` (18 decimals)
- VITA: `0x490a4B510d0Ea9f835D2dF29Eb73b4FcA5071937` (18 decimals)

## Environment Variables (set on Railway, not in code)
- `RPC_URL` — Alchemy Base endpoint (free tier, 10-block getLogs limit)
- `TELEGRAM_BOT_TOKEN` — @AubraiPoolMonitorBot
- `TELEGRAM_CHAT_ID` — VitaSwarm HQ supergroup
- `TELEGRAM_THREAD_ID` — "AUBRAI Pool Monitor" topic (health alerts + daily status)
- `TELEGRAM_ADMIN_CHAT_ID` — Amit's personal DM for bot errors
- `TELEGRAM_STATS_THREAD_ID` — "Pool Stats" topic (daily swap/LP stats)

## Architecture
```
src/
├── index.js    — Entry point, 30s poll loop, daily status + stats scheduler
├── pool.js     — On-chain reads (CL + V2), event polling (Swap/Mint/Burn), DexScreener
├── stats.js    — In-memory stats accumulator, snapshotAndReset() at 9:00 CET
├── checks.js   — 6 health checks (sanity, stability, reserves, liquidity, dexscreener, swap slippage)
├── alerts.js   — Telegram Bot API (pool alerts, swap alerts, admin DM, daily status, daily stats)
└── config.js   — All thresholds, addresses, env vars
```

## Health Checks & Thresholds (configurable in config.js)
- Price sanity: 1–10,000 BIO per AUBRAI
- Price stability: <20% change between polls
- Reserves: AUBRAI >100, BIO >1,000
- Pool liquidity: >1,000
- DexScreener deviation: <30%
- Swap slippage: <10% per real swap

## Daily Stats
In-memory accumulation of swap/LP events across all pools. Snapshot + reset at 9:00 CET daily. Reports nominal token amounts + USD values (via DexScreener). Data lost on restart (acceptable — Railway keeps process running).

## Important Constraints
- Alchemy free tier limits `eth_getLogs` to 10-block range — all event polling chunks requests
- Etherscan API free tier does NOT support Base chain (paid only)
- Public Base RPC doesn't support event filters — must use Alchemy
- Telegram MarkdownV2 requires escaping: `_*[]()~>#+\-=|{}.!`
- CL pool uses sqrtPriceX96 math: `price = (sqrtPriceX96 / 2^96)^2`, token0/token1 ordering auto-detected
- V2 pools use getReserves() for price, token ordering auto-detected at init

## Deployment
- Railway project: `aubrai-pool-monitor` in VitaDAO workspace
- Deploy via `railway up` (not GitHub integration — Railway can't see collaborator repos)
- GitHub: `amitsadhu/aubrai-pool-monitor` (public)
