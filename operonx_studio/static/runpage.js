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
  const line = el("span", "tlorigin");
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
    if (s.session_id) {
      // a session id is a uuid: its head names it, the whole one copies
      const sid = String(s.session_id);
      line.append(" · session ");
      const b = el("button", "linkbtn mono tlsid", sid.length > 12 ? sid.slice(0, 8) + "…" : sid);
      b.type = "button";
      b.title = `Session ${sid} — click to copy`;
      b.onclick = async () => { try { await navigator.clipboard.writeText(sid); toast("Session id copied"); } catch { toast(sid); } };
      line.append(b);
    }
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
  const tree = await api(`/api/p/${PID}/trace/${encodeURIComponent(run)}/tree`);
  StepValues.preload(run, tree);
  return tree;
}

/* Every step's values, kept in the page. A finished run's are fetched in
 * one request as soon as its tree arrives (each request through a tunnel
 * costs a second or more), so a click reads them here. What the preload
 * did not bring (a run still going, or one past the size cap) comes on
 * the click, with the steps after it in the same request. A recorded
 * step never changes: nothing here goes stale. */
const StepValues = (() => {
  const cache = new Map();      // `${PID}|${run}|${id}` -> the step's values
  const preloads = new Map();   // `${PID}|${run}` -> the preload's promise
  const key = (run, id) => `${PID}|${run}|${id}`;
  const url = (run) => `/api/p/${PID}/trace/${encodeURIComponent(run)}/steps`;
  function put(run, steps) {
    if (cache.size > 20000) cache.clear();      // a long session: start over
    for (const [id, step] of Object.entries(steps || {})) cache.set(key(run, id), step);
  }
  function preload(run, tree) {
    const k = `${PID}|${run}`;
    if (preloads.has(k) || ((tree || {}).summary || {}).status === "running") return;
    preloads.set(k, api(url(run)).then(d => { put(run, d.steps); return d; })
      .catch(() => { preloads.delete(k); return null; }));
  }
  async function get(run, id, ahead) {
    if (cache.has(key(run, id))) return cache.get(key(run, id));
    const pending = preloads.get(`${PID}|${run}`);
    if (pending) {
      await pending;
      if (cache.has(key(run, id))) return cache.get(key(run, id));
    }
    const ids = [id, ...(ahead || []).filter(x => x && x !== id && !cache.has(key(run, x)))].slice(0, 24);
    const d = await api(`${url(run)}?${ids.map(x => "ids=" + encodeURIComponent(x)).join("&")}`);
    put(run, d.steps);
    return cache.get(key(run, id)) || null;
  }
  return {preload, get};
})();

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
/* "What if this op had answered otherwise?" — a step of a run kept in a
 * journal can be changed and the run continued from it (operonx fork): the
 * steps before it are replayed, not run; what follows runs with the new
 * value, in the current code. The original run is not changed: the new
 * one opens, with Compare beside it. */
function forkable(sm, e, node) {
  return (sm.metadata || {}).durable && (sm.service || sm.job)
    && ["service", "playground", "job"].includes(sm.origin)
    // the graph shown may be another service's: an op it does not know is
    // left to the bridge, which refuses one that does not answer once
    && e.status !== "error" && !e.child && !(node && (node.is_gen || node.kind === "graph"))
    && !String(e.id || "").endsWith("@stopped") && !(window.Account && Account.viewOnly);
}

function forkSection(run, e, recorded) {
  const sec = el("section", "rerunsec forksec");
  sec.append(el("div", "stitle", "What if"));
  const hint = el("div", "note", "Change what this op answered and run what follows, in the current code — the steps before it are not run again, and this run stays as it is.");
  const start = el("button", null, "Change this output and continue…");
  start.type = "button";
  sec.append(hint, start);
  start.onclick = () => {
    const outs = {};
    for (const [k, v] of Object.entries((recorded && recorded.outputs) || {})) {
      if (!k.startsWith("_") && !["usage", "cost_usd", "model_used"].includes(k)) outs[k] = v;
    }
    const box = el("div", "rerunbox");
    const ta = el("textarea", "mono playjson");
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "The op's output, changed");
    ta.value = JSON.stringify(outs, null, 2);
    const err = el("div", "fielderr");
    const acts = el("div", "priceacts");
    const go = el("button", "primary", "Continue from here");
    go.type = "button";
    acts.append(go);
    const res = el("div", "rerunres");
    box.append(ta, err, acts, res);
    start.replaceWith(box);
    ta.focus();
    go.onclick = async () => {
      let outputs;
      try { outputs = JSON.parse(ta.value); err.textContent = ""; }
      catch (x) { err.textContent = `Not JSON: ${x.message}`; return; }
      if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
        err.textContent = "The output is an object: {\"<output>\": value}"; return;
      }
      go.disabled = true;
      res.textContent = "";
      res.append(el("div", "note", "Running what follows…"));
      let got;
      try {
        got = await api(`/api/p/${PID}/runs/fork`, {run_id: run, at: e.op, ctx: e.ctx || "main", outputs});
      } catch (x) {
        res.textContent = ""; res.append(el("div", "errbox", x.message)); go.disabled = false; return;
      }
      go.disabled = false;
      res.textContent = "";
      const top = el("div", "execverdict");
      const word = got.status === "error" ? "failed" : got.status === "interrupted" ? "waiting" : "ok";
      top.append(el("span", "status " + (got.status === "error" ? "s-bad" : got.status === "interrupted" ? "s-wait" : "s-ok"), word));
      const open = el("button", "linkbtn", "Open the new run"); open.type = "button";
      open.onclick = () => performUi("open_run", {run: got.run_id, quiet: true});
      const cmp = el("button", "linkbtn", "Compare with this run"); cmp.type = "button";
      cmp.onclick = () => performUi("compare", {a: run, b: got.run_id});
      top.append(el("span", "vsep", "·"), open, el("span", "vsep", "·"), cmp);
      res.append(top);
      if (got.error) res.append(el("div", "errbox", got.error));
    };
  };
  return sec;
}

