/**
 * In-memory stats accumulator for daily swap/LP reports.
 * Accumulates events during each 30s poll cycle, snapshot+reset at 9:00 CET.
 * Persists to disk (Railway volume) so data survives redeploys.
 */
const fs = require('fs');
const path = require('path');

const STATS_DIR = process.env.STATS_PATH || '/data';
const STATS_FILE = path.join(STATS_DIR, 'stats.json');

function createTokenStats() {
  return {
    swaps: {
      bought: { tokens: 0, bio: 0 },
      sold: { tokens: 0, bio: 0 },
      count: 0,
    },
    lp: {
      added: { tokens: 0, bio: 0 },
      withdrawn: { tokens: 0, bio: 0 },
      mintCount: 0,
      burnCount: 0,
    },
  };
}

let stats = {
  aubrai: createTokenStats(),
  vita: createTokenStats(),
  periodStart: Date.now(),
};

// --- Persistence ---

function loadFromDisk() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      stats = data;
      console.log(`[stats] Loaded stats from disk (period started ${new Date(stats.periodStart).toISOString()})`);
    }
  } catch (err) {
    console.warn('[stats] Failed to load stats from disk:', err.message);
  }
}

function saveToDisk() {
  try {
    if (!fs.existsSync(STATS_DIR)) return; // volume not mounted (local dev)
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8');
  } catch (err) {
    console.warn('[stats] Failed to save stats to disk:', err.message);
  }
}

function deleteFromDisk() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      fs.unlinkSync(STATS_FILE);
      console.log('[stats] Deleted stats file after snapshot');
    }
  } catch (err) {
    console.warn('[stats] Failed to delete stats file:', err.message);
  }
}

// Load on startup
loadFromDisk();

// --- AUBRAI ---

function recordAubraiSwap(swap) {
  stats.aubrai.swaps.count++;
  if (swap.direction === 'BIO → AUBRAI') {
    // Buying AUBRAI
    stats.aubrai.swaps.bought.tokens += swap.aubraiAmount;
    stats.aubrai.swaps.bought.bio += swap.bioAmount;
  } else {
    // Selling AUBRAI
    stats.aubrai.swaps.sold.tokens += swap.aubraiAmount;
    stats.aubrai.swaps.sold.bio += swap.bioAmount;
  }
  saveToDisk();
}

function recordAubraiMint(mint) {
  stats.aubrai.lp.mintCount++;
  stats.aubrai.lp.added.tokens += mint.aubraiAmount;
  stats.aubrai.lp.added.bio += mint.bioAmount;
  saveToDisk();
}

function recordAubraiBurn(burn) {
  stats.aubrai.lp.burnCount++;
  stats.aubrai.lp.withdrawn.tokens += burn.aubraiAmount;
  stats.aubrai.lp.withdrawn.bio += burn.bioAmount;
  saveToDisk();
}

// --- VITA ---

function recordVitaSwap(swap) {
  stats.vita.swaps.count++;
  if (swap.direction === 'BIO → VITA') {
    // Buying VITA
    stats.vita.swaps.bought.tokens += swap.vitaAmount;
    stats.vita.swaps.bought.bio += swap.bioAmount;
  } else {
    // Selling VITA
    stats.vita.swaps.sold.tokens += swap.vitaAmount;
    stats.vita.swaps.sold.bio += swap.bioAmount;
  }
  saveToDisk();
}

function recordVitaMint(mint) {
  stats.vita.lp.mintCount++;
  stats.vita.lp.added.tokens += mint.vitaAmount;
  stats.vita.lp.added.bio += mint.bioAmount;
  saveToDisk();
}

function recordVitaBurn(burn) {
  stats.vita.lp.burnCount++;
  stats.vita.lp.withdrawn.tokens += burn.vitaAmount;
  stats.vita.lp.withdrawn.bio += burn.bioAmount;
  saveToDisk();
}

// --- Snapshot ---

function snapshotAndReset() {
  const snapshot = JSON.parse(JSON.stringify(stats));
  snapshot.periodEnd = Date.now();
  stats = {
    aubrai: createTokenStats(),
    vita: createTokenStats(),
    periodStart: Date.now(),
  };
  deleteFromDisk();
  return snapshot;
}

function needsBackfill() {
  // Force backfill via env var (remove after use)
  if (process.env.FORCE_BACKFILL === 'true') {
    console.log('[stats] FORCE_BACKFILL=true — deleting existing stats file');
    deleteFromDisk();
    return fs.existsSync(STATS_DIR);
  }
  // Backfill needed if volume exists but no stats file
  return fs.existsSync(STATS_DIR) && !fs.existsSync(STATS_FILE);
}

module.exports = {
  recordAubraiSwap, recordAubraiMint, recordAubraiBurn,
  recordVitaSwap, recordVitaMint, recordVitaBurn,
  snapshotAndReset, needsBackfill,
};
