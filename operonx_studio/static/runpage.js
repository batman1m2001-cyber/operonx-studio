/* operonx studio — one run: the tree and the workflow view. Split from
 * studio.js, same bundle, same order. */

/* ── the run, two ways (Traces tab) ─────────────────────────────────
 * TREE: the run as operonx's ctx tree — the same parents Langfuse gets
 * (a yield record contains everything dispatched for that item), one
 * row per execution wearing the op's flow icon and chips, its show-key
 * values and a duration bar on one scale.
 * WORKFLOW: the flow canvas moved into this pane and painted — the same
 * layout, every card carrying the run's real values, a turn picker so
 * the cards show one turn's values and the ops that did not run in
 * that turn fade. Both read /tree. */

// the time math lives in timeline.js — pure, node-tested
const TL = Timeline.TL;
const timePlace = Timeline.timePlace;
const fmtMs = Timeline.fmtMs;

// the IR node behind an op name, nested graphs included — the flow's
// icon, kind colour, chips and show keys all hang off it
function irNodeByName(name) {
  if (!state._irByName || state._irByName.graph !== state.graph) {
    const m = new Map();
    (function walk(g) {
      for (const n of (g && g.nodes) || []) {
        if (!m.has(n.name)) m.set(n.name, n);
        if (n.graph) walk(n.graph);
      }
    })(state.graph);
    state._irByName = {graph: state.graph, map: m};
  }
  return state._irByName.map.get(name) || null;
}

// "key = value" per show key present in this execution's outputs; an
// op with no show keys (a door, an op the extractor could not see)
// falls back to its first two recorded outputs
function execValues(node, outputs, max) {
  if (!outputs) return [];
  let keys = ((node && node.show_keys) || []).filter(k => k in outputs);
  if (!keys.length) keys = Object.keys(outputs).filter(k => !k.startsWith("_"));
  return keys.slice(0, 2).map(k => [k, Values.brief(outputs[k], max)]);
}

const execsOf = (rows) => rows.filter(r => r.kind === "record");

function runHeader(run, data, mode, extras) {
  return RunView.header(run, data, mode, extras);
}

/* Where a run came from, as links back: the job run and item it was, the
 * service that answered, the runbook run that grouped it — the other
 * direction of the Jobs pane's Trace links. */
function originLine(s) {
  if (!s || !s.origin || s.origin === "adhoc") return null;
  const line = el("div", "tlorigin");
  const link = (text, title, onclick) => {
    const b = el("button", "linkbtn", text);
    b.type = "button";
    b.title = title;
    b.onclick = onclick;
    return b;
  };
  if (s.origin === "job" || s.origin === "eval") {
    line.append(`${s.origin === "eval" ? "Eval" : "Job"} `);
    line.append(link(s.job, `All traces of ${s.job}`, () => RunsView.openFolder({kind: s.origin, name: s.job})));
    if (s.key) line.append(` · item ${s.key}`);
    if (s.job_run) {
      line.append(" of run ");
      line.append(link(s.job_run, "Open this job run in Jobs", () => {
        state.jobSel = s.job; state.jobRun = s.job_run; switchTab("jobs"); showJobs(s.job, s.job_run);
      }));
    }
    if (s.runbook) {
      line.append(" · steps ");
      line.append(link(s.runbook, "Every trace of this steps run",
        () => RunsView.openFolder({kind: "runbook", name: s.runbook, runbook_run: s.runbook_run})));
    }
  } else if (s.origin === "service" || s.origin === "playground") {
    line.append(s.origin === "playground" ? "Playground · " : "Service ");
    line.append(link(s.service || s.name, "Every run of this service",
      () => RunsView.openFolder({kind: s.origin, name: s.service || s.name})));
    if (s.transport) line.append(` · ${s.transport}`);
    if (s.session_id) line.append(` · session ${s.session_id}`);
    // a real session its service recorded, or a playground one: send it again
    const md = s.metadata || {};
    const sent = (md.replay_script || md.playground_script || []).filter(m => m.kind === "text" || m.kind === "json");
    if (sent.length && typeof PlayView !== "undefined" && md.toy !== "rerun" && !(window.Account && Account.viewOnly)) {
      line.append(" · ");
      line.append(link("Replay in the Playground", `Send its ${sent.length} message${sent.length === 1 ? "" : "s"} again, to the current code`,
        () => PlayView.replayFrom(s.trace_id, {...md, service: s.service || s.name})));
    }
  }
  if (s.version) line.append(` · code @${String(s.version).slice(0, 7)}${s.version_dirty ? " (uncommitted changes)" : ""}`);
  return line;
}

