/* operonx studio — the inspector: the selected op, its ports and code.
 * Split from studio.js, same bundle, same order. */

/* ── inspector ────────────────────────────────────────────────────── */

/* The inspector's contract: the most important thing first.
 *
 * With a run painted, that is what the op actually DID — its recorded
 * output and input values, then its execution history. Without one, it
 * is what the op IS — its wiring and params. Identity chips always lead;
 * code, prompts and source live in collapsed sections underneath, so
 * they are one click away but never in the way. */
function select(key) {
  dfPlatePin = null;
  state.route = null;
  state.dfTerm = null;
  state.dfTermPort = state.dfTermHover = null;
  const before = state.sel;
  state.sel = (state.sel === key) ? null : key;
  // Workflow opens the selected op in place: a re-layout round the card
  if (canvasView === "workflow" && before !== state.sel) renderKeeping(before && !state.sel ? before : state.sel);
  refreshSelection();
  pushView();
  const panel = $("#inspector");
  const runStep = state.workflowOn && state.run && $("#wfstep");
  if (!state.sel) { if (runStep) renderRunStep(null); renderFlowInfo(); return; }
  const it = state.rendered.get(state.sel);
  if (!it) { state.sel = null; renderFlowInfo(); return; }
  const n = it.node;
  // a run's Workflow: what the op did goes to the step panel beside the canvas
  if (runStep) {
    if (!state._autoStep) state.runPinned = true;   // picked by hand: a live run stops pulling the focus
    renderRunStep(n);
    syncStepper();
    return;
  }
  // a step the run recorded (an agent's turn, model or tool call) reads as
  // the Tree view reads it: that one execution, its inputs and outputs
  if (n.step && state.run) { renderExecPanel(state.run.run, n.step, execsOf(state.runRows || [])); return; }
  // an op was picked on the canvas: its detail is the point, bring the tab forward
  // (on a phone the panel is a sheet that only a selection opens)
  if (MOBILE.matches || (panelWanted() && recall("sideTab", "assistant") !== "inspect")) showSide("inspect");
  panel.textContent = "";
  panel.scrollTop = 0;

  // ── identity: sticky while the body scrolls ───────────────────────
  const head = el("div", "phead");
  const close = el("button", "pclose", "✕");
  close.title = "close (Esc)";
  close.onclick = deselect;
  head.append(close);
  // a nested member keeps its address visible: container › … › me
  const parts = state.sel.split("/");
  if (parts.length > 1) {
    const trail = parts.slice(0, -1)
      .map((_, i) => state.rendered.get(parts.slice(0, i + 1).join("/"))?.node.name || "?")
      .join(" › ");
    head.append(el("div", "crumbpath mono", trail + " ›"));
  }
  const titleRow = el("div", "ptitle-row");
  titleRow.append(el("h3", null, n.name));
  if (window.oxAssistant) {
    const ask = Icons.button("spark", "Ask", "askbtn", `Ask the assistant about ${n.name}`);
    ask.onclick = () => window.oxAssistant.focus();
    titleRow.append(ask);
  }
  head.append(titleRow);
  const chips = el("div", "chips");
  const kindChip = el("span", "chip kindchip", n.kind);
  kindChip.style.setProperty("--kind", kindColor(n));
  chips.append(kindChip);
  if (n.bound) chips.append(el("span", "chip", n.bound));
  if (n.is_gen) {
    const c = el("span", "chip cgen", "⚡ generator");
    c.title = "Invoked once, yields many — every consumer dispatches per yield.";
    chips.append(c);
  }
  if (n.transient) {
    const c = el("span", "chip", "transient");
    c.title = "Outputs are delivered and then evicted; a long stream retains nothing.";
    chips.append(c);
  }
  if (n.resource) {
    chips.append(el("span", "chip cres",
      "⛁ " + (Array.isArray(n.resource) ? n.resource.join(" · ") : n.resource)));
  }
  if (n.loop) chips.append(el("span", "chip cloop", "↺ in a loop"));
  head.append(chips);
  panel.append(head);
  if (n.loop) panel.append(loopNote(n, it.zone));

  if (state.run && !ranInRun(n)) {
    panel.append(el("div", "rolenote dormnote",
      `— did not execute in ${state.run.run}. The values below are its wiring, not a recording.`));
  }
  // with a run painted, the op's verdict in that run comes first
  const inRun = state.run && state.run.ops[n.name];
  if (inRun) {
    const roll = state.runRollups ? state.runRollups.get(n.name) : null;
    const total = Math.max(1, (state.run.wall_s || 0) * 1000);
    const v = el("div", "execverdict");
    v.append(el("span", "status " + (inRun.errors ? "s-bad" : "s-ok"), inRun.errors ? `${inRun.errors} failed` : "ok"));
    v.append(el("span", "vsep", "·"), el("span", "strong", fmtMs(inRun.total_ms)));
    v.append(el("span", "vsep", "·"), el("span", null, `${inRun.runs} run${inRun.runs > 1 ? "s" : ""}`));
    if (state.run.wall_s) v.append(el("span", "vsep", "·"), el("span", null, `${Math.round(100 * inRun.total_ms / total)}% of the run`));
    const cost = roll ? RunView.money(roll.cost_usd, roll.unpriced) : null;
    if (cost) v.append(el("span", "vsep", "·"), el("span", null, cost));
    panel.append(v);
  }
  if (n.serve_role) {
    panel.append(el("div", "rolenote",
      n.serve_role === "ingress"
        ? "⇥ Serve boundary — the client's data enters the run here. No business logic inside."
        : "⇥ Serve boundary — the run's answers leave for the client here. No business logic inside."));
    const t = n.serve_role === "ingress" && serveFor(state.graph);
    if (t) {
      const line = el("div", "srcline mono",
        `⟶ transport: ${t.kind}${t.path ? " " + t.path : ""}`);
      if (t.description) line.title = t.description;
      panel.append(line);
    }
  }

  // One fetch per selection; every section that cares about the painted
  // run shares it.
  const execP = state.run
    ? api(`/api/p/${PID}/trace/${encodeURIComponent(state.run.run)}/op/${encodeURIComponent(n.name)}`)
    : null;

  // A painted run leads with THE RUNS: click an execution, see its
  // inputs and outputs — that is what a trace is for. Everything else
  // (wiring, resource, code) queues behind. Containers keep the
  // member-scan latest-values view before their grouped passes.
  if (execP && !n.graph) panel.append(executionsSection(n, execP));
  if (execP && n.graph) panel.append(valuesSection(n, execP));
  // With a run painted the panel is a TRACE reader: ports would only
  // repeat what every execution already shows, and code lives in the
  // flow view — both stand down until the run is cleared.
  if (n.description) panel.append(el("div", "rolenote", n.description));
  // what can be set on it, as what it is (configure.js), then its wiring
  if (!state.run && !n.graph) panel.append(Configure.section(it));
  if (!state.run) panel.append(portsSection(it));
  const res = resourceSection(n);
  if (res) panel.append(res);
  const tools = toolsSection(n);
  if (tools) panel.append(tools);
  const llm = llmSection(n, execP);
  if (llm) panel.append(llm);
  if (n.routes) panel.append(routeSection(it, execP));
  if (execP && n.graph) panel.append(executionsSection(n, execP));
  if (n.code && !state.run) panel.append(codeSection(n));
  if (n.graph) panel.append(membersSection(it));
}

