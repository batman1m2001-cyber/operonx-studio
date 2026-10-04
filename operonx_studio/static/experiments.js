/* operonx studio — experiments: the pure layer the Evals pages draw from.
 *
 * Every number on the Evals pages is operonx's — the intervals, the gate's
 * verdict, a comparison's difference and p-value come from the server
 * exactly as operonx computed them. This file only words and orders them:
 * a verdict as a badge with what it means, an interval as text, cases with
 * the failures first, a trend's geometry, a case's repeats as marks, the
 * run view's deep link to a blamed op, an edit's fields parsed.
 *
 * Split like io.js: this layer runs under `node --test`; evals.js draws.
 */

(function (global) {
  "use strict";

  /* ── numbers as words ─────────────────────────────────────────────── */

  function pct(x, digits = 1) {
    if (x == null || Number.isNaN(x)) return "—";
    const v = 100 * x;
    return `${v === 100 || v === 0 ? v.toFixed(0) : v.toFixed(digits)}%`;
  }

  /* a difference of shares, in points, signed */
  function pts(d, digits = 1) {
    if (d == null) return "—";
    const v = 100 * d;
    const s = Math.abs(v).toFixed(digits);
    return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${s} pts`;
  }

  /* a metric {mean, ci_lo, ci_hi} as "83.3% [60.4–96.2]" */
  function ciText(m) {
    if (!m || m.mean == null) return "—";
    if (m.ci_lo == null || m.ci_hi == null) return pct(m.mean);
    return `${pct(m.mean)} [${(100 * m.ci_lo).toFixed(1)}–${(100 * m.ci_hi).toFixed(1)}]`;
  }

  /* a paired difference's interval, in points: "[−40.0, −5.0]" */
  function diffCi(t) {
    if (!t || t.ci_lo == null) return "—";
    const f = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(100 * v).toFixed(1)}`;
    return `[${f(t.ci_lo)}, ${f(t.ci_hi)}]`;
  }

  function money(x) {
    if (x == null) return "—";
    if (x === 0) return "$0";
    if (x < 0.0001) return `$${Number(x.toPrecision(2))}`;   // one cheap call: $0.00002, not $0.0000
    return x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
  }

  /* ── verdicts ─────────────────────────────────────────────────────── */

  // operonx's five gate verdicts (operonx/app/evals/gate.py), worst last,
  // and what each one means to someone deciding whether to merge
  const VERDICTS = {
    pass: {label: "pass", tone: "ok", explain: "No drop larger than the tolerance; every threshold met."},
    inconclusive: {label: "inconclusive", tone: "warn",
      explain: "The data cannot rule out a drop larger than the tolerance — more cases or repeats would decide it. Not a pass."},
    failed: {label: "failed", tone: "bad", explain: "A threshold was missed, or a must-pass case fails."},
    regressed: {label: "regressed", tone: "bad",
      explain: "Worse than the baseline — confidently, and by more than the tolerance — or a must-pass case broke."},
    error: {label: "error", tone: "bad",
      explain: "Too many trials errored: an infrastructure failure, not a quality verdict. Run it again."},
  };

  function verdictOf(v) {
    if (v == null) return {label: "not judged", tone: "none",
      explain: "Compared, not judged: nobody said how large a drop matters (a tolerance)."};
    return VERDICTS[v] || {label: String(v), tone: "none", explain: ""};
  }

  /* ── fingerprints ─────────────────────────────────────────────────── */

  /* the code an experiment ran: a short sha, and whether the tree was dirty */
  function codeOf(fp) {
    const sha = fp && fp.code_version;
    return {sha: sha ? String(sha).slice(0, 7) : "no git", dirty: !!(fp && fp.version_dirty)};
  }

  /* ── cases ────────────────────────────────────────────────────────── */

  /* failures first: what broke against the baseline, what always fails,
   * then the flaky, then what was fixed, then the rest */
  function caseRank(c) {
    if (c.flip === "regressed") return 0;
    if (c.stability === "stable_fail" || c.errored) return 1;
    if (c.flip === "destabilised") return 2;
    if (c.stability === "flaky") return 3;
    if (c.flip === "fixed" || c.flip === "stabilised") return 4;
    return 5;
  }

  function sortCases(cases) {
    return cases.map((c, i) => [c, i]).sort((x, y) => caseRank(x[0]) - caseRank(y[0]) || x[1] - y[1]).map(x => x[0]);
  }

  const FILTERS = [
    ["all", "All", () => true],
    ["failed", "Failed", (c) => c.passes < c.trials],
    ["flaky", "Flaky", (c) => c.stability === "flaky"],
    ["changed", "Changed", (c) => !!c.flip],
    ["critical", "Must-pass", (c) => (c.tags || []).includes("critical")],
  ];

  function filterCases(cases, key) {
    const f = FILTERS.find(x => x[0] === key) || FILTERS[0];
    return cases.filter(f[2]);
  }

  function filterCounts(cases) {
    return FILTERS.map(([key, label, fn]) => ({key, label, n: cases.filter(fn).length}));
  }

  /* one mark per repeat, in repeat order: true passed, false failed, null errored */
  function repeatMarks(runs) {
    return (runs || []).slice().sort((a, b) => (a.repeat || 0) - (b.repeat || 0))
      .map(r => (r.error && r.status !== "ok" ? null : !!r.passed));
  }

  /* a history cell: how a case did in one experiment */
  function cellOf(h) {
    if (!h) return {tone: "none", label: "—", title: "not in this experiment"};
    const tone = h.passes === h.trials ? "ok" : h.passes === 0 ? "bad" : "flaky";
    return {tone, label: `${h.passes}/${h.trials}`,
      title: `${h.passes} of ${h.trials} repeat${h.trials === 1 ? "" : "s"} passed`};
  }

  /* a dataset's history row for one case, aligned to the strip's columns */
  function historyRow(columns, cells) {
    const by = new Map((cells || []).map(h => [h.experiment, h]));
    return columns.map(c => ({id: c.id, ...cellOf(by.get(c.id))}));
  }

  /* ── compare ──────────────────────────────────────────────────────── */

  // how a case moved (operonx gate.flip_class), plus what the studio adds
  // for a whole comparison: unchanged, flaky on both sides, on one side only
  const CLASSES = [
    ["regressed", "Regressed", "always passed in A, always fails in B"],
    ["destabilised", "Destabilised", "always passed in A, not always in B"],
    ["fixed", "Fixed", "always failed in A, always passes in B"],
    ["stabilised", "Stabilised", "not always in A, always passes in B"],
    ["changed", "Case edited", "the case's input or expected changed: not compared"],
    ["only_a", "Only in A", "not run in B"],
    ["only_b", "Only in B", "new in B"],
    ["noise", "Flaky in both", "noise: it wobbles either way"],
    ["same", "Unchanged", ""],
  ];

  function groupByClass(cases) {
    const out = [];
    for (const [key, label, hint] of CLASSES) {
      const list = cases.filter(c => c.class === key);
      if (list.length) out.push({key, label, hint, cases: list});
    }
    return out;
  }

  /* ── the trend ────────────────────────────────────────────────────── */

  /* Pass rate with its interval over experiments, oldest left. Returns the
   * points (x, y and the interval's ends in pixels), the band as an SVG
   * path, and a marker wherever the code changed. */
  function trend(rows, opts = {}) {
    const W = opts.width || 320, H = opts.height || 64, P = opts.pad || 6;
    const pts = rows.filter(r => r.pass && r.pass.mean != null).slice().reverse();
    const x = (i) => (pts.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (pts.length - 1));
    const y = (v) => H - P - Math.max(0, Math.min(1, v)) * (H - 2 * P);
    const points = pts.map((r, i) => ({
      id: r.id, x: x(i), y: y(r.pass.mean),
      lo: y(r.pass.ci_lo != null ? r.pass.ci_lo : r.pass.mean),
      hi: y(r.pass.ci_hi != null ? r.pass.ci_hi : r.pass.mean),
      verdict: r.verdict || null, mean: r.pass.mean, sha: codeOf(r.fingerprint).sha,
    }));
    let band = "";
    if (points.length > 1) {
      band = "M" + points.map(p => `${p.x.toFixed(1)},${p.hi.toFixed(1)}`).join(" L")
        + " L" + points.slice().reverse().map(p => `${p.x.toFixed(1)},${p.lo.toFixed(1)}`).join(" L") + " Z";
    }
    const markers = [];
    for (let i = 1; i < points.length; i++) {
      if (points[i].sha !== points[i - 1].sha) markers.push({x: (points[i].x + points[i - 1].x) / 2, sha: points[i].sha});
    }
    return {width: W, height: H, points, band, markers, y};
  }

  /* ── the run view ─────────────────────────────────────────────────── */

  /* an execution id ("params.classify#main", "params.sub.step#main.0") as
   * its op's name ("classify", "step") */
  function opNameOf(opId) {
    if (!opId) return "";
    const path = String(opId).split("#")[0];
    return path.split(".").pop();
  }

  /* the run view's deep link: the run, and the execution to select */
  function deepLink(pid, run, op) {
    const q = new URLSearchParams({run});
    if (op) q.set("op", op);
    return `/p/${encodeURIComponent(pid)}?${q}`;
  }

  /* ── editing a case ───────────────────────────────────────────────── */

  /* what was typed as `expected`: JSON when it parses ({…}, […], numbers,
   * true/false/null, "quoted"), else the text itself; empty removes it */
  function parseExpected(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return {value: null};
    if (/^[[{"]|^(true|false|null|-?\d)/.test(t)) {
      try { return {value: JSON.parse(t)}; } catch (err) {
        if (/^[[{]/.test(t)) return {error: `not valid JSON: ${err.message}`};
      }
    }
    return {value: t};
  }

  /* `expected` as it is edited: text stays text, the rest as JSON */
  function expectedText(v) {
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  }

  function parseTags(text) {
    return [...new Set(String(text || "").split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
  }

  /* the fields an edit changed, as Dataset.update takes them (null removes) */
  function changesOf(row, form) {
    const out = {};
    const exp = parseExpected(form.expected);
    if (exp.error) return {error: exp.error};
    if (JSON.stringify(exp.value) !== JSON.stringify(row.expected ?? null)) out.expected = exp.value;
    const tags = parseTags(form.tags);
    if (JSON.stringify(tags) !== JSON.stringify(row.tags || [])) out.tags = tags.length ? tags : null;
    const split = String(form.split || "").trim() || null;
    if (split !== (row.split || null)) out.split = split;
    const note = String(form.note || "").trim() || null;
    if (note !== (row.note || null)) out.note = note;
    return {changes: out};
  }

  const api = {pct, pts, ciText, diffCi, money, VERDICTS, verdictOf, codeOf, caseRank, sortCases, FILTERS,
               filterCases, filterCounts, repeatMarks, cellOf, historyRow, CLASSES, groupByClass, trend,
               opNameOf, deepLink, parseExpected, expectedText, parseTags, changesOf};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.XP = api;
})(typeof window !== "undefined" ? window : globalThis);