async function loadRunTree(run) {
  return api(`/api/p/${PID}/trace/${encodeURIComponent(run)}/tree`);
}

// A run still going (a live run store lists it as running) is followed:
// asked again every 2.5 s, drawn again only when it grew or ended — at the
// same scroll position, so reading it while it runs is not a fight.
const runSig = (t) => `${(t.summary || {}).status}|${(t.rows || []).length}|${t.total_ms || 0}`;
function followRun(run, mine, tree, redraw) {
  if (((tree || {}).summary || {}).status !== "running") return;
  const sig = runSig(tree);
  setTimeout(async () => {
    if (state.tracesView !== mine) return;                        // another view now
    if (state.tab !== "traces" || document.hidden) return followRun(run, mine, tree, redraw);
    let now;
    try { now = await loadRunTree(run); } catch { return followRun(run, mine, tree, redraw); }
    if (state.tracesView !== mine) return;
    if (runSig(now) === sig) return followRun(run, mine, tree, redraw);
    const box = $("#traces");
    const y = box.scrollTop;
    await redraw();
    box.scrollTop = y;
  }, 2500);
}

/* TREE: the run page (runtree.js) — the steps beside the selected step. */
async function showRunTree(run) {
  return RunTree.show(run);
}

/* One execution, in the order it is read: the verdict (how it went, how
 * it ranks among this op's runs, what stands out), what it produced,
 * what it received, what it cost, its other runs, and what fed it. */
