// An agent op's run as a graph the canvas opens — pure data → data.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rootOps, agentGraph, withSteps, visual } =
  require("../../operonx_studio/static/agentsteps.js");

// the tree API's rows for a service run whose agent op `cashier` ran twice
// (a request, then its resume): turn → model, tool; egress rows `out`
let t = 0;
const row = (id, parent, op, op_type, ctx, child = true, outputs = {}) =>
  ({id, parent, kind: "record", name: op, op, op_type, ctx, child, outputs, start_ms: t++, dur_ms: 1});
const ROWS = [
  row("src", null, "src", "code", "main", false),
  {id: "s0", parent: "src", kind: "stand-in", name: "src [0]", ctx: "main.[0]", start_ms: t++},
  row("a0", "s0", "cashier", "agent", "main.[0]", false),
  row("t0", "a0", "turn", "turn", "main.[0].turn[0]"),
  row("m0", "t0", "model", "llm", "main.[0].turn[0].model[0]", true, {finish_reason: "tool_calls"}),
  row("o0", "t0", "order_status", "tool", "main.[0].turn[0].order_status[0]"),
  row("e0", "a0", "out", "code", "main.[0].[0]", false),
  row("t1", "a0", "turn", "turn", "main.[0].turn[1]"),
  row("m1", "t1", "model", "llm", "main.[0].turn[1].model[0]"),
  row("r1", "t1", "refund", "tool", "main.[0].turn[1].refund[0]"),
  row("r2", "t1", "refund", "tool", "main.[0].turn[1].refund[1]"),
  {id: "s1", parent: "src", kind: "stand-in", name: "src [1]", ctx: "main.[1]", start_ms: t++},
  row("a1", "s1", "cashier", "agent", "main.[1]", false),
  row("t2", "a1", "turn", "turn", "main.[1].turn[0]"),
  row("r3", "t2", "refund", "tool", "main.[1].turn[0].refund[0]"),
];

const names = (g) => g.nodes.map(n => n.name);
const wires = (g) => g.edges.map(e => `${g.nodes.find(n => n.id === e.src).name}→${g.nodes.find(n => n.id === e.dst).name}`);

test("a run matches its graph on its root ops, not its steps", () => {
  assert.deepEqual(rootOps({ops: {a: {}, turn: {}, model: {}}, root_ops: ["a"]}), ["a"]);
  // a run recorded before the server named them: every op, as before
  assert.deepEqual(rootOps({ops: {a: {}, b: {}}}), ["a", "b"]);
});

test("the agent's turns follow one another; a model call fans out to its tools", () => {
  const g = agentGraph("cashier", ROWS, "main.[0]");
  assert.deepEqual(names(g), ["turn[0]", "turn[1]"]);
  assert.deepEqual(wires(g), ["turn[0]→turn[1]"]);
  assert.deepEqual(g.nodes.map(n => [n.start, n.end]), [[true, false], [false, true]]);
  const [first, second] = g.nodes;
  assert.deepEqual(names(first.graph), ["model[0]", "order_status[0]"]);
  assert.deepEqual(wires(first.graph), ["model[0]→order_status[0]"]);
  assert.deepEqual(wires(second.graph), ["model[0]→refund[0]", "model[0]→refund[1]"]);
  assert.deepEqual(second.graph.nodes.map(n => [n.name, n.start, n.end]),
    [["model[0]", true, false], ["refund[0]", false, true], ["refund[1]", false, true]]);
  // each step carries its record, for the inspector
  assert.equal(first.graph.nodes[0].step.id, "m0");
  assert.equal(first.graph.nodes[0].step.outputs.finish_reason, "tool_calls");
  // egress rows under the agent op are not its steps
  assert.ok(!JSON.stringify(g).includes('"out"'));
});

test("without a picked turn every execution's steps show, ids unique", () => {
  const g = agentGraph("cashier", ROWS, null);
  assert.deepEqual(names(g), ["turn[0]", "turn[1]", "turn[0]"]);
  assert.equal(new Set(g.nodes.map(n => n.id)).size, 3);
  // a resumed turn with no model call: its tool is the whole level
  assert.deepEqual(g.nodes[2].graph.nodes.map(n => [n.name, n.start, n.end]), [["refund[0]", true, true]]);
});

