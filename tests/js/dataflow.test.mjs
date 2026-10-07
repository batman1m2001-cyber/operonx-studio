// Data bindings from the IR, and the questions the views ask of them.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { dataBindings, nodeBindings, lineage, pairs, isBroadcast } =
  require("../../operonx_studio/static/dataflow.js");

const ref = (from, output) => ({kind: "ref", from, output});
// answer(question) — retrieve(q) → rank(docs, q) → llm(context, history, clock)
const G = {
  name: "answer",
  nodes: [
    {id: "r", name: "retrieve", inputs: [{name: "q", binding: ref("answer", "question")}]},
    {id: "k", name: "rank", inputs: [
      {name: "docs", binding: ref("answer.retrieve", "documents")},
      {name: "q", binding: ref("answer", "question")}]},
    {id: "l", name: "llm", inputs: [
      {name: "context", binding: ref("answer.rank", "top")},
      {name: "history", binding: ref("answer", "history")},
      {name: "clock", binding: {kind: "scratch", key: "clock"}},
      {name: "temperature", binding: {kind: "literal", value: 0.2}}]},
    {id: "s", name: "summarize", graph: {
      name: "summarize",
      nodes: [{id: "c", name: "cut", inputs: [{name: "text", binding: ref("summarize", "text")}]}],
      exports: [{from: "summarize.cut", output: "short", as: "summary"}]},
     inputs: [{name: "text", binding: ref("answer.llm", "answer")}]},
  ],
};

test("bindings: op outputs, graph inputs and scratch; literals are not data flow", () => {
  const B = dataBindings(G, new Set());
  const s = B.map(b => `${b.from.kind}:${b.from.key}.${b.from.port}→${b.to.key}.${b.to.port}`);
  assert.deepEqual(s, [
    "input:.question→r.q",
    "op:r.documents→k.docs",
    "input:.question→k.q",
    "op:k.top→l.context",
    "input:.history→l.history",
    "scratch:.clock→l.clock",
    "op:l.answer→s.text",
  ]);
  assert.ok(B.every((b, i) => b.id === i));
});

test("an opened GraphOp: its inputs feed the ops inside, its exports leave through its card", () => {
  const B = dataBindings(G, new Set(["s"]));
  const s = B.map(b => `${b.from.kind}:${b.from.key}.${b.from.port}→${b.to.key}.${b.to.port}${b.to.export ? "!" : ""}`);
  assert.ok(s.includes("input:s.text→s/c.text"));
  assert.ok(s.includes("op:s/c.short→s.summary!"));
});

test("broadcast: root graph inputs and scratch, not an opened GraphOp's inputs", () => {
  const B = dataBindings(G, new Set(["s"]));
  const bc = B.filter(isBroadcast).map(b => b.from.port);
  assert.deepEqual(bc.sort(), ["clock", "history", "question", "question"]);
});

test("nodeBindings: what a node reads and feeds", () => {
  const B = dataBindings(G, new Set());
  const {ins, outs} = nodeBindings(B, "k");
  assert.deepEqual(ins.map(b => b.to.port), ["docs", "q"]);
  assert.deepEqual(outs.map(b => b.to.key), ["l"]);
});

test("lineage of an input port: its source, then what that source reads", () => {
  const B = dataBindings(G, new Set());
  const lv = lineage(B, {key: "l", port: "context", dir: "in"});
  const at = (l) => [...lv].filter(([, v]) => v === l).map(([id]) => `${B[id].from.port}→${B[id].to.key}.${B[id].to.port}`).sort();
  assert.deepEqual(at(1), ["top→l.context"]);
  assert.deepEqual(at(2), ["documents→k.docs", "question→k.q"]);
});

test("lineage of an output port: every reader", () => {
  const B = dataBindings(G, new Set());
  const lv = lineage(B, {key: "r", port: "documents", dir: "out"});
  assert.deepEqual([...lv.keys()].map(id => B[id].to.key), ["k"]);
});

test("pairs: one connector per node pair, broadcasts left out", () => {
  const B = dataBindings(G, new Set());
  const P = pairs(B).map(p => `${p.from}>${p.to}:${p.bindings.length}`);
  assert.deepEqual(P, ["r>k:1", "k>l:1", "l>s:1"]);
});

test("a nested graph with no name: its ops read its inputs by the GraphOp's id", () => {
  const H = {name: "qc", nodes: [
    {id: "qc.sa", name: "sa", inputs: [{name: "conversation", binding: ref("qc", "conversation")}],
     graph: {nodes: [{id: "qc.sa.l1", name: "l1", inputs: [{name: "conversation", binding: ref("qc.sa", "conversation")}]}],
             exports: [{from: "qc.sa.l1", output: "result", as: "result"}]}},
  ]};
  const B = dataBindings(H, new Set(["qc.sa"]));
  const s = B.map(b => `${b.from.kind}:${b.from.key}.${b.from.port}→${b.to.key}.${b.to.port}${b.to.export ? "!" : ""}`);
  assert.ok(s.includes("input:qc.sa.conversation→qc.sa/qc.sa.l1.conversation"));
  assert.ok(s.includes("op:qc.sa/qc.sa.l1.result→qc.sa.result!"));
});
