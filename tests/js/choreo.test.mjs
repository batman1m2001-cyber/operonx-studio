// The screen follows the assistant's work: tool items → the hand's gestures
// (static/choreo.js, docs/ALIVE_ASSISTANT_PLAN.md D3).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../operonx_studio/static/choreo.js");

const NOW = {tab: "project", page: "now"};
const PLANS = {tab: "project", page: "plans"};
const tool = (name, input, status = "running") => ({kind: "tool", name, input, status});

test("a plan's path, from any absolute path that ends in docs/…_PLAN.md", () => {
  assert.equal(C.planPath("/home/x/ow/docs/EXPORT_PLAN.md"), "docs/EXPORT_PLAN.md");
  assert.equal(C.planPath("docs/plans/A_PLAN.md"), "docs/plans/A_PLAN.md");
  assert.equal(C.planPath("/x/docs/README.md"), null);
  assert.equal(C.planPath("/x/docs/brd/X_PLAN.md"), null);
  assert.equal(C.planPath(""), null);
});

test("writing a plan goes to Plans and rings it, the page's head while it is not drawn", () => {
  const s = C.steps(tool("Write", {file_path: "/r/docs/EXPORT_PLAN.md"}), "start", NOW);
  assert.deepEqual(s, [{go: {tab: "project", page: "plans"}}, {point: "plan:docs/EXPORT_PLAN.md", words: "writing", or: "pagehead"}]);
  // already on Plans: no going
  assert.deepEqual(C.steps(tool("Edit", {file_path: "/r/docs/EXPORT_PLAN.md"}), "start", PLANS).map((x) => x.words), ["editing"]);
});

test("a plan edit that ends reads the status again, then a soft 'saved'", () => {
  const s = C.steps(tool("Edit", {file_path: "/r/docs/EXPORT_PLAN.md"}, "ok"), "end", PLANS);
  assert.deepEqual(s[0], {refresh: true});
  assert.equal(s[1].words, "saved");
  assert.equal(s[1].soft, true);
  // a failed edit changed nothing
  assert.deepEqual(C.steps(tool("Edit", {file_path: "/r/docs/EXPORT_PLAN.md"}, "error"), "end", PLANS), []);
});

test("the checklist matrix and the open questions go to their pages", () => {
  const m = C.steps(tool("Edit", {file_path: "/r/docs/brd/requirements/requirements_traceability.md"}), "start", NOW);
  assert.deepEqual(m[0], {go: {tab: "project", page: "checklist"}});
  const q = C.steps(tool("Edit", {file_path: "/r/docs/brd/requirements/open_questions.md"}), "start", NOW);
  assert.deepEqual(q[0], {go: {tab: "project", page: "questions"}});
});

test("reading moves nothing: a plan is ringed only where it already shows", () => {
  assert.deepEqual(C.steps(tool("Read", {file_path: "/r/docs/X_PLAN.md"}), "start", {tab: "flow"}), []);
  assert.deepEqual(C.steps(tool("Read", {file_path: "/r/docs/X_PLAN.md"}), "start", PLANS), [{point: "plan:docs/X_PLAN.md", words: "reading"}]);
  assert.deepEqual(C.steps(tool("Read", {file_path: "/r/app/main.py"}), "start", PLANS), []);
  assert.deepEqual(C.steps(tool("Grep", {pattern: "x"}), "start", PLANS), []);
});

test("a commit rings the changes, and the new commit once it lands", () => {
  const cmd = {command: "git add docs/X_PLAN.md && git commit -m 'plan: X'"};
  assert.deepEqual(C.steps(tool("Bash", cmd), "start", NOW), [{point: "status:changes", words: "committing"}]);
  const end = C.steps(tool("Bash", cmd, "ok"), "end", NOW);
  assert.deepEqual(end[0], {refresh: true});
  assert.equal(end[1].point, "commit:new");
  assert.deepEqual(C.steps(tool("Bash", {command: "uv run pytest -q"}), "start", NOW), [{point: "status:checklist", words: "checking"}]);
  // off Now the column is not drawn: the Project bar's icon stands for it
  assert.deepEqual(C.steps(tool("Bash", cmd), "start", PLANS), [{point: "page:changes", words: "committing"}]);
  assert.equal(C.steps(tool("Bash", cmd, "ok"), "end", PLANS)[1].or, "page:changes");
  assert.deepEqual(C.steps(tool("Bash", {command: "ls"}), "start", NOW), []);
});

test("the studio's own tools: status sweeps the column, an answer presses its option", () => {
  const sweep = C.steps(tool("mcp__studio__project_status", {}), "start", NOW);
  assert.deepEqual(sweep.map((x) => x.point), ["status:needs", "status:working", "status:checklist", "status:plans", "status:changes"]);
  assert.ok(sweep.every((x) => x.quick));
  const a = C.steps(tool("mcp__studio__board_act", {op: "answer", ref: "Q3", answer: {choice: "b"}}), "start", NOW);
  assert.deepEqual(a, [{go: {tab: "project", page: "questions"}}, {press: "qopt:Q3:b", words: "answering"}]);
  const w = C.steps(tool("mcp__studio__board_act", {op: "answer", ref: "Q3", answer: "use CSV"}), "start", NOW);
  assert.deepEqual(w[1], {point: "q:Q3", words: "answering"});
});

test("what changed between two status documents", () => {
  const before = {
    plans: [{path: "docs/A_PLAN.md", status: "in_progress", done: 1, total: 3}],
    changes: [{sha: "aaa"}],
    checklist: {open: [{id: "R-1", status: "not_started"}, {id: "R-2", status: "in_progress"}]},
  };
  const after = {
    plans: [{path: "docs/A_PLAN.md", status: "in_progress", done: 2, total: 3}, {path: "docs/B_PLAN.md", status: "plan", done: 0, total: 2}],
    changes: [{sha: "bbb"}, {sha: "aaa"}],
    checklist: {open: [{id: "R-1", status: "in_progress"}]},
  };
  assert.deepEqual(C.changed(before, after), [
    {point: "plan:docs/A_PLAN.md", words: "2/3"},
    {point: "plan:docs/B_PLAN.md", words: "new plan"},
    {point: "commit:bbb", words: "new"},
    {point: "row:R-1", words: "in progress"},
  ]);
  assert.deepEqual(C.changed(after, after), []);
  assert.deepEqual(C.changed(null, after), []);
});
