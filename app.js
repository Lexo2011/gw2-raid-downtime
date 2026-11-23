/* UI + data fetching. Calculation lives in downtime.js. */
(function () {
  "use strict";
  const D = window.Downtime;
  const WINGMAN = "https://gw2wingman.nevermindcreations.de";
  const DPS_REPORT_HOSTS = ["https://dps.report", "https://b.dps.report"];

  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const statusEl = $("status");

  let bossNames = null;
  let controller = null;

  // ---------- persistence (per-viewer convenience only) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const savedAccount = store.get("dt.account");
  if (savedAccount) $("account").value = savedAccount;

  // ---------- helpers ----------
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).getTime() : NaN);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtDateTime = (ms) =>
    new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function setStatus(msg, isError) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("error", !!isError);
  }

  async function getJson(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  // ---------- data sources ----------
  async function loadBossNames(signal) {
    if (bossNames) return bossNames;
    try {
      const data = await getJson(`${WINGMAN}/api/bosses`, signal);
      bossNames = {};
      for (const [id, b] of Object.entries(data)) bossNames[id] = b.displayName || b.name || b.short;
    } catch {
      bossNames = {};
    }
    return bossNames;
  }

  async function fetchWingman(account, signal) {
    const data = await getJson(`${WINGMAN}/api/playerStats?account=${encodeURIComponent(account)}`, signal);
    const logs = Array.isArray(data.latestLogs) ? data.latestLogs : [];
    return { fights: logs.map(D.fromWingman).filter(Boolean), total: logs.length };
  }

  async function fetchDpsReport(token, account, from, to, signal) {
    const params = new URLSearchParams({ userToken: token, perPage: "1000", page: "1" });
    if (isFinite(from)) params.set("sinceEncounter", String(Math.floor(from / 1000) - 3600));
    if (isFinite(to)) params.set("untilEncounter", String(Math.ceil(to / 1000)));
    let lastErr;
    for (const host of DPS_REPORT_HOSTS) {
      try {
        const fights = [];
        for (let page = 1; page <= 10; page++) {
          params.set("page", String(page));
          const data = await getJson(`${host}/getUploads?${params}`, signal);
          for (const up of data.uploads || []) {
            if (D.dpsReportHasAccount(up, account)) {
              const f = D.fromDpsReport(up);
              if (f) fights.push(f);
            }
          }
          if (!data.pages || page >= data.pages) break;
        }
        return fights;
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // ---------- presets ----------
  document.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const p = btn.dataset.preset;
      if (p === "clear") {
        $("start").value = "";
        $("end").value = "";
        return;
      }
      const now = Date.now();
      $("start").value = toLocalInput(now - Number(p) * 3600e3);
      $("end").value = toLocalInput(now);
    })
  );

  // ---------- main ----------
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const account = $("account").value.trim();
    const token = $("token").value.trim();
    const startIn = fromLocalInput($("start").value);
    const endIn = fromLocalInput($("end").value);
    if (isFinite(startIn) && isFinite(endIn) && endIn <= startIn) {
      setStatus("The end point must be after the start point.", true);
      return;
    }
    store.set("dt.account", account);

    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    $("go").disabled = true;
    setStatus("Fetching logs from Wingman… (a few MB, can take a moment)");

    const warnings = [];
    try {
      const [names, wing, dps] = await Promise.all([
        loadBossNames(signal),
        fetchWingman(account, signal).catch((e) => {
          if (e.name === "AbortError") throw e;
          warnings.push(`Wingman: ${e.message}`);
          return { fights: [], total: 0 };
        }),
        token
          ? fetchDpsReport(token, account, startIn, endIn, signal).catch((e) => {
              if (e.name === "AbortError") throw e;
              warnings.push(`dps.report: ${e.message}`);
              return [];
            })
          : Promise.resolve([]),
      ]);

      const all = wing.fights.concat(dps);
      if (!all.length) throw new Error(warnings.join(" · ") || "No logs found for this account.");

      // Auto window: first pull / last fight end inside the requested bounds.
      const inBounds = all.filter(
        (f) => (!isFinite(startIn) || f.end > startIn) && (!isFinite(endIn) || f.start < endIn)
      );
      if (!inBounds.length) throw new Error("No logs found between those points.");
      const winStart = isFinite(startIn) ? startIn : Math.min(...inBounds.map((f) => f.start));
      const winEnd = isFinite(endIn) ? endIn : Math.max(...inBounds.map((f) => f.end));

      // 250-log cap: if Wingman's oldest log is after the window start, earlier logs may be missing.
      if (wing.total >= 250 && wing.fights.length) {
        const oldest = Math.min(...wing.fights.map((f) => f.start));
        if (oldest > winStart) {
          warnings.push(
            `Wingman only returns the latest 250 logs. The oldest one is from ${fmtDateTime(oldest)}, so anything before that is missing and counted as idle.`
          );
        }
      }

      const r = D.calculate(all, winStart, winEnd);
      render(r, names, warnings);
      setStatus(
        `${r.pulls} pull${r.pulls === 1 ? "" : "s"} found` +
          (r.duplicatesRemoved ? `, ${r.duplicatesRemoved} duplicate upload${r.duplicatesRemoved === 1 ? "" : "s"} merged` : "") +
          "."
      );
    } catch (e) {
      if (e.name === "AbortError") return;
      $("results").hidden = true;
      setStatus(e.message || String(e), true);
    } finally {
      $("go").disabled = false;
    }
  });

  // ---------- rendering ----------
  function bossLabel(f, names) {
    const n = names[f.bossId] || f.bossShort || `Boss ${f.bossId}`;
    return f.isCM ? `${n} (CM)` : n;
  }

  function render(r, names, warnings) {
    $("results").hidden = false;
    $("warnings").innerHTML = warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("");

    $("c-window").textContent = D.formatDuration(r.windowMS);
    $("c-range").textContent = `${fmtDateTime(r.windowStart)} – ${fmtTime(r.windowEnd)}`;
    $("c-fight").textContent = D.formatDuration(r.fightingMS);
    $("c-fightpct").textContent = pct(1 - r.idlePct);
    $("c-idle").textContent = D.formatDuration(r.idleMS);
    $("c-idlepct").textContent = pct(r.idlePct);
    $("c-pulls").textContent = r.pulls;
    $("c-kf").textContent = `${r.kills} kill${r.kills === 1 ? "" : "s"} · ${r.fails} wipe${r.fails === 1 ? "" : "s"}`;

    // Timeline
    const span = r.windowMS;
    const x = (t) => ((Math.min(Math.max(t, r.windowStart), r.windowEnd) - r.windowStart) / span) * 100;
    const tl = $("timeline");
    tl.setAttribute(
      "aria-label",
      `Timeline: ${D.formatDuration(r.fightingMS)} fighting, ${D.formatDuration(r.idleMS)} idle`
    );
    tl.innerHTML =
      r.gaps
        .map(
          (g) =>
            `<div class="seg gap" style="left:${x(g.start)}%;width:${x(g.end) - x(g.start)}%" title="Idle ${D.formatDuration(g.end - g.start)}\n${fmtTime(g.start)} – ${fmtTime(g.end)}"></div>`
        )
        .join("") +
      r.rows
        .map(
          (f) =>
            `<a class="seg ${f.success ? "kill" : "fail"}" href="${esc(f.link)}" target="_blank" rel="noopener" style="left:${x(f.start)}%;width:${Math.max(x(f.end) - x(f.start), 0.15)}%" title="${esc(bossLabel(f, names))}: ${f.success ? "kill" : "wipe"}, ${D.formatDuration(f.durationMS)}\n${fmtTime(f.start)} – ${fmtTime(f.end)}"></a>`
        )
        .join("");

    // Axis ticks
    const ticks = 6;
    $("axis").innerHTML = Array.from({ length: ticks + 1 }, (_, i) => {
      const t = r.windowStart + (span * i) / ticks;
      return `<span style="left:${(i / ticks) * 100}%">${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>`;
    }).join("");

    // Breakdown
    const longest = r.gaps
      .filter((g) => g.start > r.windowStart && g.end < r.windowEnd)
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    const items = [
      ["Before the first pull", r.leadingMS],
      ["Between wipes and the next attempt", r.retryIdleMS],
      ["Between bosses", r.transitionIdleMS],
      ["After the last fight", r.trailingMS],
    ];
    $("breakdown").innerHTML =
      items
        .map(
          ([k, v]) =>
            `<div><dt>${k}</dt><dd>${D.formatDuration(v)}<span class="bar"><i style="width:${r.idleMS ? (v / r.idleMS) * 100 : 0}%"></i></span></dd></div>`
        )
        .join("") +
      (longest
        ? `<div><dt>Longest break</dt><dd>${D.formatDuration(longest.end - longest.start)} <small>(${fmtTime(longest.start)} – ${fmtTime(longest.end)})</small></dd></div>`
        : "");

    // Table
    $("rows").innerHTML = r.rows
      .map(
        (f) => `<tr>
          <td>${fmtTime(f.start)}</td>
          <td>${esc(bossLabel(f, names))}</td>
          <td><span class="pill ${f.success ? "kill" : "fail"}">${f.success ? "Kill" : "Wipe"}</span></td>
          <td class="num">${D.formatDuration(f.durationMS)}</td>
          <td class="num ${f.gapBeforeMS > 600000 ? "long" : ""}">${f.gapBeforeMS == null ? "–" : D.formatDuration(f.gapBeforeMS)}</td>
          <td><a href="${esc(f.link)}" target="_blank" rel="noopener">log</a></td>
        </tr>`
      )
      .join("");
  }
})();
