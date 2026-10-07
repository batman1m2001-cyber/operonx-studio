/* Data flow on the canvas — pure data → data.
 *
 * The canvas draws CONTROL flow: `graph.edges`, what runs before what.
 * The IR also records DATA flow, which it never drew: every op input's
 * binding (`{kind: "ref", from, output}`), the graph inputs (a ref whose
 * `from` is the graph itself), SCRATCH reads (`{kind: "scratch", key}`)
 * and an opened GraphOp's exports (`{from, output, as}`). This module turns
 * those into DataBindings — `from: {kind, key, port} → to: {key, port}` —
 * keyed by the same card keys the canvas uses, and answers the questions
 * the views ask: what does this node read and feed, what is this port's
 * lineage, and which node pairs carry data.
 *
 * Kinds of source: "op" (an op's output, or an opened GraphOp's export),
 * "input" (a graph input: key "" is the root graph, else the opened
 * GraphOp's card key), "scratch" (the run's SCRATCH; key "").
 * Tested in node: tests/js/dataflow.test.mjs.
 */
(function (global) {
  "use strict";

  const last = (s) => String(s || "").split(".").pop();

  // every binding on the canvas: the root graph, and every opened GraphOp
  // inside it (`expanded` holds the card keys of the opened ones)
  function dataBindings(graph, expanded) {
    const out = [];
    const open = expanded || new Set();
    // a nested graph may carry no name of its own: its ops then name their
    // graph inputs by the GraphOp's id (`qc_flow.sentiment_agent`)
    (function walk(g, prefix, owner) {
      const byName = new Map((g.nodes || []).map(n => [n.name, n]));
      const level = prefix ? prefix.slice(0, -1) : "";
      const self = (from) => (g.name && last(from) === g.name)
        || (owner && (from === owner.id || last(from) === owner.name));
      const source = (from, output) => {
        if (self(from)) return {kind: "input", key: level, port: output};
        const n = byName.get(last(from));
        return n ? {kind: "op", key: prefix + n.id, port: output} : null;
      };
      for (const n of g.nodes || []) {
        const key = prefix + n.id;
        for (const inp of n.inputs || []) {
          const b = inp.binding || {};
          let from = null;
          if (b.kind === "ref") from = source(b.from, b.output || "?");
          else if (b.kind === "scratch") from = {kind: "scratch", key: "", port: String(b.key ?? inp.name)};
          if (!from || (from.kind === "op" && from.key === key)) continue;
          out.push({from, to: {key, port: inp.name}});
        }
        if (n.graph && open.has(key)) walk(n.graph, key + "/", n);
      }
      // an opened GraphOp hands its exports out through its own card
      if (prefix) for (const e of g.exports || []) {
        const from = source(e.from, e.output);
        if (from) out.push({from, to: {key: level, port: e.as, export: true}});
      }
    })(graph, "", null);
    out.forEach((b, i) => { b.id = i; });
    return out;
  }

  // a value read everywhere is shown where it is read, never wired across
  const isBroadcast = (b) => b.from.kind === "input" && b.from.key === "" || b.from.kind === "scratch";

  // what one card reads and feeds, in port order
  function nodeBindings(bindings, key) {
    return {
      ins: bindings.filter(b => b.to.key === key && !b.to.export),
      outs: bindings.filter(b => b.from.kind !== "scratch" && b.from.key === key && !(b.from.kind === "input")),
      exports: bindings.filter(b => b.to.key === key && b.to.export),
    };
  }

  /* A port's lineage: binding id → level (1 = direct, 2 = one step
   * further). An input port: its source, then what that source op itself
   * reads. An output port: everything that reads it. A whole node: every
   * binding into or out of it. */
  function lineage(bindings, sel) {
    const lv = new Map();
    const mark = (b, l) => { if (!lv.has(b.id) || lv.get(b.id) > l) lv.set(b.id, l); };
    if (sel.port == null) {
      for (const b of bindings) if (b.to.key === sel.key || (b.from.kind === "op" && b.from.key === sel.key)) mark(b, 1);
      return lv;
    }
    if (sel.dir === "in") {
      for (const b of bindings) {
        if (b.to.key !== sel.key || b.to.port !== sel.port || b.to.export) continue;
        mark(b, 1);
        if (b.from.kind !== "op") continue;
        // one step further: what the source reads (an opened GraphOp's
        // export continues to the op inside that produced it)
        for (const c of bindings) {
          if (c.to.key === b.from.key && (!c.to.export || c.to.port === b.from.port)) mark(c, 2);
        }
      }
    } else {
      for (const b of bindings) {
        if (b.from.kind === "op" && b.from.key === sel.key && b.from.port === sel.port) mark(b, 1);
        if (b.to.key === sel.key && b.to.export && b.to.port === sel.port) mark(b, 1);
      }
    }
    return lv;
  }

  // node pairs that carry data between ops: one connector each, weighted
  function pairs(bindings) {
    const m = new Map();
    for (const b of bindings) {
      if (isBroadcast(b)) continue;
      const k = `${b.from.key}>${b.to.key}`;
      if (!m.has(k)) m.set(k, {from: b.from.key, to: b.to.key, kind: b.from.kind, bindings: []});
      m.get(k).bindings.push(b);
    }
    return [...m.values()];
  }

  const api = {dataBindings, nodeBindings, lineage, pairs, isBroadcast};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.DataFlow = api;
})(typeof window !== "undefined" ? window : globalThis);
