// What a tool call did (static/tools.js, docs/VISUAL_CHAT_PLAN.md D5).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../../operonx_studio/static/tools.js");

const bash = (command) => ({kind: "tool", name: "Bash", status: "ok", input: JSON.stringify({command})});
const cls = (item, touched) => T.classOf(item, touched).cls;

test("classes from the tool's name", () => {
  assert.equal(cls({name: "Read", input: {file_path: "/p/a.py"}}), "read");
  assert.equal(cls({name: "MultiEdit", input: {file_path: "/p/a.py"}}), "edit");
  assert.equal(cls({name: "Grep", input: {pattern: "lane"}}), "search");
  assert.equal(cls({name: "WebFetch", input: {url: "https://x.dev"}}), "web");
  assert.equal(cls({name: "mcp__studio__board_act", input: {card: "F1"}}), "studio");
  assert.equal(cls({name: "ToolSearch", input: {}}), "plumbing");
  assert.equal(cls({name: "Agent", input: {}}), "tool");
});

test("a Write is a create only when the turn's facts say the file is new", () => {
  const w = {name: "Write", input: {file_path: "/p/src/new.py"}};
  assert.equal(cls(w), "edit");
  assert.equal(T.classOf(w).verb, "Wrote");
  assert.equal(cls(w, new Map([["src/new.py", "created"]])), "create");
});

test("Bash classes from the command", () => {
  assert.equal(cls(bash("cd /p && uv run pytest -q tests/")), "test");
  assert.equal(cls(bash("node --test tests/js/")), "test");
  assert.equal(cls(bash("npm run build")), "build");
  assert.equal(cls(bash("npx tsc --noEmit")), "build");
  assert.equal(cls(bash("docker build -t x .")), "build");
  assert.equal(cls(bash("git status --short")), "git");
  assert.equal(T.classOf(bash("git -C /p log --oneline -3")).verb, "git log");
  assert.equal(cls(bash("git rm old.py")), "delete");
  assert.equal(T.classOf(bash("rm -f build/out.js")).res.value, "build/out.js");
  assert.equal(cls(bash("sed -i 's/a/b/' src/x.py")), "edit");
  assert.equal(T.classOf(bash("cat > notes.md <<'EOF'\nhi\nEOF")).res.value, "notes.md");
  assert.equal(cls(bash("rg lane src/")), "search");
  assert.equal(cls(bash("cat README.md")), "read");
  assert.equal(T.classOf(bash("sed -n 1,40p src/a.py")).res.value, "src/a.py");
  assert.equal(cls(bash("curl -s localhost:8000/health")), "run");
  assert.deepEqual(T.classOf(bash("ls")).res, {kind: "cmd", value: "ls"});
});

test("fold: consecutive calls of one class are one row; a test run stands alone", () => {
  const r = (p) => ({name: "Read", input: {file_path: p}});
  const groups = T.fold([r("a.py"), r("b.py"), r("a.py"), bash("pytest"), bash("pytest"), r("c.py")]);
  assert.deepEqual(groups.map((g) => [g.cls, g.items.length]), [["read", 3], ["test", 1], ["test", 1], ["read", 1]]);
  assert.equal(T.words("read", groups[0].items), "Read 2 files", "files counted once");
  assert.deepEqual(T.filesOf(groups[0].items), ["a.py", "b.py"]);
  assert.equal(T.words("search", [{}, {}, {}]), "Searched 3 times");
});

test("exit status: Bash says it; a running call has none", () => {
  assert.equal(T.exitOf({name: "Bash", status: "error", output: "Exit code 2\nboom"}), 2);
  assert.equal(T.exitOf({name: "Bash", status: "ok", output: "fine"}), 0);
  assert.equal(T.exitOf({name: "Bash", status: "running"}), null);
  assert.equal(T.exitOf({name: "Read", status: "ok"}), null);
});

test("the turn's diff splits per file, a new file too", () => {
  const diff = [
    "diff --git a/src/a.py b/src/a.py", "index 1..2 100644", "--- a/src/a.py", "+++ b/src/a.py",
    "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
    "diff --git a/gone.py b/gone.py", "deleted file mode 100644", "--- a/gone.py", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
    "--- /dev/null", "+++ b/new.py", "+a", "+b", ""].join("\n");
  const files = T.splitDiff(diff);
  assert.deepEqual(files.map((f) => f.path), ["src/a.py", "gone.py", "new.py"]);
  assert.deepEqual(files[0].lines.map((l) => l.t), ["hunk", "ctx", "del", "add"]);
  assert.deepEqual(files[2].lines.map((l) => l.s), ["+a", "+b"]);
});

test("a failed call is recovered when a later call of its class worked", () => {
  const items = [
    {seq: 1, ...bash("pytest"), status: "error", output: "Exit code 1\n2 failed"},
    {seq: 2, ...bash("npm run build"), status: "error", output: "Exit code 2\nboom"},
    {seq: 3, ...bash("pytest"), status: "ok", tests: {runner: "pytest", passed: 3, failed: 0, skipped: 1}},
  ];
  const sev = T.severities(items);
  assert.deepEqual([...sev], [[1, "recovered"], [2, "failed"], [3, "warning"]]);
});

test("the outcome: files, last run per runner, steps, failures by class", () => {
  const items = [
    {seq: 1, kind: "tool", plan: {steps: [{title: "a", state: "done"}, {title: "b", state: "active"}]}},
    {seq: 2, kind: "tool", ...bash("pytest"), status: "error", output: "Exit code 1",
     tests: {runner: "pytest", passed: 1, failed: 2, skipped: 0}},
    {seq: 3, kind: "tool", ...bash("pytest"), status: "ok", tests: {runner: "pytest", passed: 3, failed: 0, skipped: 0}},
    {seq: 4, kind: "tool", ...bash("curl x"), status: "error", output: "Exit code 7\nrefused"},
    {seq: 5, kind: "changes", files: [{path: "a"}, {path: "b", new: true}, {path: "c", deleted: true}]},
  ];
  const o = T.outcome(items, {kind: "turn_end", ms: 900, cost: 0.1});
  assert.deepEqual(o.files, {modified: 1, created: 1, deleted: 1});
  assert.equal(o.tests.length, 1);
  assert.equal(o.tests[0].passed, 3);
  assert.deepEqual(o.steps, {done: 1, total: 2});
  assert.deepEqual(o.byClass, {test: 1, run: 1});
  assert.equal(o.state, "failed");
  assert.equal(T.outcome([{seq: 9, kind: "error", text: "x"}], {}).state, "fatal");
});
