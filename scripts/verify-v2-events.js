/**
 * Verification script: pull VITA/BIO CL events from a recent window
 * and cross-reference with DexScreener.
 *
 * Rate-limited to avoid saturating Alchemy free tier.
 * Usage: RPC_URL=<alchemy_url> node scripts/verify-v2-events.js
 */
require('dotenv').config();
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const VITA = '0x490a4B510d0Ea9f835D2dF29Eb73b4FcA5071937'.toLowerCase();

const POOLS = [
  { address: '0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd', label: 'VITA/BIO Pool 1' },
  { address: '0xa81b95635682295cbd25129199420ae195dcef89', label: 'VITA/BIO Pool 2' },
];

// CL (SlipStream) ABI — these are CL pools, NOT V2
const CL_ABI = [
  'function token0() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
];

const MAX_RANGE = 10;
const DELAY_MS = 100; // 100ms between requests to avoid 429s

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const currentBlock = await provider.getBlockNumber();

  // Last 6 hours (~10,800 blocks at 2s/block)
  const lookback = 10800;
  const startBlock = currentBlock - lookback;

  console.log(`Current block: ${currentBlock}`);
  console.log(`Scanning blocks ${startBlock}–${currentBlock} (last ~6h)`);
  console.log(`Rate-limited: ${DELAY_MS}ms between requests\n`);

  for (const poolCfg of POOLS) {
    console.log(`=== ${poolCfg.label} (${poolCfg.address}) ===`);

    const contract = new ethers.Contract(poolCfg.address, CL_ABI, provider);

    let token0;
    try {
      token0 = (await contract.token0()).toLowerCase();
    } catch (err) {
      console.log(`  Failed to read token0: ${err.message}`);
      console.log(`  Retrying after 2s...`);
      await sleep(2000);
      token0 = (await contract.token0()).toLowerCase();
    }
    const vitaIsToken0 = token0 === VITA;
    console.log(`  VITA is token${vitaIsToken0 ? '0' : '1'}`);

    const swapTopic = contract.interface.getEvent('Swap').topicHash;
    const mintTopic = contract.interface.getEvent('Mint').topicHash;
    const burnTopic = contract.interface.getEvent('Burn').topicHash;

    console.log(`  Swap topic: ${swapTopic}`);

    let swapCount = 0, mintCount = 0, burnCount = 0, errors = 0;
    let totalVitaBought = 0, totalVitaSold = 0;
    let totalBioBought = 0, totalBioSold = 0;
    const swapDetails = [];

    let from = startBlock;
    const totalChunks = Math.ceil(lookback / MAX_RANGE);

    while (from <= currentBlock) {
      const to = Math.min(from + MAX_RANGE - 1, currentBlock);
      try {
        const logs = await provider.getLogs({
          address: poolCfg.address,
          topics: [[swapTopic, mintTopic, burnTopic]],
          fromBlock: from,
          toBlock: to,
        });

        for (const log of logs) {
          if (log.topics[0] === swapTopic) {
            swapCount++;
            const event = contract.interface.parseLog({ topics: log.topics, data: log.data });
            const { amount0, amount1 } = event.args;

            const amt0 = Number(ethers.formatUnits(amount0 < 0n ? -amount0 : amount0, 18));
            const amt1 = Number(ethers.formatUnits(amount1 < 0n ? -amount1 : amount1, 18));

            let vitaAmt, bioAmt, dir;
            if (vitaIsToken0) {
              vitaAmt = amt0; bioAmt = amt1;
              dir = amount0 < 0n ? 'BIO->VITA' : 'VITA->BIO';
            } else {
              vitaAmt = amt1; bioAmt = amt0;
              dir = amount1 < 0n ? 'BIO->VITA' : 'VITA->BIO';
            }

            if (dir === 'BIO->VITA') { totalVitaBought += vitaAmt; totalBioBought += bioAmt; }
            else { totalVitaSold += vitaAmt; totalBioSold += bioAmt; }

            swapDetails.push({ dir, vitaAmt, bioAmt, block: log.blockNumber, tx: log.transactionHash });
          } else if (log.topics[0] === mintTopic) {
            mintCount++;
          } else {
            burnCount++;
          }
        }
      } catch (err) {
        errors++;
        if (errors <= 3) console.log(`  Error blocks ${from}-${to}: ${err.message.substring(0, 80)}`);
      }
      from = to + 1;
      await sleep(DELAY_MS);
    }

    console.log(`\n  On-chain (last 6h):`);
    console.log(`  Swaps: ${swapCount} | Mints: ${mintCount} | Burns: ${burnCount} | RPC errors: ${errors}`);
    for (const s of swapDetails) {
      console.log(`    ${s.dir} | ${s.vitaAmt.toFixed(2)} VITA / ${s.bioAmt.toFixed(2)} BIO | block ${s.block}`);
      console.log(`    tx: ${s.tx}`);
    }
    console.log(`  Totals: Bought ${totalVitaBought.toFixed(2)} VITA | Sold ${totalVitaSold.toFixed(2)} VITA`);

    // DexScreener comparison
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${poolCfg.address}`);
      const data = await res.json();
      const pair = data.pairs?.[0];
      if (pair) {
        console.log(`\n  DexScreener 24h: buys=${pair.txns?.h24?.buys} sells=${pair.txns?.h24?.sells} vol=$${pair.volume?.h24}`);
      }
    } catch (err) {
      console.log(`  DexScreener fetch failed: ${err.message}`);
    }
    console.log('');
  }
}

main().catch(console.error);
