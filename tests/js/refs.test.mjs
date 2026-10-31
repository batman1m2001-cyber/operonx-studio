// What the assistant's text names (static/refs.js, docs/VISUAL_CHAT_PLAN.md D4).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../../operonx_studio/static/refs.js");

const world = {
  files: R.index(["app.py", "src/flows/triage.py", "src/flows/route.py", "tests/test_triage.py", "a/util.py", "b/util.py",
    "docs/MAIL_PLAN.md", "operonx.toml"]),
  root: "/home/me/proj",
  ops: new Set(["triage", "route"]),
  points: new Map([["MPO-REQ-INBOX-01", "row:MPO-REQ-INBOX-01"], ["Q-16", "q:Q-16"], ["docs/MAIL_PLAN.md", "plan:docs/MAIL_PLAN.md"]]),
  touched: new Map([["src/flows/triage.py", "modified"]]),
};

test("file: a path in the tree, with a line, a range, a #L anchor, an absolute path or a unique base name", () => {
  assert.deepEqual(R.classify("app.py", world), {kind: "file", path: "app.py", line: 0, end: 0, touch: ""});
  assert.equal(R.classify("app.py:42", world).line, 42);
  assert.deepEqual([R.classify("app.py:42-50", world).line, R.classify("app.py:42-50", world).end], [42, 50]);
  assert.equal(R.classify("app.py#L7", world).line, 7);
  assert.equal(R.classify("/home/me/proj/app.py", world).path, "app.py");
  assert.equal(R.classify("./app.py", world).path, "app.py");
  assert.equal(R.classify("triage.py", world).path, "src/flows/triage.py");
  assert.equal(R.classify("flows/route.py:3", world).path, "src/flows/route.py");
});

test("file: nothing is guessed — a missing path or an ambiguous name stays code", () => {
  assert.equal(R.classify("nope.py", world).kind, "code");
  assert.equal(R.classify("util.py", world).kind, "code", "two files are named util.py");
  assert.equal(R.classify("a/util.py", world).kind, "file");
});

test("file: what this turn did to it rides along", () => {
  assert.equal(R.classify("triage.py", world).touch, "modified");
  assert.equal(R.classify("app.py", world).touch, "");
});

test("file: outside a project, the paths this turn's tools used are the tree", () => {
  const w = {files: null, touched: new Map([["src/x.py", "read"]])};
  assert.equal(R.classify("src/x.py:3", w).path, "src/x.py");
  assert.equal(R.classify("src/y.py", w).kind, "code");
});

test("points and ops resolve against real state, before shape", () => {
  assert.deepEqual(R.classify("Q-16", world), {kind: "point", target: "q:Q-16"});
  assert.equal(R.classify("docs/MAIL_PLAN.md", world).target, "plan:docs/MAIL_PLAN.md", "a plan is a point, not just a file");
  assert.equal(R.classify("Q-17", world).kind, "code");
  assert.deepEqual(R.classify("triage", world), {kind: "op", name: "triage"});
  assert.equal(R.classify("triage()", world).kind, "op");
});

test("shape: commands, config keys, symbols", () => {
  assert.equal(R.classify("pytest -q tests/", world).kind, "command");
  assert.equal(R.classify("git status", world).kind, "command");
  assert.equal(R.classify("foo --all", world).kind, "command");
  assert.equal(R.classify("OPENAI_API_KEY=", world).kind, "config");
  assert.equal(R.classify("studio.port", world, "set studio.port in operonx.toml").kind, "config");
  assert.equal(R.classify("studio.port", world, "the port").kind, "code", "no toml named: not a config key");
  assert.equal(R.classify("load_declared()", world).kind, "symbol");
  assert.equal(R.classify("Manifest.from_file", world).kind, "symbol");
  assert.equal(R.classify("ProjectMode", world).kind, "symbol");
  assert.equal(R.classify("lane", world).kind, "code");
});

test("fileHref: studio:file links", () => {
  assert.deepEqual(R.fileHref("studio:file/src/a.py#L42"), {path: "src/a.py", line: 42, end: 0});
  assert.deepEqual(R.fileHref("studio:file/a.py#L4-L9"), {path: "a.py", line: 4, end: 9});
  assert.deepEqual(R.fileHref("studio:file/a%20b.py"), {path: "a b.py", line: 0, end: 0});
  assert.equal(R.fileHref("studio:op/x"), null);
});

test("touched: reads, edits and the changes item, the strongest wins; failed calls do not count", () => {
  const t = R.touched([
    {kind: "tool", name: "Read", status: "ok", input: JSON.stringify({file_path: "/home/me/proj/app.py"})},
    {kind: "tool", name: "Edit", status: "ok", input: {file_path: "/home/me/proj/app.py"}},
    {kind: "tool", name: "Read", status: "error", input: {file_path: "/home/me/proj/gone.py"}},
    {kind: "changes", files: [{path: "new.py", new: true}, {path: "old.py", deleted: true}]},
  ], "/home/me/proj");
  assert.equal(t.get("app.py"), "modified");
  assert.equal(t.has("gone.py"), false);
  assert.equal(t.get("new.py"), "created");
  assert.equal(t.get("old.py"), "deleted");
});