function valuesSection(n, execP) {
  const sec = el("section");
  sec.append(el("div", "stitle", `Latest values · ${state.run.run}`));
  const box = el("div", null, "…");
  sec.append(box);

  const addRow = (dir, key, val) => {
    const row = el("div", `valrow ${dir === "in" ? "vin" : ""}`);
    row.append(el("div", "vname mono", dir === "out" ? `${key} →` : `→ ${key}`));
    row.append(Values.render(val, {open: dir === "out"}));
    box.append(row);
  };

  execP.then(data => {
    box.textContent = "";
    if (!data.executions.length) {
      box.append(el("div", "note", "no records for this op in this run"));
      return;
    }

    if (n.graph) {
      // A GraphOp never executes under its own name — its ports' values
      // live in its MEMBERS' records. The last member record that
      // carried each declared port name is the value that crossed the
      // container's boundary.
      const boundary = (names, dir) => {
        const found = {};
        for (const ex of data.executions) {
          const src = dir === "out" ? ex.outputs : ex.inputs;
          if (!src || typeof src !== "object") continue;
          for (const k of names) if (k in src) found[k] = src[k];
        }
        return found;
      };
      const outs = boundary(n.outputs || [], "out");
      const ins = boundary((n.inputs || []).map(i => i.name), "in");
      for (const k of n.outputs || []) {
        if (k in outs) addRow("out", k, outs[k]);
        else addRow("out", k, "(not recorded in this run)");
      }
      for (const inp of n.inputs || []) {
        if (inp.name in ins) addRow("in", inp.name, ins[inp.name]);
      }
      if (!box.childNodes.length) box.append(el("div", "note", "no declared ports"));
      return;
    }

    // a plain op: the latest record's values, outputs first — "what did
    // this op produce" is why the node was clicked
    const last = data.executions[data.executions.length - 1];
    const groups = [["out", last.outputs, n.outputs || []],
                    ["in", last.inputs, null]];
    for (const [dir, values, priority] of groups) {
      const entries = Object.entries(values || {});
      if (priority) entries.sort((a, b) =>
        (priority.indexOf(a[0]) + 1 || 99) - (priority.indexOf(b[0]) + 1 || 99));
      for (const [key, val] of entries) addRow(dir, key, val);
    }
    if (!box.childNodes.length) box.append(el("div", "note", "record carried no values"));
  }).catch(e => { box.textContent = e.message; });
  return sec;
}

