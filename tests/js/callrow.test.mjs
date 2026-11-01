// A running shell call's row (static/callrow.js, docs/EXECUTION_PROGRESS_PLAN.md D3–D5).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../operonx_studio/static/callrow.js");

const run = (progress, extra) => ({seq: 4, kind: "tool", name: "Bash", label: "pytest -q", status: "running", t0: 1000,
  progress, ...extra});

test("an event is taken only while the call runs, and only when newer", () => {
  const item = run({rev: 3, mode: "indeterminate"});
  assert.equal(C.accept(item, {rev: 4, progress: {}}), true);
  assert.equal(C.accept(item, {rev: 3, progress: {}}), false);
  assert.equal(C.accept(item, {rev: 2, progress: {}}), false);
  assert.equal(C.accept({...item, status: "ok"}, {rev: 9, progress: {}}), false);
  assert.equal(C.accept(run(undefined), {rev: 1, progress: {}}), true);
  assert.equal(C.accept(undefined, {rev: 1, progress: {}}), false);
});

test("a bar only with a total or a percentage; a count alone is not one", () => {
  const m = C.view(run({mode: "measured", current: 312, total: 570, pct: 54, unit: "tests"}), 1010);
  assert.deepEqual(m.bar, {kind: "measured", pct: 54});
  assert.equal(m.counter, "312 / 570 tests");
  assert.equal(m.elapsed, 10);
  const i = C.view(run({mode: "indeterminate", current: 412, unit: "modules", activity: "transforming"}), 1010);
  assert.equal(i.bar, null);
  assert.equal(i.counter, "412 modules");
  assert.equal(i.activity, "transforming");
  assert.equal(C.view(run({mode: "measured", pct: 37, unit: "%"}), 1010).counter, null);
});

test("an estimate fills by the last run's time and holds short of the end when late", () => {
  const e = C.view(run({mode: "estimated", est_ms: 80000}), 1040);
  assert.deepEqual([e.bar.kind, e.bar.pct, e.bar.last, e.bar.over], ["estimated", 50, "1:20", false]);
  const late = C.view(run({mode: "estimated", est_ms: 80000}), 1200);
  assert.deepEqual([late.bar.pct, late.bar.over], [95, true]);
});

test("the liveness chip: nothing while active, words for the rest", () => {
  const at = (live) => C.view(run({mode: "indeterminate", live}), 1300).chip;
  assert.equal(at({state: "active"}), null);
  assert.deepEqual(at({state: "busy", since: 1270}), {tone: "busy", text: "working · no output for 30 s"});
  assert.deepEqual(at({state: "idle", since: 1210}), {tone: "idle", text: "waiting · no output or CPU for 1:30"});
  assert.equal(at({state: "stalled", since: 1100}).text, "may be stuck · nothing for 3:20");
  assert.equal(at({state: "ended"}).text, "finished, waiting for the result");
});

test("stages: times from the markers, the active one named", () => {
  const v = C.view(run({mode: "indeterminate", stage: 2, stages: [
    {title: "ruff check .", state: "done", t0: 1000, t1: 1003.5},
    {title: "pytest -q", state: "active", t0: 1003.5, current: 3, unit: "tests"},
    {title: "git status", state: "pending"},
  ]}), 1010);
  assert.deepEqual(v.stages.map((s) => [s.state, s.ms]), [["done", 3500], ["active", 6500], ["pending", null]]);
  assert.equal(v.stage, "pytest -q");
});

test("the status line says running or waiting, the stage (not the whole chain), and the count", () => {
  const p = {mode: "measured", current: 312, total: 570, pct: 54, unit: "tests"};
  assert.equal(C.status(run(p), 1010), "Running · pytest -q · 312 / 570 tests");
  assert.equal(C.status(run(p, {task: "b7x"}), 1010), "Waiting · pytest -q · 312 / 570 tests");
  assert.equal(C.status(run({mode: "measured", pct: 37, unit: "%"}, {label: "curl -O x"}), 1010), "Running · curl -O x · 37%");
  assert.equal(C.status(run({mode: "indeterminate", stages: [{id: "part1", title: "uv sync", state: "active", t0: 1000}]},
    {label: "uv sync && pytest"}), 1010), "Running · uv sync");
  assert.equal(C.status(run({mode: "estimated", est_ms: 80000, stages: [{id: "prepare", title: "Download", state: "active"}]},
    {label: "uv sync"}), 1010), "Running · uv sync · Download");
});

test("a running call's test counts become the live report the page already draws", () => {
  const item = C.bridge(run({mode: "measured", pct: 60, tests: {passed: 2, failed: 1, skipped: 0, errors: 0, runner: "pytest"}}));
  assert.deepEqual(item.tests, {passed: 2, failed: 1, skipped: 0, errors: 0, runner: "pytest", live: true, pct: 60});
  const done = C.bridge({...run({tests: {passed: 1}}), status: "ok", tests: {passed: 5}});
  assert.deepEqual(done.tests, {passed: 5});
});