async function renderExecPanel(run, e, execs, target) {
  state.execSel = `${e.op} @ ${e.ctx || "main"} (+${fmtMs(e.start_ms)})`;
  state.execId = e.id || null;
  state.execPanelRun = run;
  pushView();
  // the run page draws the step beside its steps (runtree.js); the
  // workflow view draws it in the side panel
  const panel = target || $("#inspector");
  if (!target) {
    // picking an execution is asking to read it: bring the panel forward
    const ps = panelState();
    if (!ps.on || ps.tab !== "inspect") showSide("inspect");
    panel.classList.remove("off");
  }
  panel.textContent = "";
  panel.scrollTop = 0;
  const mine = execs.filter(x => x.op === e.op);
  const node = e.op && !e.child ? irNodeByName(e.op) : null;

  // ── verdict ──
  const head = el("div", "phead");
  const title = el("div", "pheadrow");
  if (target) {
    // on a phone the step covers the steps: the way back
    // (the Workflow's sheet closes from its own bar)
    if (!target.closest("#wfstep")) {
      const back = Icons.button("back", "Steps", "small ghost rt-back", "Back to the steps");
      back.onclick = () => RunTree.backToSteps();
      title.append(back);
    }
    const ico = el("span", "rt-ico", node ? kindIcon(node) : "≋");
    if (node) ico.style.setProperty("--kind", kindColor(node));
    title.append(ico);
  }
  title.append(el("h3", null, e.name || e.op));
  if (!target) {
    // reading a long prompt wants width: the panel widens in place
    const wide = Icons.button($("#sidebar").classList.contains("wide") ? "collapse" : "expand", undefined,
      "small ghost widebtn", "Widen the panel to read values");
    wide.onclick = () => {
      const on = $("#sidebar").classList.toggle("wide");
      store("panelWide", on);
      renderExecPanel(run, e, execs);
    };
    title.append(wide);
  } else {
    const link = Icons.button("link", undefined, "small ghost", "Copy a link to this step");
    link.onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); toast("Link copied"); }
      catch { toast(location.href); }
    };
    title.append(link);
    if (node) {
      const flow = Icons.button("graph", undefined, "small ghost", "Show this op in the Flow");
      flow.onclick = () => performUi("select_op", {op: e.op});
      title.append(flow);
    }
  }
  head.append(title);
  // the facts at a glance, as pills: how it went, how long, how it ranks,
  // when (the recorder's wall clock, so a step can be matched to a log line)
  const verdict = el("div", "execverdict pills");
  verdict.append(el("span", "pill status " + (e.status === "error" ? "s-bad" : "s-ok"), e.status === "error" ? "failed" : "ok"));
  verdict.append(RunView.pill(fmtMs(e.dur_ms), "Took", "p-strong"));
  const rank = RunView.rank(e, mine);
  if (rank) verdict.append(RunView.pill(rank));
  verdict.append(RunView.pill(`+${fmtMs(e.start_ms)}`, "Start"));
  if (e.wall_start) {
    const at = new Date(e.wall_start * 1000);
    verdict.append(RunView.pill(at.toLocaleTimeString([], {hour12: false}) + "." + String(at.getMilliseconds()).padStart(3, "0"),
      "At", "mono", at.toISOString()));
  }
  head.append(verdict);
  if (e.ctx && e.ctx !== "main") {
    const when = el("div", "execwhen");
    when.append(el("span", "mono", e.ctx));
    if (e.id) when.append(RunView.copyId(e.id, "Copy the step id"));
    head.append(when);
  }
  panel.append(head);

  const flags = RunView.anomalies(e, mine);
  if (e.error) {
    const err = el("div", "errcard");
    const lines = String(e.error).trim().split("\n");
    err.append(el("div", "errcard-head", lines[lines.length - 1]));
    if (lines.length > 1) {
      const fold = el("details");
      fold.append(el("summary", null, "Traceback"), el("pre", "mono", String(e.error)));
      err.append(fold);
    }
    panel.append(err);
  }
  const notes = flags.filter(([k]) => k !== "bad");
  if (notes.length) {
    const box = el("div", "flags");
    for (const [kind, text] of notes) box.append(el("div", `flag ${kind}`, text));
    panel.append(box);
  }

  // ── output, input, cost ── fetched per op, matched to this execution
  const vsec = el("section");
  const vbox = el("div", null, "Loading values…");
  vsec.append(vbox);
  panel.append(vsec);
  const costSec = el("section");
  panel.append(costSec);

  // ── its other runs ──
  if (mine.length > 1) {
    const sec = el("section");
    sec.append(el("div", "stitle", `This op's ${mine.length} runs`));
    sec.append(RunView.dots(e, mine, (x) => {
      x.el?.scrollIntoView({block: "center", behavior: "smooth"});
      x.el?.click();
    }));
    panel.append(sec);
  }

  // ── what fed it ──
  if ((e.upstreams || []).length) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Fed by"));
    const byId = new Map(execs.map(x => [x.id, x]));
    for (const u of e.upstreams) {
      const src = byId.get(u.from);
      const row = el("div", "resrow");
      row.append(el("span", "reskey mono", u.to_key || ""));
      const chip = el("button", "pchip pref",
        `${src ? src.op : u.from}.${u.from_key || ""}`);
      if (src) chip.onclick = () => {
        src.el?.scrollIntoView({block: "center", behavior: "smooth"});
        src.el?.click();
      };
      row.append(chip);
      sec.append(row);
    }
    panel.append(sec);
  }

  // ── what it fed ── (the run page knows every step's downstream)
  const fed = target && RunTree.current() ? (RunTree.current().feeds.get(e.id) || []) : [];
  if (fed.length) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Fed"));
    for (const f of fed.slice(0, 24)) {
      const row = el("div", "resrow");
      row.append(el("span", "reskey mono", f.from_key || ""));
      const chip = el("button", "pchip pref", `${f.to.name}.${f.to_key || ""}`);
      chip.onclick = () => RunTree.selectId(f.to.id);
      row.append(chip);
      sec.append(row);
    }
    if (fed.length > 24) sec.append(el("div", "note", `and ${fed.length - 24} more`));
    panel.append(sec);
  }

  // ── the facts a reader rarely needs, folded ──
  if (target) {
    const more = el("details", "rt-facts");
    more.append(el("summary", null, "Details"));
    const facts = el("div", "facts compact");
    const fact = (k, v) => { if (v == null || v === "") return; const r = el("div", "factrow"); r.append(el("div", "factkey", k), el("div", "factval mono", String(v))); facts.append(r); };
    fact("Op", node ? `${node.name} (${node.kind})` : e.op);
    if (node) fact("Runs as", [node.bound, node.is_gen ? "generator" : null, node.transient ? "transient" : null].filter(Boolean).join(" · "));
    fact("Context", e.ctx);
    fact("Step id", e.id);
    if (e.attempt && e.attempt !== 1) fact("Attempt", e.attempt);
    const src = node && node.source && (node.source.defined_at || node.source.wired_at);
    if (src) fact("Code", `${src.file}:${src.line}`);
    more.append(facts);
    panel.append(more);
  }

  try {
    // one execution by its id; an older studio's record without ids
    // falls back to the op's executions, matched by duration
    let match = null;
    const stepId = e.step || e.id;
    if (stepId) {
      try { match = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}/step?id=${encodeURIComponent(stepId)}`); }
      catch { match = null; }
    }
    if (!match) {
      const got = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`
        + `/op/${encodeURIComponent(e.op)}?limit=200`);
      match = (got.executions || []).find(x =>
        Math.abs((x.duration_ms ?? -1) - e.dur_ms) < 0.001
        && (x.ctx == null || e.ctx == null
            || String(Array.isArray(x.ctx) ? x.ctx.join(".") : x.ctx) === String(e.ctx)))
        || (got.executions || [])[0];
    }
    vbox.textContent = "";
    if (!match) { vbox.append(el("div", "note", "Values were not kept for this execution.")); return; }
    // which inputs came out of SCRATCH cells — the IR knows the binding
    const scratchKeyOf = {};
    (function walk(g) {
      for (const nn of (g && g.nodes) || []) {
        if (nn.name === e.op) {
          for (const inp of nn.inputs || []) {
            if (inp.binding && inp.binding.kind === "scratch")
              scratchKeyOf[inp.name] = inp.binding.key || inp.name;
          }
        }
        if (nn.graph) walk(nn.graph);
      }
    })(state.graph);
    const outs = match.outputs && typeof match.outputs === "object" ? match.outputs : {};
    const priced = "cost_usd" in outs || "usage" in outs;
    valueZones(vbox, match.inputs, match.outputs, scratchKeyOf,
               {outputsFirst: true, hide: priced ? ["usage", "cost_usd", "model_used"] : [],
                focus: (node && node.show_keys) || []});
    // the op again, with these inputs, in the current code
    const sm = state.runSummary;
    if (typeof PlayView !== "undefined" && sm && (sm.service || sm.job) && state._tlrun === run) {
      panel.insertBefore(PlayView.rerunSection(run, e, match), costSec.nextSibling);
    }
    // an LLM reply carries its own facts line (io.js); only a priced op
    // that is not a chat reply keeps the separate block
    if (priced && !IO.replyOf(outs)) {
      costSec.append(el("div", "stitle", "Cost and usage"));
      const u = outs.usage || {};
      const facts = el("div", "facts compact");
      const fact = (k, v) => { const r = el("div", "factrow"); r.append(el("div", "factkey", k), el("div", "factval", v)); facts.append(r); };
      if (outs.model_used) fact("Model", String(outs.model_used));
      fact("Tokens in", String(u.prompt_tokens ?? "—") + (u.cached_tokens ? ` (${u.cached_tokens} cached)` : ""));
      fact("Tokens out", String(u.completion_tokens ?? "—"));
      fact("Cost", RunView.money(outs.cost_usd, outs.cost_usd == null ? 1 : 0) || "—");
      costSec.append(facts);
    }
  } catch (err) {
    vbox.textContent = "";
    vbox.append(el("div", "note", err.message));
  }
}

