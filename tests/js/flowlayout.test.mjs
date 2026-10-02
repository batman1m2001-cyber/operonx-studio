// The flow canvas's compound layout (static/flowlayout.js): positions for
// every card of every open level first, then each wire along the lanes the
// placement reserved. Checked on the paths the canvas actually draws.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { problems, sample } from "./flowgeom.mjs";

const require = createRequire(import.meta.url);
const FL = require("../../operonx_studio/static/flowlayout.js");

// ── a seeded random workflow ──────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function randomGraph(R, prefix, depthLeft, budget) {
  const n = 2 + Math.floor(R() * Math.min(9, budget));
  const nodes = [], edges = [];
  const id = (i) => `${prefix}n${i}`;
  for (let i = 0; i < n; i++) {
    const node = {id: id(i), name: `n${i}`, kind: "FuncOp", x: Math.floor(R() * 900), routes: null, graph: null};
    if (depthLeft > 0 && i > 0 && R() < 0.3) node.graph = randomGraph(R, `${id(i)}.`, depthLeft - 1, Math.max(2, budget - 3));
    nodes.push(node);
  }
  let eid = 0;
  const add = (a, b, extra = {}) => edges.push({id: `e${eid++}`, src: id(a), dst: id(b), type: "normal", origin: "authored", ...extra});
  // a forward DAG: each node after the first gets 1–2 feeders, some far back (long edges)
  for (let j = 1; j < n; j++) {
    const k = 1 + (R() < 0.35 ? 1 : 0);
    const feeders = new Set();
    for (let t = 0; t < k; t++) feeders.add(Math.floor(R() * j));
    for (const a of feeders) add(a, j);
  }
  // fan-out: an extra edge or two
  for (let t = 0; t < 2; t++) {
    const a = Math.floor(R() * (n - 1)), b = a + 1 + Math.floor(R() * (n - 1 - a));
    if (b < n) add(a, b);
  }
  // a branch: several conditions, some into the same target, maybe into END
  if (n >= 3 && R() < 0.7) {
    const a = Math.floor(R() * (n - 2));
    const r = nodes[a];
    if (!r.graph) {
      r.kind = "BranchOp";
      r.routes = [];
      const m = 2 + Math.floor(R() * 3);
      for (let k = 0; k < m; k++) {
        const roll = R();
        if (roll < 0.15) { r.routes.push({condition: `c${k}`, target: "__END__"}); continue; }
        const b = a + 1 + Math.floor(R() * (n - 1 - a));
        r.routes.push({condition: k === m - 1 ? "else" : `c${k}`, target: nodes[b].name});
        edges.push({id: `r${a}->${b}#${k}`, src: id(a), dst: id(b), type: "condition", origin: "authored", route: k, kind: "branch"});
      }
      if (r.routes.some(x => x.target === "__END__")) r.end = true;
    }
  }
  // a loop: a return from later to earlier
  if (n >= 3 && R() < 0.5) {
    const b = Math.floor(R() * (n - 1)), a = b + 1 + Math.floor(R() * (n - 1 - b));
    add(a, b, {type: "back", origin: "back_edge", back: true});
  }
  const hasIn = new Set(edges.filter(e => e.origin !== "back_edge").map(e => e.dst));
  const hasOut = new Set(edges.filter(e => e.origin !== "back_edge").map(e => e.src));
  for (const node of nodes) {
    if (!hasIn.has(node.id)) node.start = true;
    if (!hasOut.has(node.id)) node.end = true;
  }
  return {
    nodes, edges,
    entries: nodes.filter(x => x.start).map(x => x.name),
    exits: nodes.filter(x => x.end).map(x => x.name),
  };
}

const containers = (g, prefix = "", out = []) => {
  for (const n of g.nodes) if (n.graph) { out.push(prefix + n.id); containers(n.graph, prefix + n.id + "/", out); }
  return out;
};

