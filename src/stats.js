/**
 * In-memory stats accumulator for daily swap/LP reports.
 * Accumulates events during each 30s poll cycle, snapshot+reset at 9:00 CET.
 * Persists to disk (Railway volume) so data survives redeploys.
 */
const fs = require('fs');
const path = require('path');

const STATS_DIR = process.env.STATS_PATH || '/data';
const STATS_FILE = path.join(STATS_DIR, 'stats.json');
const CURSORS_FILE = path.join(STATS_DIR, 'cursors.json');

function createTokenStats() {
  return {
    swaps: {
      bought: { tokens: 0, counter: 0 },
      sold: { tokens: 0, counter: 0 },
      count: 0,
    },
    lp: {
      added: { tokens: 0, counter: 0 },
      withdrawn: { tokens: 0, counter: 0 },
      mintCount: 0,
      burnCount: 0,
    },
  };
}

let stats = {
  aubrai: createTokenStats(),
  vita: createTokenStats(),
  vitaEthereum: createTokenStats(),
  periodStart: Date.now(),
};

// --- Persistence ---

function ensureTokenStats(obj) {
  const defaults = createTokenStats();
  if (!obj) return defaults;
  // Deep-ensure all nested fields exist, migrate old 'bio' → 'counter'
  for (const side of ['bought', 'sold']) {
    if (!obj.swaps) obj.swaps = defaults.swaps;
    if (!obj.swaps[side]) obj.swaps[side] = defaults.swaps[side];
    if ('bio' in obj.swaps[side] && !('counter' in obj.swaps[side])) {
      obj.swaps[side].counter = obj.swaps[side].bio;
      delete obj.swaps[side].bio;
    }
    if (obj.swaps[side].counter === undefined) obj.swaps[side].counter = 0;
    if (obj.swaps[side].tokens === undefined) obj.swaps[side].tokens = 0;
  }
  if (obj.swaps.count === undefined) obj.swaps.count = 0;
  if (!obj.lp) obj.lp = defaults.lp;
  for (const side of ['added', 'withdrawn']) {
    if (!obj.lp[side]) obj.lp[side] = defaults.lp[side];
    if ('bio' in obj.lp[side] && !('counter' in obj.lp[side])) {
      obj.lp[side].counter = obj.lp[side].bio;
      delete obj.lp[side].bio;
    }
    if (obj.lp[side].counter === undefined) obj.lp[side].counter = 0;
    if (obj.lp[side].tokens === undefined) obj.lp[side].tokens = 0;
  }
  if (obj.lp.mintCount === undefined) obj.lp.mintCount = 0;
  if (obj.lp.burnCount === undefined) obj.lp.burnCount = 0;
  return obj;
}

function loadFromDisk() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      stats = data;
      stats.aubrai = ensureTokenStats(stats.aubrai);
      stats.vita = ensureTokenStats(stats.vita);
      stats.vitaEthereum = ensureTokenStats(stats.vitaEthereum);
      if (!stats.periodStart) stats.periodStart = Date.now();
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
    // Save cursors atomically alongside stats so they're always in sync
    if (_getCursors) {
      fs.writeFileSync(CURSORS_FILE, JSON.stringify(_getCursors()), 'utf8');
    }
  } catch (err) {
    console.warn('[stats] Failed to save stats/cursors to disk:', err.message);
  }
}

// --- Cursor persistence (separate from stats — cursors must survive daily snapshot) ---

let _getCursors = null; // registered by pool.js to avoid circular dep

function registerCursorGetter(fn) {
  _getCursors = fn;
}

function loadCursorsFromDisk() {
  try {
    if (fs.existsSync(CURSORS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CURSORS_FILE, 'utf8'));
      console.log('[stats] Loaded cursors from disk');
      return data;
    }
  } catch (err) {
    console.warn('[stats] Failed to load cursors from disk:', err.message);
  }
  return null;
}

// Load on startup
loadFromDisk();

// --- AUBRAI ---

function recordAubraiSwap(swap) {
  stats.aubrai.swaps.count++;
  if (swap.direction === 'BIO → AUBRAI') {
    stats.aubrai.swaps.bought.tokens += swap.aubraiAmount;
    stats.aubrai.swaps.bought.counter += swap.bioAmount;
  } else {
    stats.aubrai.swaps.sold.tokens += swap.aubraiAmount;
    stats.aubrai.swaps.sold.counter += swap.bioAmount;
  }
}

function recordAubraiMint(mint) {
  stats.aubrai.lp.mintCount++;
  stats.aubrai.lp.added.tokens += mint.aubraiAmount;
  stats.aubrai.lp.added.counter += mint.bioAmount;
}

function recordAubraiBurn(burn) {
  stats.aubrai.lp.burnCount++;
  stats.aubrai.lp.withdrawn.tokens += burn.aubraiAmount;
  stats.aubrai.lp.withdrawn.counter += burn.bioAmount;
}

// --- VITA ---

function recordVitaSwap(swap) {
  stats.vita.swaps.count++;
  if (swap.direction === 'bought') {
    stats.vita.swaps.bought.tokens += swap.vitaAmount;
    stats.vita.swaps.bought.counter += swap.counterAmount;
  } else {
    stats.vita.swaps.sold.tokens += swap.vitaAmount;
    stats.vita.swaps.sold.counter += swap.counterAmount;
  }
}

function recordVitaMint(mint) {
  stats.vita.lp.mintCount++;
  stats.vita.lp.added.tokens += mint.vitaAmount;
  stats.vita.lp.added.counter += mint.counterAmount;
}

function recordVitaBurn(burn) {
  stats.vita.lp.burnCount++;
  stats.vita.lp.withdrawn.tokens += burn.vitaAmount;
  stats.vita.lp.withdrawn.counter += burn.counterAmount;
}

// --- VITA (Ethereum) ---

function recordEthVitaSwap(swap) {
  stats.vitaEthereum.swaps.count++;
  if (swap.direction === 'bought') {
    stats.vitaEthereum.swaps.bought.tokens += swap.vitaAmount;
    stats.vitaEthereum.swaps.bought.counter += swap.counterAmount;
  } else {
    stats.vitaEthereum.swaps.sold.tokens += swap.vitaAmount;
    stats.vitaEthereum.swaps.sold.counter += swap.counterAmount;
  }
}

function recordEthVitaMint(mint) {
  stats.vitaEthereum.lp.mintCount++;
  stats.vitaEthereum.lp.added.tokens += mint.vitaAmount;
  stats.vitaEthereum.lp.added.counter += mint.counterAmount;
}

function recordEthVitaBurn(burn) {
  stats.vitaEthereum.lp.burnCount++;
  stats.vitaEthereum.lp.withdrawn.tokens += burn.vitaAmount;
  stats.vitaEthereum.lp.withdrawn.counter += burn.counterAmount;
}

// --- Snapshot ---

function snapshotAndReset() {
  const snapshot = JSON.parse(JSON.stringify(stats));
  snapshot.periodEnd = Date.now();
  stats = {
    aubrai: createTokenStats(),
    vita: createTokenStats(),
    vitaEthereum: createTokenStats(),
    periodStart: Date.now(),
  };
  saveToDisk(); // overwrite with fresh empty stats (don't delete — Telegram send may fail)
  return snapshot;
}

module.exports = {
  recordAubraiSwap, recordAubraiMint, recordAubraiBurn,
  recordVitaSwap, recordVitaMint, recordVitaBurn,
  recordEthVitaSwap, recordEthVitaMint, recordEthVitaBurn,
  snapshotAndReset, saveToDisk,
  registerCursorGetter, loadCursorsFromDisk,
};