/* WORKFLOW view: the flow canvas itself, moved into the Traces pane and
 * painted with this run — the same layout, every card carrying real
 * values, a turn picker to read one exchange. The paint lives only
 * here: leaving the view moves the canvas home and clears it, so the
 * Flow tab is always the clean flow. */
/* The graph a run ran. A run records its engine's name ("engine",
 * "params"), not the graph's, so it is matched on evidence: the project
 * graph whose ops (nested ones included) cover the ops the run executed.
 * Ties go to the graph with fewer ops the run never touched, then to the
 * one on screen. Null when no graph covers half of them. */
function graphForRun(data) {
  // the ops that ran at the run's root: the steps an agent op records under
  // itself are not graph ops, and counting them sank its graph's score
  const ran = AgentSteps.rootOps(data);
  if (!ran.length) return state.graph;
  const opsOf = (g, out = new Set()) => {
    for (const n of (g && g.nodes) || []) { out.add(n.name); if (n.graph) opsOf(n.graph, out); }
    return out;
  };
  let best = null;
  for (const g of state.ir.graphs || []) {
    const names = opsOf(g);
    const hits = ran.filter(o => names.has(o)).length;
    const cand = {g, score: hits / ran.length, extra: names.size - hits, here: g === state.graph ? 0 : 1};
    if (!best || cand.score > best.score
        || (cand.score === best.score && (cand.extra < best.extra || (cand.extra === best.extra && cand.here < best.here)))) best = cand;
  }
  return best && best.score >= 0.5 ? best.g : null;
}

