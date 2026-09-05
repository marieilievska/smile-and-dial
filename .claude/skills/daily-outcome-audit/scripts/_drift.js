// Trailing-baseline drift detector for the audit scorecard. PURE — unit-tested.
// Compares today's ratios to the median of the last N prior audited days and
// flags any watched metric that moved beyond its threshold. Read aid only; it
// never changes data — it points the reviewer at a behavioral shift (an agent
// prompt change, a campaign-mix change, an EL change) the day it happens.

const DEFAULT_WATCHES = [
  { key: "not_interested_dm_no", kind: "share", threshold: 0.15, label: "not_interested with dm≠yes" },
  { key: "ai_receptionist_share", kind: "share", threshold: 0.01, label: "ai_receptionist share" },
  { key: "callback_share", kind: "share", threshold: 0.1, label: "callback share" },
  { key: "connect_rate", kind: "share", threshold: 0.15, label: "connect rate" },
  { key: "goal_met", kind: "count", label: "goal_met count" },
  { key: "dnc", kind: "count", label: "dnc count" },
];

function median(xs) {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** A flag → human string, count vs share formatted. */
function fmt(f) {
  const v = f.kind === "count" ? (x) => String(x) : (x) => Number(x).toFixed(3);
  return `${f.label} ${v(f.today)} vs baseline ${v(f.baseline)} (${f.direction})`;
}

/** Compare today's scorecard ratios to the trailing baseline.
 *  today/history entries look like { date, ratios: { <key>: number, ... } }. */
function driftReport({ today, history, watches = DEFAULT_WATCHES, lookback = 5, minHistory = 2 }) {
  const prior = (history || [])
    // STRICTLY BEFORE today, not merely "a different day". Excluding only the
    // same date silently let LATER days into a "trailing" baseline, so
    // re-auditing a historical day compared it against its own future (running
    // the audit across 2026-09-02..04 measured Sep 2 against Sep 3 + Sep 4).
    // Invisible in the normal flow, where the day being audited is always the
    // newest row — which is exactly why it survived this long.
    .filter((h) => h && h.date && h.date < today.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1)) // newest first
    .slice(0, lookback);
  if (prior.length < minHistory) {
    return { baselineBuilding: true, priorDays: prior.length, flags: [] };
  }
  const flags = [];
  for (const w of watches) {
    const todayVal = today.ratios?.[w.key];
    if (typeof todayVal !== "number") continue;
    const baseline = median(prior.map((h) => h.ratios?.[w.key]));
    if (baseline == null) continue;
    let flagged = false;
    if (w.kind === "share") {
      flagged = Math.abs(todayVal - baseline) >= w.threshold;
    } else {
      // count: a doubling/halving on a non-trivial base (avoids tiny-count noise)
      flagged = baseline >= 3 && (todayVal >= 2 * baseline || todayVal <= 0.5 * baseline);
    }
    if (flagged) {
      flags.push({
        key: w.key,
        label: w.label,
        kind: w.kind,
        today: todayVal,
        baseline,
        direction: todayVal >= baseline ? "up" : "down",
      });
    }
  }
  return { baselineBuilding: false, priorDays: prior.length, flags };
}

module.exports = { driftReport, median, fmt, DEFAULT_WATCHES };
