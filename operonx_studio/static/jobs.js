/* operonx studio — the project menu and the Jobs screen. Split from
 * studio.js, same bundle, same order. */

/* ── the project menu: Operons · Services · Jobs ───────────────────────
 * The three lists the application layer declares (operonx.app), from
 * the /ir payload. An Operon opens in the Flow tab; a Service opens the
 * graph it serves; a Job opens the Jobs tab on that job. */

function renderProjectMenu() {
  const box = $("#pmenu");
  box.textContent = "";
  const ir = state.ir || {};
  const col = (title, rows) => {
    const c = el("div", "pcol");
    c.append(el("div", "ptitle", title));
    if (!rows.length) c.append(el("div", "pnone", "none"));
    for (const r of rows) c.append(r);
    return c;
  };
  const row = (name, sub, onclick, cls) => {
    const r = el("div", "prow" + (cls ? " " + cls : ""));
    r.append(el("span", "pn", name));
    if (sub) r.append(el("span", "ps", sub));
    r.onclick = () => { $("#pmenu").hidden = true; onclick(); };
    return r;
  };
  const operons = (ir.graphs || []).map(g => row(g.name, `${g.nodes.length} ops`, () => {
    state.graph = g; $("#graph-pick").value = g.name; switchTab("flow"); render(); renderFlowInfo();
  }, state.graph && state.graph.name === g.name ? "sel" : ""));
  const services = (ir.services || ir.serves || []).map(sv => {
    const variants = sv.variants || [];
    const base = sv.graph ? sv.graph.split(":").pop() : "";
    const meta = `${sv.kind} ${sv.path || ""}${sv.port ? " :" + sv.port : ""}${sv.session ? " · " + sv.session : ""}` +
      (variants.length ? ` · ${variants.length} variants` : "");
    return row(sv.name || sv.path, meta, () => {
      // one door, one compiled graph per variant: open the first, the
      // Operons column lists them all as <graph>[<variant>]
      const names = variants.length ? variants.map(v => `${base}[${v}]`) : [base];
      const target = sv.graph ? (ir.graphs || []).find(g => names.includes(g.name)) : null;
      if (target) { state.graph = target; $("#graph-pick").value = target.name; switchTab("flow"); render(); renderFlowInfo(); }
      else toast(sv.app ? `${sv.name}: an ASGI app, not a graph` : `${sv.name}: graph ${sv.graph} is not listed under [[graph]]`);
    });
  });
  const jobs = (ir.jobs || []).map(j => row(j.name,
    `${jobKind(j)}${j.schedule ? " · " + j.schedule : ""}`,
    () => { state.jobSel = j.name; switchTab("jobs"); }));
  box.append(col("Operons", operons), col("Services", services), col("Jobs", jobs));
}
$("#btn-project").onclick = (ev) => {
  ev.stopPropagation();
  const box = $("#pmenu");
  if (box.hidden) { renderProjectMenu(); $("#switcher").hidden = true; }
  box.hidden = !box.hidden;
  $("#btn-project").setAttribute("aria-expanded", String(!box.hidden));
};
document.addEventListener("click", (ev) => {
  const box = $("#pmenu");
  if (!box.hidden && !box.contains(ev.target)) {
    box.hidden = true;
    $("#btn-project").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  for (const [menu, btn] of [["#pmenu", "#btn-project"], ["#switcher", "#pname"]]) {
    if (!$(menu).hidden) { $(menu).hidden = true; $(btn).setAttribute("aria-expanded", "false"); $(btn).focus(); }
  }
});

/* ── the Jobs tab: the records the jobs write, and Run / Resume ────────
 * A job is never a span; its truth is run.json + items.jsonl. The pane
 * shows exactly those: the jobs with their last run, one job's runs, one
 * run's items (or a runbook's tree). Run and Resume start `operonx-run`
 * under the project's interpreter; the pane polls while a run is open. */

let _jobsPoll = null;

/* A status is a dot and a word — colour for the eye, the word for
 * everyone else. */
function statusChip(status) {
  const cls = status === "ok" ? "s-ok" : status === "running" ? "s-run"
    : (status === "failed" || status === "stopped" || status === "timeout") ? "s-bad"
    : status === "skipped" ? "s-skip" : "";
  return el("span", "status " + cls, status || "unknown");
}

function countsChips(counts) {
  const wrap = el("span", "counts");
  for (const [k, v] of Object.entries(counts || {})) {
    if (!v && k !== "ok") continue;
    wrap.append(el("span", k === "failed" || k === "timeout" ? "bad" : k === "empty" ? "warn" : "", `${v} ${k}`));
  }
  return wrap;
}

async function showJobs(sel, runId) {
  const box = $("#jobs");
  const mine = (state.jobsView = {});
  if (!box.childNodes.length) box.append(el("div", "note", "Loading jobs…"));
  let data;
  // one round trip: the list carries the opened job's runs and run
  const q = new URLSearchParams({open: sel || "", run: runId || ""});
  try { data = await api(`/api/p/${PID}/jobs?${q}`); }
  catch (e) { box.textContent = ""; box.append(loadError(e, () => showJobs(sel, runId))); return; }
  if (state.jobsView !== mine) return;
  box.textContent = "";
  if (!data.jobs.length) {
    box.append(paneNote("No jobs declared",
      "A job runs a graph over a batch of items — one run per item, a record per run.",
      '[[job]]\nname   = "score_calls"\ngraph  = "pipeline:score_call"\nsource = "data/calls.jsonl"\nsink   = "out/scores.jsonl"\nkey    = "call_id"',
      {ask: {label: "Add a job", prompt: "Add a job to this project that runs its main graph over a batch of items "
        + "(a small JSONL of realistic examples if there is none) and records each result. Declare it, run it once, "
        + "and tell me how it went."}}));
    return;
  }
  const cols = el("div", "jcols");
  const list = el("div", "jlist");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Jobs");
  const detail = el("div", "jdetail");
  cols.append(list, detail);
  box.append(cols);

  const picked = data.jobs.find(j => j.name === sel) || data.jobs[0];
  state.jobSel = picked.name;
  for (const j of data.jobs) {
    const r = el("div", "jrow" + (j.name === picked.name ? " sel" : ""));
    r.tabIndex = 0;
    r.setAttribute("role", "option");
    r.setAttribute("aria-selected", String(j.name === picked.name));
    const head = el("div", "jhead");
    head.append(el("span", "jn", j.name));
    head.append(el("span", "jkind", jobKind(j) + (j.schedule ? ` · ${j.schedule}` : "")));
    r.append(head);
    if (j.description) r.append(el("div", "jdesc", j.description));
    const last = el("div", "jlast");
    if (j.last) {
      last.append(statusChip(j.last.status));
      if (j.last.started) {
        const w = el("span", "jwhen", fmtAgo(j.last.started));
        w.title = fmtWhen(j.last.started);
        last.append(w);
      }
    } else last.append(el("span", "jwhen", "Never run"));
    r.append(last);
    r.onclick = () => showJobs(j.name);
    r.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); showJobs(j.name); } };
    list.append(r);
  }
  await renderJobDetail(detail, picked, runId, mine, data.detail && data.detail.name === picked.name ? data.detail : null);
  // keep the picked job in view on the phone's horizontal strip
  const on = list.querySelector(".jrow.sel");
  if (on && MOBILE.matches) on.scrollIntoView({block: "nearest", inline: "nearest"});
}

