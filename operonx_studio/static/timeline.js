/* operonx studio — the run canvas's time math.
 *
 * Pure data → data, split out of studio.js so it runs under
 * `node --test` (tests/js/timeline.test.mjs) exactly as in the browser.
 *
 * The axis is piecewise-compressed: busy stretches stay proportional
 * (k px per ms), tight bursts never collapse below minStep, and idle
 * gaps clamp at maxStep with the skipped time reported as a BREAK —
 * a 46-second call reads as one page without lying about when.
 */
(function (global) {
  const TL = {k: 4, minStep: 26, maxStep: 110, minH: 16, maxH: 84,
              laneW: 150, pitch: 168, padTop: 76, axisW: 96};

  /* execs: [{start_ms, dur_ms}], sorted by start_ms. Mutates each with
   * y, h and (when a gap collapsed) gapBreak = the skipped ms.
   * Returns the world height. */
  function timePlace(execs, tl) {
    tl = tl || TL;
    let y = tl.padTop, prev = null;
    for (const e of execs) {
      delete e.gapBreak;
      if (prev != null) {
        const step = (e.start_ms - prev) * tl.k;
        if (step > tl.maxStep) e.gapBreak = e.start_ms - prev;
        y += Math.min(Math.max(step, tl.minStep), tl.maxStep);
      }
      e.y = y;
      e.h = Math.min(Math.max(e.dur_ms * tl.k, tl.minH), tl.maxH);
      prev = e.start_ms;
    }
    return y + 160;
  }

  /* lane order = first appearance in time: in a DAG that IS the flow's
   * structural order, and the first screen is never empty. */
  function laneOrder(execs) {
    const lanes = new Map();
    for (const e of execs) {
      if (!lanes.has(e.op)) lanes.set(e.op, lanes.size);
    }
    return lanes;
  }

  function fmtMs(ms) {
    return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s`
         : ms >= 100 ? `${Math.round(ms)}ms`
         : `${ms.toFixed(1)}ms`;
  }

  const api = { TL, timePlace, laneOrder, fmtMs };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Timeline = api;
})(typeof window !== "undefined" ? window : globalThis);
