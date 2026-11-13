// Fan-outs (static/flowlayout.js stackFanouts): six or more agents side by
// side draw as one stack node; opening it lays them out as before.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FL = require("../../operonx_studio/static/flowlayout.js");

const op = (name, extra = {}) => ({id: `g.${name}`, name, kind: "FuncOp", ...extra});
const agent = (name, extra = {}) => op(name, {kind: "AgentOp", op_type: "agent", agent: {}, ...extra});
const edge = (a, b, extra = {}) => ({id: `${a}->${b}`, src: `g.${a}`, dst: `g.${b}`, type: "normal", origin: "authored", ...extra});

function fan(k) {
  const names = Array.from({length: k}, (_, i) => `a${i}`);
  return {
    nodes: [op("plan"), ...names.map(n => agent(n)), op("merge")],
    edges: [...names.map(n => edge("plan", n)), ...names.map(n => edge(n, "merge"))],
    entries: ["plan"], exits: ["merge"],
  };
}

const sizeOf = () => ({w: 260, h: 64});
const pos = (out) => Object.fromEntries([...out.items, ...out.pills].map(i => [i.key, [i.x, i.y, i.w, i.h]]));

test("ten parallel agents fold into one stack, wired plan → stack → merge", () => {
  const s = FL.stackFanouts(fan(10));
  assert.deepEqual(s.nodes.map(n => n.name), ["plan", "10 agents", "merge"]);
  const st = s.nodes[1];
  assert.equal(st.stack, true);
  assert.equal(st.graph.nodes.length, 10);
  assert.ok(st.graph.nodes.every(n => n.start && n.end), "members tie to the stack's START and END");
  assert.deepEqual(s.edges.map(e => [e.src, e.dst]), [["g.plan", st.id], [st.id, "g.merge"]]);
});

test("five agents stay as they are; the input is never mutated", () => {
  const g = fan(FL.STACK_MIN - 1);
  assert.equal(FL.stackFanouts(g), g);
  const big = fan(10), copy = JSON.stringify(big);
  FL.stackFanouts(big);
  assert.equal(JSON.stringify(big), copy);
});

test("agents on a branch route or with different feeders do not stack", () => {
  const g = fan(10);
  g.edges[0] = edge("plan", "a0", {type: "condition", route: 0});
  g.edges.push(edge("a1", "a2"));       // a1 feeds a2: a1, a2 differ from the rest
  const s = FL.stackFanouts(g);
  const st = s.nodes.find(n => n.stack);
  assert.equal(st.graph.nodes.length, 7);
  assert.ok(s.nodes.some(n => n.name === "a0") && s.nodes.some(n => n.name === "a1"));
});

test("a fan-out inside a GraphOp stacks too, and entries name the stack", () => {
  const inner = fan(8);
  inner.nodes.forEach(n => { n.id = `g.box.${n.name}`; });
  inner.edges = inner.edges.map(e => ({...e, src: e.src.replace("g.", "g.box."), dst: e.dst.replace("g.", "g.box.")}));
  const g = {nodes: [op("box", {kind: "GraphOp", graph: inner}), agent("solo")], edges: [], entries: ["box"], exits: ["box"]};
  const s = FL.stackFanouts(g);
  assert.deepEqual(s.nodes[0].graph.nodes.map(n => n.name), ["plan", "8 agents", "merge"]);
  // six top-level agents that are all entries and exits: the lists name the stack
  const top = FL.stackFanouts({nodes: Array.from({length: 6}, (_, i) => agent(`t${i}`)), edges: [],
    entries: ["t0", "t1", "t2", "t3", "t4", "t5"], exits: ["t0", "t1", "t2", "t3", "t4", "t5"]});
  assert.deepEqual(top.entries, ["6 agents"]);
  assert.deepEqual(top.exits, ["6 agents"]);
});

test("a member's key maps into its stack", () => {
  const s = FL.stackFanouts(fan(10));
  const st = s.nodes[1];
  assert.equal(FL.stackedKey(s, "g.a3"), `${st.id}/g.a3`);
  assert.equal(FL.stackedKey(s, "g.plan"), "g.plan");
});

test("opening the stack lays the agents out, closing it puts every card back", () => {
  const s = FL.stackFanouts(fan(10));
  const st = s.nodes[1];
  const closed = FL.layout(s, {expanded: new Set(), sizeOf});
  const opened = FL.layout(s, {expanded: new Set([st.id]), sizeOf});
  const box = opened.items.find(i => i.key === st.id);
  assert.equal(box.kind, "container");
  assert.equal(opened.items.filter(i => i.key.startsWith(st.id + "/g.a")).length, 10);
  assert.equal(closed.items.find(i => i.key === st.id).kind, "card");
  assert.deepEqual(pos(FL.layout(s, {expanded: new Set(), sizeOf})), pos(closed));
});
