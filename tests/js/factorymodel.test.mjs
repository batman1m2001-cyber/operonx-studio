// The factory model (static/factorymodel.js): a project's IR → doors, flows, blocks, resources and
// the links between them. Every rule the picture relies on is checked on a small hand-built project.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FM = require("../../operonx_studio/static/factorymodel.js");

// ── builders: the IR as the studio serves it ──────────────────────
const op = (flow, name, at, extra = {}) => ({id: `${flow}.${name}`, name, kind: "FuncOp", source: {defined_at: {file: at.split(":")[0], line: +at.split(":")[1]}, wired_at: {file: extra.wired || "shop/graph.py", line: 1}}, ...extra});
const edge = (flow, a, b) => ({id: `${a}->${b}`, src: `${flow}.${a}`, dst: `${flow}.${b}`, back: false});
/* a nested graph of two ops, the same functions wherever it is used */
const reader = (id, name) => ({id, name, kind: "GraphOp", subgraph_ops: 2, source: {wired_at: {file: "shop/graph.py", line: 9}},
  graph: {name: null, nodes: [op(id, "read", "src/shop/io.py:10"), op(id, "clean", "src/shop/io.py:20")], edges: [edge(id, "read", "clean")]}});
const flow = (name, nodes, edges = []) => ({name, nodes, edges});

function project() {
  return {
    name: "shop",
    graphs: [
      flow("orders", [op("orders", "take", "src/shop/orders.py:5", {resource: "writer"}), reader("orders.stock", "stock"), op("orders", "price", "src/shop/money.py:7")], [edge("orders", "take", "stock")]),
      flow("refunds", [op("refunds", "ask", "src/shop/refunds.py:3", {wired: "money/graph.py"}), reader("refunds.held_stock", "held_stock"), op("refunds", "price_again", "src/shop/money.py:7"),
        op("refunds", "src", ".venv/lib/python3.12/site-packages/operonx/app/serve/ops.py:33")]),
      flow("report", [op("report", "src", ".venv/lib/python3.12/site-packages/operonx/app/serve/ops.py:33"), op("report", "ask", "src/shop/report.py:3", {resource: ["writer", "docs"]})]),
    ],
    services: [
      {name: "order", kind: "http", path: "/order", graph: "shop.graph:orders", job: null},
      {name: "order_ws", kind: "websocket", path: "/ws", graph: "shop.graph:orders", job: null},
      {name: "nightly", kind: "schedule", path: "/__schedule__/job/sweep", graph: null, job: "sweep"},
      {name: "web", kind: "asgi", path: "/", graph: null, job: null},
      {name: "ghost", kind: "http", path: "/ghost", graph: "shop.graph:not_there", job: null},
    ],
    jobs: [{name: "sweep", kind: "job", graph: "refunds"}, {name: "prices", kind: "job", graph: "market"}, {name: "golden", kind: "eval", graph: "report"}],
    resources: {keys: ["llm:writer", "vector_store:docs", "llm:spare"], details: {}},
  };
}
const ids = (xs) => xs.map(x => x.id || x).sort();

test("doors: a service runs its flow, a schedule runs a job, a job runs its flow", () => {
  const m = FM.build(project());
  assert.deepEqual(m.counts, {flows: 3, services: 5, jobs: 3, blocks: 2, sharedBlocks: 2, resources: 3, domains: 2, unresolved: 2});
  assert.equal(m.by.get("s:order").flow, "f:orders");
  assert.equal(m.by.get("s:nightly").job, "j:sweep");
  assert.equal(m.by.get("j:sweep").flow, "f:refunds");
  assert.deepEqual(m.outOf("s:nightly").map(l => [l.dst, l.kind]), [["j:sweep", "schedules"]]);
  assert.deepEqual(ids(m.into("f:orders").map(l => l.src)), ["s:order", "s:order_ws"]);
});

