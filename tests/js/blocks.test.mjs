// The block registry and the status vocabulary (static/blocks.js,
// docs/VISUAL_CHAT_PLAN.md D2, D3).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = require("../../operonx_studio/static/blocks.js");

// a DOM stand-in: nodes are plain objects that remember what was put in them
const ctx = {
  el: (tag, cls, text) => ({tag, cls, text, kids: [], style: {}, append(...k) { this.kids.push(...k); }}),
  codeBlock: (lang, body) => ({tag: "code", lang, body}),
};

test("status: every state the page shows has a tone, an icon and a word", () => {
  for (const k of ["done", "failed", "active", "pending", "skipped", "waiting", "blocked", "recovered", "fatal", "warning"]) {
    const s = B.status(k);
    assert.ok(s.tone && s.word, k);
    assert.ok(s.icon || s.spin, `${k} has an icon or spins`);
  }
  assert.equal(B.status("failed").tone, B.status("error").tone, "a failure looks the same wherever it comes from");
  assert.equal(B.status("active").spin, true);
  assert.equal(B.status("blocked").word, "Blocked");
  assert.equal(B.status("waiting").word, "Needs you");
});

test("status: an unknown kind is pending, not a crash", () => {
  assert.equal(B.status("weird").kind, "pending");
  assert.equal(B.status(undefined).tone, "pending");
});

test("callout: the five GitHub kinds, with or without a title", () => {
  assert.deepEqual(B.callout(["[!WARNING]", "the key is", "shared"]),
    {kind: "warning", title: "Warning", body: "the key is\nshared"});
  assert.equal(B.callout(["[!finding] Two flows write one table"]).title, "Two flows write one table");
  assert.equal(B.callout(["[!ERROR]"]).title, "Error");
  assert.equal(B.status(B.callout(["[!SUCCESS]"]).kind).tone, "ok");
  assert.equal(B.callout(["just a quote"]), null);
  assert.equal(B.callout(["[!TIP]"]), null, "an unknown kind stays a plain quote");
});

test("fence: an unregistered language is not the registry's", () => {
  assert.equal(B.fence("python", "x = 1", true, ctx), null);
});

test("fence: open → placeholder, closed and valid → render, invalid → the code and why", () => {
  B.register("ox-test", {
    validate(body) { const v = JSON.parse(body); return v.n > 0 ? {ok: true, value: v} : {ok: false, reason: "n must be positive"}; },
    render(v, c) { return c.el("div", "drawn", String(v.n)); },
  });
  const wait = B.fence("ox-test", '{"n": ', false, ctx);
  assert.equal(wait.cls, "ax-blk-wait");
  assert.match(wait.kids[1].text, /Drawing test…/);
  assert.equal(B.fence("ox-test", '{"n": 3}', true, ctx).text, "3");
  const bad = B.fence("ox-test", '{"n": 0}', true, ctx);
  assert.equal(bad.cls, "ax-blk-fail");
  assert.equal(bad.kids[0].body, '{"n": 0}', "the block as written");
  assert.equal(bad.kids[1].text, "could not draw: n must be positive");
  const broken = B.fence("ox-test", '{"n": ', true, ctx);
  assert.match(broken.kids[1].text, /^could not draw: /, "bad JSON falls back too");
});

test("fence: a renderer that throws falls back instead of breaking the reply", () => {
  B.register("ox-throws", {render() { throw new Error("boom"); }});
  assert.equal(B.fence("ox-throws", "{}", true, ctx).kids[1].text, "could not draw: boom");
});

test("item: a registered kind renders, another is left to the page", () => {
  B.register("item:probe", {render: (it, c) => c.el("div", "probe", it.text)});
  assert.equal(B.item("probe", {text: "hi"}, ctx).text, "hi");
  assert.equal(B.item("text", {text: "hi"}, ctx), null);
});
