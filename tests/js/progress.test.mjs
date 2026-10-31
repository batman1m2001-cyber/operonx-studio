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

test("the head counts done steps of a total without the skipped ones (D12)", () => {
  const s = P.summary([step("a", "done"), step("b", "skipped"), step("c", "active"), step("d", "pending")], true);
  assert.deepEqual(s.chip, ["Executing", "run"]);
  assert.deepEqual([s.done, s.n, s.pct], [1, 3, 33]);
  assert.equal(s.say, "Step 3 of 4: c");
  assert.equal(P.summary([step("a", "done"), step("b", "blocked")], true).say, "Step 2 of 2: b");
});

test("a step's facts: its calls by seq or time window, files, last run per runner, commands, progress", () => {
  const bash = (seq, command, extra) => ({seq, kind: "tool", name: "Bash", input: JSON.stringify({command}), status: "ok",
    ms: 50, created: 10 + seq, ...extra});
  const items = [
    {seq: 1, kind: "tool", name: "Edit", input: JSON.stringify({file_path: "src/a.py"}), status: "ok", created: 11},
    {seq: 2, kind: "tool", name: "Write", input: JSON.stringify({file_path: "src/new.py"}), status: "ok", created: 12},
    bash(3, "pytest -q", {status: "error", output: "Exit code 1", tests: {runner: "pytest", passed: 1, failed: 2, errors: 0, skipped: 0}}),
    bash(4, "cd x && pytest -q", {tests: {runner: "pytest", passed: 3, failed: 0, errors: 0, skipped: 1}}),
    bash(9, "ls", {created: 30}),
  ];
  const touched = new Map([["src/new.py", "created"], ["src/a.py", "modified"]]);
  const f = P.stepFacts({title: "x", started: 10, ended: 15}, [], items, touched);
  assert.deepEqual(f.calls.map((c) => c.seq), [1, 2, 3, 4], "the call at 30 is after the step ended");
  assert.deepEqual(f.files, [{path: "src/a.py", how: "modified"}, {path: "src/new.py", how: "created"}]);
  assert.equal(f.tests.length, 1);
  assert.deepEqual(f.progress, {kind: "tests", done: 3, total: 3}, "the last run, not the first");
  assert.deepEqual(f.commands.map((c) => [c.cmd, c.exit]), [["pytest -q", 1], ["pytest -q", 0]]);
  const sub = P.stepFacts({title: "y", sub: [step("a", "done"), step("b", "pending"), step("c", "skipped")]}, [9], items);
  assert.deepEqual(sub.progress, {kind: "sub", done: 1, total: 2}, "subtasks win; skipped ones leave the total");
  assert.deepEqual(sub.calls.map((c) => c.seq), [9]);
  assert.equal(P.stepFacts({title: "z"}, [], items).progress, null, "no facts, no bar");
});

test("a plan with after is a structure; without, a list", () => {
  assert.equal(P.structure([step("a", "done"), step("b", "active")]), null);
  const g = P.structure([step("a", "done"), step("b", "active"), {...step("c", "pending"), after: [1]},
    {...step("d", "pending"), after: [2, 3]}]);
  assert.deepEqual(g.edges, [{from: "s1", to: "s3"}, {from: "s2", to: "s4"}, {from: "s3", to: "s4"}]);
  assert.equal(g.direction, "down");
  assert.equal(g.nodes[1].state, "active");
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
