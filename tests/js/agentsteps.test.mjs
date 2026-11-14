// An agent op's steps: how each looks, and the ops a run ran at its root.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rootOps, visual } = require("../../operonx_studio/static/agentsteps.js");

test("a run matches its graph on its root ops, not its steps", () => {
  assert.deepEqual(rootOps({ops: {a: {}, turn: {}, model: {}}, root_ops: ["a"]}), ["a"]);
  // a run recorded before the server said so: every op
  assert.deepEqual(rootOps({ops: {a: {}, b: {}}}), ["a", "b"]);
});

test("each step looks like its type", () => {
  assert.equal(visual("llm").icon, "✧");
  assert.equal(visual("tool").label, "tool call");
  assert.equal(visual("code"), null);
});
