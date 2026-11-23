// Run with: node test.js
const assert = require("assert");
const D = require("./downtime.js");

const t0 = Date.UTC(2026, 10, 23, 19, 0, 0);
const min = 60e3;
const f = (startMin, durMin, opts = {}) => ({
  id: opts.id || `f${startMin}`,
  start: t0 + startMin * min,
  end: t0 + (startMin + durMin) * min,
  durationMS: durMin * min,
  success: opts.success ?? true,
  bossId: opts.boss || "1",
  link: "",
});

// parseWingmanTime handles offsets
assert.strictEqual(D.parseWingmanTime("2026-11-23 20:49:19 +00:00"), Date.UTC(2026, 10, 23, 20, 49, 19));
assert.strictEqual(D.parseWingmanTime("2026-11-24 01:31:04 +08:00"), Date.UTC(2026, 10, 23, 17, 31, 4));
assert.strictEqual(D.slugBoss("9956f-Kerkhoven8264_20261123-194725_vg_kill"), "vg");
assert.strictEqual(D.slugBoss("ddRO-20261122-095854_vg"), "vg");

// Basic: 60 min window, fights 10-15 (wipe), 20-30 (kill, same boss), 40-45 other boss
{
  const r = D.calculate(
    [f(10, 5, { success: false }), f(20, 10), f(40, 5, { boss: "2" })],
    t0,
    t0 + 60 * min
  );
  assert.strictEqual(r.fightingMS, 20 * min);
  assert.strictEqual(r.idleMS, 40 * min);
  assert.strictEqual(r.leadingMS, 10 * min);
  assert.strictEqual(r.trailingMS, 15 * min);
  assert.strictEqual(r.retryIdleMS, 5 * min);
  assert.strictEqual(r.transitionIdleMS, 10 * min);
  assert.strictEqual(r.leadingMS + r.trailingMS + r.retryIdleMS + r.transitionIdleMS, r.idleMS);
  assert.strictEqual(r.pulls, 3);
  assert.strictEqual(r.kills, 2);
}

// Duplicate uploads (same boss, end within 15 s) collapse; overlap never double-counts
{
  const a = f(10, 5);
  const b = { ...f(10, 5), id: "dup", end: a.end + 2000, start: a.start + 2000 };
  const r = D.calculate([a, b], t0, t0 + 30 * min);
  assert.strictEqual(r.pulls, 1);
  assert.strictEqual(r.duplicatesRemoved, 1);
  assert.strictEqual(r.fightingMS, 5 * min);
}

// Fights crossing the window edges are clipped
{
  const r = D.calculate([f(-5, 10), f(55, 10)], t0, t0 + 60 * min);
  assert.strictEqual(r.fightingMS, 10 * min);
  assert.strictEqual(r.leadingMS, 0);
  assert.strictEqual(r.trailingMS, 0);
}

// No fights => all idle
{
  const r = D.calculate([], t0, t0 + 60 * min);
  assert.strictEqual(r.idleMS, 60 * min);
  assert.strictEqual(r.idlePct, 1);
}

assert.throws(() => D.calculate([], t0, t0));
assert.strictEqual(D.formatDuration(3723000), "1h 02m 03s");

console.log("All tests passed.");