/* The decision table: every condition, its target, and — with a run
 * painted — how often each fired and which fired last. Rows that never
 * fired dim; the latest choice is marked. */
function routeSection(it, execP) {
  const n = it.node;
  const sec = el("section");
  sec.append(el("div", "stitle", "Decision table"));
  const byTarget = new Map();
  n.routes.forEach((r, ri) => {
    const row = el("div", "drow" + (r.condition === "else" ? " relse" : ""));
    row.dataset.route = String(ri);
    const cond = el("div", "dcond mono", r.condition);
    cond.title = r.condition;
    row.append(cond);
    row.append(el("span", "parr out", "→"));
    const tgt = el("button", "pchip pref", r.target);
    tgt.onclick = () => jumpTo(r.target, it.depth);
    row.append(tgt);
    const meta = el("span", "dmeta");
    row.append(meta);
    if (!byTarget.has(r.target)) byTarget.set(r.target, []);
    byTarget.get(r.target).push({row, meta});
    sec.append(row);
  });
  if (execP) execP.then(data => {
    if (!data.executions.length) return;
    const fired = {};
    for (const ex of data.executions) {
      const t = (ex.outputs || {}).target;
      if (t) fired[t] = (fired[t] || 0) + 1;
    }
    const last = data.executions[data.executions.length - 1];
    const latest = (last.outputs || {}).target;
    for (const [target, entries] of byTarget) {
      const count = fired[target] || 0;
      for (const {row, meta} of entries) {
        if (count) meta.append(el("span", "chip cfired", `${count}×`));
        else row.classList.add("dnever");
        if (target === latest) {
          row.classList.add("dlatest");
          meta.append(el("span", "chip clatest", "latest"));
        }
      }
    }
  }).catch(() => {});
  return sec;
}

/* LLMOp: the traced conversation when there is one — role-labelled
 * bubbles with the response emphasized — else the authored templates. */
/* A field value with its ${VAR} knobs rendered as env pills: the var
 * NAME shows (that is safe and useful), the value never travels here.
 * A `${VAR:default}` pill carries its default right after it. */
function envValue(v) {
  const out = el("span", "resval mono");
  const s = String(v);
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.append(s.slice(last, m.index));
    const tok = el("span", "envtok", "${" + m[1] + "}");
    tok.title = m[2] !== undefined && m[2] !== ""
      ? `env variable — default: ${m[2]}` : "env variable — required";
    out.append(tok);
    if (m[2]) out.append(el("span", "envdefault", m[2]));
    last = re.lastIndex;
  }
  if (last < s.length) out.append(s.slice(last));
  return out;
}

