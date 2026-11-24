// The screen follows the assistant's work: tool items → the hand's gestures
// (static/choreo.js, docs/ALIVE_ASSISTANT_PLAN.md D3).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../operonx_studio/static/choreo.js");

const NOW = {tab: "traces"};

test("where a target lives: the screen to go to before pointing", () => {
  assert.equal(C.where("plan:docs/X_PLAN.md"), null);
  assert.equal(C.where("card:C4"), null);
  assert.deepEqual(C.where("op:stt"), {tab: "flow"});
  assert.deepEqual(C.where("run:r1"), {tab: "traces"});
  assert.equal(C.where("pagehead"), null);
});

test("on Flow, an edit to an op's file rings that op", () => {
  const ops = [{name: "count", file: "src/textstats/ops.py", fn: "count"}, {name: "clean", file: "src/textstats/ops.py", fn: "clean_text"},
               {name: "solo", file: "src/other.py", fn: "solo"}];
  const edit = (file, old, phase = "start", status = "running") => ({kind: "tool", name: "Edit", status, input: {file_path: file, old_string: old, new_string: ""}});
  assert.deepEqual(C.opSteps(edit("/r/src/textstats/ops.py", "def clean_text(s):"), "start", ops), [{point: "op:clean", words: "editing"}]);
  // a file of several ops, the edit names none: nothing to guess
  assert.deepEqual(C.opSteps(edit("/r/src/textstats/ops.py", "import re"), "start", ops), []);
  // the file's only op
  assert.deepEqual(C.opSteps(edit("/r/src/other.py", "x = 1"), "start", ops), [{point: "op:solo", words: "editing"}]);
  assert.equal(C.opSteps(edit("/r/src/other.py", "x = 1", "end", "ok"), "end", ops)[0].words, "saved");
  assert.deepEqual(C.opSteps(edit("/r/README.md", "def solo("), "start", ops), []);
  assert.deepEqual(C.opSteps({kind: "tool", name: "Read", input: {file_path: "/r/src/other.py"}}, "start", ops), []);
});

test("the screen follows the plan: a newly active step's target, then what an ended step left", () => {
  const plan = (...steps) => ({title: "t", steps: steps.map(([title, state, target]) => ({title, state, ...(target ? {target} : {})}))});
  const a = plan(["Read", "active", "op:score"], ["Ask", "pending", "run:r1"]);
  // the first plan: go to Flow and ring the op with the step's words
  assert.deepEqual(C.focus(null, a, NOW), [{go: {tab: "flow"}}, {point: "op:score", words: "Read"}]);
  // already on Flow: no going
  assert.deepEqual(C.focus(null, a, {tab: "flow"}), [{point: "op:score", words: "Read"}]);
  // the same active step again: nothing
  assert.deepEqual(C.focus(a, a, NOW), []);
  // it ends, the next needs the owner: ring what it left, then the run (already on Runs: no going)
  const b = plan(["Read", "done", "op:score"], ["Ask", "waiting", "run:r1"]);
  assert.deepEqual(C.focus(a, b, NOW),
    [{point: "op:score", words: "done", soft: true}, {point: "run:r1", words: "Ask"}]);
  // a step with no target moves nothing
  assert.deepEqual(C.focus(null, plan(["Think", "active"]), NOW), []);
});

test("an op config edit rings the op, selects it, then rings the field it changes (D6)", () => {
  const ops = [{name: "score", file: "app/ops.py", fn: "score", params: ["threshold", "model"]}];
  const edit = (status) => ({kind: "tool", name: "Edit", status, input: {file_path: "/p/app/ops.py",
    old_string: "def score(x, threshold: float = 0.5, model='a'):", new_string: "def score(x, threshold: float = 0.7, model='a'):"}});
  assert.deepEqual(C.opSteps(edit("running"), "start", ops), [
    {point: "op:score", words: "editing"}, {select: "score"}, {point: "field:score/threshold", words: "editing", or: "op:score"}]);
  assert.deepEqual(C.opSteps(edit("ok"), "end", ops), [
    {select: "score", fresh: true}, {point: "field:score/threshold", words: "saved", or: "op:score"}]);
  // code, not a setting: the op alone
  const body = {kind: "tool", name: "Edit", status: "running", input: {file_path: "/p/app/ops.py",
    old_string: "def score(x):\n    return x", new_string: "def score(x):\n    return x + 1"}};
  assert.deepEqual(C.opSteps(body, "start", ops), [{point: "op:score", words: "editing"}]);
  assert.deepEqual(C.changedParams("f(threshold == 1)", "f(threshold == 2)", ["threshold"]), []);
  assert.deepEqual(C.where("field:score/threshold"), {tab: "flow"});
  // a call-site edit in a file of several ops: the binding names the op (P7: `unpack(…, max_chars=500)` rang nothing)
  const graph = [{name: "fields", file: "app/graph.py", fn: "unpack", params: ["item", "max_chars"]},
                 {name: "out", file: "app/graph.py", fn: "render", params: ["fields"]}];
  const call = {kind: "tool", name: "Edit", status: "ok", input: {file_path: "/p/app/graph.py",
    old_string: '    fields = unpack(item=request["item"])', new_string: '    fields = unpack(item=request["item"], max_chars=500)'}};
  assert.deepEqual(C.opSteps(call, "end", graph), [
    {select: "fields", fresh: true}, {point: "field:fields/max_chars", words: "saved", or: "op:fields"}]);
});

test("a step aimed at a field selects its op first; a section setting goes to its own screen", () => {
  const a = {steps: [{title: "Raise the threshold", state: "active", target: "field:score/threshold"}]};
  assert.deepEqual(C.focus(null, a, {tab: "flow"}), [{select: "score"}, {point: "field:score/threshold", words: "Raise the threshold", or: "op:score"}]);
  assert.deepEqual(C.where("setting:retention/job"), {tab: "settings"});
  assert.deepEqual(C.where("setting:daemon"), {tab: "projectsettings"});
});
