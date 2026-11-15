// The minimap's model: boxes scaled into a small picture, the view framed.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Minimap = createRequire(import.meta.url)("../../operonx_studio/static/minimap.js");

const content = {minX: 0, minY: 0, maxX: 1000, maxY: 2000};
const boxes = [{x: 0, y: 0, w: 200, h: 50, kind: "a"}, {x: 800, y: 1950, w: 200, h: 50, kind: "b"},
               {x: 100, y: 500, w: 600, h: 400, zone: true}];

test("the picture keeps the flow's proportions inside its limits", () => {
  const m = Minimap.model(boxes, content, {x: 0, y: 0, w: 1000, h: 800});
  assert.ok(m.w <= 208 && m.h <= 148);
  assert.ok(Math.abs((m.h - 16) / (m.w - 16) - 2) < 0.1, "tall content stays tall");
  for (const r of m.rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= m.w + 1 && r.y + r.h <= m.h + 1);
  assert.equal(m.rects[2].zone, true);
});

test("the view is framed where it is, clipped to the picture", () => {
  const m = Minimap.model(boxes, content, {x: -300, y: 1000, w: 5000, h: 500});
  assert.equal(m.view.x, 0);
  assert.ok(m.view.w <= m.w);
  assert.ok(Math.abs(m.view.y - (8 + 1000 * m.k)) < 1e-6);
});

test("a flow that is all on screen needs no minimap", () => {
  assert.equal(Minimap.model(boxes, content, {x: -10, y: -10, w: 1100, h: 2100}).fits, true);
  assert.equal(Minimap.model(boxes, content, {x: 0, y: 0, w: 1000, h: 800}).fits, false);
});

test("a point of the picture maps back to the canvas", () => {
  const m = Minimap.model(boxes, content, {x: 0, y: 0, w: 1000, h: 800});
  const p = m.at(8 + 500 * m.k, 8 + 1000 * m.k);
  assert.ok(Math.abs(p.x - 500) < 1e-6 && Math.abs(p.y - 1000) < 1e-6);
});