/* The resource an op leans on is part of what the op IS — an LLM op
 * without its model and endpoint is half a description. Hardcoded
 * secrets never reach the IR (masked at extraction); env-bound ones
 * appear as their ${VAR} pill. */
function resourceSection(n) {
  if (!n.resource) return null;
  const names = Array.isArray(n.resource) ? n.resource : [n.resource];
  const all = (state.ir.resources || {}).details || {};
  const sec = el("section");
  sec.append(el("div", "stitle", "Resource"));
  const provider = llmProvider(n);
  for (const name of names) {
    const det = resourceDetail(all, name);
    const head = el("div", "resname mono");
    head.append(`⛁ ${name}` + (det && det.category ? `  ·  ${det.category}` : ""));
    sec.append(head);
    if (provider) {
      const row = el("div", "resrow");
      row.append(el("span", "reskey", "backend"));
      row.append(el("span", "resval resbackend",
        `${LLM_PROVIDERS[provider].icon} ${LLM_PROVIDERS[provider].label}`));
      sec.append(row);
    }
    if (det) {
      for (const [k, v] of Object.entries(det)) {
        if (k === "category") continue;
        const row = el("div", "resrow");
        row.append(el("span", "reskey", k));
        row.append(envValue(v));
        sec.append(row);
      }
    } else {
      sec.append(el("div", "note",
        "named here, but no matching entry in the project's resource files"));
    }
  }
  return sec;
}

/* An agent op runs the tools its agent owns, and only those: the card
 * names the first few, the inspector lists each with what it may do
 * (read-only, destructive, asks a human first). */
function toolFlags(tl) {
  const flags = [];
  if (tl.readonly) flags.push(["read-only", "tflag tro"]);
  if (tl.destructive) flags.push(["destructive", "tflag tdes"]);
  if (tl.approval && tl.approval !== "never") {
    flags.push([tl.approval === "always" ? "asks approval" : "may ask approval", "tflag task"]);
  }
  return flags;
}

function agentToolsLine(n) {
  const tools = (n.agent && n.agent.tools) || [];
  if (!tools.length) return null;
  const names = tools.map(tl => tl.name);
  const shown = names.slice(0, 3).join(" · ") + (names.length > 3 ? ` +${names.length - 3}` : "");
  const row = el("div", "agtools mono", "⚒ " + shown);
  row.title = `${n.agent.name || "agent"} can call: ${names.join(", ")}`;
  return row;
}

function toolsSection(n) {
  // an agent's tool: what it is, and what the agent's policy lets it do
  if (n.part === "tool" && n.tool) {
    const tl = n.tool, policy = tl.policy || "allow";
    const sec = el("section");
    sec.append(el("div", "stitle", `Tool of ${(n.id || "").split(".").slice(-2, -1)[0] || "the agent"}`));
    const head = el("div", "toolname mono");
    head.append(el("span", null, TOOL_KIND_WORDS[tl.kind] || "function"));
    head.append(el("span", "atpolicy p-" + policy, policy.toUpperCase()));
    for (const [label, cls] of toolFlags(tl)) head.append(el("span", cls, label));
    sec.append(head);
    sec.append(el("div", "tooldesc", policy === "allow" ? "Runs when the model calls it."
      : policy === "ask" ? "Waits for a human's approval before it runs."
      : "Refused: the model is told it may not call it."));
    return sec;
  }
  const tools = (n.agent && n.agent.tools) || [];
  if (!n.agent) return null;
  const sec = el("section");
  sec.append(el("div", "stitle", `Tools · ${tools.length}`));
  if (!tools.length) {
    sec.append(el("div", "note", `${n.agent.name || "this agent"} has no tools: it only answers`));
    return sec;
  }
  for (const tl of tools) {
    const head = el("div", "toolname mono");
    head.append(el("span", null, `⚒ ${tl.name}`));
    for (const [label, cls] of toolFlags(tl)) head.append(el("span", cls, label));
    sec.append(head);
    if (tl.description) sec.append(el("div", "tooldesc", tl.description));
  }
  return sec;
}

