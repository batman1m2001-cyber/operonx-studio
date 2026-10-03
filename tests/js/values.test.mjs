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

test("a $media blob by sha says what it is, and whether it plays or shows", () => {
  const sha = "9f".repeat(32);
  const a = spec({ $media: sha, mime: "audio/wav", size: 48044, duration_s: 1.5,
                   sample_rate: 16000, channels: 1, store: "local" });
  assert.equal(a.t, "media");
  assert.equal(a.sha, sha);
  assert.equal(a.kind, "audio");
  assert.equal(a.mime, "audio/wav");
  assert.equal(a.duration, "1.5 s");
  assert.equal(a.size, "46.9 KB");
  assert.equal(spec({ $media: sha, mime: "image/png", size: 10 }).kind, "image");
  // an svg can carry script: never shown inline
  assert.equal(spec({ $media: sha, mime: "image/svg+xml" }).kind, null);
  assert.equal(spec({ $media: sha, mime: "application/pdf" }).kind, null);
  // a path-style reference (the files store's) is not a blob id
  const old = spec({ $media: "media/a1.wav", mime: "audio/wav" });
  assert.equal(old.sha, undefined);
  assert.equal(old.kind, undefined);
  // nor is anything that is not 64 lowercase hex
  assert.equal(spec({ $media: "../" + sha.slice(3), mime: "audio/wav" }).sha, undefined);
});

test("a raw PCM blob declares its rate so the server can wrap it as WAV", () => {
  const sha = "ab".repeat(32);
  // operonx keeps the rate beside the bare mime
  const l16 = spec({ $media: sha, mime: "audio/L16", size: 52104, duration_s: 3.2565,
                     sample_rate: 8000, channels: 1, store: "clickhouse" });
  assert.equal(l16.kind, "audio");
  assert.equal(l16.mime, "audio/L16");
  assert.equal(l16.declared, "audio/L16;rate=8000;channels=1");
  assert.equal(l16.duration, "3.26 s");
  // channels default to one; a mime that already names its rate is kept
  assert.equal(spec({ $media: sha, mime: "audio/L16", sample_rate: 16000 }).declared,
               "audio/L16;rate=16000;channels=1");
  assert.equal(spec({ $media: sha, mime: "audio/L16;rate=16000;channels=2", sample_rate: 8000 }).declared,
               "audio/L16;rate=16000;channels=2");
  // a format with a header, or PCM with no rate, is passed as it is
  assert.equal(spec({ $media: sha, mime: "audio/wav", sample_rate: 8000 }).declared, "audio/wav");
  assert.equal(spec({ $media: sha, mime: "audio/L16" }).declared, "audio/L16");
  assert.equal(spec({ $media: sha }).declared, null);
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

test("brief: one card line per value, cut, never a payload", () => {
  const { brief } = require("../../operonx_studio/static/values.js");
  assert.equal(brief("alo em nghe ạ"), '"alo em nghe ạ"');
  assert.equal(brief("x".repeat(80), 20), '"' + "x".repeat(18) + "…");
  assert.equal(brief(42), "42");
  assert.equal(brief(true), "true");
  assert.equal(brief(null), "∅");
  assert.equal(brief({ $media_ref: "media/abc.npy", bytes: 38912 }), "media · 38.0 KB");
  assert.equal(brief({ $media_ref: "media/abc.npy" }), "media");
  assert.equal(brief({ $len: 12 }), "[12]");
  assert.equal(brief({ $keys: ["intent", "error", "a", "b"] }), "{intent, error, a, …}");
  assert.equal(brief([1, 2, 3]), "[3]");
  assert.equal(brief({ intent: "busy", error: null }), "{intent, error}");
  assert.equal(brief("A".repeat(2000)), "payload · 2.0 KB");
});
