// The value renderer's spec layer — pure data → data, so it runs here
// with no browser. Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { spec, fmtBytes, looksPayload } = require("../../operonx_studio/static/values.js");

test("scalars are inline tokens, typed", () => {
  assert.deepEqual(spec(null), { t: "token", cls: "null", text: "null" });
  assert.deepEqual(spec(true), { t: "token", cls: "bool", text: "true" });
  assert.equal(spec(42).text, "42");
  assert.equal(spec(0.30000001).cls, "num");
});

test("short strings stay inline; long strings clamp with their size", () => {
  assert.deepEqual(spec("alo"), { t: "str", text: "alo" });
  const long = "x".repeat(500);
  const s = spec(long);
  assert.equal(s.t, "longstr");
  assert.equal(s.full, long);
  assert.equal(s.size, "500 B");
});

test("a base64 wall becomes a size token, never a dump", () => {
  const wall = "QUJD".repeat(1000); // 4000 chars of clean base64
  assert.ok(looksPayload(wall));
  const s = spec(wall);
  assert.equal(s.t, "payload");
  assert.equal(s.size, "3.9 KB");
  // prose of the same length is NOT a payload — spaces and punctuation
  const prose = ("lorem ipsum, dolor! ").repeat(300);
  assert.equal(spec(prose).t, "longstr");
});

test("consumer markers render as tokens", () => {
  assert.equal(spec({ $unserializable: "Event" }).t, "unser");
  const m = spec({ $media: "media/a1.wav", bytes: 23000 });
  assert.equal(m.t, "media");
  assert.equal(m.size, "22.5 KB");
});

test("arrays carry a count and a scalar preview", () => {
  const s = spec([1, 2, 3, 4, 5]);
  assert.equal(s.count, 5);
  assert.equal(s.preview.length, 3);
  const mixed = spec([{ a: 1 }, 2]);
  assert.equal(mixed.preview, null, "objects disable the inline preview");
});

test("objects sort priority keys first", () => {
  const s = spec({ zeta: 1, transcript: "alo", alpha: 2 },
                 { priority: ["transcript"] });
  assert.deepEqual(s.children.map(([k]) => k), ["transcript", "zeta", "alpha"]);
});

test("depth is bounded", () => {
  let v = 0;
  for (let i = 0; i < 20; i++) v = { deep: v };
  const flat = JSON.stringify(spec(v));
  assert.ok(flat.includes("…deep"));
});

test("fmtBytes", () => {
  assert.equal(fmtBytes(10), "10 B");
  assert.equal(fmtBytes(2048), "2.0 KB");
  assert.equal(fmtBytes(3 * 1024 * 1024), "3.0 MB");
});
