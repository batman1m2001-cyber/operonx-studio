// The run line's layout — the flow's graph and a run's rows in, stations
// and lanes out (docs/RUN_LINE_PLAN.md W1). Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { layout, around, rowPath, defaultOpen } = require("../../operonx_studio/static/runline.js");

// a graph in the studio's IR shape: nodes by "<engine>.<name>", edges src → dst
const E = "eng";
const node = (name, extra = {}) => ({id: `${E}.${name}`, name, kind: "FuncOp", ...extra});
const edge = (a, b, extra = {}) => ({src: `${E}.${a}`, dst: `${E}.${b}`, type: "normal", ...extra});
const row = (op, start_ms, dur_ms = 10, extra = {}) =>
  ({id: `${E}.${op}#main`, op: op.split(".").pop(), kind: "record", op_type: "code", ctx: "main", start_ms, dur_ms, status: "ok", ...extra});
const keys = (L) => L.rows.map(r => r.key);
const ranEdges = (L) => L.rows.flatMap(r => r.forks.map(f => f.edge)).filter(e => e.ran).map(e => `${e.from}>${e.to}`);

test("rowPath: a record's id and a subgraph's id name the op's path", () => {
  assert.equal(rowPath({id: "eng.prepare.memory.task#main.[0]"}), "prepare.memory.task");
  assert.equal(rowPath({id: "graph:prepare.memory#main"}), "prepare.memory");
});

test("a chain is one lane, in run order, every wire ran", () => {
  const g = {nodes: [node("a"), node("b"), node("c")], edges: [edge("a", "b"), edge("b", "c")]};
  const L = layout(g, [row("a", 0), row("b", 10), row("c", 20)]);
  assert.deepEqual(keys(L), ["a", "b", "c"]);
  assert.equal(L.width, 1);
  assert.deepEqual(ranEdges(L), ["a>b", "b>c"]);
});

test("a branch takes one route: the others did not run, sit beside it, and fade", () => {
  const g = {
    nodes: [node("k"), node("r", {kind: "BranchOp", op_type: "branch", routes: [{}, {}]}), node("x"), node("y"), node("j")],
    edges: [edge("k", "r"), edge("r", "x", {kind: "branch", route: 0, label: "n < 3"}),
            edge("r", "y", {kind: "branch", route: 1, label: "else"}), edge("x", "j"), edge("y", "j")],
  };
  const L = layout(g, [row("k", 0), row("r", 10, 1), row("y", 12), row("j", 30)]);
  const r = L.stations.get("r");
  assert.equal(r.kind, "branch");
  assert.deepEqual(r.routes.filter(q => q.ran).map(q => q.to), ["y"]);
  assert.equal(L.stations.get("x").ran, false);
  assert.ok(keys(L).indexOf("x") < keys(L).indexOf("j"), "the route not taken shows before the join");
  assert.ok(!ranEdges(L).includes("r>x"));
  assert.ok(ranEdges(L).includes("r>y"));
  assert.equal(L.width, 2);
});

test("a branch nothing matched says so", () => {
  const g = {nodes: [node("r", {kind: "BranchOp", op_type: "branch", routes: [{}]}), node("x")],
             edges: [edge("r", "x", {kind: "branch", route: 0, label: "n < 3"})]};
  const L = layout(g, [row("r", 0, 1)]);
  assert.equal(L.stations.get("r").matched, false);
});

test("a fan-out opens lanes and the join records who it waited for", () => {
  const g = {nodes: [node("s"), node("a"), node("b"), node("j")],
             edges: [edge("s", "a"), edge("s", "b"), edge("a", "j"), edge("b", "j")]};
  const L = layout(g, [row("s", 0), row("a", 10, 300), row("b", 10, 20), row("j", 311)]);
  assert.equal(L.width, 2);
  const j = L.stations.get("j");
  assert.equal(j.waited.for, "a");
  assert.ok(j.waited.ms > 250);
  assert.ok(L.stations.get("b").idle > 250);
});

test("a race on soft wires: the first in fired it, the other came too late", () => {
  const g = {nodes: [node("c"), node("s"), node("r")],
             edges: [edge("c", "r", {soft: true}), edge("s", "r", {soft: true})]};
  const L = layout(g, [row("c", 0, 50), row("s", 0, 500), row("r", 51, 1)]);
  assert.equal(L.stations.get("r").raced.won, "c");
  const late = L.rows.flatMap(r => r.forks.map(f => f.edge)).find(e => e.from === "s");
  assert.equal(late.late, true);
  assert.equal(late.ran, false);
});

test("a loop: the back edge is dropped from the line and named on its station", () => {
  const lp = {group: "__loop_0__"};
  const g = {
    nodes: [node("s", {id: `${E}.__loop_0__.s`, loop: lp}), node("chk", {id: `${E}.__loop_0__.chk`, loop: lp}), node("fin")],
    edges: [{src: `${E}.__loop_0__.s`, dst: `${E}.__loop_0__.chk`, type: "normal"},
            {src: `${E}.__loop_0__.chk`, dst: `${E}.__loop_0__.s`, type: "back", back: true},
            {src: `${E}.__loop_0__.chk`, dst: `${E}.fin`, type: "normal"}],
  };
  const rows = [0, 1, 2].flatMap(i => [
    {...row("__loop_0__.s", i * 20), ctx: `main.${i}`}, {...row("__loop_0__.chk", i * 20 + 10), ctx: `main.${i}`}]);
  const L = layout(g, [...rows, row("fin", 70)]);
  assert.deepEqual(keys(L), ["__loop_0__.s", "__loop_0__.chk", "fin"]);
  assert.deepEqual(L.stations.get("__loop_0__.chk").loops, ["s"]);
  assert.equal(L.stations.get("__loop_0__.s").execs.length, 3);
});

