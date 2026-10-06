/* operonx studio — Evals: experiments, what changed between two, and datasets.
 *
 * An eval (operonx.app.evals.Eval) runs a dataset of cases through a graph
 * and judges each output; one run is an EXPERIMENT, with a fingerprint
 * (code, graph, config, dataset, evaluators), metrics with intervals and a
 * gate's verdict. Experiments come from the project's score store — so one
 * run in CI shows here — and from this machine's job records. Four pages,
 * each one request:
 *
 *   - an eval's experiments: the trend with its interval, and each
 *     experiment's verdict, pass rate, fingerprint, cost and flakiness;
 *   - one experiment: the gate's verdict and why, the metrics with their
 *     intervals, and its cases — failures first, each opening its trace
 *     with the op its failing check blamed selected;
 *   - A against B: operonx's paired comparison, metric by metric, and
 *     how every case moved — "inconclusive" said as such;
 *   - a dataset: its cases, each with its history across experiments,
 *     edited in place (operonx's Dataset.update writes the JSONL).
 *
 * Every number is the server's, which is operonx's; experiments.js (XP)
 * only words and orders them.
 */

"use strict";

const EvalsView = (() => {
  const box = $("#evals");
  const K = `evals:${PID}`;
  const v = Object.assign({name: "", view: "list", exp: "", a: "", b: "", tol: null, filter: "all", dataset: ""},
                          recall(K, {}));
  let data = null;
  let token = 0;
  let poller = null;

  const save = () => store(K, v);
  const when = (iso) => (iso ? fmtAgo(Date.parse(iso)) : "");
  const preview = (x, n = 140) => {
    if (x === undefined || x === null) return "";
    const s = typeof x === "string" ? x : JSON.stringify(x);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const go = (patch) => { Object.assign(v, patch); save(); show(); };

  function badge(verdict, big) {
    const vd = XP.verdictOf(verdict);
    const b = el("span", `xpbadge ${vd.tone}${big ? " big" : ""}`, vd.label);
    b.title = vd.explain;
    return b;
  }

  function code(fp) {
    const c = XP.codeOf(fp);
    const s = el("span", "xpcode mono", c.sha);
    if (c.dirty) {
      const d = el("i", "xpdirty");
      d.title = "uncommitted changes: this is not that commit's code";
      s.append(d);
      s.title = `${c.sha} with uncommitted changes`;
    } else s.title = fp && fp.code_version ? `commit ${fp.code_version}` : "not a git checkout";
    return s;
  }

  function storeLine(sc, extra) {
    const line = el("div", "xpstore");
    if (!sc) return line;
    if (!sc.openable) {
      line.classList.add("warn");
      line.append(el("b", null, "Score store unavailable — "),
        `${sc.reason || "it cannot be opened"} (${sc.source}). Showing this machine's job records only; experiments run elsewhere are missing.`);
    } else if (sc.error) {
      line.classList.add("warn");
      line.append(el("b", null, "Score store did not answer — "), `${sc.error}. Showing this machine's job records only.`);
    } else {
      // the store in a few words; where exactly, on hover
      const kind = String(sc.label || "").split(" ")[0];
      const what = el("b", null, kind === "files" ? "files + SQLite" : kind === "ClickHouse" ? sc.label.split(" (")[0] : kind);
      line.title = sc.label;
      line.append("Score store ", what, ` · ${sc.source}`);
      if (extra) line.append(` · ${extra}`);
    }
    return line;
  }

  async function patch(path, body) {
    const res = await fetch(path, {method: "PATCH", headers: {"content-type": "application/json"},
                                   body: JSON.stringify(body)});
    const got = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (window.Account) Account.refused(res.status, got.error);
      throw new Error(got.error || res.statusText);
    }
    return got;
  }

  /* ── the pane ─────────────────────────────────────────────────────── */

  async function show(opts) {
    const mine = ++token;
    // opened from elsewhere (the assistant, a studio: link, a test): which
    // eval, and which page of it — an experiment, a comparison, a dataset
    if (opts && (opts.name || opts.dataset)) {
      const exp = opts.exp || opts.run || "";
      Object.assign(v, {name: opts.name || v.name, dataset: opts.dataset || "", exp,
                        view: opts.view || (exp ? "exp" : "list"),
                        a: opts.a || v.a, b: opts.b || v.b, tol: opts.tol !== undefined ? opts.tol : null,
                        filter: opts.filter || "all"});
      save();
    }
    try { data = await api(`/api/p/${PID}/evals`); }
    catch (err) { box.textContent = ""; box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    box.textContent = "";
    const head = el("div", "panehead evhead");
    head.append(el("h2", null, "Evals"));
    box.append(head);
    if (!data.evals.length && !data.datasets.length) {
      box.append(paneNote("No evals yet",
        "An eval runs a dataset of cases through a graph and judges each output — the way to know a change made things better.",
        '# app.py — beside the other jobs in Application(jobs=[...])\nEval("replies", graph=reply_flow, dataset="dataset:replies",   # datasets/replies.jsonl\n     evaluators=[polite, correct], repeats=3,\n     gate=Gate(baseline="latest", tolerance=0.05))',
        {ask: {label: "Set up an eval", prompt: "Set up an eval for this project: pick the main service's graph, "
          + "build a small dataset from its recorded runs (or realistic examples if there are none), write evaluators "
          + "that check what matters, declare it, run it once, and report the pass rate."}}));
      return;
    }
    if (!data.evals.find(e => e.name === v.name) && !v.dataset) v.name = (data.evals[0] || {}).name || "";
    const ev = data.evals.find(e => e.name === v.name);
    const runBtn = el("button", "primary needs-edit", "Run eval");
    runBtn.type = "button";
    runBtn.disabled = !ev || !!v.dataset;
    runBtn.title = "Run every case as a new experiment (operonx eval run), stored in the project's score store";
    runBtn.onclick = () => runEval(v.name, {}, runBtn);
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = () => show();
    head.append(runBtn, refresh);

    // on a phone the list of evals sits above the page: a page past the
    // list (an experiment, a comparison, a dataset) leaves it, with a way back
    const grid = el("div", "evgrid" + (v.dataset || (ev && v.view !== "list") ? " sub" : ""));
    const side = el("div", "evside");
    const main = el("div", "evmain");
    grid.append(side, main);
    box.append(grid);
    sideList(side);

    if (v.dataset) return showDataset(main, v.dataset, mine);
    if (!ev) return;
    if ((ev.runs[0] || {}).status === "running") watch(ev.name);
    if (v.view === "exp" && v.exp) return showExperiment(main, ev, v.exp, mine);
    if (v.view === "compare" && v.a && v.b) return showCompare(main, ev, mine);
    return showList(main, ev);
  }

  function sideList(side) {
    side.append(el("div", "stitle", "Evals"));
    for (const e of data.evals) {
      const last = (e.experiments || [])[0];
      const card = el("button", "evcard" + (e.name === v.name && !v.dataset ? " sel" : ""));
      card.type = "button";
      const top = el("div", "evcard-top");
      top.append(el("span", "evname", e.name));
      if ((e.runs[0] || {}).status === "running") top.append(el("span", "evrunning", "running…"));
      else if (last) top.append(badge(last.verdict));
      card.append(top);
      const ds = (data.datasets || []).find(d => (d.used_by || []).includes(e.name));
      const nev = (e.evaluators || []).length;
      card.append(el("div", "evsub", `${ds ? `${ds.name} · ${ds.cases} cases` : e.dataset} · ${nev} evaluator${nev === 1 ? "" : "s"}`));
      const row = el("div", "evcard-rate");
      row.append(el("span", "evrate", last && last.pass ? XP.pct(last.pass.mean) : "not run"));
      row.append(trendSvg(e.experiments || [], {width: 120, height: 30, pad: 4, mini: true}));
      card.append(row);
      if (last) card.append(el("div", "evsub", `${(e.experiments || []).length} experiments · last ${when(last.started)}`));
      card.onclick = () => go({name: e.name, view: "list", dataset: ""});
      side.append(card);
    }
    side.append(el("div", "stitle evdsh", "Datasets"));
    if (!data.datasets.length) side.append(el("div", "note", "Cases live in datasets/*.jsonl."));
    for (const d of data.datasets) {
      const row = el("button", "evds" + (v.dataset === d.name ? " sel" : ""));
      row.type = "button";
      row.append(el("span", "evname", d.name),
                 el("span", "evsub", d.error ? "unreadable" : `${d.cases} cases · ${d.expected} with expected`));
      row.onclick = () => go({dataset: d.name});
      side.append(row);
    }
  }

  /* pass rate with its 95% interval over experiments, a dot per experiment
   * coloured by its verdict, a dashed line where the code changed */
  function trendSvg(rows, opts) {
    const t = XP.trend(rows, opts);
    const svg = document.createElementNS(SVGNS, "svg");
    const add = (tag, attrs, parent = svg) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val);
      parent.append(n);
      return n;
    };
    svg.setAttribute("viewBox", `0 0 ${t.width} ${t.height}`);
    svg.setAttribute("class", opts.mini ? "evspark" : "xptrend");
    if (opts.mini) { svg.setAttribute("width", t.width); svg.setAttribute("height", t.height); }
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `pass rate with its 95% interval over the last ${t.points.length} experiments`);
    if (!opts.mini) {
      for (const g of [0, 0.5, 1]) {
        add("line", {x1: 0, x2: t.width, y1: t.y(g), y2: t.y(g), class: "xpgrid"});
        const lab = add("text", {x: 2, y: t.y(g) - 3, class: "xpaxis"});
        lab.textContent = `${g * 100}%`;
      }
      for (const m of t.markers) {
        add("line", {x1: m.x, x2: m.x, y1: 4, y2: t.height - 4, class: "xpmark"});
        const lab = add("text", {x: m.x + 3, y: t.height - 6, class: "xpaxis"});
        lab.textContent = m.sha;
      }
    }
    if (t.band) add("path", {d: t.band, class: "xpband"});
    if (t.points.length > 1) add("polyline", {points: t.points.map(p => `${p.x},${p.y}`).join(" "), class: "evspark-line"});
    t.points.forEach((p, i) => {
      const last = i === t.points.length - 1;
      const c = add("circle", {cx: p.x, cy: p.y, r: opts.mini ? (last ? 3.5 : 2.5) : (last ? 5 : 4),
                               class: `xpdot ${XP.verdictOf(p.verdict).tone}`});
      const tt = add("title", {}, c);
      tt.textContent = `${p.id} · ${XP.pct(p.mean)} · ${XP.verdictOf(p.verdict).label} · ${p.sha}`;
      if (!opts.mini) { c.style.cursor = "pointer"; c.onclick = () => go({view: "exp", exp: p.id}); }
    });
    return svg;
  }

  /* ── an eval's experiments ────────────────────────────────────────── */

  function showList(main, ev) {
    const rows = ev.experiments || [];
    const top = el("div", "xptop");
    const title = el("div", "xptitle");
    title.append(el("h3", null, ev.name));
    if (ev.description) title.append(el("div", "evsub", ev.description));
    top.append(title);
    main.append(top, storeLine(data.scores, `${rows.length} experiment${rows.length === 1 ? "" : "s"}`));
    if (!rows.length) {
      main.append(paneNote("Not run yet", `Run ${ev.name} to see how each case does — every run is an experiment.`));
      return;
    }
    const newest = rows[0];
    const chart = el("div", "xpcard xpchart");
    const ch = el("div", "xpcardhead");
    ch.append(el("span", "stitle", "Pass rate, 95% interval"),
              el("span", "evsub", "dots: each experiment's verdict · dashed: the code changed"));
    // drawn at the width it gets, so its labels stay readable on a phone
    const w = Math.max(300, Math.min(960, (main.clientWidth || 640) - 30));
    chart.append(ch, trendSvg(rows.slice(0, 20), {width: w, height: w < 500 ? 120 : 140, pad: 12}));
    const cards = el("div", "xpmetrics");
    const metrics = Object.entries(newest.metrics || {}).sort((x, y) => (x[0] !== "pass") - (y[0] !== "pass"));
    for (const [name, m] of metrics) {
      const c = el("div", "xpmetric");
      c.append(el("span", "xpmname", name), el("span", "xpmval", XP.pct(m.mean)),
               el("span", "xpmci", m.ci_lo != null ? `[${(100 * m.ci_lo).toFixed(1)}–${(100 * m.ci_hi).toFixed(1)}] · n=${m.n}` : `n=${m.n}`));
      c.title = `${name === "pass" ? "pass (every check passed)" : name}: ${XP.ciText(m)} — ${m.method} interval over ${m.n} cases (newest experiment)`;
      cards.append(c);
    }
    main.append(chart, cards);

    // the two experiments a comparison is between: newest against the one before
    const cmp = el("div", "xpcmpbar");
    cmp.append(el("span", "evsub", "Compare"));
    const opts = rows.map(r => [r.id, `${r.variant ? r.variant + " · " : ""}${r.id}`]);
    const selA = selectOf(opts, v.a && rows.find(r => r.id === v.a) ? v.a : (rows[1] || rows[0]).id, "baseline A");
    const selB = selectOf(opts, v.b && rows.find(r => r.id === v.b) ? v.b : rows[0].id, "candidate B");
    const goCmp = el("button", "", "Compare A → B");
    goCmp.type = "button";
    goCmp.disabled = rows.length < 2;
    goCmp.onclick = () => go({view: "compare", a: selA.value, b: selB.value, tol: null});
    cmp.append(selA, el("span", "evsub", "→"), selB, goCmp);
    main.append(cmp);

    const table = el("div", "xptable xpexps");
    const hdr = el("div", "xprow xprow-h");
    ["Verdict", "Experiment", "Pass rate [95% CI]", "Fingerprint", "Repeats", "Cost", "p95", ""]
      .forEach(t => hdr.append(el("span", null, t)));
    table.append(hdr);
    rows.forEach((r, i) => {
      const row = el("div", "xprow click");
      row.tabIndex = 0;
      row.append(el("span", null, ""));
      row.lastChild.append(badge(r.verdict));
      const name = el("span", "xpname");
      name.append(el("b", null, r.variant || r.id));
      const sub = el("span", "evsub mono", `${r.variant ? r.id + " · " : ""}${when(r.started)}`);
      if (r.source === "store") {
        const s = el("span", "chip xpsrc", "store");
        s.title = "No record on this machine: run elsewhere (CI), read from the score store";
        sub.append(" ", s);
      }
      name.append(sub);
      row.append(name);
      const rate = el("span", "xprate");
      rate.append(el("b", null, r.pass ? XP.pct(r.pass.mean) : "—"),
                  el("span", "evsub", r.pass && r.pass.ci_lo != null ? ` [${(100 * r.pass.ci_lo).toFixed(1)}–${(100 * r.pass.ci_hi).toFixed(1)}]` : ""));
      row.append(rate);
      const fp = el("span", "xpfp");
      fp.append(code(r.fingerprint));
      const dv = el("span", "mono evsub", `data ${String(r.fingerprint.dataset_version || "—").slice(0, 7)}`);
      dv.title = `dataset version ${r.fingerprint.dataset_version || "unknown"} · graph ${r.fingerprint.graph_hash || "—"} · config ${r.fingerprint.config_hash || "—"} · evaluators ${r.fingerprint.evaluators_hash || "—"}`;
      fp.append(dv);
      row.append(fp);
      const rep = el("span", null, `×${r.repeats}`);
      if (r.flaky) { rep.append(" ", el("span", "xpflaky", `${r.flaky} flaky`)); }
      row.append(rep);
      const cost = el("span", "mono xpcost");
      cost.append(el("span", "xplab", "system "), XP.money(r.cost_usd), el("span", "evsub", " · "),
                  el("span", "xplab", "judge "), XP.money(r.judge_cost_usd));
      cost.title = "what the system's own model calls cost · what judging cost";
      row.append(cost);
      const p95 = el("span", "mono");
      p95.append(el("span", "xplab", "p95 "), r.p95_ms != null ? fmtMs(r.p95_ms) : "—");
      row.append(p95);
      const acts = el("span", "xpacts");
      const older = rows[i + 1];
      if (older) {
        const c = el("button", "linkbtn", "vs previous");
        c.type = "button";
        c.title = `Compare with ${older.variant || older.id}`;
        c.onclick = (e) => { e.stopPropagation(); go({view: "compare", a: older.id, b: r.id, tol: null}); };
        acts.append(c);
      }
      row.append(acts);
      row.onclick = () => go({view: "exp", exp: r.id, filter: "all"});
      row.onkeydown = (e) => { if (e.key === "Enter") row.onclick(); };
      table.append(row);
    });
    main.append(table);
  }

  function selectOf(options, value, label) {
    const s = el("select", "xpselect");
    s.setAttribute("aria-label", label);
    for (const [val, text] of options) { const o = el("option", null, text); o.value = val; o.selected = val === value; s.append(o); }
    return s;
  }

  function backTo(ev) {
    const b = Icons.button("back", `${ev.name} experiments`, "small ghost", "Back to the experiments");
    b.onclick = () => go({view: "list"});
    return b;
  }

  /* ── one experiment ───────────────────────────────────────────────── */

  async function showExperiment(main, ev, eid, mine) {
    let got;
    try { got = await api(`/api/p/${PID}/experiments/${encodeURIComponent(eid)}`); }
    catch (err) { main.append(backTo(ev), el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    const x = got.experiment, gate = got.gate || {};
    main.append(backTo(ev));
    const head = el("div", "xphead");
    const t = el("div", "xptitle");
    t.append(el("h3", null, x.variant || x.id), el("div", "evsub mono", `${x.id} · ran ${when(x.started)}`));
    head.append(t, badge(gate.verdict, true));
    main.append(head);

    const why = el("div", `xpwhy ${XP.verdictOf(gate.verdict).tone}`);
    why.append(el("p", "xpexplain", XP.verdictOf(gate.verdict).explain));
    if ((gate.reasons || []).length) {
      const ul = el("ul", "xpreasons");
      for (const r of gate.reasons) ul.append(el("li", "mono", r));
      why.append(ul);
    }
    const cmp = gate.comparison;
    if (cmp && cmp.baseline) {
      const line = el("div", "xpbase");
      line.append(`Against the baseline ${cmp.baseline} on ${cmp.cases} shared case${cmp.cases === 1 ? "" : "s"}. `);
      const c = el("button", "linkbtn", "Compare with it");
      c.type = "button";
      c.onclick = () => go({view: "compare", a: cmp.baseline, b: x.id, tol: null});
      line.append(c);
      why.append(line);
    }
    if ((gate.warnings || []).length) {
      const d = el("details", "xpwarn");
      d.append(el("summary", null, `${gate.warnings.length} warning${gate.warnings.length === 1 ? "" : "s"}`));
      for (const w of gate.warnings) d.append(el("div", "mono", w));
      why.append(d);
    }
    main.append(why);

    const facts = el("div", "evfacts");
    const fact = (k, val) => {
      if (val == null || val === "") return;
      const f = el("span", "xpfact");
      f.append(`${k} `, typeof val === "string" ? el("b", null, val) : val);
      facts.append(f, el("span", "vsep", "·"));
    };
    fact("code", code(x.fingerprint));
    fact("dataset", String(x.fingerprint.dataset_version || "—").slice(0, 7));
    fact("cases", String(x.cases));
    fact("repeats", `×${x.repeats}`);
    if (x.errored) fact("errored", String(x.errored));
    fact("system cost", XP.money(x.cost_usd));
    fact("judge cost", XP.money(x.judge_cost_usd));
    if (x.p95_ms != null) fact("p95", fmtMs(x.p95_ms));
    fact("from", x.source === "store" ? "the score store" : "this machine's record");
    if (facts.lastChild) facts.lastChild.remove();
    main.append(facts);

    // metrics: mean, interval, n, method — the interval drawn on 0–100%
    const mt = el("div", "xptable xpmt");
    const mh = el("div", "xprow xprow-h");
    ["Metric", "Mean", "95% interval", "", "n", "Method"].forEach(s => mh.append(el("span", null, s)));
    mt.append(mh);
    for (const m of got.metrics) {
      const r = el("div", "xprow");
      r.append(el("span", "mono", m.name === "pass" ? "pass (every check)" : m.name), el("b", null, XP.pct(m.mean)),
               el("span", "mono", m.ci_lo != null ? `${(100 * m.ci_lo).toFixed(1)}–${(100 * m.ci_hi).toFixed(1)}%` : "—"),
               ciBar(m), el("span", "mono", String(m.n)), el("span", "evsub", m.method));
      mt.append(r);
    }
    main.append(mt);
    const rel = got.reliability || {};
    if (rel.pass_hat_k && x.repeats > 1) {
      const p = el("div", "evsub xprel");
      p.append(`Reliability over ${x.repeats} repeats: `);
      for (const [k, val] of Object.entries(rel.pass_hat_k)) p.append(el("b", null, `pass^${k} ${XP.pct(val)}`), " ");
      p.append(`· ${rel.stable_pass || 0} always pass, ${rel.stable_fail || 0} always fail, ${rel.flaky || 0} flaky`);
      main.append(p);
    }

    // the cases, failures first
    const cases = XP.sortCases(got.cases);
    const bar = el("span", "tlmodes evfilters");
    for (const f of XP.filterCounts(cases)) {
      if (f.key !== "all" && !f.n) continue;
      const b = el("button", f.key === v.filter ? "on" : "", `${f.label} ${f.n}`);
      b.type = "button";
      b.dataset.key = f.key;
      b.onclick = () => { v.filter = f.key; save(); paint(); };
      bar.append(b);
    }
    main.append(bar);
    const table = el("div", "xptable xpcases");
    main.append(table);

    function paint() {
      for (const b of bar.children) b.classList.toggle("on", b.dataset.key === v.filter);
      table.textContent = "";
      const shown = XP.filterCases(cases, v.filter);
      if (!shown.length) { table.append(el("div", "note xppad", "No cases here.")); return; }
      const hdr = el("div", "xprow xprow-h");
      ["Repeats", "Case", "Why it failed", "Output", ""].forEach(s => hdr.append(el("span", null, s)));
      table.append(hdr);
      for (const c of shown) table.append(caseRow(c, ev, x));
    }
    paint();
  }

  function ciBar(m) {
    const w = el("span", "xpci");
    if (m.ci_lo == null) return w;
    const band = el("i", "xpciband");
    band.style.left = `${100 * m.ci_lo}%`;
    band.style.width = `${Math.max(0.5, 100 * (m.ci_hi - m.ci_lo))}%`;
    const dot = el("b", "xpcidot");
    dot.style.left = `${100 * m.mean}%`;
    w.append(band, dot);
    w.title = XP.ciText(m);
    return w;
  }

  function marks(runs) {
    const s = el("span", "xpmarks");
    XP.repeatMarks(runs).forEach((m, i) => {
      const d = el("i", m === null ? "err" : m ? "ok" : "bad");
      d.title = `repeat ${i}: ${m === null ? "errored" : m ? "passed" : "failed"}`;
      s.append(d);
    });
    return s;
  }

  function traceButton(run, op, label) {
    const a = el("a", "linkbtn xptrace", label);
    a.href = XP.deepLink(PID, run, op);
    a.title = op ? `Open the trace with ${XP.opNameOf(op)} selected (${op})` : "Open the trace";
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;  // a new tab: the deep link
      e.preventDefault(); e.stopPropagation();
      performUi("open_run", {run, op, quiet: true});
    };
    return a;
  }

  function caseRow(c, ev, x) {
    const wrap = el("div", "xpcase" + (c.passes < c.trials ? " bad" : ""));
    const r = el("div", "xprow click");
    r.tabIndex = 0;
    r.append(marks(c.runs));
    const id = el("span", "evcaseid");
    id.append(el("b", "mono", c.case));
    if (c.flip) id.append(el("span", `evflip ${c.flip}`, c.flip));
    if (c.stability === "flaky") {
      const f = el("span", "xpflaky", `flaky ${c.passes}/${c.trials}`);
      f.title = "passed some repeats and failed others: not a regression by itself";
      id.append(f);
    }
    for (const tg of c.tags || []) id.append(el("span", "chip", tg));
    r.append(id);
    const why = el("span", "evchecks");
    const firstBad = c.runs.find(run => !run.passed) || c.runs[0];
    if (firstBad && firstBad.error) why.append(el("span", "evcheck bad", String(firstBad.error).slice(0, 120)));
    for (const name of c.failed_checks) {
      const chk = (firstBad.checks || {})[name] || {};
      why.append(el("span", "evcheck bad", `✗ ${name}`));
      if (chk.reason) why.append(el("span", "evwhy", chk.reason));
    }
    if (!c.failed_checks.length && !(firstBad && firstBad.error)) why.append(el("span", "evcheck ok", "✓ every check"));
    r.append(why);
    r.append(el("span", "mono evval", preview(firstBad ? firstBad.output : null)));
    const acts = el("span", "xpacts");
    const run = c.blame || (firstBad && firstBad.trace_id ? {trace_id: firstBad.trace_id} : null);
    if (run && run.trace_id) acts.append(traceButton(run.trace_id, run.op, run.op ? `Trace · ${XP.opNameOf(run.op)}` : "Trace"));
    r.append(acts);
    wrap.append(r);
    let open = null;
    r.onclick = () => {
      if (open) { open.remove(); open = null; r.classList.remove("open"); return; }
      open = drill(c, ev, x);
      r.classList.add("open");
      wrap.append(open);
    };
    r.onkeydown = (e) => { if (e.key === "Enter") r.onclick(); };
    return wrap;
  }

  /* a case opened: what it asked and expected, every repeat with its
   * checks and trace, and the case across the eval's experiments */
  function drill(c, ev, x) {
    const p = el("div", "xpdrill");
    const io = el("div", "xpio");
    const field = (k, val, note) => {
      const f = el("div", "xpfield");
      f.append(el("div", "stitle", k));
      f.append(el("pre", "mono", val === undefined || val === null ? "—" : typeof val === "string" ? val : JSON.stringify(val, null, 2)));
      if (note) f.append(el("div", "evsub", note));
      io.append(f);
    };
    field("Input", c.in_dataset ? c.input : null, c.in_dataset ? null : "not in the dataset any more");
    field("Expected", c.expected, c.case_changed ? "the case was edited since this experiment: this is what it expected then, where kept" : null);
    p.append(io);
    const reps = el("div", "xpreps");
    for (const run of c.runs) {
      const rr = el("div", "xprep" + (run.passed ? "" : " bad"));
      const top = el("div", "xpreptop");
      top.append(el("span", "status " + (run.passed ? "s-ok" : "s-bad"), `repeat ${run.repeat}`),
                 el("span", "evsub mono", `${run.ms != null ? fmtMs(run.ms) : ""}${run.cost_usd != null ? " · " + XP.money(run.cost_usd) : ""}`));
      const bad = Object.entries(run.checks || {}).find(([, k]) => !k.passed && k.op);
      if (run.trace_id) top.append(traceButton(run.trace_id, bad ? bad[1].op : undefined, "Open trace"));
      rr.append(top);
      if (run.error) rr.append(el("div", "evcheck bad", run.error));
      for (const [name, k] of Object.entries(run.checks || {})) {
        const line = el("div", "xpchk");
        line.append(el("span", "evcheck " + (k.passed ? "ok" : "bad"), `${k.passed ? "✓" : "✗"} ${name}`));
        if (k.reason) line.append(el("span", "evwhy", k.reason));
        if (k.op && !k.passed) line.append(el("span", "chip mono", `blames ${XP.opNameOf(k.op)}`));
        if (k.cost_usd != null) line.append(el("span", "evsub", XP.money(k.cost_usd)));
        rr.append(line);
      }
      rr.append(el("pre", "mono xpout", preview(run.output, 600)));
      reps.append(rr);
    }
    p.append(reps);
    const hist = el("div", "xphist");
    hist.append(el("div", "stitle", "This case across experiments"), el("div", "note", "Loading…"));
    p.append(hist);
    const acts = el("div", "xpdrillacts");
    const rerun = el("button", "needs-edit", "Re-run ×5");
    rerun.type = "button";
    rerun.title = "Run only this case five times: a flip or a flake?";
    rerun.onclick = () => runEval(ev.name, {cases: [c.case], repeats: 5, variant: `recheck ${c.case} ×5`}, rerun);
    const edit = el("button", "needs-edit", "Edit in dataset");
    edit.type = "button";
    edit.disabled = !c.in_dataset;
    const ds = (data.datasets || []).find(d => (d.used_by || []).includes(ev.name));
    edit.onclick = () => { if (ds) go({dataset: ds.name, editing: c.case}); };
    acts.append(rerun, edit);
    p.append(acts);
    api(`/api/p/${PID}/experiments/${encodeURIComponent(x.id)}/cases/${encodeURIComponent(c.case)}`).then(got => {
      hist.lastChild.remove();
      hist.append(strip(got.experiments || [], got.history || [], x.id));
    }).catch(err => { hist.lastChild.textContent = err.message; });
    return p;
  }

  /* a case's cells across experiments, oldest left */
  function strip(columns, cells, here) {
    const s = el("span", "xpstrip");
    XP.historyRow(columns, cells).forEach((cell, i) => {
      const col = columns[i];
      const d = el("button", `xpcell ${cell.tone}${col.id === here ? " here" : ""}`, cell.label);
      d.type = "button";
      d.title = `${col.variant || col.id} · ${cell.title}`;
      d.onclick = (e) => { e.stopPropagation(); go({view: "exp", exp: col.id, dataset: ""}); };
      s.append(d);
    });
    return s;
  }

  /* ── A against B ──────────────────────────────────────────────────── */

  async function showCompare(main, ev, mine) {
    const q = new URLSearchParams({a: v.a, b: v.b});
    if (v.tol != null) q.set("tolerance", v.tol);
    let got;
    try { got = await api(`/api/p/${PID}/experiments/compare?${q}`); }
    catch (err) { main.append(backTo(ev), el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    main.append(backTo(ev));
    const rows = ev.experiments || [];
    const head = el("div", "xphead");
    const t = el("div", "xptitle");
    t.append(el("h3", null, `${got.a.variant || got.a.id} → ${got.b.variant || got.b.id}`),
             el("div", "evsub", "B against A, paired on the cases both ran — operonx's comparison"));
    head.append(t, badge(got.verdict, true));
    main.append(head);

    const pick = el("div", "xpcmpbar");
    const opts = rows.map(r => [r.id, `${r.variant ? r.variant + " · " : ""}${r.id}`]);
    const selA = selectOf(opts, got.a.id, "baseline A");
    const selB = selectOf(opts, got.b.id, "candidate B");
    const tol = el("input", "xptol");
    tol.type = "number"; tol.min = "0"; tol.max = "100"; tol.step = "0.5";
    tol.value = got.tolerance ? String(+(100 * got.tolerance.value).toFixed(2)) : "";
    tol.placeholder = "none";
    tol.setAttribute("aria-label", "tolerance in points");
    const apply = el("button", "", "Compare");
    apply.type = "button";
    apply.onclick = () => go({a: selA.value, b: selB.value,
                              tol: tol.value === "" ? "" : String(Number(tol.value) / 100)});
    const tl = el("label", "evsel");
    tl.append(el("span", null, "tolerance (pts)"), tol);
    pick.append(el("span", "evsub", "A"), selA, el("span", "evsub", "B"), selB, tl, apply);
    main.append(pick);
    if (got.tolerance) main.append(el("div", "evsub", `Tolerance ${(100 * got.tolerance.value).toFixed(1)} pts — ${got.tolerance.from}.`));

    const why = el("div", `xpwhy ${XP.verdictOf(got.verdict).tone}`);
    why.append(el("p", "xpexplain", XP.verdictOf(got.verdict).explain));
    if ((got.reasons || []).length) {
      const ul = el("ul", "xpreasons");
      for (const r of got.reasons) ul.append(el("li", "mono", r));
      why.append(ul);
    }
    main.append(why);
    if ((got.warnings || []).length) {
      const w = el("div", "xpstore warn");
      w.append(el("b", null, "Not directly comparable — "), got.warnings.join("; "));
      main.append(w);
    }

    const c = got.comparison;
    const mt = el("div", "xptable xpcmpm");
    const mh = el("div", "xprow xprow-h");
    ["Metric", "A", "B", "B − A", "95% CI of B − A", "", "p", "Verdict"].forEach(s => mh.append(el("span", null, s)));
    mt.append(mh);
    for (const tst of c.tests) {
      const r = el("div", "xprow");
      const ab = (k, x) => { const s = el("span"); s.append(el("span", "xplab", `${k} `), XP.pct(x)); return s; };
      r.append(el("span", "mono", tst.metric), ab("A", tst.a), ab("B", tst.b),
               el("b", tst.diff < 0 ? "xpneg" : tst.diff > 0 ? "xppos" : "", XP.pts(tst.diff)),
               el("span", "mono", XP.diffCi(tst)), diffBar(tst));
      const pv = tst.gated ? tst.p_holm : tst.q_bh;
      const p = el("span", "mono", pv != null ? `${tst.gated ? "p" : "q"}=${Number(pv).toPrecision(2)}` : "—");
      p.title = `${tst.method}${tst.units != null ? ` over ${tst.units} units` : ""}; n=${tst.n}`
        + `${tst.regressed != null ? `; ${tst.regressed} pass→fail, ${tst.fixed} fail→pass` : ""}`
        + (tst.gated ? "; Holm-adjusted" : "; Benjamini–Hochberg q, exploratory");
      r.append(p);
      if (tst.gated) r.append(tst.verdict ? badge(tst.verdict) : el("span", "evsub", "not judged"));
      else r.append(el("span", "evsub", tst.significant ? "exploratory · notable" : "exploratory"));
      mt.append(r);
    }
    main.append(mt);
    main.append(el("div", "evsub", `${c.cases} shared case${c.cases === 1 ? "" : "s"}`
      + (c.changed_cases ? `, ${c.changed_cases} edited (left out)` : "")
      + (c.only_in_baseline ? `, ${c.only_in_baseline} only in A` : "")
      + (c.only_in_this_run ? `, ${c.only_in_this_run} only in B` : "")
      + (c.flips && !c.flips.verified ? " · one repeat per side: a flip may be a flake" : "")));

    const cost = el("div", "evfacts");
    const pair = (k, a, b, fmt) => {
      cost.append(el("span", null, `${k} `), el("b", null, `${fmt(a)} → ${fmt(b)}`), el("span", "vsep", "·"));
    };
    pair("system cost", got.a.cost_usd, got.b.cost_usd, XP.money);
    pair("judge cost", got.a.judge_cost_usd, got.b.judge_cost_usd, XP.money);
    pair("p95", got.a.p95_ms, got.b.p95_ms, (x) => (x == null ? "—" : fmtMs(x)));
    cost.lastChild.remove();
    main.append(cost);

    const groups = XP.groupByClass(got.cases);
    const flips = el("div", "xpflips");
    for (const g of groups) {
      const sec = el("details", `xpgroup ${g.key}`);
      sec.open = !["same", "noise"].includes(g.key);
      const sum = el("summary");
      sum.append(el("b", null, `${g.label} ${g.cases.length}`));
      if (g.hint) sum.append(el("span", "evsub", ` — ${g.hint}`));
      sec.append(sum);
      const list = el("div", "xpflist");
      for (const cs of g.cases) {
        const it = el("span", "xpfcase");
        it.append(el("b", "mono", cs.case));
        it.append(el("span", "evsub", ` ${cs.a ? `${cs.a.passes}/${cs.a.trials}` : "—"} → ${cs.b ? `${cs.b.passes}/${cs.b.trials}` : "—"}`));
        list.append(it);
      }
      sec.append(list);
      flips.append(sec);
    }
    main.append(flips);
  }

  /* a difference's interval on −50…+50 points around 0, with the tolerance */
  function diffBar(t) {
    const w = el("span", "xpci xpdiff");
    const at = (d) => Math.max(0, Math.min(100, 50 + 100 * d));
    const zero = el("i", "xpzero"); zero.style.left = "50%";
    w.append(zero);
    if (t.tolerance != null) { const tl = el("i", "xptolline"); tl.style.left = `${at(-t.tolerance)}%`; w.append(tl); }
    if (t.ci_lo != null) {
      const band = el("i", "xpciband");
      band.style.left = `${at(t.ci_lo)}%`;
      band.style.width = `${Math.max(0.5, at(t.ci_hi) - at(t.ci_lo))}%`;
      w.append(band);
    }
    const dot = el("b", "xpcidot"); dot.style.left = `${at(t.diff)}%`;
    w.append(dot);
    w.title = `${XP.pts(t.diff)} ${XP.diffCi(t)}${t.tolerance != null ? `; tolerance −${(100 * t.tolerance).toFixed(1)} pts (red line)` : ""}`;
    return w;
  }

  /* ── a dataset ────────────────────────────────────────────────────── */

  async function showDataset(main, name, mine) {
    let got;
    try { got = await api(`/api/p/${PID}/datasets/${encodeURIComponent(name)}`); }
    catch (err) { main.append(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    const back = Icons.button("back", "Evals", "small ghost", "Back to the evals");
    back.onclick = () => go({dataset: "", view: "list"});
    main.append(back);
    const head = el("div", "xphead");
    const t = el("div", "xptitle");
    t.append(el("h3", null, name), el("div", "evsub mono", got.shown || got.path));
    head.append(t);
    main.append(head);
    const facts = el("div", "evfacts");
    const fact = (k, val) => { facts.append(el("span", null, `${k} `), el("b", null, String(val)), el("span", "vsep", "·")); };
    fact("version", String(got.version).slice(0, 7));
    fact("cases", got.active === got.total ? got.total : `${got.active} active of ${got.total}`);
    for (const [s, n] of Object.entries(got.splits || {})) fact(`split ${s}`, n);
    if ((got.used_by || []).length) fact("used by", got.used_by.join(", "));
    facts.lastChild.remove();
    main.append(facts);
    main.append(el("div", "evsub", "Edits rewrite the case's line in the JSONL (operonx Dataset.update) — commit it like code. Archived cases stay in the file and are out of every run."));
    if ((got.problems || []).length) {
      const pb = el("div", "xpstore warn");
      pb.append(el("b", null, `${got.problems.length} problem${got.problems.length === 1 ? "" : "s"} — `),
                got.problems.slice(0, 5).map(p => `line ${p.line}: ${p.why}`).join("; "));
      main.append(pb);
    }
    const cols = got.experiments || [];
    const table = el("div", "xptable xpds");
    const hdr = el("div", "xprow xprow-h");
    ["Case", "Input", "Expected", cols.length ? `History · last ${cols.length} experiments` : "History", ""].forEach(s => hdr.append(el("span", null, s)));
    table.append(hdr);
    for (const r of got.rows) table.append(dsRow(name, r, cols, (got.history || {})[r.id] || []));
    main.append(table);
    if (got.total > got.rows.length) main.append(el("p", "note", `Showing the first ${got.rows.length} of ${got.total}.`));
    if (v.editing) {
      const target = table.querySelector(`[data-case="${CSS.escape(v.editing)}"] .xpedit`);
      v.editing = ""; save();
      if (target) { target.click(); target.scrollIntoView({block: "center"}); }
    }
  }

  function dsRow(name, r, cols, cells) {
    const wrap = el("div", "xpcase" + (r.status === "archived" ? " archived" : ""));
    wrap.dataset.case = r.id;
    const row = el("div", "xprow");
    const id = el("span", "evcaseid");
    id.append(el("b", "mono", r.id));
    if (r.status === "archived") id.append(el("span", "chip xparch", "archived"));
    if (r.split) id.append(el("span", "chip xpsplit", r.split));
    for (const tg of r.tags || []) id.append(el("span", "chip", tg));
    row.append(id, el("span", "mono evval", preview(r.input, 160)), el("span", "mono evval", preview(r.expected, 160)));
    const h = el("span", "xphistcell");
    if (cols.length) h.append(strip(cols, cells, null)); else h.append(el("span", "evsub", "no experiments yet"));
    row.append(h);
    const acts = el("span", "xpacts");
    const edit = el("button", "linkbtn needs-edit xpedit", "Edit");
    edit.type = "button";
    acts.append(edit);
    if (r.from && r.from.run) {
      const o = el("button", "linkbtn", "Source run"); o.type = "button";
      o.onclick = () => performUi("open_run", {run: r.from.run, quiet: true});
      acts.append(o);
    }
    row.append(acts);
    wrap.append(row);
    let form = null;
    edit.onclick = () => {
      if (form) { form.remove(); form = null; return; }
      form = editForm(name, r, () => { form.remove(); form = null; });
      wrap.append(form);
      form.querySelector("textarea").focus();
    };
    return wrap;
  }

  function editForm(name, r, close) {
    const f = el("form", "xpform");
    const field = (label, input) => { const l = el("label", "xpfl"); l.append(el("span", null, label), input); f.append(l); return input; };
    const exp = el("textarea", "mono");
    exp.rows = Math.min(8, Math.max(2, XP.expectedText(r.expected).split("\n").length));
    exp.value = XP.expectedText(r.expected);
    field("Expected — JSON, or plain text", exp);
    const tags = el("input"); tags.value = (r.tags || []).join(", ");
    field("Tags — comma separated; critical = must-pass", tags);
    const split = el("input"); split.value = r.split || ""; split.placeholder = "dev, test, smoke…";
    field("Split", split);
    const note = el("input"); note.value = r.note || "";
    field("Note", note);
    const err = el("div", "errbox");
    err.hidden = true;
    const acts = el("div", "xpformacts");
    const saveBtn = el("button", "primary", "Save"); saveBtn.type = "submit";
    const arch = el("button", "", r.status === "archived" ? "Restore" : "Archive");
    arch.type = "button";
    arch.title = r.status === "archived" ? "Back into every run" : "Keep it in the file (its history stays) and out of every run";
    const cancel = el("button", "ghost", "Cancel"); cancel.type = "button";
    cancel.onclick = close;
    acts.append(saveBtn, arch, cancel);
    f.append(err, acts);
    const send = async (changes, btn) => {
      btn.disabled = true; err.hidden = true;
      try {
        await patch(`/api/p/${PID}/datasets/${encodeURIComponent(name)}/rows/${encodeURIComponent(r.id)}`, changes);
        toast(`Saved ${r.id} — commit datasets/${name}.jsonl to share it`);
        show();
      } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
    };
    f.onsubmit = (e) => {
      e.preventDefault();
      const got = XP.changesOf(r, {expected: exp.value, tags: tags.value, split: split.value, note: note.value});
      if (got.error) { err.textContent = got.error; err.hidden = false; return; }
      if (!Object.keys(got.changes).length) { close(); return; }
      send(got.changes, saveBtn);
    };
    arch.onclick = () => send({status: r.status === "archived" ? "active" : "archived"}, arch);
    return f;
  }

  /* ── running ──────────────────────────────────────────────────────── */

  async function runEval(name, body, btn) {
    btn.disabled = true;
    try { await api(`/api/p/${PID}/evals/${encodeURIComponent(name)}/run`, body); toast(`Running ${name}…`); }
    catch (err) { toast(err.message, true); btn.disabled = false; return; }
    Object.assign(v, {view: "list"}); save();
    setTimeout(() => show(), 800);
    watch(name);
  }

  /* while a run is going, look again every 2 s; show it when it ends */
  function watch(name) {
    if (poller) return;
    poller = setInterval(async () => {
      if (box.hidden) { clearInterval(poller); poller = null; return; }
      let got;
      try { got = await api(`/api/p/${PID}/evals`); } catch { return; }
      const ev = got.evals.find(e => e.name === name);
      if (!ev || (ev.runs[0] || {}).status !== "running") {
        clearInterval(poller); poller = null;
        show();
      }
    }, 2000);
  }

  registerPane("evals", {el: box, show});
  return {show};
})();
