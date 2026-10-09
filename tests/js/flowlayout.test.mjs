// The flow canvas's compound layout (static/flowlayout.js): positions for
// every card of every open level first, then each wire along the lanes the
// placement reserved. Checked on the paths the canvas actually draws.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { problems, sample, zoneProblems } from "./flowgeom.mjs";

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
    // as the canvas sees an inlined synthetic loop: the cycle's steps are members
    if (R() < 0.7) for (let i = b; i <= a; i++) nodes[i].loop = {group: "__loop_0__", mode: "synthetic", max_iterations: 1000};
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
      if (n.routes && R() < 0.5) {
        // the canvas's columns: exits along the bottom edge
        const k = n.routes.length;
        const rows = n.routes.map((r, i) => ({target: r.target, route: i, left: 12 + 32 * i, top: 30, w: 26, h: 60,
                                             down: true, cx: (w * (i + 0.5)) / k}));
        memo.set(key, {w, h: 104, rows});
      } else if (n.routes) {
        const rows = n.routes.map((r, i) => ({target: r.target, route: i, left: 12, top: 30 + 21 * i, w: w - 24, h: 18}));
        memo.set(key, {w, h: 40 + 21 * rows.length, rows});
      } else memo.set(key, {w, h: 48 + Math.floor(R() * 50)});
    }
    return memo.get(key);
  };
}

const pos = (out) => Object.fromEntries([...out.items, ...out.pills].map(i => [i.key, [i.x, i.y, i.w, i.h]]));

