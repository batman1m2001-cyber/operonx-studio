// The Prompts page's graph: prompt objects as boxes in columns, links as wires.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const PG = createRequire(import.meta.url)("../../operonx_studio/static/promptgraph.js");

const link = (how, name, extra = {}) => ({role: "system", how, var: null, case: null, name, kind: "text", ...extra});
const cards = [
  {name: "classifier", kind: "chat", links: [
    link("use", "classifier/system"),
    link("pick", "hr/rules", {var: "agent", case: "hr"}),
    link("pick", "hr/rules", {var: "agent", case: "hr_v2"}),
    link("pick", "trial/rules", {var: "agent", case: "trial"}),
    link("pick", null, {var: "agent", case: "else"}),
    link("when", "guard", {var: "urgent"}),
    link("use", "classifier/user", {role: "user", kind: "text"})]},
  {name: "classifier/user", kind: "text", links: [link("use", "few_shot")]},  // a text never links; a composite named like one may
  {name: "classifier/system", kind: "text", links: []},
  {name: "hr/rules", kind: "text", links: []},
  {name: "trial/rules", kind: "text", links: []},
  {name: "guard", kind: "text", links: []},
  {name: "few_shot", kind: "text", links: []},
  {name: "lonely", kind: "text", links: []},
];

test("a link goes left to right: each box's column is the longest chain into it", () => {
  const m = PG.layout(cards, "");
  const x = Object.fromEntries(m.nodes.map(n => [n.name, n.x]));
  assert.ok(x.classifier < x["hr/rules"] && x["classifier/user"] < x.few_shot);
  assert.equal(x.lonely, x.classifier);           // nothing links it: the first column
  for (const e of m.edges) assert.ok(e.x1 < e.x2, `${e.from} → ${e.to} runs left to right`);
  for (const n of m.nodes) assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= m.w && n.y + n.h <= m.h);
});

test("two cases to one object are one wire with both cases; else none draws nothing", () => {
  const m = PG.layout(cards, "");
  const hr = m.edges.filter(e => e.to === "hr/rules");
  assert.equal(hr.length, 1);
  assert.equal(hr[0].label, "hr, hr_v2");
  assert.match(hr[0].title, /pick agent = hr; pick agent = hr_v2/);
  assert.equal(m.edges.find(e => e.to === "guard").label, "if urgent");
  assert.equal(m.edges.find(e => e.to === "classifier/system").label, "");
  assert.equal(m.edges.length, 6);
});

test("a focus is the object, all it links, and who links it one level up", () => {
  const m = PG.layout(cards, "classifier/user");
  assert.deepEqual(m.nodes.map(n => n.name).sort(), ["classifier", "classifier/user", "few_shot"]);
  assert.equal(m.nodes.find(n => n.focus).name, "classifier/user");
  assert.equal(PG.layout(cards, "nope").nodes.length, cards.length);   // a stale focus: every object
});

test("boxes in one column do not overlap", () => {
  const m = PG.layout(cards, "");
  const cols = new Map();
  for (const n of m.nodes) (cols.get(n.x) || cols.set(n.x, []).get(n.x)).push(n);
  for (const col of cols.values()) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) assert.ok(col[i].y >= col[i - 1].y + col[i - 1].h);
  }
});

test("linked by: the composites that link an object, and how", () => {
  assert.deepEqual(PG.linkedBy(cards, "hr/rules"), [{name: "classifier", how: "pick agent = hr, pick agent = hr_v2"}]);
  assert.deepEqual(PG.linkedBy(cards, "lonely"), []);
});