test("retries are counted apart from the execution; a failure is marked", () => {
  const g = {nodes: [node("crm"), node("bad")], edges: [edge("crm", "bad")]};
  const L = layout(g, [
    row("crm", 0, 5, {status: "retried", id: "eng.crm#main@1"}), row("crm", 6, 5, {status: "retried", id: "eng.crm#main@2"}),
    row("crm", 12, 5), row("bad", 20, 5, {status: "error"})]);
  assert.equal(L.stations.get("crm").retries, 2);
  assert.equal(L.stations.get("crm").execs.length, 1);
  assert.equal(L.stations.get("bad").failed, true);
});

test("on_error: the handler's wire ran only because its op failed", () => {
  const g = {nodes: [node("slow"), node("sorry"), node("out")],
             edges: [edge("slow", "out"), edge("slow", "sorry", {type: "error"}), edge("sorry", "out")]};
  const L = layout(g, [row("slow", 0, 200, {status: "error"}), row("sorry", 201), row("out", 212)]);
  assert.ok(ranEdges(L).includes("slow>sorry"));
  assert.ok(!ranEdges(L).includes("slow>out"));
});

test("a GraphOp with a shape opens; its rows stay together after it; a chain stays shut", () => {
  const inner = {nodes: [node("p", {id: `${E}.mid.p`}), node("q", {id: `${E}.mid.q`}), node("r", {id: `${E}.mid.r`})],
                 edges: [{src: `${E}.mid.p`, dst: `${E}.mid.q`}, {src: `${E}.mid.p`, dst: `${E}.mid.r`}]};
  const chain = {nodes: [node("a", {id: `${E}.w.a`}), node("b", {id: `${E}.w.b`})], edges: [{src: `${E}.w.a`, dst: `${E}.w.b`}]};
  const g = {nodes: [node("pre"), node("mid", {kind: "GraphOp", graph: inner}), node("w", {kind: "GraphOp", graph: chain}), node("other")],
             edges: [edge("pre", "mid"), edge("pre", "other"), edge("mid", "w")]};
  assert.deepEqual([...defaultOpen(g)], ["mid"]);
  // "other" starts while mid runs: it comes before or after the group, never inside
  const L = layout(g, [row("pre", 0), {...row("mid", 10, 100), id: "graph:mid#main", kind: "container", op_type: "graph"},
    row("mid.p", 11), row("other", 15), row("mid.q", 25), row("mid.r", 25), row("w", 120)]);
  const k = keys(L), at = k.indexOf("mid");
  assert.deepEqual(k.slice(at, at + 4), ["mid", "mid.p", "mid.q", "mid.r"]);
  assert.equal(L.stations.get("mid.p").depth, 1);
  assert.equal(L.stations.get("w").open, false);
});

test("a GraphOp that did not run stays shut", () => {
  const inner = {nodes: [node("p", {id: `${E}.g.p`}), node("q", {id: `${E}.g.q`}), node("r", {id: `${E}.g.r`})],
                 edges: [{src: `${E}.g.p`, dst: `${E}.g.q`}, {src: `${E}.g.p`, dst: `${E}.g.r`}]};
  const g = {nodes: [node("a"), node("g", {kind: "GraphOp", graph: inner})], edges: [edge("a", "g")]};
  const L = layout(g, [row("a", 0)]);
  assert.deepEqual(keys(L), ["a", "g"]);
  assert.equal(L.open.has("g"), false);
});

test("a turn narrows the run to that turn's rows", () => {
  const g = {nodes: [node("a")], edges: []};
  const rows = [{...row("a", 0), ctx: "main.0"}, {...row("a", 50), ctx: "main.1"}];
  assert.equal(layout(g, rows).stations.get("a").execs.length, 2);
  assert.equal(layout(g, rows, {turn: "main.1"}).stations.get("a").start, 50);
});

test("an LLM call and a tool call under an agent are counted on it", () => {
  const g = {nodes: [node("ag", {kind: "AgentOp", op_type: "agent"})], edges: []};
  const L = layout(g, [row("ag", 0, 100, {op_type: "agent"}),
    {...row("ag.llm", 5), op_type: "llm"}, {...row("ag.web_search", 20), op_type: "tool", op: "web_search"},
    {...row("ag.llm2", 40), op_type: "llm"}]);
  const s = L.stations.get("ag");
  assert.equal(s.kind, "agent");
  assert.equal(s.llm, 2);
  assert.deepEqual([...s.tools.keys()], ["web_search"]);
});

test("around: a station lights its feeders, what it fed, and its GraphOp", () => {
  const g = {nodes: [node("a"), node("b"), node("c"), node("d")], edges: [edge("a", "b"), edge("b", "c"), edge("c", "d")]};
  const L = layout(g, [row("a", 0), row("b", 10), row("c", 20), row("d", 30)]);
  assert.deepEqual([...around(L, "b")].sort(), ["a", "b", "c"]);
});