async function renderJobDetail(detail, job, runId, mine, pre) {
  detail.textContent = "";
  const bar = el("div", "jbar");
  bar.append(el("h2", "jtitle", job.name));
  const refresh = Icons.button("refresh", undefined, "", "Refresh");
  refresh.onclick = () => showJobs(job.name, state.jobRun);
  bar.append(refresh);
  if (job.kind !== "runbook" && job.session !== "stream") {  // a steps job resumes every step
    const resume = Icons.button("resume", "Resume", "needs-edit");
    resume.title = "Run only the keys the last run did not finish";
    resume.onclick = () => startJob(job.name, true);
    bar.append(resume);
  }
  const run = Icons.button("play", "Run", "primary needs-edit");
  run.title = `operonx-run ${job.name} — under the project's interpreter`;
  run.onclick = () => startJob(job.name, false);
  bar.append(run);
  detail.append(bar);
  if (job.description) detail.append(el("p", "jmeta", job.description));
  // operonx >= 1.17: a job of steps, or a job over items; older: a runbook, or source → sink
  const facts = job.kind === "steps" ? [`Steps: ${(job.steps || []).join(" → ")}`]
    : job.kind === "runbook" ? ["Runbook"]
    : job.session ? [`${job.session} job`] : [job.kind === "eval" ? "Eval" : "Job"];
  if (job.schedule) facts.push(`schedule ${job.schedule}`);
  if (job.kind === "steps" || job.kind === "runbook") { /* the steps say it */ }
  else if (job.source || job.sink) facts.push(`${job.source || "—"} → ${job.sink || "—"}`);
  else if (job.kind !== "eval") {
    facts.push(`${job.items || "once"} → ${job.graph || "—"}` + (job.reduce ? ` → reduce ${job.reduce}` : ""));
  }
  detail.append(el("p", "jpath", facts.join("  ·  ") + (job.record_dir ? `\nrecords in ${job.record_dir}` : "")));
  detail.querySelector(".jpath").style.whiteSpace = "pre-line";

  let data = pre ? {runs: pre.runs} : null;
  if (!data) {
    try { data = await api(`/api/p/${PID}/jobs/${encodeURIComponent(job.name)}/runs`); }
    catch (e) { detail.append(el("div", "errbox", e.message)); return; }
  }
  if (state.jobsView !== mine) return;
  if (!data.runs.length) {
    detail.append(paneNote("Not run yet", `Press Run to start ${job.name}; its runs and their items appear here.`));
    return;
  }

  detail.append(el("h3", "jsection", "Runs"));
  const wrap = el("div", "tablewrap");
  const table = el("table", "datatable jruns");
  const hr = el("tr");
  for (const [h, cls] of [["Started"], ["Status"], ["Items"], ["Took", "num"]]) hr.append(el("th", cls || null, h));
  const thead = el("thead"); thead.append(hr); table.append(thead);
  const tbody = el("tbody");
  const open = data.runs.find(r => r.run_id === runId) || data.runs[0];
  state.jobRun = open.run_id;
  for (const r of data.runs) {
    const tr = el("tr", "clickable" + (r.run_id === open.run_id ? " sel" : ""));
    const when = el("td");
    when.append(el("div", "cellmain", r.started ? fmtWhen(r.started) : "—"));
    when.append(el("div", "cellsub mono", r.run_id));
    tr.append(when);
    const st = el("td"); st.append(statusChip(r.status)); tr.append(st);
    const ct = el("td");
    if (r.tree) { const c = countsOfTree(r.tree); ct.append(countsChips(c)); }
    else ct.append(countsChips(r.counts));
    tr.append(ct);
    tr.append(el("td", "num dim", r.ended ? fmtSpan(r.started, r.ended) : (r.status === "running" ? "running…" : "")));
    tr.onclick = () => showJobs(job.name, r.run_id);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  detail.append(wrap);

  let one = pre && pre.one && pre.run_id === open.run_id ? pre.one : null;
  if (!one) {
    try { one = await api(`/api/p/${PID}/jobs/${encodeURIComponent(job.name)}/runs/${open.run_id}`); }
    catch (e) { detail.append(el("div", "errbox", e.message)); return; }
  }
  if (state.jobsView !== mine) return;
  if (one.run.error) detail.append(el("div", "errbox", one.run.error));
  const tree = one.run.tree || stepsTree(job.name, one.run, one.items);
  if (tree) {
    detail.append(el("h3", "jsection", "Steps in this run"));
    if ((one.run.wires || []).length) detail.append(renderWires(one.run.wires));
    detail.append(renderRunbookTree(tree));
  } else {
    const n = (one.items || []).length;
    const h = el("h3", "jsection", "Items");
    if (n) h.append(el("span", "count", `  ${n}`));
    detail.append(h);
    detail.append(renderItems(one.items, one.run));
  }

  // a running run: poll until it settles
  clearTimeout(_jobsPoll);
  if (open.status === "running" && state.tab === "jobs") {
    _jobsPoll = setTimeout(() => { if (state.tab === "jobs") showJobs(job.name, open.run_id); }, 2500);
  }
}

/* What kind of job, in a word: steps, eval, or job (operonx >= 1.17);
 * runbook, or its session, from an older operonx. */
function jobKind(j) {
  if (j.kind === "steps" || j.kind === "runbook" || j.kind === "eval") return j.kind;
  return j.session || "job";
}

/* A steps run (operonx >= 1.17) as the tree a runbook run had: each step
 * by name, with its status, its own run id and how long it took. */
function stepsTree(name, run, items) {
  if (!Array.isArray(run.steps) || !run.steps.length || typeof run.steps[0] !== "object") return null;
  const ms = Object.fromEntries((items || []).map(i => [i.key, i.ms]));
  return {kind: "runbook", name, status: run.status,
          children: run.steps.map(s => ({kind: "job", name: s.name, status: s.status, run_id: s.run_id,
                                         ms: ms[s.name]}))};
}

function countsOfTree(tree) {
  const c = {ok: 0, failed: 0, skipped: 0};
  const walk = (n) => { if (n.kind === "job") c[n.status] = (c[n.status] || 0) + 1; for (const k of n.children || []) walk(k); };
  walk(tree);
  return c;
}

function renderRunbookTree(tree) {
  const box = el("div", "rtree");
  const walk = (n, depth) => {
    const row = el("div", "rrow jobrow" + (n.status === "failed" ? " err" : ""));
    row.style.paddingLeft = `${12 + depth * 18}px`;
    row.append(el("span", "rico", n.kind === "job" ? "⚙" : n.kind === "parallel" ? "⇉" : "→"));
    // a job and a runbook (operonx >= 1.8) by name; an old tree's
    // sequential / parallel nodes by kind
    row.append(el("span", "rn", n.kind === "job" || n.kind === "runbook" ? n.name : n.kind));
    row.append(statusChip(n.status));
    if (n.ms) row.append(el("span", "rval", `${(n.ms / 1000).toFixed(2)}s`));
    if (n.error) row.append(el("span", "rval bad", n.error));
    if (n.run_id) row.append(el("span", "rval mono", n.run_id));
    box.append(row);
    for (const c of n.children || []) walk(c, depth + 1);
  };
  walk(tree, 0);
  return box;
}

/* A runbook's wires as it was written: one `>>` line per source, sources
 * feeding the same jobs on one line — `[a, b] >> c` — as `operonx-run
 * --show` prints them. */
function wireLines(wires) {
  const order = [];
  const into = new Map();
  for (const [a, b] of wires) {
    for (const n of [a, b]) if (!order.includes(n)) order.push(n);
    if (!into.has(a)) into.set(a, []);
    into.get(a).push(b);
  }
  const side = (xs) => (xs.length === 1 ? xs[0] : `[${xs.join(", ")}]`);
  const groups = new Map();
  for (const [src, dsts] of into) {
    const key = side(dsts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(src);
  }
  return [...groups].map(([dst, srcs]) => `${side(srcs)} >> ${dst}`);
}

function renderWires(wires) {
  const box = el("div", "rwires mono");
  for (const line of wireLines(wires)) box.append(el("div", null, line));
  return box;
}

function renderItems(items, run) {
  if (!items.length) {
    const c = run.counts || {};
    return el("div", "note", "fed" in c ? `One run: fed ${c.fed} · sent ${c.sent}${run.trace_id ? " · trace " + run.trace_id : ""}` : "No items recorded.");
  }
  const wrap = el("div", "tablewrap");
  const table = el("table", "datatable jitems");
  const hr = el("tr");
  for (const [h, cls] of [["Key"], ["Status"], ["Took", "num"], ["Sent", "num hide-sm"], ["Attempts", "num hide-sm"], ["Error"], [""]])
    hr.append(el("th", cls || null, h));
  const thead = el("thead"); thead.append(hr); table.append(thead);
  const tbody = el("tbody");
  for (const it of items) {
    const tr = el("tr", it.status === "failed" || it.status === "timeout" ? "err" : "");
    tr.append(el("td", "mono", it.key));
    const st = el("td"); st.append(statusChip(it.status)); tr.append(st);
    tr.append(el("td", "num", it.ms ? fmtMs(it.ms) : ""), el("td", "num hide-sm", String(it.sent ?? "")),
              el("td", "num hide-sm", String(it.attempts ?? "")));
    const err = el("td", "jerr", it.error || "");
    if (it.error) err.title = it.error;
    tr.append(err);
    const tc = el("td", "num");
    if (it.trace_id) {
      const b = el("button", "linkbtn", "Trace");
      b.append(Icons.svg("right"));
      b.title = `Open trace ${it.trace_id}`;
      b.onclick = async () => {
        switchTab("traces", {quiet: true});
        try { await showRunTree(it.trace_id); } catch (e) { toast(`Trace ${it.trace_id} is not in the traces directory`, true); }
      };
      tc.append(b);
    }
    tr.append(tc);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

async function startJob(name, resume) {
  try {
    const r = await api(`/api/p/${PID}/jobs/${encodeURIComponent(name)}/run`, {resume});
    toast(`${resume ? "Resuming" : "Running"} ${name} (pid ${r.pid})`);
    setTimeout(() => showJobs(name), 1200);
  } catch (e) { toast(e.message, true); }
}
