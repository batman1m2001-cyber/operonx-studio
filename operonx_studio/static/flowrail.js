/* operonx studio — the Flow screen's flows rail. Every flow stays in
 * view beside the canvas, with what makes one stand out: its ops, its
 * runs over the last week (a bar a day), its errors. A click opens it;
 * [ or the canvas bar's first button hides the rail, and the flow crumb
 * then lists the same rows. Run numbers come from /flows/stats. */

window.FlowRail = (() => {
  const ON = "ox:flowrail", SORT = "ox:flowrail-sort";
  const keep = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const SORTS = [
    ["busy", "Busiest", "the most runs this week first"],
    ["slow", "Slowest", "the longest average run first"],
    ["errors", "Errors", "the most failed runs first"],
    ["ops", "Most ops", "the biggest flow first"],
  ];
  const rail = $("#flowrail");
  const btn = $("#btn-flowrail");
  let sort = keep.get(SORT, "busy");
  let stats = null, statsAt = 0, loading = false;

  const count = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
  const ms = (v) => v >= 60000 ? `${(v / 60000).toFixed(1)} min` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;

  /* A service that serves a listed flow is one of its routes. */
  function routesOf(ir) {
    const routes = new Map();
    for (const sv of ir.services || ir.serves || []) {
      if (!sv.graph) continue;
      const base = sv.graph.split(":").pop();
      const names = [base, ...(sv.variants || []).map(v => `${base}[${v}]`)];
      const g = (ir.graphs || []).find(x => names.includes(x.name));
      if (!g) continue;
      if (!routes.has(g.name)) routes.set(g.name, []);
      routes.get(g.name).push(sv);
    }
    return routes;
  }

  /* One row per flow: the rail draws it, the crumb's menu lists it. */
  function items() {
    const ir = state.ir || {};
    const routes = routesOf(ir);
    const st = (stats && stats.flows) || {};
    return (ir.graphs || []).map(g => {
      const mine = routes.get(g.name) || [];
      const s = st[g.name] || null;
      const n = g.variants ? g.variants.length : mine.length;
      const where = n > 1 ? `${n} routes` : mine.length === 1 ? (mine[0].path || mine[0].name || "") : "";
      const sub = [where, s && s.avg_ms != null ? `avg ${ms(s.avg_ms)}` : ""].filter(Boolean).join(" · ");
      return {
        g, s, ops: g.nodes.length, sub,
        find: [...mine.map(sv => `${sv.name || ""} ${sv.path || ""}`), ...(g.variants || [])].join(" "),
        title: [s ? `${s.runs} runs in the last ${stats.days} days, ${ms(s.avg_ms || 0)} on average` : "",
          ...mine.map(sv => `${sv.name || ""}  ${sv.kind || ""} ${sv.path || ""}`)].filter(Boolean).join("\n"),
      };
    });
  }

  const by = {
    busy: (a, b) => ((b.s && b.s.runs) || 0) - ((a.s && a.s.runs) || 0) || b.ops - a.ops,
    slow: (a, b) => ((b.s && b.s.avg_ms) || -1) - ((a.s && a.s.avg_ms) || -1) || b.ops - a.ops,
    errors: (a, b) => ((b.s && b.s.errors) || 0) - ((a.s && a.s.errors) || 0) || by.busy(a, b),
    ops: (a, b) => b.ops - a.ops,
  };

  const sorted = () => items().sort(by[sort] || by.busy);

  function build() {
    const head = el("div", "frhead");
    const find = el("input", "frfind");
    find.type = "search";
    find.placeholder = "Filter flows, routes…";
    find.setAttribute("aria-label", "Filter flows and routes");
    find.autocomplete = "off";
    find.oninput = () => render();
    const sorts = el("div", "frsort");
    sorts.setAttribute("role", "group");
    sorts.setAttribute("aria-label", "Sort the flows");
    for (const [key, label, tip] of SORTS) {
      const b = el("button", null, label);
      b.type = "button";
      b.dataset.sort = key;
      b.title = `Sort: ${tip}`;
      b.onclick = () => { sort = key; keep.set(SORT, key); render(); };
      sorts.append(b);
    }
    head.append(find, sorts);
    const cols = el("div", "frcols");
    cols.append(el("span", null, "Flow"), el("span", null, "Ops"), el("span", null, "Runs 7d"), el("span", null, "Err"));
    rail.append(head, cols, el("div", "frrows"));
  }

  function render() {
    if (!rail) return;
    if (!rail.firstChild) build();
    for (const b of rail.querySelectorAll(".frsort button")) b.setAttribute("aria-pressed", String(b.dataset.sort === sort));
    const q = rail.querySelector(".frfind").value.trim().toLowerCase();
    const list = rail.querySelector(".frrows");
    const top = list.scrollTop;
    list.textContent = "";
    let rows = sorted();
    const maxOps = Math.max(1, ...rows.map(r => r.ops));
    if (q) rows = rows.filter(r => `${r.g.name} ${r.sub} ${r.find}`.toLowerCase().includes(q));
    if (!rows.length) list.append(el("div", "frnone", q ? "No flow matches" : "No flows"));
    for (const r of rows) {
      const b = el("button", "frrow" + (state.graph && state.graph.name === r.g.name ? " current" : ""));
      b.type = "button";
      if (r.title) b.title = r.title;
      const text = el("span");
      text.append(el("span", "frname", r.g.name), el("span", "frsub", r.sub || " "));
      const ops = el("span", "frops");
      const bar = el("span", "frbar");
      bar.style.width = `${Math.round(r.ops / maxOps * 100)}%`;
      ops.append(bar, el("span", null, String(r.ops)));
      const runs = el("span", "frruns");
      const spark = el("span", "frspark");
      runs.append(spark, el("span", null, r.s ? count(r.s.runs) : ""));
      const daily = (r.s && r.s.daily) || [];
      const peak = Math.max(1, ...daily);
      for (const d of daily) {
        const i = el("i");
        i.style.height = `${Math.round(d / peak * 100)}%`;
        spark.append(i);
      }
      if (r.s) runs.title = `${r.s.runs} runs in ${stats.days} days`;
      const errs = r.s ? r.s.errors : 0;
      const err = el("span", "frerr" + (errs ? " bad" : ""), errs ? `● ${count(errs)}` : "–");
      if (errs) err.title = `${errs} failed runs in ${stats.days} days`;
      b.append(text, ops, runs, err);
      b.onclick = () => open(r.g.name);
      list.append(b);
    }
    list.scrollTop = top;
    fetchStats();
  }

  /* At most once a minute; the rows draw before the numbers arrive. */
  async function fetchStats() {
    if (loading || Date.now() - statsAt < 60000) return;
    loading = true;
    try { stats = await api(`/api/p/${PID}/flows/stats?days=7`); }
    catch { stats = stats || {days: 7, flows: {}}; }
    finally { loading = false; statsAt = Date.now(); }
    render();
  }

  function open(name) {
    if (document.body.dataset.tab !== "flow") switchTab("flow");
    const pick = $("#graph-pick");
    if (!state.graph || state.graph.name !== name) {
      pick.value = name;
      pick.onchange({target: pick});
    }
    if (innerWidth <= 760) show(false);
    render();
  }

  function show(on, save = true) {
    document.body.classList.toggle("flowrail-off", !on);
    if (btn) {
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-label", on ? "Hide the flows" : "Show the flows");
    }
    if (save) keep.set(ON, on ? "on" : "off");
    if (on) render();
  }

  if (btn) btn.onclick = () => show(document.body.classList.contains("flowrail-off"));
  // [ the flows, ] the side panel: both away leaves the canvas alone
  document.addEventListener("keydown", (ev) => {
    if ((ev.key !== "[" && ev.key !== "]") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.body.dataset.tab !== "flow") return;
    ev.preventDefault();
    if (ev.key === "]") window.oxSide.toggle();
    else if (btn) btn.click();
  });
  const saved = keep.get(ON, null);
  show(saved ? saved === "on" : innerWidth > 760, false);

  return {items, sorted, render, open, show};
})();
