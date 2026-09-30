/* operonx studio — Monitor: one service's or job's health over a range.
 *
 * Four numbers first (runs, error rate, p50, p95) with the previous
 * period beside them; runs over time (succeeded / failed) and p95 over
 * time, with the code version marked where it changed; where the time
 * goes, op by op; what it cost; what broke, grouped by message.
 *
 * Charts are plain SVG, drawn to the dataviz rules: thin marks with a
 * rounded data end on the baseline, a 2px surface gap between stacked
 * segments, recessive hairline grid, a legend for two series (none for
 * one), a hover tooltip on every mark, and a table beside every chart.
 * Colours: blue = succeeded / the series, the reserved critical red =
 * failed (validated: CVD ΔE 23.8, normal 31.6, both ≥ 3:1 on white).
 */

"use strict";

(() => {
  const box = $("#monitor");
  // the charts' colours are the theme's tokens, read when a chart is drawn
  const C = {};
  const paletteNow = () => Object.assign(C, {
    ok: Theme.token("--chart-ok", "#2a78d6"), failed: Theme.token("--chart-failed", "#d03b3b"),
    line: Theme.token("--chart-ok", "#2a78d6"), grid: Theme.token("--chart-grid", "#ecebe6"),
    axis: Theme.token("--chart-axis", "#c3c2b7"), ink2: Theme.token("--chart-ink", "#52514e"),
    muted: Theme.token("--chart-muted", "#898781"), surface: Theme.token("--surface", "#fff")});
  paletteNow();
  // a new theme redraws what is on screen
  document.addEventListener("oxtheme", () => { paletteNow(); if (state.tab === "monitor") show(); });
  const RANGES = [["24h", "24 hours", 86400, 24], ["7d", "7 days", 7 * 86400, 28], ["30d", "30 days", 30 * 86400, 30]];
  const v = Object.assign({target: "", range: "7d"}, recall(`monitor:${PID}`, {}));
  let tip = null;
  let token = 0;     // the latest show() owns the pane; slower answers are dropped

  const pct = (x) => (x == null ? "—" : `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`);
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, val] of Object.entries(attrs || {})) n.setAttribute(k, String(val));
    return n;
  };
  const when = (t) => fmtWhen(t * 1000);

  function tooltip() {
    if (!tip) { tip = el("div", "viztip"); tip.hidden = true; document.body.append(tip); }
    return tip;
  }
  function showTip(ev, lines) {
    const t = tooltip();
    t.textContent = "";
    for (const [i, line] of lines.entries()) t.append(el("div", i ? null : "viztip-head", line));
    t.hidden = false;
    const x = Math.min(window.innerWidth - t.offsetWidth - 8, ev.clientX + 14);
    const y = Math.max(8, ev.clientY - t.offsetHeight - 10);
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }
  const hideTip = () => { if (tip) tip.hidden = true; };

  /* a stat tile: the number, and how it moved against the last period */
  function tile(label, value, prev, fmt, lowerIsBetter, note) {
    const t = el("div", "stattile");
    t.append(el("div", "statlabel", label));
    t.append(el("div", "statvalue", value == null ? "—" : fmt(value)));
    const sub = el("div", "statsub");
    if (note) sub.append(note);
    else if (value == null) sub.append("");
    else if (prev != null && prev !== 0) {
      const d = (value - prev) / Math.abs(prev);
      if (Math.abs(d) < 0.005) sub.append("same as the previous period");
      else {
        const better = lowerIsBetter ? d < 0 : d > 0;
        const arrow = el("span", "delta " + (better ? "good" : "bad"), `${d > 0 ? "▲" : "▼"} ${Math.abs(100 * d).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`);
        sub.append(arrow, " vs the previous period");
      }
    } else if (prev === 0 || prev == null) sub.append("nothing in the previous period");
    t.append(sub);
    return t;
  }

  /* geometry shared by both charts */
  // charts are drawn at the width they are shown at, so an axis label is
  // 10.5px on a phone too (a fixed viewBox shrank them to 5px there)
  let chartW = 640;
  function frame(series, height) {
    const W = chartW, H = height, L = 44, R = 8, T = 10, B = 22;
    return {W, H, L, R, T, B, pw: W - L - R, ph: H - T - B,
      x: (i) => L + (i + 0.5) * (W - L - R) / series.length, bw: (W - L - R) / series.length};
  }

  function yAxis(svg, f, max, fmt) {
    const ticks = 3;
    for (let i = 0; i <= ticks; i++) {
      const val = max * i / ticks;
      const y = f.T + f.ph - f.ph * i / ticks;
      svg.append(svgEl("line", {x1: f.L, x2: f.W - f.R, y1: y, y2: y, stroke: i ? C.grid : C.axis, "stroke-width": 1}));
      const tx = svgEl("text", {x: f.L - 6, y: y + 3, "text-anchor": "end", class: "vizaxis"});
      tx.textContent = fmt(val);
      svg.append(tx);
    }
  }

  function xLabels(svg, f, series) {
    const every = Math.ceil(series.length / Math.max(2, Math.floor(f.pw / 90)));
    series.forEach((b, i) => {
      if (i % every) return;
      const tx = svgEl("text", {x: f.x(i), y: f.H - 6, "text-anchor": "middle", class: "vizaxis"});
      const d = new Date(b.t0 * 1000);
      tx.textContent = (b.t1 - b.t0) < 86400
        ? d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", hour12: false})
        : d.toLocaleDateString([], {month: "short", day: "numeric"});
      svg.append(tx);
    });
  }

  function versionMarks(svg, f, series, versions) {
    if (!versions || versions.length < 2) return;   // one version: nothing changed
    const t0 = series[0].t0, t1 = series[series.length - 1].t1;
    for (const ver of versions.slice(1)) {
      const x = f.L + f.pw * (ver.first_started - t0) / (t1 - t0);
      svg.append(svgEl("line", {x1: x, x2: x, y1: f.T, y2: f.T + f.ph, stroke: C.ink2, "stroke-width": 1, "stroke-dasharray": "3 3"}));
      const tx = svgEl("text", {x: x + 3, y: f.T + 9, class: "vizver"});
      tx.textContent = `@${String(ver.version).slice(0, 7)}${ver.dirty ? "*" : ""}`;
      svg.append(tx);
    }
  }

  /* runs over time: stacked bars, succeeded under failed */
  function runsChart(series, versions) {
    const f = frame(series, 180);
    const svg = svgEl("svg", {viewBox: `0 0 ${f.W} ${f.H}`, class: "vizsvg", role: "img",
      "aria-label": "Runs over time, succeeded and failed"});
    const max = Math.max(1, ...series.map(b => b.ok + b.failed));
    const nice = Math.max(1, Math.ceil(max / 3) * 3);
    yAxis(svg, f, nice, (x) => String(Math.round(x)));
    const w = Math.max(2, Math.min(18, f.bw - 4));
    series.forEach((b, i) => {
      const x = f.x(i) - w / 2;
      const hOk = f.ph * b.ok / nice, hBad = f.ph * b.failed / nice;
      const base = f.T + f.ph;
      if (b.ok) svg.append(svgEl("path", {d: bar(x, base - hOk, w, hOk, !b.failed), fill: C.ok}));
      if (b.failed) {
        const gap = b.ok ? 2 : 0;
        svg.append(svgEl("path", {d: bar(x, base - hOk - hBad, w, Math.max(0, hBad - gap), true), fill: C.failed}));
      }
      const hit = svgEl("rect", {x: f.x(i) - f.bw / 2, y: f.T, width: f.bw, height: f.ph, fill: "transparent"});
      hit.addEventListener("pointermove", (ev) => showTip(ev, [
        `${when(b.t0)} – ${when(b.t1)}`, `${b.ok} succeeded`, `${b.failed} failed`]));
      hit.addEventListener("pointerleave", hideTip);
      svg.append(hit);
    });
    xLabels(svg, f, series);
    versionMarks(svg, f, series, versions);
    return svg;
  }

  /* a bar with its data end rounded (4px) and its base square */
  function bar(x, y, w, h, roundTop) {
    if (h <= 0) return "";
    const r = roundTop ? Math.min(4, h, w / 2) : 0;
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  }

  /* p95 over time: one line, no legend (the title names it) */
  function p95Chart(series, versions) {
    const f = frame(series, 150);
    const svg = svgEl("svg", {viewBox: `0 0 ${f.W} ${f.H}`, class: "vizsvg", role: "img", "aria-label": "p95 duration over time"});
    const vals = series.map(b => b.p95_ms);
    const max = Math.max(1, ...vals.filter(x => x != null));
    yAxis(svg, f, max * 1.1, (x) => fmtMs(x));
    let d = "";
    let pen = false;
    vals.forEach((val, i) => {
      if (val == null) { pen = false; return; }
      const y = f.T + f.ph - f.ph * val / (max * 1.1);
      d += `${pen ? "L" : "M"}${f.x(i).toFixed(1)},${y.toFixed(1)} `;
      pen = true;
    });
    svg.append(svgEl("path", {d, fill: "none", stroke: C.line, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"}));
    vals.forEach((val, i) => {
      if (val == null) return;
      const y = f.T + f.ph - f.ph * val / (max * 1.1);
      const dot = svgEl("circle", {cx: f.x(i), cy: y, r: 3, fill: C.line, stroke: C.surface, "stroke-width": 2});
      svg.append(dot);
    });
    const cross = svgEl("line", {x1: 0, x2: 0, y1: f.T, y2: f.T + f.ph, stroke: C.axis, "stroke-width": 1, visibility: "hidden"});
    svg.append(cross);
    series.forEach((b, i) => {
      const hit = svgEl("rect", {x: f.x(i) - f.bw / 2, y: f.T, width: f.bw, height: f.ph, fill: "transparent"});
      hit.addEventListener("pointermove", (ev) => {
        cross.setAttribute("x1", f.x(i)); cross.setAttribute("x2", f.x(i)); cross.setAttribute("visibility", "visible");
        showTip(ev, [`${when(b.t0)} – ${when(b.t1)}`, b.p95_ms == null ? "no runs" : `p95 ${fmtMs(b.p95_ms)}`]);
      });
      hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
      svg.append(hit);
    });
    xLabels(svg, f, series);
    versionMarks(svg, f, series, versions);
    return svg;
  }

  function card(title, body, sub) {
    const c = el("section", "vizcard");
    const h = el("div", "vizcardhead");
    h.append(el("h3", null, title));
    if (sub) h.append(sub);
    c.append(h, body);
    return c;
  }

  function legend(items) {
    const l = el("div", "vizlegend");
    for (const [color, label] of items) {
      const it = el("span", "vizlegend-item");
      const sw = el("span", "vizswatch");
      sw.style.background = color;
      it.append(sw, label);
      l.append(it);
    }
    return l;
  }

  function opsTable(ops) {
    const wrap = el("div", "tablewrap");
    const table = el("table", "datatable optable");
    const hr = el("tr");
    for (const [h, cls, title] of [["Op"], ["p50", "num"], ["p95", "num"], ["p99", "num hide-sm"], ["Max", "num hide-sm"],
      ["Per run", "num hide-sm"],
      ["% of run time", null, "The op's time as a share of the runs' length. Ops that overlap (nested, concurrent) each count their own time, so the column can add up past 100%."],
      ["p95 vs before", "num"]]) {
      const th = el("th", cls || null, h);
      if (title) th.title = title;
      hr.append(th);
    }
    const thead = el("thead"); thead.append(hr); table.append(thead);
    const tbody = el("tbody");
    const topShare = Math.max(0.0001, ...ops.filter(o => !o.background).map(o => o.share));
    for (const o of ops.filter(x => !x.background)) {
      const tr = el("tr");
      const name = el("td");
      name.append(el("span", "mono", o.op));
      if (o.key) name.append(el("span", "keytag", "key"));
      if (o.errors) name.append(el("span", "errtag", `${o.errors} failed`));
      tr.append(name);
      tr.append(el("td", "num", fmtMs(o.p50_ms)), el("td", "num strongnum", fmtMs(o.p95_ms)),
        el("td", "num hide-sm", fmtMs(o.p99_ms)), el("td", "num hide-sm", fmtMs(o.max_ms)),
        el("td", "num hide-sm", o.per_run >= 10 ? Math.round(o.per_run) : o.per_run.toFixed(1)));
      const share = el("td", "sharecell");
      const bar = el("span", "sharebar");
      const fill = el("i");
      fill.style.width = `${Math.max(1, 100 * o.share / topShare).toFixed(1)}%`;
      bar.append(fill);
      share.append(bar, el("span", "sharepct", pct(o.share)));
      tr.append(share);
      const trend = el("td", "num");
      if (o.trend == null) { trend.textContent = "—"; trend.classList.add("dim"); }
      else if (Math.abs(o.trend) < 0.05) { trend.textContent = "≈"; trend.classList.add("dim"); trend.title = "within 5%"; }
      else {
        trend.textContent = `${o.trend > 0 ? "▲" : "▼"} ${Math.abs(100 * o.trend).toFixed(0)}%`;
        trend.classList.add(o.trend > 0 ? "worse" : "better");
        trend.title = `p95 was ${fmtMs(o.prev_p95_ms)} in the previous period`;
      }
      tr.append(trend);
      tbody.append(tr);
    }
    const session = ops.filter(x => x.background);
    if (session.length) {
      const tr = el("tr", "bgop");
      const td = el("td", "dim");
      td.colSpan = 8;
      td.append(el("span", "mono", session.map(x => x.op).join(", ")));
      td.append(` — ${session.length === 1 ? "spans" : "span"} the whole session: their time is the run's length, not latency.`);
      tr.append(td);
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  function costBody(m) {
    const t = m.tiles;
    const body = el("div");
    const row = el("div", "stattiles small");
    const unpriced = t.unpriced ? `+ ${t.unpriced} unpriced call${t.unpriced > 1 ? "s" : ""}` : null;
    row.append(tile("Total", t.cost_usd, m.previous.cost_usd, (x) => RunView.money(x, 0), true,
      t.cost_usd == null ? (unpriced ? `no priced calls ${unpriced}` : "no priced calls") : unpriced));
    row.append(tile("Per run", t.cost_per_run, m.previous.cost_per_run, (x) => RunView.money(x, 0), true,
      t.cost_per_run == null ? "no priced calls" : null));
    row.append(tile("Tokens in", t.tokens_in, m.previous.tokens_in, (x) => x.toLocaleString(), true,
      t.tokens_cached ? `${t.tokens_cached.toLocaleString()} cached` : null));
    row.append(tile("Tokens out", t.tokens_out, m.previous.tokens_out, (x) => x.toLocaleString(), true));
    body.append(row);
    if (m.cost_ops.length) {
      const wrap = el("div", "tablewrap");
      const table = el("table", "datatable");
      const hr = el("tr");
      for (const [h, cls] of [["Op"], ["Cost", "num"], ["Calls", "num"], ["Tokens in", "num hide-sm"], ["Tokens out", "num hide-sm"]]) hr.append(el("th", cls || null, h));
      const thead = el("thead"); thead.append(hr); table.append(thead);
      const tbody = el("tbody");
      for (const o of m.cost_ops) {
        const tr = el("tr");
        tr.append(el("td", "mono", o.op), el("td", "num", RunView.money(o.cost_usd, o.unpriced) || "—"),
          el("td", "num", String(o.count)), el("td", "num hide-sm", o.tokens_in.toLocaleString()),
          el("td", "num hide-sm", o.tokens_out.toLocaleString()));
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      body.append(wrap);
    } else {
      body.append(el("p", "note", "No op in this range reported a cost. LLM ops do once their resource has prices — set them in Resources."));
    }
    return body;
  }

  function errorsBody(errors) {
    if (!errors.length) return el("p", "note", "Nothing failed in this range.");
    const wrap = el("div", "tablewrap");
    const table = el("table", "datatable");
    const hr = el("tr");
    for (const [h, cls] of [["Error"], ["Count", "num"], ["First seen", "hide-sm"], ["Last seen"], [""]]) hr.append(el("th", cls || null, h));
    const thead = el("thead"); thead.append(hr); table.append(thead);
    const tbody = el("tbody");
    for (const e of errors) {
      const tr = el("tr");
      const msg = el("td");
      msg.append(el("div", "errmsg", e.message));
      if (e.op) msg.append(el("div", "cellsub mono", e.op));
      tr.append(msg, el("td", "num strongnum", String(e.count)),
        el("td", "hide-sm nowrap", fmtAgo(e.first_seen * 1000)), el("td", "nowrap", fmtAgo(e.last_seen * 1000)));
      const open = el("td", "num");
      const b = el("button", "linkbtn", "Latest");
      b.type = "button";
      b.append(Icons.svg("right"));
      b.title = `Open ${e.example}`;
      b.onclick = () => { switchTab("traces", {quiet: true}); showRunTree(e.example); };
      open.append(b);
      tr.append(open);
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  async function show() {
    hideTip();
    paletteNow();
    const mine = ++token;
    box.textContent = "";
    const head = el("div", "panehead monhead");
    head.append(el("h2", null, "Monitor"));
    const targets = el("select", "montarget");
    targets.setAttribute("aria-label", "Service or job");
    const opt = (label, value, group) => {
      const o = el("option", null, label);
      o.value = value;
      o.selected = value === v.target;
      (group || targets).append(o);
    };
    opt("Everything", "");
    const ir = state.ir || {};
    const svcs = (ir.services || []).filter(s => s.kind !== "asgi");
    const jobs = (ir.jobs || []).filter(j => j.kind !== "runbook");
    if (svcs.length) { const g = el("optgroup"); g.label = "Services"; for (const s of svcs) opt(s.name, `service:${s.name}`, g); targets.append(g); }
    if (jobs.length) { const g = el("optgroup"); g.label = "Jobs"; for (const j of jobs) opt(j.name, `job:${j.name}`, g); targets.append(g); }
    if (!targets.querySelector("option[selected]") && !targets.value) targets.value = "";
    targets.onchange = () => { v.target = targets.value; store(`monitor:${PID}`, v); show(); };
    const range = el("span", "tlmodes");
    for (const [k, label] of RANGES) {
      const b = el("button", k === v.range ? "on" : "", label);
      b.type = "button";
      b.onclick = () => { v.range = k; store(`monitor:${PID}`, v); show(); };
      range.append(b);
    }
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = show;
    head.append(targets, range, refresh);
    box.append(head);

    const [origin, name] = v.target ? v.target.split(":") : ["", ""];
    const [, , secs, buckets] = RANGES.find(r => r[0] === v.range) || RANGES[1];
    const until = Math.floor(Date.now() / 1000);
    const withPlay = v.withPlay !== false;
    const q = `origin=${origin}&name=${encodeURIComponent(name || "")}&since=${until - secs}&until=${until}`
      + `&buckets=${buckets}&playground=${withPlay ? 1 : 0}`;
    const loading = el("div", "note", "Loading…");
    box.append(loading);
    let m;
    try { m = await api(`/api/p/${PID}/monitor?${q}`); }
    catch (e) { if (mine === token) loading.replaceWith(loadError(e, () => show())); return; }
    if (mine !== token) return;
    loading.remove();
    // a service's playground sessions: counted in unless left out, and said so
    const togglePlay = () => { v.withPlay = !withPlay; store(`monitor:${PID}`, v); show(); };
    const playNote = () => {
      const n = m.playground_runs || 0;
      if (!n) return null;
      const line = el("p", "note monplay");
      const sessions = `${n.toLocaleString()} playground session${n === 1 ? "" : "s"}`;
      const b = el("button", "linkbtn", withPlay ? "Served runs only" : `Include ${sessions}`);
      b.type = "button";
      b.onclick = togglePlay;
      line.append(withPlay ? `Includes ${sessions} · ` : "Served runs only · ", b);
      return line;
    };
    if (!m.tiles.runs) {
      box.append(paneNote("No runs in this range",
        withPlay ? "The Monitor summarises the runs this service or job recorded, its playground sessions included."
          : "The Monitor summarises the runs this service answered; its playground sessions are left out.", null,
        {actions: [...(v.range !== "30d" ? [{label: "Show 30 days", icon: "clock",
          run: () => { v.range = "30d"; store(`monitor:${PID}`, v); show(); }}] : []),
          ...(!withPlay && m.playground_runs ? [{label: `Include ${m.playground_runs} playground sessions`, icon: "play",
            run: togglePlay}] : [{label: "Try a service in the Playground", icon: "play", run: () => switchTab("playground")}])]}));
      return;
    }
    const t = m.tiles, p = m.previous;
    const tiles = el("div", "stattiles");
    tiles.append(tile("Runs", t.runs, p.runs, (x) => x.toLocaleString(), false));
    tiles.append(tile("Error rate", t.error_rate, p.error_rate, pct, true,
      t.errors ? null : "no failures"));
    tiles.append(tile("p50 duration", t.p50_ms, p.p50_ms, fmtMs, true));
    tiles.append(tile("p95 duration", t.p95_ms, p.p95_ms, fmtMs, true));
    box.append(tiles);
    const pn = playNote();
    if (pn) box.append(pn);

    const inner = Math.max(300, box.clientWidth - 56);
    chartW = Math.round(Math.max(300, window.matchMedia("(max-width: 1100px)").matches ? inner - 30 : inner / 2 - 44));
    const charts = el("div", "vizgrid");
    const runsCard = card("Runs", runsChart(m.series, m.versions),
      legend([[C.ok, "Succeeded"], [C.failed, "Failed"]]));
    const latCard = card("p95 duration", p95Chart(m.series, m.versions));
    charts.append(runsCard, latCard);
    box.append(charts);

    box.append(card("Where the time goes", opsTable(m.ops),
      m.key_ops && m.key_ops.length ? el("span", "note", `key ops first: ${m.key_ops.join(", ")}`) : null));
    box.append(card("Cost", costBody(m)));
    box.append(card("What broke", errorsBody(m.errors)));
    if (m.truncated) box.append(el("p", "note", "Only the first 50,000 runs in the range are summarised."));
  }

  registerPane("monitor", {el: box, show});
})();