function llmSection(n, execP) {
  // an agent's model is no LLMOp of the graph: the agent writes its conversation
  if (!(n.kind || "").includes("LLM") || n.part === "model") return null;
  const byName = {};
  for (const inp of n.inputs || []) byName[inp.name] = inp.binding || {};
  const sec = el("section");
  sec.append(el("div", "stitle", "Conversation"));
  const box = el("div");
  sec.append(box);

  const templates = () => {
    const prompt = byName.prompt;
    if (prompt && prompt.kind === "literal" && prompt.value && typeof prompt.value === "object") {
      for (const part of ["system", "user"]) {
        if (prompt.value[part] === undefined) continue;
        box.append(el("div", "plabel", part + " (template)"));
        box.append(el("pre", "promptblock mono", String(prompt.value[part])));
      }
    } else if (byName.messages) {
      const b = byName.messages;
      box.append(el("div", "srcline",
        b.kind === "ref" ? `messages ← ${(b.from || "").split(".").pop()}.${b.output} (conversation is data, never templated)`
                         : "messages: bound at run time"));
    } else {
      box.append(el("div", "note", "no prompt literal — see wiring below"));
    }
  };

  const bubbles = (msgs, response) => {
    for (const m of msgs.slice(-8)) {
      const b = el("div", `bubble b-${m.role || "user"}`);
      b.append(el("div", "plabel", m.role || "?"));
      b.append(el("div", "btext", typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      box.append(b);
    }
    if (msgs.length > 8) box.append(el("div", "srcline", `…${msgs.length - 8} earlier messages`));
    if (response !== undefined && response !== null) {
      const b = el("div", "bubble b-assistant b-resp");
      b.append(el("div", "plabel", "response"));
      b.append(el("div", "btext", String(response)));
      box.append(b);
    }
  };

  if (execP) {
    execP.then(data => {
      const last = data.executions[data.executions.length - 1];
      const msgs = last && last.inputs && last.inputs.messages;
      const content = last && last.outputs && last.outputs.content;
      if (Array.isArray(msgs) && msgs.length) bubbles(msgs, content);
      else if (content !== undefined && content !== null) { templates(); bubbles([], content); }
      else templates();
    }).catch(templates);
  } else {
    templates();
  }

  const params = el("div", "chips");
  for (const [name, b] of Object.entries(byName)) {
    if (b.kind !== "literal") continue;
    if (name === "prompt" || name === "messages") continue;
    const v = b.value;
    if (v === null || ["string", "number", "boolean"].includes(typeof v))
      params.append(el("span", "chip", `${name}=${JSON.stringify(v)}`));
  }
  if (params.childNodes.length) sec.append(params);
  return sec;
}

/* GraphOp: the members, right here — click one to open the container
 * and select it. With a run painted, each member's cost. */
function membersSection(it) {
  const n = it.node;
  const sec = el("section");
  sec.append(el("div", "stitle", `Inside · ${n.subgraph_ops} ops`));
  for (const m of (n.graph.nodes || [])) {
    const row = el("button", "memberrow");
    row.append(el("span", "memicon", kindIcon(m)));
    row.append(el("span", "mono", m.name));
    row.append(el("span", "memkind", m.kind));
    const runinfo = state.run && state.run.ops[m.name];
    if (runinfo) {
      const avg = runinfo.runs ? runinfo.total_ms / runinfo.runs : 0;
      const chip = el("span", "chip", `${runinfo.runs}× ${avg < 10 ? avg.toFixed(1) : Math.round(avg)}ms`);
      if (runinfo.errors) chip.classList.add("cbad");
      row.append(chip);
    }
    row.onclick = () => {
      if (!state.expanded.has(it.key)) { state.expanded.add(it.key); render(); }
      select(it.key + "/" + m.id);
    };
    sec.append(row);
  }
  return sec;
}

/* ── code, tinted offline ─────────────────────────────────────────── */

const PY_KW = new Set(("def return if else elif for while in not and or async await yield "
  + "import from as class try except finally with pass raise lambda None True False "
  + "is global del assert break continue match case").split(" "));
const PY_TOKEN = /("""|'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#.*$|@\w+|\b[A-Za-z_]\w*\b)/g;

function tintLine(line, st) {
  const frag = document.createDocumentFragment();
  if (st.instr) {   // inside a triple-quoted string
    const end = line.indexOf(st.instr);
    if (end === -1) { frag.append(span("cs", line)); return frag; }
    frag.append(span("cs", line.slice(0, end + 3)));
    st.instr = null;
    frag.append(...tintLine(line.slice(end + 3), st).childNodes);
    return frag;
  }
  let idx = 0, m;
  PY_TOKEN.lastIndex = 0;
  while ((m = PY_TOKEN.exec(line)) !== null) {
    if (m.index > idx) frag.append(line.slice(idx, m.index));
    const t = m[0];
    if (t === '"""' || t === "'''") {
      const rest = line.slice(m.index + 3);
      const end = rest.indexOf(t);
      if (end === -1) { st.instr = t; frag.append(span("cs", line.slice(m.index))); return frag; }
      frag.append(span("cs", t + rest.slice(0, end + 3)));
      idx = m.index + 3 + end + 3;
      PY_TOKEN.lastIndex = idx;
      continue;
    }
    if (t.startsWith("#")) frag.append(span("cc", t));
    else if (t.startsWith("@")) frag.append(span("cd", t));
    else if (t.startsWith('"') || t.startsWith("'")) frag.append(span("cs", t));
    else if (PY_KW.has(t)) frag.append(span("ck", t));
    else frag.append(t);
    idx = PY_TOKEN.lastIndex;
  }
  if (idx < line.length) frag.append(line.slice(idx));
  return frag;
}

