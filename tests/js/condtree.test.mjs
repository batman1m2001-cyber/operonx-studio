// A router's condition read back as a tree (static/condtree.js).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CT = require("../../operonx_studio/static/condtree.js");
const show = (n) => n.op ? `${n.op}[${n.kids.map(show).join(", ")}]` : n.text;

test("one clause is one leaf", () => {
  assert.equal(show(CT.parse("score >= 90")), "score >= 90");
  assert.equal(CT.depth(CT.parse("score >= 90")), 0);
});

test("and binds tighter than or, as Python reads it", () => {
  assert.equal(show(CT.parse("a == 1 and b == 2 or c == 3")), "|[&[a == 1, b == 2], c == 3]");
  assert.equal(show(CT.parse("a == 1 or b == 2 and c == 3")), "|[a == 1, &[b == 2, c == 3]]");
});

test("brackets group, as operonx writes them since 1.17.9", () => {
  const t = CT.parse("(intent == 'reschedule' or retries >= 3) and confidence > 0.5");
  assert.equal(show(t), "&[|[intent == 'reschedule', retries >= 3], confidence > 0.5]");
  assert.equal(CT.depth(t), 2);
  assert.deepEqual(CT.leaves(t).map(l => l.text), ["intent == 'reschedule'", "retries >= 3", "confidence > 0.5"]);
});

test("a run of one operator is one node; & and | read like and and or", () => {
  assert.equal(show(CT.parse("a and b and c")), "&[a, b, c]");
  assert.equal(show(CT.parse("(a & b) & c")), "&[a, b, c]");
  assert.equal(show(CT.parse("(a) | (b)")), "|[a, b]");
});

test("quotes and calls are never split", () => {
  assert.equal(show(CT.parse("name == 'rock and roll' or len(x, 2) > 3")), "|[name == 'rock and roll', len(x, 2) > 3]");
  assert.equal(show(CT.parse('tag == "a|b" and brand == "x&y"')), '&[tag == "a|b", brand == "x&y"]');
  assert.equal(show(CT.parse("orders > 1 and android")), "&[orders > 1, android]");   // words inside names stay
});

test("not stays with its clause", () => {
  assert.equal(show(CT.parse("not (a == 1 or b == 2) and c")), "&[not (a == 1 or b == 2), c]");
});
