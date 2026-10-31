// Graphs and charts in a reply (static/graph.js, docs/VISUAL_CHAT_PLAN.md D9, D10).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../../operonx_studio/static/graph.js");

const graph = (extra = {}) => JSON.stringify({id: "flow", title: "Flow", groups: {in: "Input", core: "Core"},
  nodes: [{id: "a", label: "Read", group: "in", state: "done"}, {id: "b", label: "Parse", group: "core", state: "active"},
    {id: "c", label: "Store", group: "core", file: "src/store.py"}, {id: "d", label: "Report"}],
  edges: [["a", "b"], ["b", "c", "rows"], ["c", "d"], ["c", "b", "retry"]], ...extra});

const overlap = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

test("validate: a graph, and why one cannot be drawn", () => {
  const v = G.validate(graph());
  assert.ok(v.ok);
  assert.equal(v.value.nodes.length, 4);
  assert.equal(v.value.direction, "auto");
  assert.match(G.validate("{nodes: [").reason, /not JSON/);
  assert.match(G.validate('{"nodes": []}').reason, /no nodes/);
  assert.match(G.validate('{"nodes": [{"id": "a"}, {"id": "a"}]}').reason, /twice/);
  assert.match(G.validate('{"nodes": [{"id": "a"}], "edges": [["a", "z"]]}').reason, /no such node/);
  assert.match(G.validate('{"nodes": [{"id": "a", "state": "great"}]}').reason, /unknown state/);
  assert.deepEqual(G.validate('{"id": "flow", "update": {"b": "done"}}').value, {id: "flow", update: {b: "done"}});
  assert.match(G.validate('{"update": {"b": "done"}}').reason, /id/);
});

test("layout: layers follow the edges, the cycle's edge is a back edge, nothing overlaps", () => {
  const g = G.validate(graph({direction: "down"})).value;
  const L = G.layout(g);
  const at = Object.fromEntries(L.nodes.map((n) => [n.id, n]));
  assert.ok(at.a.y < at.b.y && at.b.y < at.c.y && at.c.y < at.d.y, "top-down by layer");
  assert.deepEqual(L.edges.filter((e) => e.back).map((e) => [e.from, e.to]), [["c", "b"]]);
  for (const p of L.nodes) for (const q of L.nodes) if (p !== q) assert.ok(!overlap(p, q), `${p.id} overlaps ${q.id}`);
  for (const p of L.nodes) assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= L.width && p.y + p.h <= L.height);
  // a group's frame holds its nodes and no other's
  const core = L.groups.find((r) => r.id === "core");
  const inside = (p) => p.x >= core.x && p.y >= core.y && p.x + p.w <= core.x + core.w && p.y + p.h <= core.y + core.h;
  assert.ok(inside(at.b) && inside(at.c) && !inside(at.a));
  for (const r of L.groups) for (const s of L.groups) if (r !== s) assert.ok(!overlap(r, s), "frames apart");
});

test("layout: with no direction, a long chain runs the way that fits", () => {
  const chain = (n) => G.validate(JSON.stringify({nodes: Array.from({length: n}, (_, i) => ({id: "n" + i})),
    edges: Array.from({length: n - 1}, (_, i) => ["n" + i, "n" + (i + 1)])})).value;
  assert.equal(G.layout(chain(3)).down, true, "short: top-down");
  assert.equal(G.layout(chain(7)).down, false, "seven layers do not fit 260 px down: left to right");
});

test("layout: right runs left to right; a wide layer keeps its nodes apart", () => {
  const g = G.validate(JSON.stringify({direction: "right", nodes: [{id: "s"}, ...[1, 2, 3, 4, 5].map((i) => ({id: "n" + i}))],
    edges: [1, 2, 3, 4, 5].map((i) => ["s", "n" + i])})).value;
  const L = G.layout(g);
  const s = L.nodes.find((n) => n.id === "s");
  for (const n of L.nodes.filter((x) => x.id !== "s")) assert.ok(n.x > s.x + s.w);
  for (const p of L.nodes) for (const q of L.nodes) if (p !== q) assert.ok(!overlap(p, q));
});

test("update by id: applied once, replayed when the first drawing is drawn again", () => {
  G.reset();
  const first = G.validate(graph()).value;
  let redrawn = null;
  G.remember("graph", first, (changed) => { redrawn = changed; });
  const r = G.update("graph", "flow", {b: "done", c: {state: "failed", detail: "disk full"}}, 1000);
  assert.deepEqual(r.changed, ["b", "c"]);
  assert.deepEqual(redrawn, ["b", "c"]);
  assert.equal(r.entry.at, 1000);
  assert.ok(G.update("graph", "flow", {b: "done", c: {state: "failed", detail: "disk full"}}).again, "the same fence re-rendered");
  // md() draws the text again: a fresh value, the update still on it
  const again = G.validate(graph()).value;
  G.remember("graph", again, null);
  assert.equal(again.nodes.find((n) => n.id === "c").state, "failed");
  assert.equal(again.nodes.find((n) => n.id === "c").detail, "disk full");
  assert.equal(G.update("graph", "nope", {a: "done"}), null, "no such graph");
});

test("charts: validated, appended to by id, ticks are round", () => {
  G.reset();
  const c = G.validateChart(JSON.stringify({id: "lat", type: "line", unit: "ms",
    series: [{name: "p50", points: [[1, 120], [2, 95]]}]}));
  assert.ok(c.ok);
  assert.match(G.validateChart('{"type": "pie", "series": []}').reason, /type is one of/);
  assert.match(G.validateChart(JSON.stringify({series: Array.from({length: 9}, (_, i) => ({name: "s" + i, points: [[0, 1]]}))})).reason, /over 8 series/);
  assert.match(G.validateChart('{"series": [{"name": "a", "points": [[0, "x"]]}]}').reason, /number/);
  const app = G.validateChart('{"id": "lat", "append": [{"name": "p50", "points": [[3, 80]]}]}');
  assert.deepEqual(app.value, {id: "lat", append: [{name: "p50", points: [[3, 80]]}]});
  G.remember("chart", c.value, null);
  G.update("chart", "lat", app.value.append);
  assert.deepEqual(c.value.series[0].points.map((p) => p[1]), [120, 95, 80]);
  assert.deepEqual(G.ticks(0, 137), [0, 50, 100, 150]);
  assert.deepEqual(G.ticks(0, 1), [0, 0.5, 1]);
});
