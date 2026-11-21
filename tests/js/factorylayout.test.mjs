// The factory picture's layout (static/factorylayout.js): two wings, a lattice between, doors in ranks.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FL = require("../../operonx_studio/static/factorylayout.js");

/* a project of n workflows, m shared items; workflow i has i % 9 doors and reads or writes a few items */
function project(n, m) {
  const clusters = Array.from({length: n}, (_, i) => ({id: `f:w${i}`, size: 3 + (i * 37) % 110,
    doors: Array.from({length: i % 9}, (_, k) => ({id: `${k % 3 ? "s" : "j"}:w${i}d${k}`, type: k % 3 ? "service" : "job"}))}));
  const shared = Array.from({length: m}, (_, i) => ({id: `t:s${i}`}));
  const pairs = []; if (m) for (let i = 0; i < n; i++) for (let k = 0; k < 1 + i % 4; k++) {
    const dst = `t:s${(i * 7 + k * 3) % m}`, kind = k % 2 ? "reads" : "writes"; if (!pairs.some(p => p.src === `f:w${i}` && p.dst === dst && p.kind === kind)) pairs.push({src: `f:w${i}`, dst, kind}); }
  return {clusters, shared, pairs};
}
const boxes = (p, L) => p.clusters.map(c => { const a = L.at.get(c.id); return [a.x - a.a, a.y - a.rise, a.x + a.a, a.y + a.a / 2 + 6]; });
const hit = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];

for (const [n, m] of [[1, 0], [2, 1], [3, 4], [15, 16], [15, 30], [30, 40], [9, 0], [64, 9]]) {
  test(`${n} workflows, ${m} shared: everything has a place, no two platforms overlap`, () => {
    const p = project(n, m), L = FL.layout(p.clusters, p.shared, p.pairs);
    for (const c of p.clusters) assert.ok(L.at.has(c.id));
    for (const s of p.shared) assert.ok(L.at.has(s.id));
    const b = boxes(p, L);
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) assert.ok(!hit(b[i], b[j]), `${p.clusters[i].id} over ${p.clusters[j].id}`);
    for (const c of p.clusters) { const a = L.at.get(c.id); for (const s of p.shared) { const q = L.at.get(s.id); assert.ok(Math.abs(q.x - a.x) > a.a || Math.abs(q.y - a.y) > a.a / 2 + 10, `${s.id} under ${c.id}`); } }
  });
}

test("the same project gives the same picture", () => {
  const p = project(15, 16), A = FL.layout(p.clusters, p.shared, p.pairs), B = FL.layout(p.clusters, p.shared, p.pairs);
  assert.deepEqual([...A.at], [...B.at]); assert.deepEqual([...A.doors], [...B.doors]);
});

test("every door is drawn once beside its own workflow, or counted", () => {
  const p = project(15, 16); p.clusters[0].doors = Array.from({length: 50}, (_, k) => ({id: `s:big${k}`, type: "service"}));
  const L = FL.layout(p.clusters, p.shared, p.pairs);
  for (const c of p.clusters) { const drawn = c.doors.filter(d => L.doors.has(d.id));
    assert.equal(drawn.length + (L.more.get(c.id) || 0), c.doors.length);
    for (const d of drawn) assert.equal(L.doors.get(d.id).owner, c.id); }
  assert.equal(L.more.get(p.clusters[0].id), 14);
  const ds = [...L.doors.values()];
  for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) if (ds[i].owner === ds[j].owner) assert.ok(Math.hypot(ds[i].x - ds[j].x, ds[i].y - ds[j].y) > 9, "two markers on one spot");
});

test("services stand nearer the platform than jobs", () => {
  const c = {id: "f:a", size: 28, doors: [...Array.from({length: 7}, (_, k) => ({id: `s:${k}`, type: "service"})), ...Array.from({length: 6}, (_, k) => ({id: `j:${k}`, type: "job"}))]};
  const L = FL.layout([c], [{id: "t:x"}], [{src: "f:a", dst: "t:x", kind: "writes"}]), a = L.at.get("f:a");
  const far = (id) => Math.hypot(L.doors.get(id).x - a.x, L.doors.get(id).y - a.y);
  assert.ok(Math.max(...[0, 1, 2, 3, 4, 5, 6].map(k => far(`s:${k}`))) < Math.min(...[0, 1, 2, 3, 4, 5].map(k => far(`j:${k}`))) + 12);
  for (const d of L.doors.values()) assert.ok((d.x - a.x) * a.sg > 0, "a door on the inner side");
});

test("one relationship, one path: each leaves its platform at its own point", () => {
  const p = project(15, 16), L = FL.layout(p.clusters, p.shared, p.pairs);
  assert.equal(L.starts.size, p.pairs.length);
  for (const c of p.clusters) { const pts = p.pairs.filter(q => q.src === c.id).map(q => L.starts.get(q));
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 0.5); }
  const path = FL.curve({x: 0, y: 0}, {x: 100, y: 40}, 8);
  assert.equal(path.length, 49); assert.match(path.d, /^M0\.0 0\.0C/); assert.deepEqual(path[48], {x: 100, y: 40});
});

test("a panel takes the place that covers nothing", () => {
  const own = [100, 100, 200, 200], right = [222, 60, 420, 260];
  const a = FL.placePanel(own, [], 120, 90, [0, 0, 1000, 800]); assert.equal(a.left, false); assert.equal(a.x, 222);
  const b = FL.placePanel(own, [right], 120, 90, [0, 0, 1000, 800]); assert.equal(b.score < 400, true); assert.ok(b.rect[2] <= right[0] || b.rect[0] >= right[2] || b.rect[3] <= right[1] || b.rect[1] >= right[3]);
});

test("prisms say scale, not a count", () => {
  assert.equal(FL.prismsOf(3), 2); assert.equal(FL.prismsOf(114), 7); assert.equal(FL.prismsOf(5000), 7); assert.equal(FL.prismsOf(1), 1);
});