test("withSteps opens a copy of the graph on the agent op, the original untouched", () => {
  const ir = {name: "cashier_service", nodes: [
    {id: "f.src", name: "src", kind: "FuncOp"},
    {id: "f.cashier", name: "cashier", kind: "AgentDoorOp", op_type: "agent"},
    {id: "f.out", name: "out", kind: "FuncOp"},
  ], edges: [], entries: ["src"], exits: ["out"]};
  const {graph, opened} = withSteps(ir, ROWS, "main.[0]");
  const agent = graph.nodes[1];
  assert.equal(agent.subgraph_ops, 2);
  assert.deepEqual(names(agent.graph), ["turn[0]", "turn[1]"]);
  assert.deepEqual(opened, ["f.cashier", "f.cashier/main.[0].turn[0]", "f.cashier/main.[0].turn[1]"]);
  assert.equal(ir.nodes[1].graph, undefined);
  assert.equal(graph.nodes[0], ir.nodes[0]);
});

test("a run with no agent op leaves the graph as it is", () => {
  const ir = {nodes: [{id: "a", name: "a"}]};
  const plain = [row("x", null, "a", "code", "main", false)];
  assert.equal(withSteps(ir, plain).graph, ir);
});

test("an op that is not an agent keeps its name's steps to itself", () => {
  // an IR op named like the agent but of another type is not opened
  const ir = {nodes: [{id: "c", name: "cashier", op_type: "code"}]};
  assert.equal(withSteps(ir, ROWS).graph.nodes[0].graph, undefined);
});

test("each step looks like its type", () => {
  assert.equal(visual("llm").icon, "✧");
  assert.equal(visual("tool").label, "tool call");
  assert.equal(visual("code"), null);
});

// operonx >= 1.18: a tool that is a @graph runs under its call; its run's
// record (op_type "graph") holds the graph's ops, some inside a subgraph
const NESTED = [
  row("ag", null, "helper", "agent", "main", false),
  row("tn", "ag", "turn", "turn", "main.turn[0]"),
  row("md", "tn", "model", "llm", "main.turn[0].model[0]"),
  row("rp", "tn", "read_page", "tool", "main.turn[0].read_page[0]"),
  row("gr", "rp", "read_page", "graph", "main.turn[0].read_page[0].read_page[0]"),
  row("f", "gr", "fetch", "code", "main.turn[0].read_page[0].read_page[0]", false),
  {id: "graph:x.clean#c", parent: "gr", kind: "container", name: "clean", ctx: "c", start_ms: t++},
  row("v", "graph:x.clean#c", "visible", "code", "main.turn[0].read_page[0].read_page[0]", false),
];

test("a graph tool's step opens onto the ops its run recorded, through subgraphs", () => {
  const g = agentGraph("helper", NESTED, null);
  const turn = g.nodes[0];
  const call = turn.graph.nodes.find(n => n.name === "read_page[0]");
  const run = call.graph.nodes[0];
  assert.equal(run.op_type, "graph");
  assert.deepEqual(names(run.graph), ["fetch", "visible"]);
  assert.deepEqual(wires(run.graph), ["fetch→visible"]);
  assert.equal(new Set(run.graph.nodes.map(n => n.id)).size, 2);
});

test("an agent drawn as its loop still opens onto the run's steps", () => {
  const loop = {nodes: [{id: "x.model", name: "model"}], edges: [], entries: ["model"], exits: ["model"]};
  const ir = {nodes: [{id: "x.helper", name: "helper", op_type: "agent", graph: loop}]};
  const {graph, opened} = withSteps(ir, NESTED, null);
  assert.equal(graph.nodes[0].agentSteps, true);
  assert.deepEqual(names(graph.nodes[0].graph), ["turn[0]"]);
  assert.deepEqual(opened.slice(0, 1), ["x.helper"]);
  // with no steps recorded for it, it keeps its loop
  const quiet = withSteps(ir, [row("o", null, "other", "agent", "main", false)], null);
  assert.equal(quiet.graph.nodes[0].graph.nodes[0].name, "model");
});