async function showRunWorkflow(run) {
  if (state.tab !== "traces") switchTab("traces", {quiet: true});
  leaveWorkflow();
  const box = $("#traces");
  box.textContent = "";
  const mine = (state.tracesView = {});
  let data, tree;
  try {
    [data, tree] = await Promise.all([
      api(`/api/p/${PID}/trace/${encodeURIComponent(run)}`), loadRunTree(run)]);
  } catch (e) { box.append(el("div", "note", e.message)); return; }
  if (state.tracesView !== mine) return;
  followRun(run, mine, tree, () => showRunWorkflow(run));
  state.run = data;
  state.errIdx = 0;
  // every execution with its values, by op and by turn — the cards
  // read one turn's values when a turn is picked, the last otherwise
  state.runTurn = null;
  state.runTurns = tree.turns || [];
  state.runByOpTurn = new Map();
  for (const e of execsOf(tree.rows)) {
    const key = (e.ctx || "").split(".").slice(0, 2).join(".");
    if (!state.runByOpTurn.has(e.op)) state.runByOpTurn.set(e.op, new Map());
    state.runByOpTurn.get(e.op).set(key, e);   // rows are in time order: last wins
  }
  // heat scale: the run's slowest average paints the hottest border
  state.heatMax = Math.max(0, ...Object.values(data.ops || {})
    .map(o => o.runs ? o.total_ms / o.runs : 0));

  state.runRollups = new Map((tree.rollups || []).map(r => [r.op, r]));

  // the canvas shows the graph this run ran: another of the project's
  // graphs is switched to (and said so); one the studio does not draw
  // gets a note and the tree, never a canvas of unrelated faded cards
  const ranGraph = graphForRun(data);
  const workflowName = ((data.summary || tree.summary || {}).workflow) || "?";
  if (!ranGraph) {
    box.append(runHeader(run, tree, "workflow", []));
    const note = el("div", "wfnote wfmissing");
    const said = el("span");
    said.append("This run's graph (", el("code", null, workflowName), ") isn't drawn here.");
    const ops = Object.keys(data.ops || {});
    if (ops.length) said.append(el("span", "wfops", ` It ran ${ops.slice(0, 6).join(", ")}${ops.length > 6 ? "…" : ""}.`));
    note.append(said);
    const tb = el("button", "small", "Open as tree");
    tb.type = "button";
    tb.onclick = () => showRunTree(run);
    note.append(tb);
    box.append(note);
    state.run = null;
    pushView();
    return;
  }
  let switched = null;
  if (ranGraph !== state.graph) {
    switched = state.graph ? state.graph.name : null;
    // the run BORROWS the canvas for its graph: the Flow tab's own graph,
    // its open GraphOps and its view are kept and come back on leaving
    if (!state.flowHome) state.flowHome = {graph: state.graph, sel: state.sel, expanded: new Set(state.expanded)};
    state.graph = ranGraph;
    $("#graph-pick").value = ranGraph.name;
    state.sel = null;
    state.expanded.clear();
  }
  // an agent op opens onto the steps this run recorded under it
  state.runRows = tree.rows;
  state.stepsBase = state.graph;
  paintSteps(true);
  state.runSteps = (tree.rows || []).filter(r => (r.kind === "record" || r.step) && !(r.outputs || {})._transient_stream)
    .sort((a, b) => a.start_ms - b.start_ms);
  if (state.runFocusRun !== run) { state.runFocus = null; state.runPinned = false; state.runFocusRun = run; }
  // a live run redraws every few seconds: the step in focus is kept by its id
  else if (state.runFocus) state.runFocus = state.runSteps.find(r => r.id === state.runFocus.id) || null;
  const live = ((tree.summary || {}).status === "running");
  const extras = [RunView.lensBar(), runStepper(), replayControl(run)];
  box.append(runHeader(run, tree, "workflow", extras));
  if (switched) {
    const note = el("div", "wfnote");
    const said = el("span");
    said.append("Showing ", el("code", null, ranGraph.name), ", the graph this run ran",
      el("span", "wfops", switched ? ` (the canvas had ${switched})` : ""));
    note.append(said);
    box.append(note);
  }
  box.append(RunView.timeline(state.runTurns, tree.total_ms, (key) => {
    state.runTurn = key; paintSteps(true); render(); renderFlowInfo();
    // the panel reads the picked turn: the selected op's execution in it
    renderRunStep(selectedNode());
  }));
  box.classList.add("workflow");
  const stage = $("#stage");
  if (!state._stageHome) state._stageHome = {parent: stage.parentNode, next: stage.nextSibling};
  stage.style.display = "";
  // the canvas and, beside it, the step it is on: what an op did is never
  // in a panel the user has to have opened (it was, at 0 px, on Runs)
  const split = el("div", "wfsplit");
  const side = el("aside", "wfstep");
  side.id = "wfstep";
  side.setAttribute("aria-label", "The selected step");
  split.append(stage, side);
  box.append(split);
  state.workflowOn = true;
  syncChrome();
  render();
  // moving the canvas into the run's pane reset its scroll to the top-left
  // corner (a phone showed 3 of 27 cards, at the edge): the run opens
  // fitted to its own, smaller box — the Flow tab's saved view untouched
  initView(true);
  landOnAgent();
  pushView();
  renderFlowInfo();
  // live, and nothing picked by hand: follow the newest step as it lands
  if (live && !state.runPinned && state.runSteps.length) focusStep(state.runSteps[state.runSteps.length - 1], true);
  else renderRunStep(selectedNode());
}

