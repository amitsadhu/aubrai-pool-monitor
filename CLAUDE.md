# AUBRAI/BIO + VITA Pool Health Monitor

## What This Is
Bot monitoring pools on Base and Ethereum:
- **AUBRAI/BIO** SlipStream CL pool (Base) — health checks + alerts
- **VITA pools** across chains via unified `vitaChains` config — swap/LP event tracking

Polls on-chain state every 30s, monitors real swap + mint/burn events, sends Telegram alerts when thresholds are breached. Daily status report at 9:00 CET. Daily swap/LP stats report to a separate "Pool Stats" topic.

## Commands
- `npm start` — run locally
- `railway service link aubrai-pool-monitor && railway up --detach` — deploy pool monitor
- `railway service link wallet-balance-monitor && railway up --detach --path-as-root wallet-monitor` — deploy wallet monitor
- `railway logs -n 50` — check deployment logs (after linking the target service)

## Key Addresses (Base chain)
- AUBRAI/BIO CL Pool: `0x6744257f30D991fF0de9f5Aa2AcD03f8093e7067` (Aerodrome SlipStream)
- VITA/BIO CL Pool 1: `0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd` (Aerodrome CL)
- VITA/BIO CL Pool 2: `0xa81b95635682295cbd25129199420ae195dcef89` (Aerodrome CL)
- AUBRAI: `0x9d56c29e820Dd13b0580B185d0e0Dc301d27581d` (18 decimals)
- BIO: `0x226A2FA2556C48245E57cd1cbA4C6c9e67077DD2` (18 decimals)
- VITA: `0x490a4B510d0Ea9f835D2dF29Eb73b4FcA5071937` (18 decimals)

## Key Addresses (Ethereum)
- VITA/BIO Pool: `0x2DC8FbaFc10da100F2f12807b93CBb3E5Ff7e6b0` (Uniswap v3)
- VITARNA/VITA Pool #1: `0xa28b1854a654e35e94d51eA2F4F34208D9BA79A2` (Uniswap v3)
- VITARNA/VITA Pool #2: `0x6aeB5A2974902717ee01d33B6F999eDBc4Ab4C7a` (Uniswap v3)
- VITA: `0x81f8f0bb1cb2a06649e51913a151f0e7ef6fa321` (18 decimals)

## Environment Variables (set on Railway, not in code)
- `RPC_URL` — Ankr Base endpoint (primary RPC)
- `ETHEREUM_RPC_URL` — Ankr Ethereum endpoint (primary RPC)
- `ALCHEMY_BASE_URL` — Alchemy Base endpoint (fallback RPC, both services)
- `ALCHEMY_ETH_URL` — Alchemy Ethereum endpoint (fallback RPC, pool monitor only)
- `TELEGRAM_BOT_TOKEN` — @AubraiPoolMonitorBot
- `TELEGRAM_CHAT_ID` — VitaSwarm HQ supergroup
- `TELEGRAM_THREAD_ID` — "AUBRAI Pool Monitor" topic (health alerts + daily status)
- `TELEGRAM_ADMIN_CHAT_ID` — Amit's personal DM for bot errors
- `TELEGRAM_STATS_THREAD_ID` — "Pool Stats" topic (daily swap/LP stats)
- `TELEGRAM_WALLET_THREAD_ID` — "Wallet Balances" topic (wallet monitor only)

## Architecture
```
src/
├── index.js    — Entry point, 30s poll loop, daily status + stats scheduler
├── pool.js     — RPC failover, on-chain reads (CL), event polling (Swap/Mint/Burn), DexScreener
├── stats.js    — In-memory stats accumulator, snapshotAndReset() at 9:00 CET
├── checks.js   — 5 health checks (sanity, stability, reserves, liquidity, dexscreener)
├── alerts.js   — Telegram Bot API (pool alerts, swap alerts, admin DM, daily status, daily stats)
└── config.js   — All thresholds, addresses, env vars, RPC failover config

wallet-monitor/
├── index.js    — Entry point, 60s poll loop, daily report scheduler
├── wallets.js  — RPC failover, USDC balance reads
├── alerts.js   — Telegram alerts for low balances
└── config.js   — Wallet addresses, thresholds, env vars
```

## RPC Failover
- **Primary**: Ankr (500-block getLogs range)
- **Fallback**: Alchemy (10-block getLogs range)
- Auto-switches on 401/403/unauthorized/forbidden/quota errors
- Reprobes primary every 10 minutes to auto-recover when credits renew
- All providers use `staticNetwork` with explicit chain IDs to prevent ethers v6 retry loops
- Configured in `pool.js` (`initProviders`/`withFailover`) and `wallet-monitor/wallets.js`

## Health Checks & Thresholds (configurable in config.js)
- Price sanity: 1–10,000 BIO per AUBRAI
- Price stability: <20% change between polls
- Reserves: AUBRAI >100, BIO >1,000
- Pool liquidity: >1,000
- DexScreener deviation: <30%
- Swap slippage: <10% per real swap

## Daily Stats
In-memory accumulation of swap/LP events across all pools. Snapshot + reset at 9:00 CET daily. Reports nominal token amounts + USD values (via DexScreener). Stats persisted to disk; cursors saved atomically with stats.

## Important Constraints
- Ankr freemium tier: 200M credits/month, 1,000-block getLogs limit (we use 500)
- Alchemy free tier: 10-block getLogs limit (fallback only)
- Telegram MarkdownV2 requires escaping: `_*[]()~>#+\-=|{}.!`
- CL pool uses sqrtPriceX96 math: `price = (sqrtPriceX96 / 2^96)^2`, token0/token1 ordering auto-detected

## Deployment
- Railway project: `aubrai-pool-monitor` in VitaDAO workspace
- Two services: `aubrai-pool-monitor` (pool monitor) and `wallet-balance-monitor` (wallet monitor)
- Must `railway service link <name>` before deploying to switch target service
- Deploy via `railway up` (not GitHub integration)
- GitHub: `VitaDAO/vitadao-pool-monitor`
