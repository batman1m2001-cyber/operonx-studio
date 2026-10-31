// The progress card's logic: what it says about a plan, and the plan the
// page makes from tool calls when none was posted
// (static/progress.js, docs/ASSISTANT_PROGRESS_PLAN.md D3, D4).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../../operonx_studio/static/progress.js");

const step = (title, state) => ({title, state});
let seq = 0;
const tool = (name, input, status = "ok", ms = 100) => ({seq: ++seq, kind: "tool", name, input: JSON.stringify(input), status, ms});

test("the head counts done steps, the bar counts skipped ones too", () => {
  const s = P.summary([step("a", "done"), step("b", "skipped"), step("c", "active"), step("d", "pending")], true);
  assert.deepEqual(s.chip, ["Executing", "run"]);
  assert.equal(s.done, 1);
  assert.equal(s.pct, 50);
  assert.equal(s.say, "Step 3 of 4: c");
});

test("the chip: failed, then needs you, then completed, then stopped", () => {
  assert.equal(P.summary([step("a", "failed"), step("b", "waiting")], true).chip[0], "Failed");
  assert.equal(P.summary([step("a", "done"), step("b", "waiting")], true).chip[0], "Needs you");
  assert.equal(P.summary([step("a", "done"), step("b", "skipped")], false).chip[0], "Completed");
  assert.equal(P.summary([step("a", "done"), step("b", "active")], false).chip[0], "Stopped");
});

test("targets read as words", () => {
  assert.equal(P.targetWords("op:score_news"), "op score_news");
  assert.equal(P.targetWords("row:OWN-EX-01"), "requirement OWN-EX-01");
  assert.equal(P.targetWords("status:needs"), "needs");
  assert.equal(P.targetWords(""), "");
});

test("without a plan, tool calls group into steps by what they did", () => {
  const steps = P.fallback([
    tool("ToolSearch", {query: "select:mcp__studio__board_card"}),           // plumbing: no step
    tool("Read", {file_path: "/p/app/ops.py"}),
    tool("Grep", {path: "/p/app/ops.py"}),
    tool("Read", {file_path: "/p/app/flow.py"}),
    tool("Edit", {file_path: "/p/app/ops.py"}),
    tool("Edit", {file_path: "/p/app/ops.py"}),
    tool("Bash", {command: "pytest -q"}, "error"),
    tool("mcp__studio__board_act", {milestone: "m1", card: "F1", action: "start"}, "running"),
  ]);
  assert.deepEqual(steps.map((s) => [s.title, s.state]), [
    ["Read 2 files", "done"], ["Edited ops.py", "done"], ["Ran the tests", "failed"], ["Moved F1", "active"]]);
  assert.equal(steps[0].seqs.length, 3);
  assert.equal(steps[1].ms, 200);
});

test("a clipped input still makes a step", () => {
  const [s] = P.fallback([{seq: 1, kind: "tool", name: "Write", input: '{"file_path": "/p/x.py", "content": "…', status: "ok"}]);
  assert.equal(s.title, "Edited files");
});
