// Pasted text, understood — pure data → data, so it runs here with no
// browser. Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../../operonx_studio/static/paste.js");

const lines = (n, f) => Array.from({length: n}, (_, i) => f(i)).join("\n");

test("a paste becomes a card past 12 lines or 2,000 characters; shorter stays inline", () => {
  assert.equal(P.isLong(lines(12, (i) => `line ${i}`)), false);
  assert.equal(P.isLong(lines(13, (i) => `line ${i}`)), true);
  assert.equal(P.isLong("x".repeat(2000)), false);
  assert.equal(P.isLong("x".repeat(2001)), true);
  assert.equal(P.isLong(lines(12, (i) => `line ${i}`) + "\n\n\n"), false, "trailing newlines do not count");
});

test("JSON becomes a card from 200 characters, even on one line", () => {
  const small = JSON.stringify({a: 1, b: [1, 2]});
  assert.equal(P.wantsCard(small), false);
  const wall = JSON.stringify(Object.fromEntries(Array.from({length: 18}, (_, i) => [`field_${i}`, {id: i}])));
  assert.equal(P.isLong(wall), false, "one line, under 2,000 characters");
  assert.equal(P.wantsCard(wall), true);
  assert.equal(P.wantsCard("x".repeat(300)), false, "a long line that is not JSON stays");
  assert.equal(P.wantsCard(lines(13, (i) => `l${i}`)), true);
});

test("JSON is validated, pretty-printed and counted", () => {
  const obj = Object.fromEntries(Array.from({length: 12}, (_, i) => [`k${i}`, {v: i, tags: ["a", "b"]}]));
  const c = P.classify(JSON.stringify(obj));
  assert.equal(c.kind, "json");
  assert.equal(c.lang, "json");
  assert.equal(c.detail, "12 keys");
  assert.equal(c.text, JSON.stringify(obj, null, 2));
  assert.equal(c.lines, c.text.split("\n").length);
  assert.equal(P.label(c), `Pasted · ${c.lines} lines · JSON`);
  assert.equal(P.classify("[1, 2, 3]").detail, "3 items");
});

test("broken JSON is not JSON", () => {
  const c = P.classify('{"a": 1,\n "b": [1, 2,\n}');
  assert.notEqual(c.kind, "json");
});

test("JSON lines are counted as records", () => {
  const c = P.classify(lines(20, (i) => JSON.stringify({i, ok: true})));
  assert.equal(c.lang, "jsonl");
  assert.equal(c.detail, "20 records");
});

test("a Python traceback is a traceback, named by its last line", () => {
  const tb = `Traceback (most recent call last):
  File "/app/main.py", line 12, in <module>
    run()
  File "/app/main.py", line 8, in run
    return 1 / 0
ZeroDivisionError: division by zero`;
  const c = P.classify(tb);
  assert.equal(c.kind, "log");
  assert.equal(c.lang, "traceback");
  assert.equal(c.detail, "ZeroDivisionError: division by zero");
});

test("a service log is a log", () => {
  const log = lines(20, (i) => `2026-09-27 10:00:${String(i).padStart(2, "0")},120 INFO call.pipeline turn ${i} ok`);
  assert.equal(P.classify(log).lang, "log");
});

test("code is recognised from simple cues", () => {
  const py = `import asyncio
from operonx import op

@op
async def scored(text: str) -> float:
    if not text:
        return 0.0
    for word in text.split():
        print(word)
    return len(text) / 100`;
  assert.equal(P.classify(py).lang, "python");

  const js = `const box = document.querySelector(".ax");
function paint(n) {
  console.log(n);
  return n * 2;
}
export default paint;`;
  assert.equal(P.classify(js).lang, "javascript");

  const ts = `export interface Turn { id: string; ms: number }
const t: Turn = { id: "a", ms: 3 };
function ms(t: Turn): number {
  return t.ms;
}`;
  assert.equal(P.classify(ts).lang, "typescript");

  const sql = `SELECT id, title
FROM sessions
WHERE archived = 0
ORDER BY updated DESC
LIMIT 20;`;
  assert.equal(P.classify(sql).lang, "sql");

  const yaml = `name: callbot
services:
  api:
    port: 9924
    replicas: 2
  worker:
    queue: calls`;
  assert.equal(P.classify(yaml).lang, "yaml");

  const toml = `[project]
name = "educa"
version = "1.2.0"
[studio.assistant]
model = "opus"`;
  assert.equal(P.classify(toml).lang, "toml");

  const sh = `$ uv sync
$ uv run pytest -q
git status && git log --oneline -3`;
  assert.equal(P.classify(sh).lang, "bash");

  const diff = `diff --git a/main.py b/main.py
@@ -1,3 +1,4 @@
+# reviewed
 import asyncio
-import os`;
  assert.equal(P.classify(diff).lang, "diff");
});

