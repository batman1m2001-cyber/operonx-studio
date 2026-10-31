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
    checklist: {open: [{id: "R-1", status: "in_progress"}, {id: "R-9", status: "planned"}]},
  };
  assert.deepEqual(C.changed(before, after), [
    {point: "plan:docs/A_PLAN.md", words: "2/3"},
    {point: "plan:docs/B_PLAN.md", words: "new plan"},
    {point: "commit:bbb", words: "new"},
    {point: "row:R-1", words: "in progress"},
  ]);
  // a row the turn added is lit too (cut at four: the newest first come from the plans and commits)
  assert.deepEqual(C.changed({...before, plans: after.plans, changes: after.changes}, after),
    [{point: "row:R-1", words: "in progress"}, {point: "row:R-9", words: "new"}, {point: "status:checklist", words: "1 closed"}]);
  assert.deepEqual(C.changed(after, after), []);
  assert.deepEqual(C.changed(null, after), []);
});

test("where a target lives: the page to go to before pointing", () => {
  assert.deepEqual(C.where("q:Q-16"), {tab: "project", page: "questions"});
  assert.deepEqual(C.where("phase:docs/X_PLAN.md#P2"), {tab: "project", page: "plans"});
  assert.deepEqual(C.where("commit:abc"), {tab: "project", page: "changes"});
  assert.deepEqual(C.where("status:needs"), {tab: "project", page: "now"});
  assert.deepEqual(C.where("op:stt"), {tab: "flow"});
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

// A real Sonnet turn on a OneWealth clone (2026-10-23) wrote every file with the shell, and the page got each
// tool's input as the server clipped it: JSON text, cut short after 4000 characters.
test("the shell: a heredoc into a plan, sed -i on the matrix, git -c … commit; inputs as clipped JSON text", () => {
  const bash = (command, clip) => {
    const text = JSON.stringify({command});
    return {kind: "tool", name: "Bash", status: "running", input: clip ? text.slice(0, clip) + "\n… (900 more characters)" : text};
  };
  const heredoc = bash("cd /x/pm/ow && cat > docs/CSV_EXPORT_PLAN.md <<'EOF'\n---\ntitle: CSV export\nstatus: plan\n" + "x".repeat(200), 120);
  assert.equal(C.inputOf(heredoc).command.slice(0, 16), "cd /x/pm/ow && c");
  assert.deepEqual(C.steps(heredoc, "start", NOW),
    [{go: {tab: "project", page: "plans"}}, {point: "plan:docs/CSV_EXPORT_PLAN.md", words: "editing", or: "pagehead"}]);
  const sed = bash("sed -i 's/| 120 |/| 123 |/' docs/brd/requirements/requirements_traceability.md && uv run python scripts/check_brd_docs.py");
  assert.deepEqual(C.steps(sed, "start", NOW).slice(0, 2), [{go: {tab: "project", page: "checklist"}}, {point: "page:checklist", words: "editing rows"}]);
  const commit = bash("git add docs/CSV_EXPORT_PLAN.md docs/brd/requirements/requirements_traceability.md && git -c user.email=a@b -c user.name=a commit -q -m 'plan'");
  assert.deepEqual(C.steps(commit, "start", NOW), [{point: "status:changes", words: "committing"}]);
  // reading with the shell moves nothing; a bare name after `cd docs` is still the plan
  assert.deepEqual(C.steps(bash("cd docs && head -20 WEALTH_NAMES_PLAN.md 2>/dev/null"), "start", NOW), []);
  assert.deepEqual(C.steps(bash("cd docs && head -20 WEALTH_NAMES_PLAN.md"), "start", PLANS), [{point: "plan:docs/WEALTH_NAMES_PLAN.md", words: "reading"}]);
  assert.deepEqual(C.steps(bash("grep -q x docs/A_PLAN.md >/dev/null"), "start", NOW), []);
  // an Edit's input clipped mid-string still names its file
  const edit = {kind: "tool", name: "Edit", status: "running", input: '{"file_path": "/r/docs/X_PLAN.md", "old_string": "abc'};
  assert.equal(C.steps(edit, "start", PLANS)[0].point, "plan:docs/X_PLAN.md");
  // an answer through board_act, as text
  const ans = {kind: "tool", name: "mcp__studio__board_act", status: "running", input: '{"op": "answer", "ref": "Q3", "answer": {"choice": "b", "text": ""}}'};
  assert.equal(C.steps(ans, "start", NOW)[1].press, "qopt:Q3:b");
});

test("the screen follows the plan: a newly active step's target, then what an ended step left", () => {
  const plan = (...steps) => ({title: "t", steps: steps.map(([title, state, target]) => ({title, state, ...(target ? {target} : {})}))});
  const a = plan(["Read", "active", "op:score"], ["Ask", "pending", "q:Q-3"]);
  // the first plan: go to Flow and ring the op with the step's words
  assert.deepEqual(C.focus(null, a, NOW), [{go: {tab: "flow"}}, {point: "op:score", words: "Read"}]);
  // already on Flow: no going
  assert.deepEqual(C.focus(null, a, {tab: "flow"}), [{point: "op:score", words: "Read"}]);
  // the same active step again: nothing
  assert.deepEqual(C.focus(a, a, NOW), []);
  // it ends, the next needs the owner: ring what it left, then the question
  const b = plan(["Read", "done", "op:score"], ["Ask", "waiting", "q:Q-3"]);
  assert.deepEqual(C.focus(a, b, {tab: "project", page: "questions"}),
    [{point: "op:score", words: "done", soft: true}, {point: "q:Q-3", words: "Ask"}]);
  // a step with no target moves nothing
  assert.deepEqual(C.focus(null, plan(["Think", "active"]), NOW), []);
});
