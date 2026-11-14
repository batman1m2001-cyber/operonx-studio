/* An agent op and the steps it records (operonx `child()`: its turns,
 * model calls and tool calls) — how each looks, the ops a run ran at its
 * root, and what a container says it holds. Pure; tested in node:
 * tests/js/agentsteps.test.mjs, tests/js/containerkind.test.mjs. */
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

  /* The ops that ran at the run's root: what matches a run to its graph.
   * A run recorded before the server said so falls back to every op. */
  function rootOps(data) {
    if (data && Array.isArray(data.root_ops)) return data.root_ops;
    return Object.keys((data && data.ops) || {});
  }

  /* The agents inside a graph, at any depth, each with its canvas key (the
   * ids on the path, "/"-joined under `key`). An agent's own turns are not
   * walked: an agent inside an agent is not drawn. */
  function agentsInside(g, key = "", out = []) {
    for (const n of (g && g.nodes) || []) {
      const k = `${key}/${n.id}`;
      if (n.op_type === "agent" && n.agent) out.push({name: n.name, key: k});
      else if (n.graph) agentsInside(n.graph, k, out);
    }
    return out;
  }

  const plural = (k, one) => `${k} ${one}${k === 1 ? "" : "s"}`;
  /* What a container holds, in its own words: a fan-out, or a nested
   * graph's agents (at any depth, from the walk above) and its ops (the
   * ones directly inside, as the band counts them). */
  function containerKind(n) {
    const k = n.subgraph_ops || 0;
    if (n.stack) return "fan-out · side by side";
    const a = agentsInside(n.graph).length;
    return [n.kind, a ? plural(a, "agent") : null, plural(k, "op")].filter(Boolean).join(" · ");
  }

  const api = {VISUALS, visual, rootOps, agentsInside, containerKind};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.AgentSteps = api;
})(typeof window !== "undefined" ? window : globalThis);