/* the run line on screen (the Workflow view), or null */
const lineView = () => (typeof RunLineView !== "undefined" && RunLineView.current()) || null;

/* go to another execution in whichever run view is showing */
function pickExec(x) {
  if (lineView()) return RunLineView.selectId(x.id);
  if (x.el) {
    x.el.scrollIntoView({block: "center", behavior: "smooth"});
    x.el.click();
    return true;
  }
  return RunTree.selectId(x.id);
}

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
    const back = Icons.button("back", "Steps", "small ghost rt-back", "Back to the steps");
    back.onclick = () => (lineView() ? RunLineView.backToSteps() : RunTree.backToSteps());
    title.append(back);
    const ico = node ? kindIconEl("rt-ico", node) : el("span", "rt-ico", "≋");
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
    sec.append(RunView.dots(e, mine, (x) => pickExec(x)));
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
      if (src) chip.onclick = () => pickExec(src);
      row.append(chip);
      sec.append(row);
    }
    panel.append(sec);
  }

  // ── what it fed ── (the run page knows every step's downstream)
  const view = target && (lineView() || RunTree.current());
  const fed = view ? (view.feeds.get(e.id) || []) : [];
  if (fed.length) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Fed"));
    for (const f of fed.slice(0, 24)) {
      const row = el("div", "resrow");
      row.append(el("span", "reskey mono", f.from_key || ""));
      const chip = el("button", "pchip pref", `${f.to.name}.${f.to_key || ""}`);
      chip.onclick = () => (lineView() ? RunLineView.selectId(f.to.id) : RunTree.selectId(f.to.id));
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
      // the steps after this one ride along, for the next clicks
      const at = execs.indexOf(e);
      const ahead = at < 0 ? [] : [...execs.slice(at + 1, at + 17), ...execs.slice(Math.max(0, at - 4), at)]
        .map(x => x.step || x.id);
      try { match = await StepValues.get(run, stepId, ahead); }
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
               {hide: priced ? ["usage", "cost_usd", "model_used"] : [],
                focus: (node && node.show_keys) || []});
    // calls this step sent again (operonx retry_call): "3 calls, 2 retried (429)"
    const resent = callRetries(match.attrs);
    if (resent) vbox.prepend(resent);
    // the op again, with these inputs, in the current code
    const sm = state.runSummary;
    if (typeof PlayView !== "undefined" && sm && (sm.service || sm.job) && state._tlrun === run) {
      panel.insertBefore(PlayView.rerunSection(run, e, match), costSec.nextSibling);
    }
    // a journalled run's step: what if it had answered otherwise?
    if (sm && forkable(sm, e, node)) {
      panel.insertBefore(forkSection(run, e, match), costSec.nextSibling);
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

/* The calls a step sent again, folded: IO.retrySummary's line, the
 * attempts under it. */
function callRetries(attrs) {
  const sum = IO.retrySummary(attrs);
  if (!sum) return null;
  const box = el("details", "callretry");
  box.append(el("summary", null, sum.line));
  const facts = el("div", "facts compact");
  for (const [k, v] of sum.rows) {
    const row = el("div", "factrow");
    row.append(el("div", "factkey", k), el("div", "factval mono", v));
    facts.append(row);
  }
  box.append(facts);
  return box;
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

/* the run page's Workflow view: the flow as a line beside the step (runlineview.js) */
async function showRunWorkflow(run) {
  leaveWorkflow();
  return RunLineView.show(run);
}

/* leaving a run page: a replay on the canvas stops (not quietly — a quiet
 * stop left the "Replaying … done" pill riding back to the Flow tab) */
function leaveWorkflow() {
  if (liveCanvas) liveCanvas.stop();
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