test("doors: a graph the project does not list is unresolved, with the name asked for; a door that asks for nothing is not", () => {
  const m = FM.build(project());
  assert.deepEqual(m.unresolved.map(d => [d.id, d.asks]).sort(), [["j:prices", "market"], ["s:ghost", "not_there"]]);
  assert.equal(m.by.get("s:web").asks, null);
  assert.equal(m.outOf("s:web").length, 0);
});

test("blocks: the same nested graph in two flows is one block, whatever each use is called", () => {
  const m = FM.build(project());
  const b = m.blocks.find(x => x.kind === "graph");
  assert.equal(b.uses.length, 2);
  assert.deepEqual(b.flows.sort(), ["f:orders", "f:refunds"]);
  assert.equal(b.shared, true);
  assert.equal(b.ops, 2);
  assert.equal(b.name, "*_stock");
  assert.deepEqual(ids(m.into(b.id).map(l => l.src)), ["f:orders", "f:refunds"]);
});

test("blocks: a nested graph of other ops, or wired differently, is a different block", () => {
  const p = project();
  p.graphs[1].nodes[1].graph.nodes[1] = op("refunds.held_stock", "clean", "src/shop/io.py:99");
  assert.equal(FM.build(p).blocks.filter(x => x.kind === "graph").length, 0);
  const q = project();
  q.graphs[1].nodes[1].graph.edges = [edge("refunds.held_stock", "clean", "read")];
  assert.equal(FM.build(q).blocks.filter(x => x.kind === "graph").length, 0);
});

test("blocks: an op is shared by where it is defined, not by its name; a framework op is never a block", () => {
  const m = FM.build(project());
  const ops = m.blocks.filter(x => x.kind === "op");
  assert.deepEqual(ops.map(b => [b.definedAt, b.uses.map(u => u.name).sort()]), [["src/shop/money.py:7", ["price", "price_again"]]]);
  // "ask" is in two flows under one name but is two different functions; "src" comes from the framework
  assert.equal(m.blocks.some(b => b.uses.some(u => u.name === "ask" || u.name === "src")), false);
  // the ops inside the shared reader are shown by the reader, not again as ops
  assert.equal(m.blocks.some(b => b.kind === "op" && b.uses.some(u => u.name === "read")), false);
});

test("blocks: used twice inside one flow is a block, but not a shared one", () => {
  const p = project();
  p.graphs = [flow("orders", [reader("orders.a", "a"), reader("orders.b", "b")])]; p.services = []; p.jobs = [];
  const m = FM.build(p);
  assert.equal(m.blocks.length, 1);
  assert.equal(m.blocks[0].shared, false);
  assert.deepEqual(m.outOf("f:orders").map(l => [l.kind, l.count]), [["uses", 2]]);
});

test("resources: a flow needs what its ops name, nested ones included; a declared one nobody names has no flows", () => {
  const p = project();
  p.graphs[0].nodes[1].graph.nodes[0].resource = "docs";
  const m = FM.build(p);
  assert.deepEqual(m.by.get("r:llm:writer").flows.sort(), ["f:orders", "f:report"]);
  assert.deepEqual(m.by.get("r:vector_store:docs").flows.sort(), ["f:orders", "f:report"]);
  assert.deepEqual(m.by.get("r:llm:spare").flows, []);
  assert.deepEqual(m.unknownResources, []);
});

test("resources: an instance name resolves through the IR's details; a name nothing declares is reported, not drawn", () => {
  const p = project();
  p.resources = {keys: ["llm", "http"], details: {writer: {category: "llm"}, tts: {category: "http"}}};
  const m = FM.build(p);
  assert.deepEqual(m.by.get("r:llm").flows.sort(), ["f:orders", "f:report"]);
  assert.deepEqual(m.unknownResources, [{flow: "f:report", ref: "docs"}]);
});

