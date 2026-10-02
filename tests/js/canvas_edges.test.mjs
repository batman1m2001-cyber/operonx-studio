// The flow canvas's wire geometry — studio.js is a browser script, so the
// pure functions under test are lifted out of its source by name and run
// here without a DOM.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../../operonx_studio/static/studio.js", import.meta.url), "utf8");

// one top-level declaration, by brace matching from its first line
function lift(name) {
  const m = new RegExp(`^(function ${name}\\(|const ${name} =|let ${name} =)`, "m").exec(SRC);
  if (!m) throw new Error(`studio.js has no ${name}`);
  let i = SRC.indexOf("{", m.index), depth = 0;
  const lineEnd = SRC.indexOf("\n", m.index);
  if (i > lineEnd && !m[1].startsWith("function")) return SRC.slice(m.index, lineEnd);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) break;
  }
  const end = SRC.indexOf("\n", i);
  return SRC.slice(m.index, end < 0 ? SRC.length : end);
}

const NAMES = ["portCX", "_lanes", "_hits", "_cubic", "_sampleCubic", "_vFree", "_clearLaneX", "_rects",
  "sLane", "pathSampler", "_pathHits", "bezier", "routeAvoiding", "returnRoute", "returnPath",
  "rowDot", "rowWirePath", "hangUnderOpened"];
const G = new Function(NAMES.map(lift).join("\n")
  + `\nreturn {${NAMES.join(", ")}, reset: () => { _lanes = {v: []}; }};`)();

const card = (key, x, y, w = 260, h = 72) => ({key, x, y, w, h, node: {id: key, name: key, kind: "op"}});
const ends = (d) => {
  const s = G.pathSampler(d);
  const a = s.at(0), b = s.at(s.len);
  return [[a.x, a.y], [b.x, b.y]];
};

test("single anchor: every wire into a plain card lands on the same point", () => {
  G.reset();
  const t = card("t", 400, 600);
  const srcs = [card("a", 40, 300), card("b", 400, 300), card("c", 760, 300), card("d", 1100, 100)];
  const obstacles = [t, ...srcs];
  const landing = new Set(), leaving = [];
  for (const s of srcs) {
    const [p0, p1] = ends(G.routeAvoiding(s, t, obstacles));
    landing.add(p1.map(Math.round).join(","));
    leaving.push([p0, s]);
  }
  assert.deepEqual([...landing], [`${400 + 130},600`]);
  // ...and every wire leaves its source's single bottom-centre port
  for (const [p0, s] of leaving) assert.deepEqual(p0.map(Math.round), [s.x + 130, s.y + 72]);
});

test("single anchor: a long edge down its lane still starts and ends at the ports", () => {
  G.reset();
  const a = card("a", 300, 40), mid = card("m", 300, 240), t = card("t", 300, 440);
  const lane = 300 + 260 + 30;
  const d = G.routeAvoiding(a, t, [a, mid, t], [lane]);
  const [p0, p1] = ends(d);
  assert.deepEqual(p0.map(Math.round), [430, 112]);
  assert.deepEqual(p1.map(Math.round), [430, 440]);
  assert.equal(G._pathHits(d, G._rects([a, mid, t], a, t)), false, "the lane keeps it off the middle card");
});

test("routes of one branch into one target under the card: one lane each", () => {
  const A = card("r", 300, 40, 260, 140);
  const port = (y) => ({x: 260, y, side: 1});
  const xs = [0, 1, 2].map(k => {
    const d = G.rowWirePath(A, port(60 + 20 * k), 430, 400, 1 - 0.55 * k / 2, k);
    const s = G.pathSampler(d);
    // where each wire runs down beside the card
    let maxX = -Infinity;
    for (let v = 0; v <= s.len; v += 4) maxX = Math.max(maxX, s.at(v).x);
    return Math.round(maxX);
  });
  assert.equal(new Set(xs).size, 3, `three distinct lanes, got ${xs}`);
  assert.deepEqual([...xs].sort((p, q) => p - q), xs, "in route order");
});

test("a loop's return goes around an opened subgraph inside the loop", () => {
  const first = card("z", 300, 40), last = card("again", 300, 900);
  const sub = {...card("tl", 60, 400, 720, 300), inner: {}};
  const rects = G._rects([first, sub, last], last, first);
  const d = G.returnPath(last, first, null, rects);
  assert.equal(G._pathHits(d, rects), false);
  const [p0, p1] = ends(d);
  assert.deepEqual(p0.map(Math.round), [560, 936]);
  assert.deepEqual(p1.map(Math.round), [560, 76]);
});

test("a loop's return with nothing in its way keeps its plain bow", () => {
  const first = card("a", 300, 40), last = card("b", 300, 240);
  const d = G.returnPath(last, first, null, G._rects([first, last], last, first));
  assert.match(d, /^M 560 276 C [\d.]+ 276, [\d.]+ 76, 560 76$/);
});

test("nothing opened: hanging under opened cards moves nothing (collapse restores)", () => {
  const items = [card("a", 48, 48), card("b", 400, 200), card("c", 48, 400)];
  const before = JSON.stringify(items);
  assert.equal(G.hangUnderOpened(items, [{src: "a", dst: "b"}, {src: "b", dst: "c"}]), 0);
  assert.equal(JSON.stringify(items), before);
});

test("an opened card keeps the order of unrelated cards in every row", () => {
  const items = [
    card("top", 400, 48),
    {...card("box", 48, 200, 900, 500), inner: {}}, card("side", 1000, 200),
    card("u1", 48, 800), card("u2", 400, 800), card("u3", 752, 800),
  ];
  const edges = [{src: "top", dst: "box"}, {src: "top", dst: "side"},
                 {src: "box", dst: "u2"}, {src: "side", dst: "u3"}];
  const order = (its) => its.filter(i => i.y === 800).sort((p, q) => p.x - q.x).map(i => i.key);
  const pre = order(items);
  G.hangUnderOpened(items, edges);
  assert.deepEqual(order(items), pre);
  // the row stays apart: no two cards overlap
  const row = items.filter(i => i.y === 800).sort((p, q) => p.x - q.x);
  for (let k = 1; k < row.length; k++) assert.ok(row[k].x >= row[k - 1].x + row[k - 1].w);
  assert.equal(Math.min(...items.map(i => i.x)), 48, "the leftmost card sits at the margin");
});

test("an opened stack does not leave an empty margin on its left", () => {
  const items = [{...card("l1", 2574, 48, 2128, 3000), inner: {}}, card("d", 3509, 3254),
                 {...card("l2", 3223, 3543, 830, 2000), inner: {}}];
  const dx = G.hangUnderOpened(items, [{src: "l1", dst: "d"}, {src: "d", dst: "l2"}]);
  assert.equal(Math.min(...items.map(i => i.x)), 48);
  assert.ok(dx < 0);
});
