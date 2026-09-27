/* operonx studio — Evals: datasets of cases, and how the system does on them.
 *
 * An eval (operonx.app.evals.Eval) is a job: a dataset, the system under
 * test, evaluators. Its runs are job records whose items carry verdicts.
 * This pane lists the evals with their pass rate over time, runs one, and
 * reads a run case by case against an earlier one — which cases a change
 * fixed and which it broke. Datasets are JSONL files; their cases show
 * here, and cases arrive from the playground ("Add to dataset").
 */

"use strict";

const EvalsView = (() => {
  const box = $("#evals");
  const K = `evals:${PID}`;
  const v = Object.assign({name: "", run: "", against: "", filter: "all", dataset: ""}, recall(K, {}));
  let data = null;
  let token = 0;
  let poller = null;

  const save = () => store(K, v);
  const pct = (x) => (x == null ? "—" : `${(100 * x).toFixed(x === 1 || x === 0 ? 0 : 1)}%`);
  const rateText = (e) => (e && e.cases ? `${e.passed}/${e.cases}` : "—");
  const when = (iso) => (iso ? fmtAgo(Date.parse(iso)) : "");
  const preview = (x, n = 120) => {
    if (x === undefined) return "";
    const s = typeof x === "string" ? x : JSON.stringify(x);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };

  /* pass rate over runs, oldest → newest: one series, so no legend; the
   * number beside it names it */
  function spark(runs) {
    const pts = runs.filter(r => r.eval && r.eval.cases).slice(0, 20).reverse();
    const W = 120, H = 30, P = 4;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.setAttribute("class", "evspark");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `pass rate over the last ${pts.length} runs`);
    if (!pts.length) return svg;
    const x = (i) => pts.length === 1 ? W - P : P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = (r) => H - P - r * (H - 2 * P);
    const base = document.createElementNS(SVGNS, "line");
    Object.entries({x1: P, x2: W - P, y1: y(1), y2: y(1), class: "evspark-top"}).forEach(([k, val]) => base.setAttribute(k, val));
    svg.append(base);
    if (pts.length > 1) {
      const path = document.createElementNS(SVGNS, "polyline");
      path.setAttribute("points", pts.map((r, i) => `${x(i)},${y(r.eval.pass_rate)}`).join(" "));
      path.setAttribute("class", "evspark-line");
      svg.append(path);
    }
    pts.forEach((r, i) => {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", x(i)); c.setAttribute("cy", y(r.eval.pass_rate));
      c.setAttribute("r", i === pts.length - 1 ? 3.5 : 2.5);
      c.setAttribute("class", "evspark-dot" + (i === pts.length - 1 ? " last" : ""));
      const t = document.createElementNS(SVGNS, "title");
      t.textContent = `${r.run_id} · ${rateText(r.eval)} passed (${pct(r.eval.pass_rate)})`;
      c.append(t);
      svg.append(c);
    });
    return svg;
  }

  async function show(opts) {
    const mine = ++token;
    if (opts && opts.name) { v.name = opts.name; v.run = opts.run || ""; v.against = ""; v.dataset = ""; save(); }
    // one round trip: the list carries the run the screen opens
    const q = new URLSearchParams({name: v.name || "", run: v.run || "", against: v.against || ""});
    try { data = await api(`/api/p/${PID}/evals?${q}`); }
    catch (err) { box.textContent = ""; box.append(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    box.textContent = "";
    const head = el("div", "panehead evhead");
    head.append(el("h2", null, "Evals"));
    box.append(head);
    if (!data.evals.length && !data.datasets.length) {
      box.append(paneNote("No evals yet",
        "An eval runs a dataset of cases through a graph and judges each output. Declare one in operonx.toml — or ask the assistant to set one up:",
        '[[job]]\nname       = "replies"\ngraph      = "bot:reply_flow"\ndataset    = "dataset:replies"     # datasets/replies.jsonl\nevaluators = ["evals:polite", "evals:correct"]\nthreshold  = 0.9'));
      return;
    }
    if (!data.evals.find(e => e.name === v.name) && !v.dataset) v.name = (data.evals[0] || {}).name || "";
    const runBtn = el("button", "primary", "Run eval");
    runBtn.type = "button";
    runBtn.disabled = !v.name || !!v.dataset;
    runBtn.onclick = () => runEval(v.name, runBtn);
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = () => show();
    head.append(runBtn, refresh);

    const grid = el("div", "evgrid");
    const side = el("div", "evside");
    const main = el("div", "evmain");
    grid.append(side, main);
    box.append(grid);

    side.append(el("div", "stitle", "Evals"));
    for (const e of data.evals) {
      const last = (e.runs || [])[0];
      const card = el("button", "evcard" + (e.name === v.name && !v.dataset ? " sel" : ""));
      card.type = "button";
      const top = el("div", "evcard-top");
      top.append(el("span", "evname", e.name));
      if (last && last.status === "running") top.append(el("span", "evrunning", "running…"));
      card.append(top);
      const ds = (data.datasets || []).find(d => (d.used_by || []).includes(e.name));
      card.append(el("div", "evsub", `${ds ? `${ds.name} · ${ds.cases} cases` : e.dataset} · ${(e.evaluators || []).length} evaluator${(e.evaluators || []).length === 1 ? "" : "s"}`));
      const row = el("div", "evcard-rate");
      const le = last && last.eval;
      row.append(el("span", "evrate" + (le && le.cases ? (le.passed === le.cases ? " ok" : " bad") : ""),
                    le && le.cases ? pct(le.pass_rate) : "not run"));
      row.append(spark(e.runs || []));
      card.append(row);
      if (last) card.append(el("div", "evsub", `${rateText(le)} passed · ${when(last.started)}`));
      card.onclick = () => { v.name = e.name; v.run = ""; v.against = ""; v.dataset = ""; save(); show(); };
      side.append(card);
    }
    side.append(el("div", "stitle evdsh", "Datasets"));
    if (!data.datasets.length) side.append(el("div", "note", "Cases live in datasets/*.jsonl."));
    for (const d of data.datasets) {
      const row = el("button", "evds" + (v.dataset === d.name ? " sel" : ""));
      row.type = "button";
      row.append(el("span", "evname", d.name),
                 el("span", "evsub", d.error ? "unreadable" : `${d.cases} cases · ${d.expected} with expected`));
      row.onclick = () => { v.dataset = d.name; save(); show(); };
      side.append(row);
    }

    if (v.dataset) return showDataset(main, v.dataset, mine);
    const ev = data.evals.find(e => e.name === v.name);
    if (!ev) return;
    const runs = (ev.runs || []).filter(r => r.status !== "running");
    if (!ev.runs.length) {
      main.append(paneNote("Not run yet", `Run ${ev.name} to see how each case does.`));
      return;
    }
    if ((ev.runs[0] || {}).status === "running") watch(ev.name);
    if (!runs.length) { main.append(el("div", "note", "The first run is under way…")); return; }
    if (!runs.find(r => r.run_id === v.run)) v.run = runs[0].run_id;
    await showRun(main, ev, runs, mine);
  }

  async function showRun(main, ev, runs, mine) {
    const pre = data && data.detail;
    let got = pre && pre.name === ev.name && pre.run_id === v.run && (pre.against_asked || "") === (v.against || "")
      ? pre : null;
    if (!got) {
      const q = v.against ? `?against=${encodeURIComponent(v.against)}` : "";
      try { got = await api(`/api/p/${PID}/evals/${encodeURIComponent(ev.name)}/runs/${encodeURIComponent(v.run)}${q}`); }
      catch (err) { main.append(el("div", "errbox", err.message)); return; }
    }
    if (mine !== token) return;
    const e = got.run.eval || {};
    const a = got.against_eval;

    // the verdict: the rate, how it moved, the counts
    const head = el("div", "evrunhead");
    const big = el("div", "evbig");
    big.append(el("span", "evbignum", pct(e.pass_rate)), el("span", "evbiglabel", `passed · ${rateText(e)} cases`));
    head.append(big);
    if (a && a.cases && e.cases) {
      const d = 100 * ((e.pass_rate || 0) - (a.pass_rate || 0));
      const moved = el("div", "evdelta " + (d > 0.05 ? "up" : d < -0.05 ? "down" : ""),
        Math.abs(d) < 0.05 ? "same as before" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)} pts vs ${rateText(a)} before`);
      head.append(moved);
    }
    const facts = el("div", "evfacts");
    const fact = (k, val) => { if (val == null || val === "") return; facts.append(el("span", null, `${k} `), el("b", null, String(val))); facts.append(el("span", "vsep", "·")); };
    fact("status", got.run.status);
    fact("failed", e.failed);
    if (e.errored) fact("errored", e.errored);
    if (e.threshold != null) fact("gate", pct(e.threshold));
    if (e.p50_ms != null) fact("p50", fmtMs(e.p50_ms));
    if (e.judge_cost_usd != null) fact("judge cost", `$${e.judge_cost_usd.toFixed(4)}`);
    fact("ran", when(got.run.started));
    if (facts.lastChild) facts.lastChild.remove();
    head.append(facts);
    main.append(head);

    // which run, against which
    const pick = el("div", "evpick");
    const sel = (label, value, options, onchange) => {
      const wrap = el("label", "evsel");
      wrap.append(el("span", null, label));
      const s = el("select");
      for (const [val, text] of options) { const o = el("option", null, text); o.value = val; o.selected = val === value; s.append(o); }
      s.onchange = () => onchange(s.value);
      wrap.append(s);
      return wrap;
    };
    const runOpts = runs.map(r => [r.run_id, `${r.run_id} · ${r.eval && r.eval.cases ? pct(r.eval.pass_rate) : r.status}`]);
    pick.append(sel("Run", v.run, runOpts, (x) => { v.run = x; v.against = ""; save(); show(); }));
    const older = runs.filter(r => r.run_id < v.run);
    pick.append(sel("Against", got.against || "", [["", older.length ? "the run before" : "nothing earlier"], ...older.map(r => [r.run_id, r.run_id])],
      (x) => { v.against = x; save(); show(); }));
    main.append(pick);

    // the cases
    const flips = got.flips || {};
    const failed = got.items.filter(i => !(i.verdict || {}).passed);
    const filters = [["all", `All ${got.items.length}`], ["failed", `Failed ${failed.length}`], ["changed", `Changed ${Object.keys(flips).length}`]];
    const bar = el("span", "tlmodes evfilters");
    for (const [k, label] of filters) {
      const b = el("button", k === v.filter ? "on" : "", label);
      b.type = "button";
      b.onclick = () => { v.filter = k; save(); paint(); };
      bar.append(b);
    }
    main.append(bar);
    const table = el("div", "evcases");
    main.append(table);
    const checksOf = (vd) => Object.entries((vd && vd.checks) || {});

    function paint() {
      for (const b of bar.children) b.classList.toggle("on", b.textContent.startsWith(filters.find(f => f[0] === v.filter)[1].split(" ")[0]));
      table.textContent = "";
      const rows = got.items.filter(i => v.filter === "all" ? true : v.filter === "failed" ? !(i.verdict || {}).passed : !!flips[i.key]);
      if (!rows.length) { table.append(el("div", "note", v.filter === "changed" ? "Nothing changed against that run." : "No failing cases.")); return; }
      const hdr = el("div", "evcase evcase-h");
      ["", "Case", "Checks", "Output", "Expected", ""].forEach(t => hdr.append(el("span", null, t)));
      table.append(hdr);
      // regressions first, then failures, then the rest
      const rank = (i) => flips[i.key] === "regressed" ? 0 : !(i.verdict || {}).passed ? 1 : flips[i.key] === "fixed" ? 2 : 3;
      rows.sort((x, y) => rank(x) - rank(y));
      for (const it of rows) {
        const vd = it.verdict || {};
        const r = el("div", "evcase" + (vd.passed ? "" : " bad"));
        r.append(el("span", "status " + (vd.passed ? "s-ok" : "s-bad"), vd.error ? "error" : vd.passed ? "pass" : "fail"));
        const id = el("span", "evcaseid");
        id.append(el("b", "mono", it.key));
        if (flips[it.key]) id.append(el("span", `evflip ${flips[it.key]}`, flips[it.key]));
        for (const t of vd.tags || []) id.append(el("span", "chip", t));
        r.append(id);
        const checks = el("span", "evchecks");
        if (vd.error) checks.append(el("span", "evcheck bad", vd.error.slice(0, 90)));
        for (const [name, c] of checksOf(vd)) {
          const chip = el("span", "evcheck " + (c.passed ? "ok" : "bad"), `${c.passed ? "✓" : "✗"} ${name}`);
          chip.title = [c.reason, c.score != null ? `score ${c.score}` : "", c.error].filter(Boolean).join(" · ") || (c.passed ? "passed" : "failed");
          checks.append(chip);
          if (!c.passed && (c.reason || c.error)) checks.append(el("span", "evwhy", c.reason || c.error));
        }
        r.append(checks);
        r.append(el("span", "mono evval", preview(vd.output)));
        r.append(el("span", "mono evval", preview(vd.expected)));
        const acts = el("span", "evacts");
        if (it.trace_id) {
          const o = el("button", "linkbtn", "Open run"); o.type = "button";
          o.onclick = () => performUi("open_run", {run: it.trace_id, quiet: true});
          acts.append(o);
        }
        r.append(acts);
        table.append(r);
      }
    }
    paint();
  }

  async function showDataset(main, name, mine) {
    let got;
    try { got = await api(`/api/p/${PID}/datasets/${encodeURIComponent(name)}`); }
    catch (err) { main.append(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    const head = el("div", "evrunhead");
    const big = el("div", "evbig");
    big.append(el("span", "evbignum", String(got.total)), el("span", "evbiglabel", `cases in ${name}`));
    head.append(big, el("div", "evfacts mono", got.shown || got.path));
    main.append(head);
    const table = el("div", "evcases evrows");
    const hdr = el("div", "evcase evcase-h");
    ["Case", "Input", "Expected", "From"].forEach(t => hdr.append(el("span", null, t)));
    table.append(hdr);
    for (const r of got.rows) {
      const row = el("div", "evcase");
      const id = el("span", "evcaseid");
      id.append(el("b", "mono", r.id));
      for (const t of r.tags || []) id.append(el("span", "chip", t));
      row.append(id, el("span", "mono evval", preview(r.input, 200)), el("span", "mono evval", preview(r.expected, 200)));
      const from = el("span", "evacts");
      if (r.from && r.from.run) {
        const o = el("button", "linkbtn", "Source run"); o.type = "button";
        o.onclick = () => performUi("open_run", {run: r.from.run, quiet: true});
        from.append(o);
      }
      row.append(from);
      table.append(row);
    }
    main.append(table);
    if (got.total > got.rows.length) main.append(el("p", "note", `Showing the first ${got.rows.length} of ${got.total}.`));
  }

  async function runEval(name, btn) {
    btn.disabled = true;
    try { await api(`/api/p/${PID}/jobs/${encodeURIComponent(name)}/run`, {}); toast(`Running ${name}…`); }
    catch (err) { toast(err.message, true); btn.disabled = false; return; }
    v.run = ""; v.against = ""; save();
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
        v.run = ""; save();
        show();
      }
    }, 2000);
  }

  registerPane("evals", {el: box, show});
  return {show};
})();
