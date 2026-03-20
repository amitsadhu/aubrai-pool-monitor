/**
 * In-memory stats accumulator for daily swap/LP reports.
 * Accumulates events during each 30s poll cycle, snapshot+reset at 9:00 CET.
 * Data is lost on restart (acceptable for Railway persistent process).
 */

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
}

function recordAubraiMint(mint) {
  stats.aubrai.lp.mintCount++;
  stats.aubrai.lp.added.tokens += mint.aubraiAmount;
  stats.aubrai.lp.added.bio += mint.bioAmount;
}

function recordAubraiBurn(burn) {
  stats.aubrai.lp.burnCount++;
  stats.aubrai.lp.withdrawn.tokens += burn.aubraiAmount;
  stats.aubrai.lp.withdrawn.bio += burn.bioAmount;
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
}

function recordVitaMint(mint) {
  stats.vita.lp.mintCount++;
  stats.vita.lp.added.tokens += mint.vitaAmount;
  stats.vita.lp.added.bio += mint.bioAmount;
}

function recordVitaBurn(burn) {
  stats.vita.lp.burnCount++;
  stats.vita.lp.withdrawn.tokens += burn.vitaAmount;
  stats.vita.lp.withdrawn.bio += burn.bioAmount;
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
  return snapshot;
}

module.exports = {
  recordAubraiSwap, recordAubraiMint, recordAubraiBurn,
  recordVitaSwap, recordVitaMint, recordVitaBurn,
  snapshotAndReset,
};