/* ── the Workflow's step panel ──────────────────────────────────────── */

function selectedNode() {
  const it = state.sel && state.rendered.get(state.sel);
  return it ? it.node : null;
}

/* An op's executions in this run — in the picked turn when one is. A
 * subgraph's own record (operonx 1.22.3) is one of them. */
function runStepRows(name) {
  const turn = state.runTurn;
  return (state.runSteps || []).filter(r => r.op === name
    && (!turn || (r.ctx || "") === turn || (r.ctx || "").startsWith(turn + ".")));
}

const turnOf = (r) => (r.ctx || "").split(".").slice(0, 2).join(".");

/* The steps of the ops inside a subgraph node, in this run (and turn):
 * by name, and by the subgraph in the step's id where it has one. */
function innerRunRows(n) {
  const names = new Set();
  const walk = (g) => { for (const m of (g && g.nodes) || []) { names.add(m.name); if (m.graph) walk(m.graph); } };
  walk(n.graph);
  const turn = state.runTurn;
  return (state.runSteps || []).filter(r => names.has(r.op)
    && (!r.id || String(r.id).startsWith("graph:") || String(r.id).includes(`.${n.name}.`))
    && (!turn || (r.ctx || "") === turn || (r.ctx || "").startsWith(turn + ".")));
}

/* The panel beside the canvas: the selected op's execution, as the Tree
 * reads a step — its output, its input, what fed it. Several executions
 * (a turn each, a stream's items) are chips above it; the stepper's or
 * the last one is open. */
function renderRunStep(n, focus) {
  const side = $("#wfstep");
  if (!side || !state.run) return;
  side.textContent = "";
  side.classList.toggle("open", !!n);
  if (!n) {
    side.append(el("p", "note wfhint",
      "Pick an op to read what it did in this run — its output, its input, what fed it. "
      + "◀ ▶ (or ← →) walk the run step by step; a turn above narrows it to that turn."));
    return;
  }
  // a phone's sheet closes from its own bar, clear of the step's buttons
  const close = el("div", "wfbar");
  const x = Icons.button("x", undefined, "small ghost wfclose", "Close");
  x.onclick = () => { if (state.sel) select(state.sel); else renderRunStep(null); };
  close.append(el("span", "wfgrip"), x);
  if (n.step) {   // a step an agent recorded: that one execution
    const body = el("div", "wfbody");
    side.append(close, body);
    renderExecPanel(state.run.run, n.step, execsOf(state.runRows || []), body);
    return;
  }
  const rows = runStepRows(n.name);
  if (!rows.length) {
    // a subgraph with no record of its own whose ops ran: a run from
    // before operonx 1.22.3, which records a subgraph's values — it ran,
    // and its ops' steps are the way in
    const inner = n.graph ? innerRunRows(n) : [];
    if (inner.length) {
      const list = el("div", "wfexecs wfinner");
      inner.slice(0, 60).forEach((r) => {
        const c = el("button", "pill" + (r.status === "error" ? " err" : ""), `${r.op} +${fmtMs(r.start_ms)}`);
        c.type = "button";
        c.title = `${r.ctx} · ${fmtMs(r.dur_ms)}`;
        c.onclick = () => { state.runPinned = true; focusStep(r); };
        list.append(c);
      });
      side.append(close, el("h3", "rt-step-title", n.name),
        el("p", "note", `Ran — ${inner.length} step${inner.length === 1 ? "" : "s"} of its ops`
          + `${state.runTurn ? " in this turn" : ""}. This run was recorded before operonx 1.22.3, so the `
          + "subgraph's own inputs and outputs were not kept: a run made since has them. Open one of its steps:"),
        list);
      return;
    }
    side.append(close, el("h3", "rt-step-title", n.name),
      el("p", "note", state.runTurn
        ? "Did not run in this turn. Pick “Whole run”, or another turn, to see where it did."
        : "Did not run in this run — the path went another way, or nothing reached it."));
    return;
  }
  const pick = (focus && rows.includes(focus)) ? focus
    : (state.runFocus && rows.includes(state.runFocus)) ? state.runFocus : rows[rows.length - 1];
  side.append(close);
  if (rows.length > 1) {
    const chips = el("div", "wfexecs");
    chips.append(el("span", "note", `${rows.length} executions`));
    rows.slice(-40).forEach((r) => {
      const i = rows.indexOf(r);
      const c = el("button", "pill" + (r === pick ? " on" : "") + (r.status === "error" ? " err" : ""),
        `#${i + 1} +${fmtMs(r.start_ms)}`);
      c.type = "button";
      c.title = `${r.ctx} · ${fmtMs(r.dur_ms)}`;
      c.onclick = () => { state.runFocus = r; state.runPinned = true; renderRunStep(n, r); syncStepper(); };
      chips.append(c);
    });
    side.append(chips);
  }
  const body = el("div", "wfbody");
  side.append(body);
  renderExecPanel(state.run.run, pick, execsOf(state.runRows || []), body);
}