function sizer(R) {
  const memo = new Map();
  return (key, n) => {
    if (!memo.has(key)) {
      const w = 180 + Math.floor(R() * 130);
      if (n.routes) {
        const rows = n.routes.map((r, i) => ({target: r.target, route: i, left: 12, top: 30 + 21 * i, w: w - 24, h: 18}));
        memo.set(key, {w, h: 40 + 21 * rows.length, rows});
      } else memo.set(key, {w, h: 48 + Math.floor(R() * 50)});
    }
    return memo.get(key);
  };
}

const pos = (out) => Object.fromEntries([...out.items, ...out.pills].map(i => [i.key, [i.x, i.y, i.w, i.h]]));

test("random workflows, random open sets: no wire through a card, no overlap, every edge drawn", () => {
  let cases = 0, wires = 0;
  for (let seed = 1; seed <= 240; seed++) {
    const R = rng(seed * 7919);
    const g = randomGraph(R, "g.", 1 + (seed % 3), 9);
    const sizeOf = sizer(R);
    const all = containers(g);
    const open = new Set(all.filter(() => R() < 0.6));
    // a container is only visible when its parents are open
    for (const k of [...open]) {
      const parts = k.split("/");
      for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join("/"))) open.delete(k);
    }
    const out = FL.layout(g, {expanded: open, sizeOf});
    const bad = problems(out);
    assert.deepEqual(bad, [], `seed ${seed}: ${bad.slice(0, 3).join("; ")}`);
    // every IR edge of every shown level is drawn
    const drawn = new Set(out.wires.filter(w => w.e).map(w => `${w.a.key}|${w.e.id}`));
    (function walk(gr, prefix) {
      for (const e of gr.edges) {
        assert.ok(drawn.has(`${prefix}${e.src}|${e.id}`), `seed ${seed}: edge ${e.id} not drawn`);
      }
      for (const n of gr.nodes) if (n.graph && open.has(prefix + n.id)) walk(n.graph, prefix + n.id + "/");
    })(g, "");
    // every wire is a smooth curve, no straight segments
    for (const w of out.wires) assert.ok(!/ L /.test(w.d), "M/C only");
    // determinism
    assert.deepEqual(pos(FL.layout(g, {expanded: open, sizeOf})), pos(out), `seed ${seed}: not deterministic`);
    // opening one more container and closing it again restores every coordinate
    const closed = all.filter(k => !open.has(k) && (!k.includes("/") || open.has(k.split("/").slice(0, -1).join("/"))));
    if (closed.length) {
      const more = new Set([...open, closed[0]]);
      const opened = FL.layout(g, {expanded: more, sizeOf});
      assert.deepEqual(problems(opened), [], `seed ${seed}: opening ${closed[0]}`);
      assert.deepEqual(pos(FL.layout(g, {expanded: open, sizeOf})), pos(out), `seed ${seed}: open→close moved cards`);
    }
    cases++; wires += out.wires.length;
  }
  assert.ok(cases >= 200 && wires > 2000, `${cases} cases, ${wires} wires`);
});

const card = (n, extra = {}) => ({id: `t.${n}`, name: n, kind: "FuncOp", ...extra});
const edge = (a, b, extra = {}) => ({id: `${a}->${b}`, src: `t.${a}`, dst: `t.${b}`, type: "normal", origin: "authored", ...extra});
const plain = () => ({w: 260, h: 64});

test("single anchor: every wire into a card lands on its top centre, leaves its bottom centre", () => {
  const g = {nodes: ["a", "b", "c", "t"].map(n => card(n)),
             edges: [edge("a", "t"), edge("b", "t"), edge("c", "t"), edge("a", "b")],
             entries: ["a", "c"], exits: ["t"]};
  const out = FL.layout(g, {expanded: new Set(), sizeOf: plain});
  for (const w of out.wires) {
    const pts = sample(w.d);
    const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
    const B = w.b.bIn || w.b, A = w.a.bOut || w.a;
    assert.ok(Math.abs(x1 - (B.x + B.w / 2)) < 0.2 && Math.abs(y1 - B.y) < 0.2, "lands on the top centre");
    assert.ok(Math.abs(x0 - (A.x + A.w / 2)) < 0.2 && Math.abs(y0 - (A.y + A.h)) < 0.2, "leaves the bottom centre");
  }
});

