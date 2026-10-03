// The I/O renderer's pure layer: the prompt is rendered with LLMOp's own
// rule (str.format_map, one pass), so these pin Python's behaviour.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pyRepr, pyFormat, chatOf, replyOf, jsonish, segments, contentParts } =
  require("../../operonx_studio/static/io.js");

test("repr matches Python for JSON values", () => {
  assert.equal(pyRepr({ a: 1, b: [true, null, "x"] }), "{'a': 1, 'b': [True, None, 'x']}");
  assert.equal(pyRepr("it's"), `"it's"`);
  assert.equal(pyRepr(`it's "q"`), `'it\\'s "q"'`);
  assert.equal(pyRepr("a\nb"), "'a\\nb'");
  assert.equal(pyRepr(0.5), "0.5");
  assert.equal(pyRepr(1e21), "1e+21");
});

test("format: one pass, escapes, attributes, conversions", () => {
  const vars = { name: "Minh", d: { k: [10, 20] }, sys: 'say {"intent": "x"}' };
  assert.equal(pyFormat("hi {name}", vars).text, "hi Minh");
  assert.equal(pyFormat("{{literal}} {name}", vars).text, "{literal} Minh");
  assert.equal(pyFormat("{d[k][1]}", vars).text, "20");
  assert.equal(pyFormat("{name!r}", vars).text, "'Minh'");
  assert.equal(pyFormat("{d}", vars).text, "{'k': [10, 20]}");
  // a value's own braces are never formatted again
  assert.equal(pyFormat("{sys}", vars).text, 'say {"intent": "x"}');
});

test("format: an unrecorded variable stays visible, never guessed", () => {
  const f = pyFormat("a {gone} b {st}", { st: { $unserializable: "AgentState" } });
  assert.deepEqual(f.missing, ["gone", "st"]);
  assert.equal(f.text, "a {gone} b {st}");
  assert.deepEqual(f.parts.map((p) => p.t), ["text", "missing", "text", "missing"]);
});

test("chatOf renders a prompt= template like LLMOp", () => {
  const c = chatOf({
    prompt: { system: "{sys}", user: "Customer said: {text}" },
    temperature: 0, sys: "You classify.", text: "bận lắm", unused: 1,
  });
  assert.equal(c.source, "rendered");
  assert.deepEqual(c.messages.map((m) => [m.role, m.content]),
    [["system", "You classify."], ["user", "Customer said: bận lắm"]]);
  assert.deepEqual(Object.keys(c.used).sort(), ["sys", "text"]);
  assert.deepEqual(Object.keys(c.extra), ["unused"]);
  assert.deepEqual(c.knobs, { temperature: 0 });
});

test("chatOf: a string prompt is one user message; messages= are recorded", () => {
  assert.deepEqual(chatOf({ prompt: "Q: {q}", q: "2+2" }).messages.map((m) => m.content), ["Q: 2+2"]);
  const rec = chatOf({ messages: [{ role: "user", content: "hi" }], temperature: 1 });
  assert.equal(rec.source, "recorded");
  assert.equal(rec.messages.length, 1);
  assert.equal(chatOf({ text: "not a chat" }), null);
  assert.equal(chatOf({ prompt: { foo: "x" } }), null);
});

test("replyOf separates the reply, its facts and the parsed fields", () => {
  const r = replyOf({
    role: "assistant", content: '{"intent": "busy"}', finish_reason: "stop", model_used: "inhouse",
    tool_calls: [], usage: { prompt_tokens: 6395, completion_tokens: 7 }, cost_usd: 0,
    extras: { thinking_content: null }, intent: "busy", error: null,
  });
  assert.equal(r.model, "inhouse");
  assert.deepEqual(r.rest, { intent: "busy" });
  assert.equal(r.priced, true);
  assert.equal(replyOf({ transcript: "x" }), null);
});

test("jsonish unwraps fences and refuses prose", () => {
  assert.deepEqual(jsonish('{"a": 1}'), { a: 1 });
  assert.deepEqual(jsonish('```json\n[1, 2]\n```'), [1, 2]);
  assert.equal(jsonish("{not json}"), undefined);
  assert.equal(jsonish("plain"), undefined);
  assert.equal(jsonish("42"), undefined);
});

test("segments split fenced code out of prose", () => {
  const s = segments("before\n```py\nx = 1\n```\nafter");
  assert.deepEqual(s.map((g) => g.t), ["text", "code", "text"]);
  assert.equal(s[1].lang, "py");
  assert.equal(s[1].text, "x = 1");
});

test("content blocks: text, image, media", () => {
  const p = contentParts([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "https://x/y.png" } },
    { type: "image_url", image_url: { url: { $media: "a".repeat(64), mime: "image/png" } } },
  ]);
  assert.deepEqual(p.map((x) => x.t), ["text", "image", "media"]);
});
