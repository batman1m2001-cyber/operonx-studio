/* An agent op's run, as a graph the canvas can open — pure data → data.
 *
 * An agent (operonx-agents) runs its loop inside ONE op and records every
 * turn, model call and tool call as a child execution under it (operonx
 * `child()`). The project's IR knows the op only; the run knows its
 * steps. So the Workflow view, painting a run, gives each agent op the
 * graph its steps make: its turns in order, and in each turn the model
 * call fanning out to the tool calls it asked for — the same structure
 * the Tree view shows (agent → turn → model, tool), in canvas form.
 *
 * Input: the tree API's rows (depth-first, `parent` ids, `child` true for
 * a step an op recorded, `op_type`). Tested in node:
 * tests/js/agentsteps.test.mjs. */
(function (global) {
  "use strict";

  /* What each kind of step looks like. The icon is the step's TYPE, never
   * an IR node it happens to share a name with (a step named `model`
   * borrowed an unrelated graph's icon). */
  const VISUALS = {
    agent:      {icon: "◎", color: "var(--k-llm)", label: "agent"},
    turn:       {icon: "↻", color: "var(--k-graph)", label: "turn"},
    llm:        {icon: "✧", color: "var(--k-llm)", label: "model call"},
    tool:       {icon: "⚒", color: "var(--k-res)", label: "tool call"},
    compaction: {icon: "≡", color: "var(--k-default)", label: "compaction"},
  };
  const visual = (opType) => VISUALS[opType] || null;

  // what a step's card says it produced, when a card shows values
  const SHOW = {turn: ["tool_calls", "finish_reason"], llm: ["finish_reason", "tool_calls"],
                tool: ["tool_message"], compaction: ["kept"]};

  /* The ops that ran at the run's root: what matches a run to its graph.
   * A run recorded before the server said so falls back to every op. */
  function rootOps(data) {
    if (data && Array.isArray(data.root_ops)) return data.root_ops;
    return Object.keys((data && data.ops) || {});
  }

  const segment = (ctx) => String(ctx || "").split(".").pop();
  const records = (rows) => (rows || []).filter(r => r.kind === "record");

  /* The steps directly under `row`, in time order. */
  function stepsOf(row, byParent) {
    return (byParent.get(row.id) || []).filter(r => r.child)
      .sort((a, b) => a.start_ms - b.start_ms);
  }

  /* Wires among one level's steps. Turns follow one another; inside a
   * turn a model call feeds the steps after it (the tools it asked for),
   * and anything before the first model call (a compaction) feeds it. */
  function wire(steps) {
    const edges = [];
    let hub = null, tail = null;
    for (const s of steps) {
      const src = s.op_type === "turn" ? tail : (hub || tail);
      if (src) edges.push([src, s]);
      if (s.op_type === "turn") { tail = s; hub = null; }
      else if (s.op_type === "llm") { hub = s; tail = s; }
      else if (!hub) tail = s;
    }
    return edges;
  }

  /* One level of steps as an IR-shaped graph: nodes with unique ids and
   * the run's record on `step`, `start`/`end` on the level's first and
   * last steps (an opened container ties its START/END knobs to those). */
  function levelGraph(steps, byParent, idOf) {
    const edges = wire(steps);
    const into = new Set(edges.map(([, b]) => b.id));
    const outOf = new Set(edges.map(([a]) => a.id));
    const nodes = steps.map((s) => {
      const kids = stepsOf(s, byParent);
      const sub = kids.length ? levelGraph(kids, byParent, idOf) : null;
      const v = visual(s.op_type);
      return {
        id: idOf(s), name: segment(s.ctx), kind: v ? v.label : (s.op_type || "step"),
        op_type: s.op_type, step: s, start: !into.has(s.id), end: !outOf.has(s.id),
        outputs: Object.keys(s.outputs || {}), inputs: [], show_keys: SHOW[s.op_type] || [],
        graph: sub, subgraph_ops: sub ? sub.nodes.length : null,
      };
    });
    return {
      nodes,
      edges: edges.map(([a, b]) => ({id: `${idOf(a)}->${idOf(b)}`, src: idOf(a), dst: idOf(b),
                                      type: "normal", soft: false, origin: "authored"})),
      entries: nodes.filter(n => n.start).map(n => n.name),
      exits: nodes.filter(n => n.end).map(n => n.name),
    };
  }

  /* The graph an agent op's run makes: every execution of the op (one per
   * request a service sent it) whose turn is `turn` (a ctx prefix such as
   * "main.[1]"; every execution when null), its steps under it. Null when
   * the op recorded no steps. */
  function agentGraph(name, rows, turn) {
    const recs = records(rows);
    const byParent = new Map();
    for (const r of recs) {
      if (!byParent.has(r.parent)) byParent.set(r.parent, []);
      byParent.get(r.parent).push(r);
    }
    const runs = recs.filter(r => !r.child && r.op === name && r.op_type === "agent"
      && (!turn || r.ctx === turn || String(r.ctx).startsWith(turn + ".")));
    const steps = runs.flatMap(r => stepsOf(r, byParent));
    if (!steps.length) return null;
    // ids unique across executions: the step's ctx, made a safe key part
    const idOf = (s) => String(s.ctx).replace(/[^A-Za-z0-9_.[\]-]/g, "_");
    return levelGraph(steps, byParent, idOf);
  }

  /* `graph` with every agent op that recorded steps in this run opened
   * onto them: a copy (the Flow tab's graph is never touched), and the
   * canvas keys to expand so the run opens showing the structure. */
  function withSteps(graph, rows, turn) {
    const opened = [];
    const agents = new Set(records(rows)
      .filter(r => !r.child && r.op_type === "agent").map(r => r.op));
    if (!agents.size) return {graph, opened};
    const copy = (g, prefix) => ({
      ...g,
      nodes: (g.nodes || []).map((n) => {
        const key = prefix + n.id;
        if (n.graph) return {...n, graph: copy(n.graph, key + "/")};
        if (!agents.has(n.name) || (n.op_type && n.op_type !== "agent")) return n;
        const sub = agentGraph(n.name, rows, turn);
        if (!sub) return n;
        opened.push(key);
        for (const s of sub.nodes) if (s.op_type === "turn" && s.graph) opened.push(`${key}/${s.id}`);
        return {...n, op_type: "agent", graph: sub, subgraph_ops: sub.nodes.length, agentSteps: true};
      }),
    });
    return {graph: copy(graph, ""), opened};
  }

  const api = {VISUALS, visual, rootOps, agentGraph, withSteps, wire};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.AgentSteps = api;
})(typeof window !== "undefined" ? window : globalThis);
