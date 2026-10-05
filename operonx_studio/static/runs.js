/* operonx studio — Runs, by where they came from.
 *
 * Left, the origin tree: every service, job and runbook the application
 * declares (an idle one shows 0), then the playground and ad hoc runs,
 * each with its count in the time range and a red dot when something
 * failed. Right, the runs in the chosen folder: when, status, how long,
 * what it cost, the first error — the answers people open a trace for.
 * A job folder lists its runs as a strip above; a runbook folder lists
 * the runbook's runs, and each opens as the traces it grouped.
 *
 * Everything reads the project's RunStore through /runs, /runs/groups and
 * /runs/origins. Opening a run is the run view (studio.js).
 */

"use strict";

const RunsView = (() => {
  const RANGES = [["1h", "Last hour", 3600], ["24h", "Last 24 hours", 86400],
                  ["7d", "Last 7 days", 7 * 86400], ["30d", "Last 30 days", 30 * 86400], ["all", "All time", 0]];
  const ORDERS = [["started_desc", "Newest"], ["duration_desc", "Slowest"],
                  ["cost_desc", "Most expensive"], ["errors_desc", "Most errors"]];
  const SECTIONS = [["services", "Services", "service"], ["jobs", "Jobs", "job"], ["runbooks", "Runbooks", "runbook"],
                    ["evals", "Evals", "eval"], ["playground", "Playground", "playground"], ["adhoc", "Ad hoc", "adhoc"]];

  const v = Object.assign({
    folder: {kind: "all"}, range: "7d", status: "", q: "", order: "started_desc",
  }, recall(`runsView:${PID}`, {}));
  let origins = null;
  let token = 0;
  let cursor = null;
  const picked = new Set();   // runs ticked for "Compare"

  const save = () => store(`runsView:${PID}`, {folder: v.folder, range: v.range, status: v.status, order: v.order});
  const since = () => {
    const r = RANGES.find(x => x[0] === v.range);
    // to the minute: a range of hours or days needs no finer edge, and a
    // stable value keeps the first page's URL the same across one render
    return r && r[2] ? Math.floor((Date.now() / 1000 - r[2]) / 60) * 60 : "";
  };
  const qs = (o) => Object.entries(o).filter(([, x]) => x !== "" && x != null)
    .map(([k, x]) => `${k}=${encodeURIComponent(x)}`).join("&");

  function money(r) {
    if (r.cost_usd == null) return r.llm_calls ? "unpriced" : "—";
    const c = r.cost_usd;
    const txt = c === 0 ? "$0" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
    return r.unpriced ? `${txt} + ${r.unpriced} unpriced` : txt;
  }

  /* the filter the folder, the range and the controls make together */
  function filterParams() {
    const f = v.folder;
    const p = {since: since(), status: v.status, order: v.order};
    const q = v.q.trim();
    if (q) {
      // "key:value" pairs match metadata; anything else searches ids and keys
      const pairs = q.split(/\s+/).filter(t => /^[\w.-]+:.+$/.test(t));
      if (pairs.length && pairs.length === q.split(/\s+/).length) p.meta = pairs.join(",");
      else p.q = q;
    }
    if (f.kind === "runbook") {
      if (f.runbook_run) p.runbook_run = f.runbook_run;
      else p.meta = [p.meta, `runbook:${f.name}`].filter(Boolean).join(",");
      p.origin = "job";
    } else if (f.kind !== "all") {
      p.origin = f.kind;
      if (f.name) p.name = f.name;
      if (f.job_run) p.job_run = f.job_run;
    }
    return p;
  }

  function railItem(label, count, errors, active, onclick, sub) {
    const b = el("button", "railitem" + (active ? " active" : ""));
    b.type = "button";
    const name = el("span", "railname", label);
    if (sub) name.title = sub;
    b.append(name);
    if (errors) {
      const dot = el("span", "raildot");
      dot.title = `${errors} failed`;
      b.append(dot);
    }
    b.append(el("span", "railcount", String(count)));
    b.onclick = onclick;
    return b;
  }

  /* which store this screen reads, and the configuration that chose it */
  function storeLine(info) {
    const line = el("div", "runsstore");
    if (!info || !info.label) return line;
    line.append(Icons.svg("database"), el("span", "runsstorename", info.label));
    if (info.why) line.append(el("span", "runsstorewhy", info.why));
    const tip = [`Reading ${info.label}`, info.why];
    if (info.remote) tip.push(`Also: ${info.remote}`);
    for (const s of info.skipped || []) tip.push(`Not read: ${s.sink} — ${s.reason}`);
    line.title = tip.filter(Boolean).join("\n");
    return line;
  }

  /* the project's store did not answer: say which and why it is read */
  function unreachable(err) {
    const info = (err.data && err.data.store) || {};
    const why = info.why ? ` The studio reads it ${info.why.replace(/^from /, "because of ")}.` : "";
    const note = paneNote("Can't reach the trace store",
      `${info.label || "The project's store"} did not answer, so no runs can be listed.${why}`,
      null, {actions: [{label: "Try again", icon: "refresh", run: () => render()}]});
    const more = el("details", "notehand");
    more.append(el("summary", null, "What the store said"), el("pre", "noteerr", err.message));
    note.append(more);
    return note;
  }

  function same(a, b) { return a.kind === b.kind && (a.name || "") === (b.name || ""); }

  function renderRail(rail) {
    rail.textContent = "";
    if (!origins) return;
    rail.append(railItem("All runs", origins.total, origins.errors, v.folder.kind === "all",
      () => pick({kind: "all"})));
    for (const [key, label, kind] of SECTIONS) {
      const items = origins[key] || [];
      if (!items.length) continue;
      rail.append(el("div", "railhead", label));
      for (const it of items) {
        const sub = kind === "service" ? `${it.kind || ""} ${it.path || ""}`.trim()
          : kind === "runbook" ? (it.schedule ? `schedule ${it.schedule}` : "") : "";
        rail.append(railItem(it.name, it.runs, it.errors, same(v.folder, {kind, name: it.name}),
          () => pick({kind, name: it.name}), sub));
      }
    }
  }

  // the phone's picker: the same tree as a <select>
  function renderPicker(sel) {
    sel.textContent = "";
    const add = (label, folder, group) => {
      const o = el("option", null, label);
      o.value = JSON.stringify(folder);
      if (same(folder, v.folder)) o.selected = true;
      (group || sel).append(o);
    };
    add(`All runs · ${origins ? origins.total : ""}`, {kind: "all"});
    for (const [key, label, kind] of SECTIONS) {
      const items = (origins && origins[key]) || [];
      if (!items.length) continue;
      const g = el("optgroup");
      g.label = label;
      for (const it of items) add(`${it.name} · ${it.runs}${it.errors ? " ●" : ""}`, {kind, name: it.name}, g);
      sel.append(g);
    }
    sel.onchange = () => pick(JSON.parse(sel.value));
  }

  function pick(folder) {
    v.folder = folder;
    save();
    render();
  }

  function folderTitle() {
    const f = v.folder;
    if (f.kind === "all") return ["All runs", "Every run this project recorded"];
    const kinds = {service: "Service", job: "Job", eval: "Eval", runbook: "Runbook", playground: "Playground", adhoc: "Ad hoc"};
    let sub = kinds[f.kind] || f.kind;
    const list = origins && (origins[{service: "services", job: "jobs", eval: "evals", runbook: "runbooks",
      playground: "playground", adhoc: "adhoc"}[f.kind]] || []);
    const it = (list || []).find(x => x.name === f.name);
    if (it && f.kind === "service") sub += ` · ${it.kind || ""} ${it.path || ""}`;
    if (it && f.kind === "runbook" && it.schedule) sub += ` · ${it.schedule}`;
    if (it && f.kind === "job" && it.session) sub += ` · ${it.session}`;
    return [f.name || sub, sub];
  }

  /* a job's runs, or a runbook's, as a strip of chips above the table */
  async function renderStrip(strip, mine) {
    const f = v.folder;
    strip.textContent = "";
    if (f.kind !== "job" && f.kind !== "eval" && f.kind !== "runbook") { strip.hidden = true; return; }
    const by = f.kind === "runbook" ? "runbook_run" : "job_run";
    const params = f.kind === "runbook" ? {by, origin: "job", runbook: f.name, since: since()}
      : {by, origin: f.kind, name: f.name, since: since()};
    let data;
    try { data = await api(`/api/p/${PID}/runs/groups?${qs(params)}`); }
    catch { strip.hidden = true; return; }
    if (mine !== token) return;
    const groups = (data.groups || []).filter(g => g[by]);
    strip.hidden = !groups.length;
    if (!groups.length) return;
    strip.append(el("span", "striplabel", f.kind === "runbook" ? "Runbook runs" : "Job runs"));
    const chips = el("div", "stripchips");
    const chosen = f[by];
    const chip = (label, sub, on, bad, onclick) => {
      const b = el("button", "stripchip" + (on ? " on" : "") + (bad ? " bad" : ""));
      b.type = "button";
      b.append(el("span", null, label));
      if (sub) b.append(el("span", "stripsub", sub));
      b.onclick = onclick;
      return b;
    };
    chips.append(chip("All", null, !chosen, false, () => pick({...f, [by]: undefined})));
    for (const g of groups.slice(0, 12)) {
      const when = g.last_started ? fmtWhen(g.last_started * 1000) : g[by];
      chips.append(chip(when, `${g.runs} ${g.runs === 1 ? "trace" : "traces"}${g.errors ? ` · ${g.errors} failed` : ""}`,
        chosen === g[by], !!g.errors, () => pick({...f, [by]: g[by]})));
    }
    strip.append(chips);
    if (chosen && f.kind === "job") {
      const open = Icons.button("right", "Open this job run", "small ghost");
      open.onclick = () => { state.jobSel = f.name; state.jobRun = chosen; switchTab("jobs"); showJobs(f.name, chosen); };
      strip.append(open);
    }
  }

  function syncCompare() {
    const btn = document.querySelector("#traces .comparebtn");
    if (!btn) return;
    btn.hidden = picked.size !== 2;
    for (const cb of document.querySelectorAll("#traces .runpick")) {
      cb.disabled = picked.size >= 2 && !cb.checked;
    }
  }

  function row(r) {
    const tr = el("tr", "clickable" + (r.status === "error" ? " failed" : ""));
    tr.dataset.key = r.run;            // a revisit marks the rows it had not seen
    const st = el("td", "stcell");
    // a live store lists a run that has not ended (or whose process died) as running
    const dot = el("span", "stdot " + (r.status === "error" ? "bad" : r.status === "running" ? "run" : "ok"));
    dot.title = r.status;
    const cb = el("input", "runpick");
    cb.type = "checkbox";
    cb.checked = picked.has(r.run);
    cb.setAttribute("aria-label", `Pick ${r.run} to compare`);
    cb.title = "Pick two runs to compare";
    cb.onclick = (ev) => ev.stopPropagation();
    cb.onchange = () => { if (cb.checked) picked.add(r.run); else picked.delete(r.run); syncCompare(); };
    st.append(dot, cb);
    tr.append(st);
    const main = el("td");
    main.append(el("div", "runname", r.source === "langfuse" ? (r.name || r.run) : r.run));
    const bits = [];
    if (v.folder.kind === "all" && r.origin !== "adhoc") bits.push(`${r.origin} ${r.name}`);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (r.key) bits.push(r.key);
    else if (r.session_id && !uuid.test(r.session_id)) bits.push(`session ${r.session_id}`);
    if (r.origin === "adhoc" && r.workflow) bits.push(r.workflow);
    if (r.source === "langfuse") bits.push("Langfuse");
    if (r.version) bits.push(`@${String(r.version).slice(0, 7)}${r.version_dirty ? "*" : ""}`);
    main.append(el("div", "runsrc", bits.join(" · ")));
    if (r.first_error) main.append(el("div", "runerr", r.first_error));
    tr.append(main);
    const when = el("td", "nowrap");
    if (r.mtime) {
      when.append(el("div", null, fmtAgo(r.mtime * 1000)));
      when.append(el("div", "cellsub", fmtWhen(r.mtime * 1000)));
    }
    tr.append(when);
    // a run still going shows how long it has been going
    tr.append(el("td", "num hide-sm" + (r.status === "running" ? " live" : ""),
      r.status === "running" && r.started_at ? `${fmtMs(Date.now() - r.started_at * 1000)}…`
        : r.duration_ms ? fmtMs(r.duration_ms) : "—"));
    const cost = el("td", "num hide-sm" + (r.cost_usd == null && r.llm_calls ? " dim" : ""), money(r));
    if (r.llm_calls) cost.title = `${r.llm_calls} LLM calls · ${r.tokens_in} in / ${r.tokens_out} out tokens`;
    tr.append(cost);
    const acts = el("td", "runacts");
    if (r.source !== "langfuse") {
      const rm = Icons.button("trash", undefined, "needs-edit", "Delete this run");
      rm.onclick = async (ev) => {
        ev.stopPropagation();
        if (!window.confirm(`Delete run ${r.run}?`)) return;
        try {
          await api(`/api/p/${PID}/trace/${encodeURIComponent(r.run)}/delete`, {});
          toast(`Deleted ${r.run}`);
          render();
        } catch (e) { toast(e.message, true); }
      };
      acts.append(rm);
    }
    tr.append(acts);
    tr.onclick = () => showRunTree(r.run);
    return tr;
  }

  function emptyFor(folder) {
    const f = folder;
    const wider = v.range !== "all" && v.range !== "30d"
      ? [{label: "Show the last 30 days", icon: "clock", run: () => { v.range = "30d"; save(); render(); }}] : [];
    if (f.kind === "service") return paneNote("No runs in this range",
      `Every ${f.name} session is recorded here as it ends.`, null,
      {actions: [...((window.Account && Account.viewOnly) ? [] : [{label: "Try it in the Playground", icon: "play", run: () => switchTab("playground")}]), ...wider]});
    if (f.kind === "job" || f.kind === "runbook") return paneNote("No runs in this range",
      `${f.name}'s runs appear here as it runs.`, null,
      {actions: [{label: `Run ${f.name}`, icon: "play", run: () => { state.jobSel = f.name; switchTab("jobs"); }}, ...wider]});
    return paneNote("No runs in this range", "Nothing was recorded in this range with these filters.", null,
      {actions: wider});
  }

  const firstPage = () => `/api/p/${PID}/runs?${qs({...filterParams(), limit: 100, cursor: ""})}`;

  async function loadRows(tbody, more, foot, mine, append, early) {
    const p = {...filterParams(), limit: 100, cursor: append ? cursor : ""};
    let data;
    // the first page was asked for alongside the folders (render) unless
    // the folder has changed since
    const ask = !append && early && early.url === firstPage() ? early.got : api(`/api/p/${PID}/runs?${qs(p)}`);
    try { data = await ask; }
    catch (e) { more.parentNode.replaceChild(el("div", "errbox", e.message), more); return null; }
    if (mine !== token) return null;
    for (const r of data.runs) tbody.append(row(r));
    // a run still going on the first page: the list looks again in 5 s, in place
    if (!append && data.runs.some(r => r.status === "running")) {
      setTimeout(async () => {
        if (mine !== token || state.tab !== "traces" || document.hidden || !tbody.isConnected) return;
        const box = $("#traces");
        const y = box.scrollTop;
        await render();
        box.scrollTop = y;
      }, 5000);
    }
    cursor = data.next;
    more.hidden = !cursor;
    foot.textContent = data.total != null ? `${tbody.childNodes.length} of ${data.total}` : "";
    return data;
  }

  async function render() {
    leaveWorkflow();
    const box = $("#traces");
    const mine = ++token;
    state.tracesView = {};
    state._tlrun = null;
    renderFlowInfo();
    box.textContent = "";
    const shell = el("div", "runsview");
    const rail = el("nav", "runsrail");
    rail.setAttribute("aria-label", "Where runs came from");
    const main = el("div", "runsmain");
    shell.append(rail, main);
    box.append(shell);

    // the folders and the first page of runs in one round trip: the
    // page carries the tree for the same range
    const early = {url: firstPage()};
    early.got = api(`${early.url}&with_origins=1`);
    early.got.catch(() => {});      // awaited below, or dropped
    let first = null;
    try { first = await early.got; origins = first.origins || null; }
    catch (e) {
      origins = null;
      if (mine !== token) return;
      if (e.data && e.data.store_unreachable) {
        main.append(unreachable(e));
        return;
      }
      main.append(loadError(e, () => render()));
    }
    if (mine !== token) return;
    // a folder that no longer exists falls back to all runs
    if (origins && v.folder.kind !== "all") {
      const key = {service: "services", job: "jobs", eval: "evals", runbook: "runbooks", playground: "playground", adhoc: "adhoc"}[v.folder.kind];
      if (!(origins[key] || []).some(x => x.name === v.folder.name)) v.folder = {kind: "all"};
    }
    renderRail(rail);

    const [title, sub] = folderTitle();
    const head = el("div", "runshead");
    const picker = el("select", "runspicker");
    picker.setAttribute("aria-label", "Where runs came from");
    renderPicker(picker);
    const htext = el("div", "runstitle");
    htext.append(el("h2", null, title), el("div", "runssub", sub));
    const tools = el("div", "runstools");
    head.append(picker, htext, tools);
    main.append(head);
    if (first && first.store) main.append(storeLine(first.store));

    const bar = el("div", "runsbar");
    const range = el("select");
    range.setAttribute("aria-label", "Time range");
    for (const [k, label] of RANGES) { const o = el("option", null, label); o.value = k; o.selected = k === v.range; range.append(o); }
    range.onchange = () => { v.range = range.value; save(); render(); };
    const status = el("select");
    status.setAttribute("aria-label", "Status");
    for (const [k, label] of [["", "Any status"], ["ok", "Succeeded"], ["error", "Failed"], ["running", "Running"]]) {
      const o = el("option", null, label); o.value = k; o.selected = k === v.status; status.append(o);
    }
    status.onchange = () => { v.status = status.value; save(); render(); };
    const search = el("label", "searchfield runssearch");
    search.append(Icons.svg("search"));
    const input = el("input");
    input.type = "text";
    input.placeholder = "Search ids, keys — or key:value";
    input.value = v.q;
    input.setAttribute("aria-label", "Search runs");
    let t = null;
    input.oninput = () => { clearTimeout(t); t = setTimeout(() => { v.q = input.value; render(); }, 300); };
    search.append(input);
    const order = el("select");
    order.setAttribute("aria-label", "Sort");
    for (const [k, label] of ORDERS) { const o = el("option", null, label); o.value = k; o.selected = k === v.order; order.append(o); }
    order.onchange = () => { v.order = order.value; save(); render(); };
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = render;
    const follow = el("label", "followpin");
    const pin = el("input");
    pin.type = "checkbox";
    pin.checked = state.follow;
    pin.onchange = () => { state.follow = pin.checked; store("follow", state.follow); };
    follow.append(pin, "Follow newest");
    follow.title = "Open the newest run as it arrives";
    bar.append(search, range, status, order);
    const compare = Icons.button("right", "Compare", "small comparebtn primary", "Compare the two picked runs op by op");
    compare.hidden = picked.size !== 2;
    compare.onclick = () => { const [a, b] = [...picked]; RunView.compare(a, b); };
    tools.append(compare, follow, refresh);
    main.append(bar);

    const strip = el("div", "runstrip");
    strip.hidden = true;
    main.append(strip);
    renderStrip(strip, mine);

    const wrap = el("div", "tablewrap");
    const table = el("table", "datatable runstable");
    const hr = el("tr");
    for (const [h, cls] of [["", "stcell"], ["Run"], ["Started"], ["Took", "num hide-sm"], ["Cost", "num hide-sm"], [""]])
      hr.append(el("th", cls || null, h));
    const thead = el("thead"); thead.append(hr); table.append(thead);
    const tbody = el("tbody");
    table.append(tbody);
    wrap.append(table);
    main.append(wrap);
    const foot = el("div", "runsfoot");
    const count = el("span", "note");
    const more = el("button", null, "Load more");
    more.type = "button";
    more.hidden = true;
    more.onclick = () => loadRows(tbody, more, count, mine, true);
    foot.append(count, more);
    main.append(foot);
    cursor = null;
    const data = await loadRows(tbody, more, count, mine, false, early);
    if (data && !data.runs.length) {
      wrap.replaceWith(emptyFor(v.folder));
      foot.hidden = true;
    }
    if (state.tab === "traces" && document.activeElement === document.body && v.q) input.focus();
  }

  /* open the Runs screen on a folder from elsewhere (a service in the
   * project menu, a job's "see its traces") */
  function openFolder(folder) {
    v.folder = folder;
    save();
    if (state.tab !== "traces") switchTab("traces");
    else render();
  }

  return {show: render, openFolder};
})();
