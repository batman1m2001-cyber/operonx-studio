// The Evals pages' pure layer: wording and ordering only — every number is
// operonx's, so these pin how it is shown, never how it is computed.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const X = require("../../operonx_studio/static/experiments.js");

test("shares, points and intervals as text", () => {
  assert.equal(X.pct(0.8333), "83.3%");
  assert.equal(X.pct(1), "100%");
  assert.equal(X.pct(null), "—");
  assert.equal(X.pts(-0.2), "−20.0 pts");
  assert.equal(X.pts(0.05), "+5.0 pts");
  assert.equal(X.pts(0), "±0.0 pts");
  assert.equal(X.ciText({ mean: 0.783333, ci_lo: 0.604257, ci_hi: 0.96241 }), "78.3% [60.4–96.2]");
  assert.equal(X.ciText({ mean: 0.5 }), "50.0%");
  assert.equal(X.diffCi({ ci_lo: -0.4, ci_hi: -0.05 }), "[−40.0, −5.0]");
  assert.equal(X.diffCi({ ci_lo: -0.15, ci_hi: 0 }), "[−15.0, 0.0]");
  assert.equal(X.money(0.0252), "$0.03");
  assert.equal(X.money(0.00039885), "$0.0004");
  assert.equal(X.money(2.04e-5), "$0.00002");   // one cheap call is not "$0.0000"
  assert.equal(X.money(null), "—");
});

test("every operonx verdict has a badge, and 'not judged' is not a pass", () => {
  for (const v of ["pass", "inconclusive", "failed", "regressed", "error"]) {
    assert.equal(X.verdictOf(v).label, v);
    assert.ok(X.verdictOf(v).explain.length > 20);
  }
  assert.equal(X.verdictOf("inconclusive").tone, "warn");
  assert.match(X.verdictOf("inconclusive").explain, /Not a pass/);
  assert.equal(X.verdictOf(null).label, "not judged");
  assert.match(X.verdictOf(null).explain, /tolerance/);
});

test("the code an experiment ran", () => {
  assert.deepEqual(X.codeOf({ code_version: "858c8255f660", version_dirty: true }), { sha: "858c825", dirty: true });
  assert.deepEqual(X.codeOf({}), { sha: "no git", dirty: false });
});

const CASES = [
  { case: "b", stability: "stable_pass", passes: 3, trials: 3, tags: [] },
  { case: "d", stability: "flaky", passes: 2, trials: 3, tags: [] },
  { case: "c", stability: "stable_fail", passes: 0, trials: 3, tags: [] },
  { case: "a", stability: "stable_fail", passes: 0, trials: 3, flip: "regressed", tags: ["critical"] },
  { case: "e", stability: "stable_pass", passes: 3, trials: 3, flip: "fixed", tags: [] },
];

test("failed cases first: regressions, then failures, then the flaky", () => {
  assert.deepEqual(X.sortCases(CASES).map((c) => c.case), ["a", "c", "d", "e", "b"]);
  assert.deepEqual(X.filterCases(CASES, "failed").map((c) => c.case), ["d", "c", "a"]);
  assert.deepEqual(X.filterCases(CASES, "flaky").map((c) => c.case), ["d"]);
  assert.deepEqual(X.filterCases(CASES, "changed").map((c) => c.case), ["a", "e"]);
  assert.deepEqual(X.filterCases(CASES, "critical").map((c) => c.case), ["a"]);
  assert.deepEqual(X.filterCounts(CASES).map((f) => f.n), [5, 3, 1, 2, 1]);
});

test("a case's repeats as marks, and a history cell", () => {
  const runs = [{ repeat: 2, passed: false, status: "ok" }, { repeat: 0, passed: true, status: "ok" },
    { repeat: 1, passed: false, status: "failed", error: "boom" }];
  assert.deepEqual(X.repeatMarks(runs), [true, null, false]);
  assert.deepEqual(X.cellOf({ passes: 2, trials: 3 }).tone, "flaky");
  assert.deepEqual(X.cellOf({ passes: 0, trials: 3 }).label, "0/3");
  assert.equal(X.cellOf(undefined).tone, "none");
  const row = X.historyRow([{ id: "e1" }, { id: "e2" }, { id: "e3" }],
    [{ experiment: "e1", passes: 3, trials: 3 }, { experiment: "e3", passes: 0, trials: 3 }]);
  assert.deepEqual(row.map((c) => c.tone), ["ok", "none", "bad"]);
});