function span(cls, text) { const s = el("span", cls, text); return s; }

function codeSection(n) {
  const sec = el("details", "foldbox");
  const sum = el("summary");
  sum.append(el("span", "stitle", "Code"));
  const loc = (n.source || {}).defined_at;
  if (loc && loc.file) sum.append(el("span", "srcline mono", ` ${loc.file}:${loc.line}`));
  sec.append(sum);
  const pre = el("pre", "codeblock mono");
  const st = {instr: null};
  n.code.replace(/\s+$/, "").split("\n").forEach((line, i) => {
    const row = el("div", "cline");
    row.append(el("span", "lno", String((loc && loc.line || 1) + i)));
    // the tinted tokens live inside ONE pre-whitespace span — as bare
    // flex children, whitespace-only text nodes (indentation, the gap
    // in `async def`) are silently discarded by flex layout
    const text = el("span", "ctext");
    text.append(tintLine(line, st));
    row.append(text);
    pre.append(row);
  });
  sec.append(pre);
  return sec;
}

/* The graph a node lives in — the top-level graph, or its container's. */
function graphOf(it) {
  const parts = it.key.split("/");
  if (parts.length > 1) {
    const parent = state.rendered.get(parts.slice(0, -1).join("/"));
    if (parent && parent.node.graph) return parent.node.graph;
  }
  return state.graph;
}

function jumpTo(name, depth) {
  let best = null;
  for (const [, item] of state.rendered) {
    if (item.node.name !== name) continue;
    if (item.depth === depth) { best = item; break; }
    if (!best || item.depth < best.depth) best = item;
  }
  if (best) { select(best.key); centerOn(best); }
}

/* PORTS — the card that answers the only three questions that matter
 * cold: what comes in, what goes out, and who it links to. Links are
 * chips you click, not `a ← b.x` text; everything secondary (dotted
 * paths, transforms, file lines) hides in tooltips and the Code fold. */