test("random workflows, random open sets: no wire through a card, no overlap, every edge drawn", () => {
  let cases = 0, wires = 0, zones = 0;
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
    const bad = [...problems(out), ...zoneProblems(out)];
    assert.deepEqual(bad, [], `seed ${seed}: ${bad.slice(0, 3).join("; ")}`);
    zones += out.zones.length;
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
  assert.ok(zones > 40, `only ${zones} loop zones exercised`);
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

test("bottom exits: each target hangs under its own exit, in route order, and no two routes cross", () => {
  const names = ["d", "c", "b", "a"];   // the server's order is the reverse of the routes'
  const routes = ["a", "b", "c", "d"].map((t, i) => ({condition: i < 3 ? `x >= ${i}` : "else", target: t}));
  const g = {nodes: [card("r", {kind: "BranchOp", routes}), ...names.map((t, i) => ({...card(t), x: i * 300}))],
             edges: routes.map((r, k) => edge("r", r.target, {id: `r->${r.target}`, type: "condition", route: k})),
             entries: ["r"], exits: names};
  const W = 200;
  const sizeOf = (key, n) => n.routes
    ? {w: W, h: 120, rows: routes.map((r, i) => ({target: r.target, route: i, left: 10 + 34 * i, top: 30, w: 26, h: 70,
                                                  down: true, cx: (W * (i + 0.5)) / 4}))}
    : {w: 220, h: 64};
  const out = FL.layout(g, {expanded: new Set(), sizeOf});
  assert.deepEqual(problems(out), []);
  const at = Object.fromEntries(out.items.map(i => [i.node.name, i]));
  const xs = ["a", "b", "c", "d"].map(t => at[t].x);
  assert.deepEqual([...xs].sort((p, q) => p - q), xs, `targets in route order, got ${xs}`);
  const R = at.r;
  const wires = out.wires.filter(w => w.e).sort((p, q) => p.e.route - q.e.route);
  wires.forEach((w, i) => {
    const [x0, y0] = sample(w.d)[0];
    assert.ok(Math.abs(x0 - (R.x + (W * (i + 0.5)) / 4)) < 0.5 && Math.abs(y0 - (R.y + R.h)) < 0.5, `route ${i} leaves its exit`);
  });
  // every wire keeps its rank all the way down: none crosses another
  for (let y = R.y + R.h + 1; y < at.a.y; y += 4) {
    const cut = wires.map(w => { const pts = sample(w.d); let best = pts[0];
      for (const p of pts) if (Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p; return best[0]; });
    assert.deepEqual([...cut].sort((p, q) => p - q), cut, `crossing at y=${y}: ${cut}`);
  }
  // no side lanes: each wire stays between its exit and its target, never
  // out beside the card
  wires.forEach((w, i) => {
    const pts = sample(w.d), x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    const lo = Math.min(x0, x1) - 0.5, hi = Math.max(x0, x1) + 0.5;
    assert.ok(pts.every(([x]) => x >= lo && x <= hi), `route ${i} detours sideways`);
  });
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

// ── loops: what repeats, where it stops ───────────────────────────
// The ReAct agent as the canvas receives it: the compiler's hidden loop
// inlined, every member tagged, `answer` outside the loop but in the same
// row as `tools` (both follow the router).
function react() {
  const lp = {group: "__loop_0__", mode: "synthetic", max_iterations: 1000};
  const chain = ["counter", "asked", "context", "model", "assistant", "router", "closed", "ended"];
  const routes = [{condition: "finished == True", target: "answer"}, {condition: "else", target: "tools"}];
  const nodes = [...chain.map(n => card(n, {loop: lp})),
    card("route_1", {kind: "BranchOp", routes, loop: lp, end: true}),
    card("answer", {end: true}), card("tools", {loop: lp}), card("gathered", {loop: lp, end: true})];
  nodes[0].start = true;
  const edges = [edge("route_1", "answer", {type: "condition"})];
  for (let i = 0; i + 1 < chain.length; i++) edges.push(edge(chain[i], chain[i + 1]));
  edges.push(edge("ended", "route_1"), edge("route_1", "tools", {id: "route_1->tools#1", type: "condition", route: 1}),
             edge("tools", "gathered"), edge("gathered", "counter", {id: "gathered->counter#back", type: "back", origin: "back_edge", back: true}));
  return {nodes, edges, entries: ["counter"], exits: ["answer", "gathered", "route_1"]};
}
const reactSize = (key, n) => n.routes
  ? {w: 240, h: 90, rows: n.routes.map((r, i) => ({target: r.target, route: i, left: 12, top: 34 + 22 * i, w: 216, h: 18}))}
  : {w: 200, h: 48};

test("a loop's exit is the route inside it that leads out of it", () => {
  const [info] = FL.loopsOf(react());
  assert.equal(info.group, "__loop_0__");
  assert.equal(info.members.length, 11);
  assert.deepEqual(info.exits, [{from: "route_1", route: 0, condition: "finished == True", target: "answer"}]);
  assert.deepEqual(FL.loopHeader(info, 1e9), ["↺ repeats each turn · exits at route_1 when finished == True → answer"]);
  // narrow room: one line per fact, the compiler's cap never shown
  const lines = FL.loopHeader(info, 100);
  assert.deepEqual(lines, ["↺ repeats each turn", "exits at route_1 when finished == True → answer"]);
  assert.ok(!lines.join(" ").includes("1000"));
});

test("loop exits: END, several, none, and an authored loop's limit", () => {
  const lp = {group: "L", mode: "synthetic", max_iterations: 1000};
  const g = {nodes: [card("t", {loop: lp}),
    card("r", {loop: lp, routes: [{condition: "x >= 3", target: "__END__"}, {condition: "err", target: "bail"}, {condition: "else", target: "t"}]}),
    card("bail")], edges: []};
  const [info] = FL.loopsOf(g);
  assert.deepEqual(info.exits.map(x => x.target), ["END", "bail"]);
  assert.match(FL.loopHeader(info, 1e9)[0], /exits at r when x >= 3 → END · exits at r when err → bail/);
  const closed = {nodes: [card("a", {loop: lp}), card("b", {loop: lp})], edges: []};
  assert.deepEqual(FL.loopHeader(FL.loopsOf(closed)[0], 1e9), ["↺ repeats until no step continues"]);
  const authored = {nodes: [card("a", {loop: {group: "L", mode: "classic", max_iterations: 5}})], edges: []};
  assert.match(FL.loopHeader(FL.loopsOf(authored)[0], 1e9)[0], /max 5/);
  assert.equal(FL.loopsOf({nodes: [card("a")], edges: []}).length, 0);
});

test("the loop zone holds every member and nothing else, its header clear", () => {
  const g = react();
  for (const open of [new Set()]) {
    const out = FL.layout(g, {expanded: open, sizeOf: reactSize});
    assert.deepEqual([...problems(out), ...zoneProblems(out)], []);
    assert.equal(out.zones.length, 1);
    const z = out.zones[0];
    assert.equal(z.members.length, 11);
    const answer = out.items.find(i => i.node.name === "answer");
    assert.ok(answer.x + answer.w <= z.x || answer.x >= z.x + z.w, "answer stands outside the loop");
    // the exit route is marked, the return is not
    const exits = out.wires.filter(w => w.exit);
    assert.deepEqual(exits.map(w => w.b.node.name), ["answer"]);
    assert.ok(out.wires.find(w => w.back).label, "the return is labelled");
    // members: each item knows its zone (the inspector reads it)
    assert.ok(out.items.filter(i => i.zone === z).length === 11);
  }
  // nested inside an opened GraphOp, as the meeting-prep agents are
  const outer = {nodes: [card("pre"), card("agent", {kind: "GraphOp", graph: {...g,
    nodes: g.nodes.map(n => ({...n, id: "t.agent." + n.name})),
    edges: g.edges.map(e => ({...e, src: e.src.replace("t.", "t.agent."), dst: e.dst.replace("t.", "t.agent.")}))}}), card("post")],
    edges: [edge("pre", "agent"), edge("agent", "post"), edge("pre", "post")], entries: ["pre"], exits: ["post"]};
  const out = FL.layout(outer, {expanded: new Set(["t.agent"]), sizeOf: reactSize});
  assert.deepEqual([...problems(out), ...zoneProblems(out)], []);
  assert.equal(out.zones[0].key, "t.agent/__loop_0__");
});

// ── an opened agent: its card on the flow, its parts in a column beside it ──
const part = (agent, name, kind, extra = {}) => ({id: `${agent}.${name}`, name, kind: "FuncOp", part: kind, ...extra});

test("an opened agent: the flow runs straight through its card, its parts hang in a column right of it", () => {
  const sub = {nodes: [card("f"), card("v")], edges: [edge("f", "v")], entries: ["f"], exits: ["v"]};
  const agent = card("ag", {op_type: "agent", parts: [
    part("t.ag", "assistant", "model", {kind: "LLMOp"}), part("t.ag", "sessions", "memory"),
    part("t.ag", "search", "tool"), part("t.ag", "read", "tool", {kind: "GraphOp", graph: sub}),
  ]});
  const g = {nodes: [card("a"), agent, card("b")], edges: [edge("a", "ag"), edge("ag", "b")],
             entries: ["a"], exits: ["b"]};
  const sizeOf = (key, n) => n.op_type === "agent" ? {w: 240, h: 92} : {w: 260, h: 64};
  for (const open of [["t.ag"], ["t.ag", "t.ag/t.ag.read"]]) {
    const out = FL.layout(g, {expanded: new Set(open), sizeOf});
    assert.deepEqual(problems(out), [], open.join(","));
    const at = Object.fromEntries(out.items.map(i => [i.key, i]));
    const A = at["t.ag"], a = at["t.a"], b = at["t.b"];
    const mid = (i) => i.x + i.w / 2;
    assert.ok(Math.abs(mid(a) - mid(A)) < 0.5 && Math.abs(mid(b) - mid(A)) < 0.5, "a, the agent's card and b in one column");
    for (const w of out.wires.filter(w => w.e)) {
      const xs = sample(w.d).map(([x]) => x);
      assert.ok(Math.max(...xs) - Math.min(...xs) < 0.5, `${w.k} runs straight down`);
    }
    // the parts: socket order, top to bottom, all right of the card, none overlapping
    assert.deepEqual(out.parts.map(p => [p.part, p.item.node.name]),
      [["model", "assistant"], ["memory", "sessions"], ["tool", "search"], ["tool", "read"]]);
    const ps = out.parts.map(p => p.item);
    for (const p of ps) assert.ok(p.x >= A.x + A.w + 100, `${p.key} right of the card`);
    for (let i = 1; i < ps.length; i++) {
      const prev = ps[i - 1].box || ps[i - 1], cur = ps[i].box || ps[i];
      assert.ok(cur.y >= prev.y + prev.h + 10, `${ps[i].key} below ${ps[i - 1].key}`);
    }
    assert.ok(b.y >= Math.max(...ps.map(p => (p.box || p).y + (p.box || p).h)) + 40, "the next op is below the whole block");
    // the card stays put when a part opens
    assert.equal(A.y, FL.layout(g, {expanded: new Set(["t.ag"]), sizeOf}).items.find(i => i.key === "t.ag").y);
  }
  // opened, the graph tool is the usual container with its ops in it
  const out = FL.layout(g, {expanded: new Set(["t.ag", "t.ag/t.ag.read"]), sizeOf});
  const box = out.items.find(i => i.key === "t.ag/t.ag.read");
  assert.ok(box.inner && out.items.some(i => i.key === "t.ag/t.ag.read/t.f"));
  // folded, the agent is one card
  const folded = FL.layout(g, {expanded: new Set(), sizeOf});
  assert.equal(folded.parts.length, 0);
  assert.equal(folded.items.length, 3);
});

/* `g` with some of its plain cards made agents: a model, sometimes a
 * memory, a few tools — a graph tool, an agent tool with its own parts. */
function withAgents(R, g, depth = 0) {
  for (const n of g.nodes) {
    if (n.graph) { withAgents(R, n.graph, depth); continue; }
    if (n.routes || R() > 0.3) continue;
    n.op_type = "agent";
    const parts = [part(n.id, "model", "model", {kind: "LLMOp"})];
    if (R() < 0.5) parts.push(part(n.id, "memory", "memory"));
    const k = 1 + Math.floor(R() * 4);
    for (let i = 0; i < k; i++) {
      const roll = R();
      const p = part(n.id, `tool${i}`, "tool");
      if (roll < 0.3) p.graph = randomGraph(R, `${p.id}.`, 0, 4);
      else if (roll < 0.45 && depth < 1) { const inner = {nodes: [p]}; withAgents(() => 0, inner, depth + 1); }
      parts.push(p);
    }
    n.parts = parts;
  }
  return g;
}
const openable = (g, prefix = "", out = []) => {
  for (const n of g.nodes) {
    const key = prefix + n.id;
    if (n.graph) { out.push(key); openable(n.graph, key + "/", out); }
    else if (n.parts) { out.push(key); openable({nodes: n.parts}, key + "/", out); }
  }
  return out;
};

test("random workflows with agents, random open sets: no wire through a card, no overlap", () => {
  let agents = 0, partsSeen = 0;
  for (let seed = 1; seed <= 160; seed++) {
    const R = rng(seed * 104729);
    const g = withAgents(R, randomGraph(R, "g.", 1 + (seed % 2), 9));
    const sizeOf = sizer(R);
    const all = openable(g);
    const open = new Set(all.filter(() => R() < 0.7));
    for (const k of [...open]) {
      const bits = k.split("/");
      for (let i = 1; i < bits.length; i++) if (!open.has(bits.slice(0, i).join("/"))) open.delete(k);
    }
    const out = FL.layout(g, {expanded: open, sizeOf});
    assert.deepEqual([...problems(out), ...zoneProblems(out)], [], `seed ${seed}`);
    // no part lands on another level's card
    const cards = out.items.filter(i => !i.inner);
    for (const p of out.parts) {
      const b = p.item.box || p.item;
      for (const c of cards) {
        if (c === p.item || c.key.startsWith(p.item.key + "/")) continue;
        const hit = c.x < b.x + b.w && b.x < c.x + c.w && c.y < b.y + b.h && b.y < c.y + c.h;
        assert.ok(!hit, `seed ${seed}: ${p.item.key} on ${c.key}`);
      }
    }
    assert.deepEqual(pos(FL.layout(g, {expanded: open, sizeOf})), pos(out), `seed ${seed}: not deterministic`);
    agents += out.items.filter(i => i.parts).length;
    partsSeen += out.parts.length;
  }
  assert.ok(agents > 60 && partsSeen > 200, `${agents} agents, ${partsSeen} parts`);
});