test("compare: cases grouped by how they moved, worst first", () => {
  const groups = X.groupByClass([{ case: "x", class: "same" }, { case: "a", class: "regressed" },
    { case: "d", class: "noise" }, { case: "s6", class: "only_b" }]);
  assert.deepEqual(groups.map((g) => g.key), ["regressed", "only_b", "noise", "same"]);
});

test("the trend: oldest left, the interval as a band, a marker where the code changed", () => {
  const rows = [  // newest first, as the list
    { id: "e3", pass: { mean: 0.8, ci_lo: 0.6, ci_hi: 0.9 }, verdict: "regressed", fingerprint: { code_version: "bbbbbbb1" } },
    { id: "e2", pass: { mean: 1, ci_lo: 0.9, ci_hi: 1 }, verdict: "pass", fingerprint: { code_version: "aaaaaaa1" } },
    { id: "e1", pass: { mean: 0.5, ci_lo: 0.3, ci_hi: 0.7 }, verdict: "pass", fingerprint: { code_version: "aaaaaaa1" } },
    { id: "x", pass: null },
  ];
  const t = X.trend(rows, { width: 100, height: 50, pad: 5 });
  assert.deepEqual(t.points.map((p) => p.id), ["e1", "e2", "e3"]);
  assert.deepEqual(t.points.map((p) => p.x), [5, 50, 95]);
  assert.equal(t.points[1].y, 5);           // 100% at the top
  assert.equal(t.points[0].y, 25);          // 50% in the middle
  assert.ok(t.points[0].hi < t.points[0].y && t.points[0].lo > t.points[0].y);
  assert.match(t.band, /^M5\.0,/);
  assert.deepEqual(t.markers, [{ x: 72.5, sha: "bbbbbbb" }]);
  assert.equal(X.trend([rows[0]], { width: 100 }).band, "");
});

test("the run view's deep link selects the blamed execution", () => {
  assert.equal(X.opNameOf("params.classify#main"), "classify");
  assert.equal(X.opNameOf("params.sub.step#main.0"), "step");
  assert.equal(X.deepLink("p1", "abc-1", "params.classify#main"), "/p/p1?run=abc-1&op=params.classify%23main");
  assert.equal(X.deepLink("p1", "abc-1"), "/p/p1?run=abc-1");
});

test("an edit: expected as JSON or text, tags, what changed", () => {
  assert.deepEqual(X.parseExpected('{"intent": "refund"}'), { value: { intent: "refund" } });
  assert.deepEqual(X.parseExpected("refund"), { value: "refund" });
  assert.deepEqual(X.parseExpected("42"), { value: 42 });
  assert.deepEqual(X.parseExpected("  "), { value: null });
  assert.match(X.parseExpected("{intent: refund}").error, /not valid JSON/);
  assert.equal(X.expectedText({ a: 1 }), '{\n  "a": 1\n}');
  assert.deepEqual(X.parseTags("refund, critical,\nrefund"), ["refund", "critical"]);
  const row = { id: "r1", expected: { intent: "refund" }, tags: ["refund"], split: "test" };
  assert.deepEqual(X.changesOf(row, { expected: '{"intent":"refund"}', tags: "refund", split: "test", note: "" }).changes, {});
  assert.deepEqual(X.changesOf(row, { expected: '{"intent":"cancel"}', tags: "", split: "", note: "why" }).changes,
    { expected: { intent: "cancel" }, tags: null, split: null, note: "why" });
  assert.match(X.changesOf(row, { expected: "{bad", tags: "", split: "" }).error, /JSON/);
});