test("a long edge gets its own lane past the card between", () => {
  const g = {nodes: ["a", "m", "t"].map(n => card(n)),
             edges: [edge("a", "m"), edge("m", "t"), edge("a", "t")], entries: ["a"], exits: ["t"]};
  const out = FL.layout(g, {expanded: new Set(), sizeOf: plain});
  assert.deepEqual(problems(out), []);
  const long = out.wires.find(w => w.e && w.e.id === "a->t");
  const m = out.items.find(i => i.node.name === "m");
  const xs = sample(long.d).filter(([, y]) => y > m.y && y < m.y + m.h).map(([x]) => x);
  assert.ok(xs.every(x => x > m.x + m.w || x < m.x), "beside m, not through it");
});

test("routes of one branch into one target: one lane each, upper rows outside", () => {
  const routes = [{condition: "a", target: "t"}, {condition: "b", target: "t"}, {condition: "else", target: "t"}];
  const g = {nodes: [card("r", {kind: "BranchOp", routes}), card("t")],
             edges: routes.map((r, k) => edge("r", "t", {id: `r->t#${k}`, type: "condition", route: k})),
             entries: ["r"], exits: ["t"]};
  const sizeOf = (key, n) => n.routes
    ? {w: 260, h: 110, rows: routes.map((r, i) => ({target: r.target, route: i, left: 12, top: 30 + 22 * i, w: 236, h: 18}))}
    : {w: 260, h: 64};
  const out = FL.layout(g, {expanded: new Set(), sizeOf});
  assert.deepEqual(problems(out), []);
  const lanes = out.wires.filter(w => w.e).sort((p, q) => p.e.route - q.e.route).map(w => Math.max(...sample(w.d).map(([x]) => x)));
  assert.equal(new Set(lanes.map(Math.round)).size, 3, `three lanes, got ${lanes}`);
  assert.deepEqual([...lanes].sort((p, q) => q - p), lanes, "the first route runs outermost");
});

test("a loop's return runs in its own lane right of everything it passes, opened subgraph included", () => {
  const sub = {nodes: [card("s"), card("u")].map(n => ({...n, id: "t.z." + n.name})),
               edges: [{id: "s->u", src: "t.z.s", dst: "t.z.u", type: "normal", origin: "authored"}],
               entries: ["s"], exits: ["u"]};
  sub.nodes[0].start = true; sub.nodes[1].end = true;
  const g = {nodes: [card("a"), card("z", {kind: "GraphOp", graph: sub}), card("b")],
             edges: [edge("a", "z"), edge("z", "b"), edge("b", "a", {id: "b->a#back", type: "back", origin: "back_edge"})],
             entries: ["a"], exits: ["b"]};
  for (const open of [new Set(), new Set(["t.z"])]) {
    const out = FL.layout(g, {expanded: open, sizeOf: plain});
    assert.deepEqual(problems(out), []);
    const back = out.wires.find(w => w.back);
    assert.ok(back && back.label, "the return is drawn and labelled");
    const right = Math.max(...out.items.map(i => i.x + i.w));
    assert.ok(Math.max(...sample(back.d).map(([x]) => x)) > right, "outside every card");
  }
});

test("opening a container keeps unrelated cards' order and leaves no empty margin", () => {
  const sub = {nodes: [{id: "t.z.s", name: "s", kind: "FuncOp", start: true, end: true}], edges: [], entries: ["s"], exits: ["s"]};
  const g = {nodes: [card("a", {x: 0}), card("z", {x: 300, kind: "GraphOp", graph: sub}), card("c", {x: 600}), card("d")],
             edges: [edge("a", "d"), edge("z", "d"), edge("c", "d")], entries: ["a", "z", "c"], exits: ["d"]};
  const out = FL.layout(g, {expanded: new Set(["t.z"]), sizeOf: plain});
  const x = (n) => out.items.find(i => i.node.name === n).x;
  assert.ok(x("a") < x("z") && x("z") < x("c"));
  assert.equal(Math.min(...out.items.map(i => i.x)), FL.C.MARGIN);
});