test("prose stays prose; notes with a colon are not YAML", () => {
  const prose = `Hi team,
Note: the callbot drops audio after 40 seconds on staging.
Steps: call the number, wait, speak.
Expected: it keeps listening.
Actual: silence.
Thanks!`;
  const c = P.classify(prose);
  assert.equal(c.kind, "text");
  assert.equal(c.lang, "text");
  const md = "# Plan\n\n- one\n- two\n- three";
  assert.equal(P.classify(md).lang, "markdown");
});

test("a fence outgrows any backtick run inside the body", () => {
  const body = "before\n```js\nx()\n```\nafter";
  const f = P.fence(body, "markdown");
  assert.ok(f.startsWith("````markdown\n"));
  assert.ok(f.endsWith("\n````"));
  const back = P.split(f);
  assert.equal(back.length, 1);
  assert.equal(back[0].text, body);
});

test("compose puts the blocks first, then the words; split reads it back", () => {
  const blocks = [{lang: "json", text: '{\n  "a": 1\n}'}, {lang: "python", name: "main.py", text: "print(1)"}];
  const msg = P.compose("  Why does this fail?  ", blocks);
  assert.equal(msg, '```json\n{\n  "a": 1\n}\n```\n\n```python main.py\nprint(1)\n```\n\nWhy does this fail?');
  const segs = P.split(msg);
  assert.deepEqual(segs.map((s) => s.t), ["block", "block", "text"]);
  assert.equal(segs[1].lang, "python");
  assert.equal(segs[1].name, "main.py");
  assert.equal(segs[2].text, "Why does this fail?");
  assert.equal(P.compose("only words", []), "only words");
});

test("an unclosed fence runs to the end", () => {
  const segs = P.split("look:\n```py\nx = 1\ny = 2");
  assert.equal(segs[1].t, "block");
  assert.equal(segs[1].text, "x = 1\ny = 2");
});

test("unpack turns long blocks back into cards and keeps short ones as words", () => {
  const long = lines(20, (i) => `row ${i}`);
  const msg = P.compose("explain `x`", [{lang: "log", text: long}]) + "\n\n```py\nx = 1\n```";
  const u = P.unpack(msg);
  assert.equal(u.blocks.length, 1);
  assert.equal(u.blocks[0].lang, "log");
  assert.equal(u.blocks[0].kind, "log");
  assert.equal(u.blocks[0].lines, 20);
  assert.equal(u.text, "explain `x`\n\n```py\nx = 1\n```");
});

test("loose finds a JSON wall in an old message after its lead-in words", () => {
  const obj = Object.fromEntries(Array.from({length: 20}, (_, i) => [`key${i}`, i]));
  const text = "Why is this payload rejected?\n" + JSON.stringify(obj, null, 2);
  const got = P.loose(text);
  assert.equal(got.before, "Why is this payload rejected?");
  assert.equal(got.block.lang, "json");
  assert.equal(P.loose("short words"), null);
  assert.equal(P.loose(lines(20, (i) => `We talked about item ${i} and agreed to revisit it later.`)), null);
});

test("gist: the words, else what was pasted", () => {
  const blocks = [{lang: "json", text: lines(30, (i) => `${i}`)}];
  assert.equal(P.gist(P.compose("", blocks)), "Pasted JSON · 30 lines");
  assert.equal(P.gist(P.compose("Fix the flow", blocks)), "Fix the flow");
  assert.equal(P.gist(P.compose("", [{lang: "python", name: "main.py", text: "x = 1"}])), "main.py · 1 line");
});
