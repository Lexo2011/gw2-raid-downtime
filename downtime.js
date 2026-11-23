/*
 * Core downtime calculation. Pure functions, no DOM / network.
 * Works as a classic browser script (exposes window.Downtime) and as a Node module (for tests).
 */
(function (root) {
  "use strict";

  /** Same fight uploaded by several squad members ends within a few seconds of each other. */
  const DUPLICATE_TOLERANCE_MS = 15000;

  /** Parse Wingman's "2026-11-23 20:49:19 +00:00" (or any ISO-ish string) into epoch ms. */
  function parseWingmanTime(s) {
    if (s == null) return NaN;
    if (typeof s === "number") return s < 1e12 ? s * 1000 : s;
    const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*([+-]\d{2}:?\d{2}|Z)?$/);
    if (!m) return Date.parse(s);
    let tz = m[3] || "Z";
    if (/^[+-]\d{4}$/.test(tz)) tz = tz.slice(0, 3) + ":" + tz.slice(3);
    return Date.parse(`${m[1]}T${m[2]}${tz}`);
  }

  /** Boss short name from a log slug like "9956f-Kerkhoven8264_20261123-194725_vg_kill". */
  function slugBoss(slug) {
    const m = String(slug || "").match(/[-_]\d{8}-\d{6}_([a-z0-9]+)(?:_(?:kill|fail))?$/i);
    return m ? m[1] : "";
  }

  /** Normalise a Wingman latestLogs entry into a fight. Returns null if it has no usable timing. */
  function fromWingman(log) {
    const end = parseWingmanTime(log.timeEnd);
    const dur = Number(log.durationMS);
    if (!isFinite(end) || !isFinite(dur) || dur <= 0) return null;
    return {
      id: log.html,
      start: end - dur,
      end,
      durationMS: dur,
      success: !!log.success,
      bossId: log.triggerID != null ? String(log.triggerID) : "",
      bossShort: slugBoss(log.html),
      isCM: !!log.isCM,
      link: `https://gw2wingman.nevermindcreations.de/log/${log.html}`,
      source: "wingman",
    };
  }

  /** Normalise a dps.report getUploads entry into a fight. */
  function fromDpsReport(up) {
    const enc = up.encounter || {};
    const start = Number(up.encounterTime) * 1000;
    const dur = Number(enc.duration) * 1000;
    if (!isFinite(start) || !start || !isFinite(dur) || dur <= 0) return null;
    return {
      id: up.id,
      start,
      end: start + dur,
      durationMS: dur,
      success: !!enc.success,
      bossId: enc.bossId != null ? String(enc.bossId) : "",
      bossShort: slugBoss(up.permalink && up.permalink.split("/").pop()),
      isCM: !!enc.isCm,
      link: up.permalink,
      source: "dps.report",
    };
  }

  /** dps.report players may be an array or an object keyed by character name. */
  function dpsReportHasAccount(up, account) {
    const players = up.players;
    if (!players) return true;
    const list = Array.isArray(players) ? players : Object.values(players);
    if (!list.length) return true; // older arc versions: no player info, keep it
    const want = account.trim().toLowerCase();
    return list.some((p) => String(p.display_name || "").toLowerCase() === want);
  }

  /** Collapse uploads of the same fight (same boss, end times within tolerance). Keeps the longest. */
  function dedupe(fights) {
    const sorted = fights.slice().sort((a, b) => a.end - b.end);
    const out = [];
    for (const f of sorted) {
      const dup = out.find(
        (o) =>
          Math.abs(o.end - f.end) <= DUPLICATE_TOLERANCE_MS &&
          (o.bossId === f.bossId || !o.bossId || !f.bossId)
      );
      if (!dup) {
        out.push({ ...f, uploads: 1 });
      } else {
        dup.uploads++;
        if (f.durationMS > dup.durationMS) {
          Object.assign(dup, { ...f, uploads: dup.uploads });
        }
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Union of [start,end] intervals. Input need not be sorted. */
  function mergeIntervals(intervals) {
    const s = intervals
      .filter((i) => i.end > i.start)
      .map((i) => ({ start: i.start, end: i.end }))
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const i of s) {
      const last = out[out.length - 1];
      if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
      else out.push(i);
    }
    return out;
  }

  /**
   * Main calculation.
   * @param {Array} rawFights normalised fights (see fromWingman / fromDpsReport)
   * @param {number} windowStart epoch ms
   * @param {number} windowEnd epoch ms
   */
  function calculate(rawFights, windowStart, windowEnd) {
    if (!(windowEnd > windowStart)) throw new Error("The end point must be after the start point.");

    const fights = dedupe(rawFights).filter((f) => f.end > windowStart && f.start < windowEnd);
    const clipped = fights.map((f) => ({
      start: Math.max(f.start, windowStart),
      end: Math.min(f.end, windowEnd),
    }));
    const busy = mergeIntervals(clipped);

    const windowMS = windowEnd - windowStart;
    const fightingMS = busy.reduce((t, i) => t + (i.end - i.start), 0);
    const idleMS = windowMS - fightingMS;

    // Gaps between busy blocks, plus leading/trailing idle.
    const gaps = [];
    let cursor = windowStart;
    for (const b of busy) {
      if (b.start > cursor) gaps.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
    }
    if (windowEnd > cursor) gaps.push({ start: cursor, end: windowEnd });

    const leadingMS = busy.length ? Math.max(0, busy[0].start - windowStart) : windowMS;
    const trailingMS = busy.length ? Math.max(0, windowEnd - busy[busy.length - 1].end) : 0;

    // Per-fight gap to previous fight + classify it.
    let retryIdleMS = 0; // after a failed pull, before the next pull of the same boss
    let transitionIdleMS = 0; // between different bosses (or after a kill)
    let prev = null;
    const rows = fights.map((f) => {
      let gapBeforeMS = null;
      let gapKind = null;
      if (prev) {
        const from = Math.max(prev.end, windowStart);
        const to = Math.max(Math.min(f.start, windowEnd), from);
        gapBeforeMS = Math.max(0, to - from);
        gapKind = !prev.success && prev.bossId === f.bossId ? "retry" : "transition";
        if (gapKind === "retry") retryIdleMS += gapBeforeMS;
        else transitionIdleMS += gapBeforeMS;
      }
      prev = !prev || f.end > prev.end ? f : prev;
      return { ...f, gapBeforeMS, gapKind };
    });

    const firstPull = fights.length ? fights[0].start : null;
    const lastEnd = fights.length ? Math.max(...fights.map((f) => f.end)) : null;

    return {
      windowStart,
      windowEnd,
      windowMS,
      fightingMS,
      idleMS,
      idlePct: windowMS ? idleMS / windowMS : 0,
      leadingMS,
      trailingMS,
      retryIdleMS,
      transitionIdleMS,
      pulls: fights.length,
      kills: fights.filter((f) => f.success).length,
      fails: fights.filter((f) => !f.success).length,
      duplicatesRemoved: fights.reduce((n, f) => n + (f.uploads - 1), 0),
      firstPull,
      lastEnd,
      busy,
      gaps,
      rows,
    };
  }

  function formatDuration(ms) {
    if (ms == null || !isFinite(ms)) return "–";
    const neg = ms < 0;
    let s = Math.round(Math.abs(ms) / 1000);
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (neg ? "-" : "") + (h ? `${h}h ${pad(m)}m ${pad(s)}s` : m ? `${m}m ${pad(s)}s` : `${s}s`);
  }

  const api = {
    DUPLICATE_TOLERANCE_MS,
    parseWingmanTime,
    slugBoss,
    fromWingman,
    fromDpsReport,
    dpsReportHasAccount,
    dedupe,
    mergeIntervals,
    calculate,
    formatDuration,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Downtime = api;
})(typeof window !== "undefined" ? window : globalThis);
