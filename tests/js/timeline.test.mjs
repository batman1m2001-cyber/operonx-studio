// The run canvas's time math — pure data → data, no browser.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TL, timePlace, laneOrder, fmtMs } =
  require("../../operonx_studio/static/timeline.js");

const ex = (start_ms, dur_ms, op = "x") => ({start_ms, dur_ms, op});

test("proportional in the busy range: 10ms gap → 10·k px", () => {
  const rows = [ex(0, 1), ex(10, 1)];
  timePlace(rows);
  assert.equal(rows[1].y - rows[0].y, 10 * TL.k);
  assert.equal(rows[1].gapBreak, undefined);
});

test("a burst never collapses below minStep", () => {
  const rows = [ex(0, 0.1), ex(0.2, 0.1), ex(0.4, 0.1)];
  timePlace(rows);
  assert.equal(rows[1].y - rows[0].y, TL.minStep);
  assert.equal(rows[2].y - rows[1].y, TL.minStep);
});

test("an idle gap clamps to maxStep and is reported as a break", () => {
  const rows = [ex(0, 1), ex(12400, 1)];
  timePlace(rows);
  assert.equal(rows[1].y - rows[0].y, TL.maxStep);
  assert.equal(rows[1].gapBreak, 12400);
});

test("card height tracks duration, clamped both ways", () => {
  const rows = [ex(0, 0.01), ex(1, 10), ex(2, 60000)];
  timePlace(rows);
  assert.equal(rows[0].h, TL.minH);      // 0.01ms op is still clickable
  assert.equal(rows[1].h, 10 * TL.k);    // proportional in range
  assert.equal(rows[2].h, TL.maxH);      // a 60s monitor is not a wall
});

test("re-placing the same rows clears stale breaks", () => {
  const rows = [ex(0, 1), ex(9000, 1)];
  timePlace(rows);
  assert.ok(rows[1].gapBreak);
  rows[1].start_ms = 5;                  // now adjacent
  timePlace(rows);
  assert.equal(rows[1].gapBreak, undefined);
});

test("lanes appear in first-run order, one per op", () => {
  const lanes = laneOrder([ex(0, 1, "recv"), ex(1, 1, "vad"),
                           ex(2, 1, "recv"), ex(3, 1, "stt")]);
  assert.deepEqual([...lanes.entries()],
    [["recv", 0], ["vad", 1], ["stt", 2]]);
});

test("ms formatting picks the readable unit", () => {
  assert.equal(fmtMs(45812), "45.8s");
  assert.equal(fmtMs(230.4), "230ms");
  assert.equal(fmtMs(3.21), "3.2ms");
});