/* ◀ step i of n ▶ — the run one execution at a time, in the order they
 * started: the canvas selects the op, the panel opens that execution. */
function runStepper() {
  const box = el("span", "wfstepper");
  const arrow = (label, title) => {
    const b = el("button", "small ghost wfarrow", label);
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  };
  const prev = arrow("◀", "Previous step (←)");
  const next = arrow("▶", "Next step (→)");
  const at = el("span", "wfstepat");
  prev.onclick = () => stepBy(-1);
  next.onclick = () => stepBy(1);
  box.append(prev, at, next);
  state.stepperEl = at;
  syncStepper();
  return box;
}

function syncStepper() {
  const steps = state.runSteps || [];
  const i = state.runFocus ? steps.indexOf(state.runFocus) : -1;
  if (state.stepperEl) state.stepperEl.textContent = steps.length ? `step ${i + 1 || "–"} of ${steps.length}` : "no steps";
}

function stepBy(d) {
  const steps = state.runSteps || [];
  if (!steps.length) return;
  state.runPinned = true;   // stepping by hand: a live run stops pulling the focus
  const i = state.runFocus ? steps.indexOf(state.runFocus) : -1;
  focusStep(steps[Math.max(0, Math.min(steps.length - 1, i < 0 ? 0 : i + d))]);
}

function focusStep(row, auto) {
  state.runFocus = row;
  state._autoStep = !!auto;
  // a step outside the picked turn: the turn follows it
  if (state.runTurn && turnOf(row) !== state.runTurn) { state.runTurn = null; paintSteps(true); render(); }
  let found = [...state.rendered.values()].find(x => x.node.name === row.op);
  if (!found) { expandAll(true); found = [...state.rendered.values()].find(x => x.node.name === row.op); }
  if (found) {
    if (state.sel !== found.key) select(found.key); else renderRunStep(found.node, row);
    centerOn(found);
  } else renderRunStep({name: row.op}, row);
  state._autoStep = false;
  syncStepper();
}

