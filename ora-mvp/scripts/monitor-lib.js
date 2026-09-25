// Pure helpers for the realtime monitor (watch-invariants.js --watch).
// Kept side-effect-free so the suite can pin the alerting logic.
const E18 = 10n ** 18n;

// TCR bands: >= warn = ok, [crit, warn) = warn (recovery mode is 150%),
// < crit = crit, <= 100% = insolvent. Returns { band, crossed } where
// crossed is true when the band CHANGED since prevBand (edge-trigger).
function tcrBand(tcrE18, warnE18, critE18) {
  if (tcrE18 <= E18) return "insolvent";
  if (tcrE18 < critE18) return "crit";
  if (tcrE18 < warnE18) return "warn";
  return "ok";
}

// Cooldown bus: shouldFire(key) is true on first sight and then at most
// once per cooldownMs — sustained-bad conditions re-alert instead of
// spamming, and recovery messages always go through (bypass with force).
function newAlertBus(cooldownMs) {
  const last = new Map();
  return {
    shouldFire(key, now = Date.now(), force = false) {
      if (force) { last.set(key, now); return true; }
      const prev = last.get(key);
      if (prev !== undefined && now - prev < cooldownMs) return false;
      last.set(key, now);
      return true;
    },
    reset(key) { last.delete(key); },
  };
}

// Keeper heartbeat staleness: file JSON { ts } (ms). Returns { ageMs, stale }
// or { missing: true } when the file cannot be read/parsed.
function heartbeatStatus(fs, file, staleAfterMs, now = Date.now()) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const ts = Number(JSON.parse(raw).ts);
    if (!Number.isFinite(ts)) return { missing: true, reason: "unparseable ts" };
    return { ageMs: now - ts, stale: now - ts > staleAfterMs };
  } catch (e) {
    return { missing: true, reason: e.code === "ENOENT" ? "file not found" : String(e.message).slice(0, 80) };
  }
}

// Redemption sizing: actualLUSD (wei) vs threshold (wei).
function isLargeRedemption(actualWei, thresholdWei) {
  return BigInt(actualWei) >= BigInt(thresholdWei);
}

module.exports = { E18, tcrBand, newAlertBus, heartbeatStatus, isLargeRedemption };
