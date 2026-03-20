require('dotenv').config();
const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL;
const VITA = '0x490a4B510d0Ea9f835D2dF29Eb73b4FcA5071937'.toLowerCase();
const poolAddr = '0x5bd27255061a0e8bce2fc32bbb50d3be4e0b28bd';

const CL_ABI = [
  'function token0() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(poolAddr, CL_ABI, provider);

  const token0 = (await contract.token0()).toLowerCase();
  const vitaIsToken0 = token0 === VITA;
  console.log('VITA is token' + (vitaIsToken0 ? '0' : '1'));

  const swapTopic = contract.interface.getEvent('Swap').topicHash;
  console.log('CL Swap topic:', swapTopic);

  const currentBlock = await provider.getBlockNumber();
  console.log('Current block:', currentBlock);
  console.log('Scanning backwards for Swap events...\n');

  for (let start = currentBlock; start > currentBlock - 10000; start -= 10) {
    const from = start - 9;
    const to = start;
    try {
      const logs = await provider.getLogs({
        address: poolAddr,
        topics: [swapTopic],
        fromBlock: from,
        toBlock: to,
      });
      if (logs.length > 0) {
        console.log('Found', logs.length, 'swap(s) in blocks', from, '-', to);
        for (const log of logs) {
          const event = contract.interface.parseLog({ topics: log.topics, data: log.data });
          const { amount0, amount1 } = event.args;
          const amt0 = Number(ethers.formatUnits(amount0 < 0n ? -amount0 : amount0, 18));
          const amt1 = Number(ethers.formatUnits(amount1 < 0n ? -amount1 : amount1, 18));

          let dir;
          if (vitaIsToken0) {
            dir = amount0 < 0n ? 'BIO->VITA' : 'VITA->BIO';
          } else {
            dir = amount1 < 0n ? 'BIO->VITA' : 'VITA->BIO';
          }
          const vita = vitaIsToken0 ? amt0 : amt1;
          const bio = vitaIsToken0 ? amt1 : amt0;
          console.log(`  ${dir} | ${vita.toFixed(2)} VITA / ${bio.toFixed(2)} BIO | tx: ${log.transactionHash}`);
        }
        return;
      }
    } catch (e) {
      // skip
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('No swaps found in last 10000 blocks');
}

main().catch(console.error);