document.addEventListener("keydown", (ev) => {
  if (!state.workflowOn || !state.run || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
  // first, and only: the canvas's own arrow keys walk to a neighbour card
  ev.preventDefault();
  ev.stopImmediatePropagation();
  stepBy(ev.key === "ArrowRight" ? 1 : -1);
}, true);

// a replay finishing an op: the panel follows it
document.addEventListener("oxreplayop", (ev) => {
  if (!state.workflowOn || !state.run) return;
  const op = (ev.detail || {}).op;
  const rows = (state.runSteps || []).filter(r => r.op === op);
  if (rows.length) { state.runFocus = rows[rows.length - 1]; renderRunStep({name: op}, state.runFocus); syncStepper(); }
});

/* A run whose agent op opened onto its steps lands on that agent: its
 * turns are what the run did, and they are below the fold of a tall flow. */
function landOnAgent() {
  const agent = [...state.rendered.values()].find(x => x.inner && x.node.agentSteps);
  if (!agent) return;
  const stage = $("#stage"), r = stage.getBoundingClientRect();
  const s = state.view.scale, ex = state.extent;
  stage.scrollTop = Math.max(0, (agent.y - ex.minY) * s + VIEW_PAD - 16);
  stage.scrollLeft = Math.max(0, (agent.x + agent.w / 2 - ex.minX) * s + VIEW_PAD - r.width / 2);
}

/* The painted graph: the run's graph with each agent op given the graph
 * its recorded steps make (agentsteps.js) — for the picked turn, or the
 * whole run. `open` opens the agents and their turns, so the run shows its
 * structure at once. The Flow tab's graph (`stepsBase`) is never changed. */
function paintSteps(open) {
  if (!state.stepsBase) return;
  const {graph, opened} = AgentSteps.withSteps(state.stepsBase, state.runRows || [], state.runTurn);
  state.graph = state.stepsGraph = graph;
  if (open) for (const key of opened) state.expanded.add(key);
}

/* "error →": center + select the errored ops one by one, opening
 * containers if the culprit is folded away inside one. */
function walkErrors() {
  if (!state.run) return;
  const names = Object.entries(state.run.ops || {})
    .filter(([, o]) => o.errors).map(([name]) => name);
  if (!names.length) return;
  const name = names[state.errIdx % names.length];
  state.errIdx += 1;
  let found = [...state.rendered.values()].find(x => x.node.name === name);
  if (!found) {          // hidden inside a collapsed GraphOp — open everything
    expandAll(true);
    found = [...state.rendered.values()].find(x => x.node.name === name);
  }
  if (found) { select(found.key); centerOn(found); }
  else toast(`'${name}' errored but is not on this canvas`, true);
}

// the canvas goes home and the paint comes off — the Flow tab never
// shows a run
function leaveWorkflow() {
  // not quiet: a quiet stop left the "Replaying … done" pill riding back
  // to the Flow tab with the canvas
  if (liveCanvas) liveCanvas.stop();
  if (!state.workflowOn) return;
  state.workflowOn = false;
  syncChrome();
  const stage = $("#stage");
  $("#traces").classList.remove("workflow");
  const home = state._stageHome;
  home.parent.insertBefore(stage, home.next && home.next.parentNode === home.parent ? home.next : null);
  stage.style.display = state.tab === "flow" ? "" : "none";
  state.run = null;
  state.runTurn = null;
  state.runByOpTurn = null;
  state.runRollups = null;
  state.heatMax = 0;
  // the Flow tab gets its own graph back, not the run's opened copy
  if (state.stepsBase && state.graph === state.stepsGraph) state.graph = state.stepsBase;
  state.stepsBase = state.stepsGraph = state.runRows = null;
  // ... nor the run's graph: the one it showed before the run borrowed it
  if (state.flowHome) {
    const h = state.flowHome;
    state.flowHome = null;
    if (h.graph && state.ir && state.ir.graphs.includes(h.graph)) {
      state.graph = h.graph;
      state.sel = h.sel;
      state.expanded = h.expanded;
      const pick = $("#graph-pick");
      if (pick) pick.value = h.graph.name;
    }
  }
  render();
  // ... and coming home it lost the Flow tab's view: it comes back once
  // the canvas shows at its full size (flushCanvas)
  state.viewPending = true;
  renderFlowInfo();
}

/* every nested graph at once — opening five GraphOps one by one to see
 * a pipeline is ritual, not choice */
function expandAll(open) {
  const all = [];
  (function walk(g, prefix) {
    for (const n of g.nodes || []) {
      if (n.graph) { all.push(prefix + n.id); walk(n.graph, prefix + n.id + "/"); }
      // an agent and its parts open too: a graph tool, an agent tool
      else if (n.parts) { all.push(prefix + n.id); walk({nodes: n.parts}, prefix + n.id + "/"); }
    }
  })(state.graph, "");
  state.expanded = open ? new Set(all) : new Set();
  render();
  return all.length;
}

$("#btn-expand").onclick = () => {
  const anyOpen = state.expanded.size > 0;
  const count = expandAll(!anyOpen);
  if (!count) toast("no nested graphs here");
  const opened = !anyOpen && !!count;
  Icons.set($("#btn-expand"), opened ? "fold" : "unfold");
  $("#btn-expand").classList.toggle("active", opened);
  $("#btn-expand").setAttribute("aria-label", opened ? "Close every nested graph" : "Open every nested graph");
};

$("#btn-find").onclick = () => openFind();