function portsSection(it) {
  const n = it.node;
  const holder = graphOf(it) || {};
  const sec = el("section");
  sec.append(el("div", "stitle", "Ports"));

  const chip = (cls, text, tip, onclick) => {
    const c = el(onclick ? "button" : "span", `pchip ${cls}`, text);
    c.title = tip || text;   // a chip may ellipsise; the title always has it whole
    if (onclick) c.onclick = onclick;
    return c;
  };

  // one visual carries the whole meaning: `name ← source` for inputs,
  // `name → consumer` for outputs — the arrow says which way the value
  // flows, and each direction lives in its own tinted zone with its
  // own name colour. No headers, no bullets.
  const inZone = el("div", "pzone pzin");
  const outZone = el("div", "pzone pzout");
  const row = (dir, name, links) => {
    const r = el("div", "portrow");
    r.append(el("span", "pname mono", name));
    r.append(el("span", `parr ${dir}`, dir === "in" ? "←" : "→"));
    const box = el("span", "plinks");
    for (const l of links) box.append(l);
    r.append(box);
    (dir === "in" ? inZone : outZone).append(r);
    return r;
  };

  for (const inp of n.inputs || []) {
    const b = inp.binding || {};
    const name = inp.name + (inp.required ? " *" : "");
    if (b.kind === "ref") {
      const src = (b.from || "").split(".").pop();
      const isCell = !(holder.nodes || []).some(m => m.name === src);
      let label = src + (b.output && b.output !== src ? `.${b.output}` : "");
      if (b.consume) label += b.consume.mode === "collect" ? " ⧉" : " ∥";
      const tip = `${b.from}.${b.output}`
        + (b.transforms ? ` · ${b.transforms} transform` : "")
        + (b.consume ? (b.consume.mode === "collect"
            ? " · collect: buffers every yield, delivers a list"
            : ` · parallel${b.consume.max ? " ≤" + b.consume.max : ""}: yields fan out concurrently`) : "");
      row("in", name, [isCell
        ? chip("pcell", `◌ ${b.output || src}`, `graph cell — ${tip}`)
        : chip("pref", label, tip, () => jumpTo(src, it.depth))]);
    } else if (b.kind === "scratch") {
      row("in", name, [chip("pscratch", `⌂ ${b.key ?? b.value ?? "?"}`,
        "session scratch — set by the serve layer")]);
    } else if (b.kind === "literal") {
      const preview = JSON.stringify(b.value);
      // a literal is set in Settings above (configure.js), as what it is
      const c = chip("plit", preview.length > 22 ? preview.slice(0, 20) + "…" : preview,
        it.depth > 0 ? "literal — edit in the nested graph's own source" : "literal — set it in Settings above", null);
      row("in", name, [c]);
    } else {
      row("in", name, [chip("pmuted", b.kind || "unbound")]);
    }
  }

  // outputs: a LINK appears only for a real WRITE — the author's
  // `member["x"] >> PARENT["y"]`, where this output overrides another
  // op's variable. A downstream pull is the CONSUMER's own wiring and
  // shows on the consumer's input side; here it is only a tooltip.
  const consumers = {};
  for (const m of holder.nodes || []) {
    for (const i2 of m.inputs || []) {
      const b2 = i2.binding || {};
      if (b2.kind === "ref" && (b2.from || "").split(".").pop() === n.name) {
        (consumers[b2.output] = consumers[b2.output] || []).push(m.name);
      }
    }
  }
  const exports = {};
  for (const e2 of holder.exports || []) {
    if (e2.from === n.name) (exports[e2.output] = exports[e2.output] || []).push(e2.as);
  }
  for (const o of n.outputs || []) {
    const links = (exports[o] || []).map(dest =>
      chip("ppar", `PARENT.${dest}`,
        `${n.name}["${o}"] >> PARENT["${dest}"] — overrides the container's '${dest}'`));
    const r = row("out", o, links);
    const who = [...new Set(consumers[o] || [])];
    if (who.length) r.title = `pulled downstream by: ${who.join(", ")}`;
  }
  if (inZone.childNodes.length) sec.append(inZone);
  if (outZone.childNodes.length) sec.append(outZone);
  if (!(n.inputs || []).length && !(n.outputs || []).length) {
    sec.append(el("div", "note", "no declared ports"));
  }
  return sec;
}

/* The drill-down under the aggregate: one dense line per recorded
 * execution — rank, member, duration with an inline bar, status — and
 * ONE detail area below the table (not fifty accordions). The latest
 * record is pre-selected. */
function fmtCtx(c) { return Array.isArray(c) ? c.join(".") : (c || ""); }