test("domains: from the module a service names, else from where the flow is wired", () => {
  const m = FM.build(project());
  assert.equal(m.by.get("f:orders").domain, "shop");       // shop.graph:orders
  assert.equal(m.by.get("f:refunds").domain, "money");     // money/graph.py
  assert.deepEqual(m.domains.map(d => [d.name, d.flows.length]), [["shop", 2], ["money", 1]]);
  assert.equal(m.domainOf("s:nightly"), "d:money");        // schedule → job → flow
  assert.equal(m.domainOf("s:web"), null);
});

test("what leads here, and what this leads to, through any number of steps", () => {
  const m = FM.build(project());
  const reader = m.blocks.find(x => x.kind === "graph").id;
  assert.deepEqual(m.upstream(reader).sort(), ["f:orders", "f:refunds", "j:sweep", "s:nightly", "s:order", "s:order_ws"]);
  assert.deepEqual(m.downstream("s:nightly").sort(), ["b:g0", "b:src/shop/money.py:7", "f:refunds", "j:sweep"].sort());
  assert.deepEqual(m.downstream("r:llm:writer"), []);
});

test("pairs: one line per pair of boxes, counted", () => {
  const m = FM.build(project());
  const byLayer = (id) => ({service: "doors", job: "doors", flow: "flows", block: "blocks", resource: "resources"}[m.by.get(id).type]);
  assert.deepEqual(FM.pairs(m, byLayer).map(p => [p.src, p.dst, p.kind, p.count]).sort(), [
    ["doors", "flows", "runs", 4], ["flows", "blocks", "uses", 4], ["flows", "resources", "needs", 3]].sort());
  // by domain: only what crosses from one domain to another
  const byDomain = (id) => m.domainOf(id) || (m.by.get(id).type === "block" ? "blocks" : null);
  const crossing = FM.pairs(m, byDomain);
  assert.deepEqual(crossing.map(p => [p.src, p.dst, p.count]).sort(), [["d:money", "blocks", 2], ["d:shop", "blocks", 2]]);
});

test("flow stats ride along", () => {
  const m = FM.build(project(), {flows: {orders: {runs: 40, errors: 3, avg_ms: 210}}});
  assert.deepEqual([m.by.get("f:orders").runs, m.by.get("f:orders").errors, m.by.get("f:orders").avgMs], [40, 3, 210]);
  assert.deepEqual([m.by.get("f:report").runs, m.by.get("f:report").avgMs], [0, null]);
});

test("names for several uses of one block", () => {
  assert.equal(FM.commonName(["held_feed", "held_search", "held_risk"]), "held_*");
  assert.equal(FM.commonName(["stock", "held_stock"]), "*_stock");
  assert.equal(FM.commonName(["a", "b", "c"]), "a +2");
  assert.equal(FM.commonName(["same", "same"]), "same");
});

test("a project of 1,200 flows is modelled in well under a second", () => {
  const p = {name: "big", graphs: [], services: [], jobs: [], resources: {keys: ["llm:a", "llm:b"], details: {}}};
  for (let i = 0; i < 1200; i++) {
    const f = `flow_${i}`;
    p.graphs.push(flow(f, [op(f, "take", `src/d${i % 14}/ops.py:${i % 40}`, {wired: `d${i % 14}/graph.py`, resource: i % 2 ? "a" : "b"}), reader(`${f}.stock`, "stock"),
      ...Array.from({length: 8}, (_, k) => op(f, `step_${k}`, `src/d${i % 14}/steps.py:${(i * 7 + k) % 300}`))]));
    if (i % 6 === 0) p.services.push({name: `svc_${i}`, kind: "http", path: `/${i}`, graph: `d${i % 14}.graph:${f}`, job: null});
    if (i % 4 === 0) p.jobs.push({name: `job_${i}`, kind: "job", graph: f});
  }
  const t = performance.now(), m = FM.build(p), ms = performance.now() - t;
  assert.equal(m.counts.flows, 1200);
  assert.equal(m.counts.domains, 14);
  assert.equal(m.blocks.find(b => b.kind === "graph").uses.length, 1200);
  assert.ok(ms < 800, `took ${ms.toFixed(0)} ms`);
});
