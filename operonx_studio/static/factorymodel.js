/* The factory model — a project's architecture, read from the IR the studio already serves.
 *
 * Four layers, the way work moves through a project (docs/SPATIAL_FACTORY_PLAN.md §4):
 *
 *   doors      services and jobs: how work comes in
 *   flows      the top-level graphs
 *   blocks     what flows are built from more than once: a nested graph of the same ops, or one op
 *              function, used in two places or more
 *   resources  the declared resources
 *   stores     the named places ops read and write (`@op(reads=, writes=)`): what one flow leaves
 *              for another. A flow that writes a store and a flow that reads it work together,
 *              though neither calls the other
 *
 * Every entity is something in the IR and every link is read from it, or derived by a rule stated
 * here. Nothing is guessed from names:
 *   - a nested graph is the same block as another when both hold the same op functions (each op's
 *     `source.defined_at`), the same kinds and the same wiring;
 *   - an op is the same op as another when both are defined at the same file and line;
 *   - an op from an installed package (the framework's own ops) is not a block.
 * What the IR does not carry is not drawn: a door whose graph is not among the project's graphs is
 * listed as unresolved, with the name it asked for.
 *
 * Pure data → data, no DOM: tests/js/factorymodel.test.mjs. */
(function (root) {
  "use strict";

  const base = (ref) => (ref ? String(ref).split(":").pop() : null);
  const moduleOf = (ref) => (ref && String(ref).includes(":") ? String(ref).split(":")[0] : null);
  const firstPart = (s) => (s ? String(s).replace(/^src\//, "").split(/[./]/)[0] : "");
  const defOf = (n) => { const d = n.source && n.source.defined_at; return d && d.file ? `${d.file}:${d.line}` : null; };
  const isLibrary = (def) => /(^|\/)(site-packages|dist-packages|\.venv|venv)\//.test(def || "");
  const opsIn = (g) => g.nodes.reduce((s, n) => s + (n.graph ? Math.max(1, n.subgraph_ops || opsIn(n.graph)) : 1), 0);

  /* a nested graph's shape: its ops by where they are defined (by name where the IR gives no
   * source), their kinds, and its wiring by position; nested graphs inside it count by their shape */
  function shape(g) {
    const short = new Map(g.nodes.map(n => [n.id, n.name]));
    const nodes = g.nodes.map(n => `${n.name}=${n.graph ? `{${shape(n.graph)}}` : `${n.kind}@${defOf(n) || "?"}`}`).sort();
    const edges = (g.edges || []).map(e => `${short.get(e.src) || e.src}>${short.get(e.dst) || e.dst}${e.back ? "~" : ""}`).sort();
    return `${nodes.join(",")}|${edges.join(",")}`;
  }
  /* what several uses of one block are called: the name they share, else what their names share */
  function commonName(names) {
    const uniq = [...new Set(names)];
    if (uniq.length === 1) return uniq[0];
    const pre = uniq.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });
    const suf = uniq.reduce((a, b) => { let i = 0; while (i < a.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return a.slice(a.length - i); });
    const p = pre.replace(/[_\-.]+$/, ""), s = suf.replace(/^[_\-.]+/, "");
    if (p.length >= 3 && p.length >= s.length) return `${p}_*`;
    if (s.length >= 3) return `*_${s}`;
    return `${uniq[0]} +${uniq.length - 1}`;
  }

  function build(ir, stats) {
    const graphs = ir.graphs || [], flowStats = (stats && stats.flows) || {};
    const by = new Map(), links = new Map();
    const put = (e) => { by.set(e.id, e); return e; };
    const link = (src, dst, kind, n = 1) => { const k = `${src}|${dst}|${kind}`; const l = links.get(k); if (l) l.count += n; else links.set(k, {src, dst, kind, count: n}); };

    // ── flows ──
    const serviceModule = new Map();
    for (const s of ir.services || []) if (s.graph && moduleOf(s.graph) && !serviceModule.has(base(s.graph))) serviceModule.set(base(s.graph), moduleOf(s.graph));
    const flows = graphs.map(g => {
      const wired = g.nodes.map(n => n.source && n.source.wired_at && n.source.wired_at.file).filter(Boolean);
      const domain = firstPart(moduleOf(g.entry) || serviceModule.get(g.name) || wired[0] || "");
      const st = flowStats[g.name] || {};
      return put({id: `f:${g.name}`, type: "flow", name: g.name, description: g.description || "", domain, ops: opsIn(g), runs: st.runs || 0, errors: st.errors || 0, avgMs: st.avg_ms == null ? null : st.avg_ms});
    });
    const flowOf = new Map(flows.map(f => [f.name, f]));

    // ── doors ──
    const doors = [], unresolved = [];
    const jobs = (ir.jobs || []).map(j => {
      const f = flowOf.get(base(j.graph));
      const d = put({id: `j:${j.name}`, type: "job", kind: j.kind || "job", name: j.name, description: j.description || "", flow: f ? f.id : null, asks: f || !j.graph ? null : base(j.graph)});
      doors.push(d); if (f) link(d.id, f.id, "runs"); else if (j.graph) unresolved.push(d);
      return d;
    });
    const jobOf = new Map(jobs.map(j => [j.name, j]));
    for (const s of ir.services || []) {
      const f = flowOf.get(base(s.graph)), j = s.job ? jobOf.get(s.job) : null;
      const d = put({id: `s:${s.name}`, type: "service", kind: s.kind || "http", name: s.name, description: s.description || "", path: s.path || "", flow: f ? f.id : null, job: j ? j.id : null,
        asks: f || j ? null : (s.graph ? base(s.graph) : s.job || null)});
      doors.push(d);
      if (f) link(d.id, f.id, "runs"); else if (j) link(d.id, j.id, "schedules"); else if (d.asks) unresolved.push(d);
    }

    // ── blocks: every nested graph and every op of every flow, gathered by what it is ──
    const seenGraph = new Map(), seenOp = new Map();
    const resUse = new Map();                                   // "flow|resource ref" → count
    const walk = (g, flow, within) => {                         // within: the shapes of the nested graphs this one sits in
      for (const n of g.nodes) {
        for (const r of [].concat(n.resource || [])) resUse.set(`${flow.id}|${r}`, (resUse.get(`${flow.id}|${r}`) || 0) + 1);
        const use = {flow: flow.id, at: n.id, name: n.name, within};
        if (n.graph) {
          const key = shape(n.graph);
          if (!seenGraph.has(key)) seenGraph.set(key, {type: "block", kind: n.agent ? "agent" : "graph", description: n.description || "", ops: opsIn(n.graph), holds: n.graph.nodes.map(m => m.name), uses: []});
          seenGraph.get(key).uses.push(use);
          walk(n.graph, flow, [...within, key]);
        } else {
          const def = defOf(n);
          if (!def || isLibrary(def)) continue;
          if (!seenOp.has(def)) seenOp.set(def, {type: "block", kind: "op", opKind: n.kind, description: n.description || "", ops: 1, definedAt: def, uses: []});
          seenOp.get(def).uses.push(use);
        }
      }
    };
    graphs.forEach((g, i) => walk(g, flows[i], []));
    const blocks = [];
    const keep = (b, id) => {
      b.id = id; b.uses = b.uses.map(u => ({flow: u.flow, at: u.at, name: u.name}));
      b.name = commonName(b.uses.map(u => u.name)); b.flows = [...new Set(b.uses.map(u => u.flow))]; b.shared = b.flows.length > 1;
      put(b); blocks.push(b);
      const per = new Map(); for (const u of b.uses) per.set(u.flow, (per.get(u.flow) || 0) + 1);
      for (const [f, n] of per) link(f, b.id, "uses", n);
    };
    // a nested graph that sits inside a kept block, and an op inside one, is already shown by that block
    const keptShapes = new Set([...seenGraph].filter(([, b]) => b.uses.length > 1).map(([k]) => k));
    const outside = (u) => !u.within.some(k => keptShapes.has(k));
    let gi = 0;
    for (const b of seenGraph.values()) { b.uses = b.uses.filter(outside); if (b.uses.length > 1) keep(b, `b:g${gi++}`); }
    for (const b of seenOp.values()) { b.uses = b.uses.filter(outside); if (b.uses.length > 1) keep(b, `b:${b.definedAt}`); }
    blocks.sort((a, b) => b.flows.length - a.flows.length || b.uses.length - a.uses.length || (a.name < b.name ? -1 : 1));

    // ── resources ──
    const keys = (ir.resources && ir.resources.keys) || [];
    const resources = keys.map(k => put({id: `r:${k}`, type: "resource", key: k, kind: k.includes(":") ? k.split(":")[0] : k, name: k.includes(":") ? k.split(":").slice(1).join(":") : k, flows: []}));
    const resBy = new Map();
    for (const r of resources) { resBy.set(r.key, r); if (!resBy.has(r.name)) resBy.set(r.name, r); if (!resBy.has(r.kind)) resBy.set(r.kind, r); }
    // a node may name an instance ("stt"); the IR's details say which declared resource that is
    const details = (ir.resources && ir.resources.details) || {};
    for (const [inst, d] of Object.entries(details)) { const r = d && d.category && resBy.get(d.category); if (r && !resBy.has(inst)) resBy.set(inst, r); }
    const unknownResources = [];
    for (const [k, n] of resUse) {
      const [fid, ref] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)], r = resBy.get(ref);
      if (!r) { unknownResources.push({flow: fid, ref}); continue; }
      if (!r.flows.includes(fid)) r.flows.push(fid);
      link(fid, r.id, "needs", n);
    }

    // ── stores: who writes each, who reads it; a job that seeds one is a writer too ──
    const stores = (ir.stores || []).map(s => {
      const st = put({id: `t:${s.name}`, type: "store", name: s.name, description: s.description || "", writers: [], readers: [], flows: []});
      for (const [side, kind] of [["writers", "writes"], ["readers", "reads"]]) {
        const per = new Map();                                    // one row per flow or job, with the ops that do it
        for (const u of s[side] || []) {
          const who = u.graph ? flowOf.get(u.graph) : u.job ? jobOf.get(u.job) : null;
          if (!who) continue;
          if (!per.has(who.id)) per.set(who.id, {id: who.id, name: who.name, type: who.type, ops: [],
            ...(u.jobs && u.jobs.length > 1 ? {name: u.runs || who.name, jobs: u.jobs} : {})});   // several jobs run one graph: named after it
          const op = String(u.op || "").split(".").pop(); if (op && !per.get(who.id).ops.includes(op)) per.get(who.id).ops.push(op);
        }
        st[side] = [...per.values()];
        for (const w of st[side]) if (w.type === "flow") { link(w.id, st.id, kind, w.ops.length || 1); if (!st.flows.includes(w.id)) st.flows.push(w.id); }
      }
      return st;
    });

    // ── domains ──
    const dom = new Map();
    for (const f of flows) { if (!dom.has(f.domain)) dom.set(f.domain, put({id: `d:${f.domain}`, type: "domain", name: f.domain, flows: []})); dom.get(f.domain).flows.push(f.id); }
    const domains = [...dom.values()].sort((a, b) => b.flows.length - a.flows.length || (a.name < b.name ? -1 : 1));

    const all = [...links.values()];
    const out = new Map(), into = new Map();
    for (const l of all) { if (!out.has(l.src)) out.set(l.src, []); out.get(l.src).push(l); if (!into.has(l.dst)) into.set(l.dst, []); into.get(l.dst).push(l); }
    const reach = (id, map, end) => { const seen = new Set(), todo = [id]; while (todo.length) { const x = todo.pop(); for (const l of map.get(x) || []) if (!seen.has(l[end])) { seen.add(l[end]); todo.push(l[end]); } } return [...seen]; };
    // a door's domain is its flow's; a schedule's is its job's
    const domainOf = (id) => { const e = by.get(id); if (!e) return null; if (e.type === "flow") return `d:${e.domain}`; if (e.type === "domain") return e.id;
      if (e.flow) return domainOf(e.flow); if (e.job) return domainOf(e.job); return null; };

    return {
      name: ir.name || "", flows, doors, blocks, resources, stores, domains, unresolved, unknownResources, links: all, by,
      /* direct links into and out of an entity */
      into: (id) => into.get(id) || [], outOf: (id) => out.get(id) || [],
      /* everything that leads here / everything this leads to, through any number of steps */
      upstream: (id) => reach(id, into, "src"), downstream: (id) => reach(id, out, "dst"),
      domainOf,
      counts: {flows: flows.length, services: doors.filter(d => d.type === "service").length, jobs: doors.filter(d => d.type === "job").length,
        blocks: blocks.length, sharedBlocks: blocks.filter(b => b.shared).length, resources: resources.length, stores: stores.length, domains: domains.length, unresolved: unresolved.length},
    };
  }

  /* One line per pair of boxes: every link whose two ends fall in different groups, added up.
   * `groupOf(id)` names the box an entity is drawn in (null leaves it out). */
  function pairs(model, groupOf) {
    const acc = new Map();
    for (const l of model.links) {
      const a = groupOf(l.src), b = groupOf(l.dst);
      if (!a || !b || a === b) continue;
      const k = `${a}|${b}|${l.kind}`; const p = acc.get(k);
      if (p) { p.count += l.count; p.links++; } else acc.set(k, {src: a, dst: b, kind: l.kind, count: l.count, links: 1});
    }
    return [...acc.values()].sort((x, y) => y.count - x.count);
  }

  const api = {build, pairs, shape, commonName};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FactoryModel = api;
})(typeof window !== "undefined" ? window : globalThis);
