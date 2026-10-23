/* operonx studio — what the screen does while the assistant works
 * (docs/ALIVE_ASSISTANT_PLAN.md D3).
 *
 * The assistant's tool calls reach the page live (an item with `name` and
 * `input` when it starts, its `status` when it ends). `steps(item, phase,
 * where)` turns one into gestures for the hand (hand.js): go to a page, point
 * at a target with two or three words, press a button the action stands
 * for. Pure: no DOM, so it is tested on its own.
 *
 *   {go: {tab, page}}                      switch the screen
 *   {point: target, words}                 ring an element (data-ox-target)
 *   {press: target, words}                 the same, with the cursor's click
 *   {refresh: true}                        read the project's status again first
 *
 * A point may carry `or` (the target to ring when its own is not drawn) and
 * `soft` (skip it when that element was just ringed by something fresher).
 *
 * `where` is what is on screen: {tab, page}. Reading moves nothing (an
 * assistant reads many files); writing goes where the change is.
 */

"use strict";

const Choreo = (() => {
  const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  const MATRIX = /docs\/brd\/requirements\/requirements_traceability\.md$/;
  const QUESTIONS = /docs\/brd\/requirements\/open_questions\.md$/;
  const PLAN = /(?:^|\/)(docs\/(?:[^/]+\/)*[^/]+\.md)$/;

  const COLUMN = {needs: "questions", working: "plans", checklist: "checklist", plans: "plans", changes: "changes"};
  const tool = (name) => String(name || "").replace(/^mcp__studio__/, "studio:");

  /* `docs/X_PLAN.md`, relative to the project, from any path that ends in it */
  function planPath(path) {
    const p = String(path || "");
    if (MATRIX.test(p) || QUESTIONS.test(p) || /docs\/brd\//.test(p)) return null;
    const m = PLAN.exec(p);
    return m && /_PLAN\.md$/.test(m[1]) ? m[1] : null;
  }

  function steps(item, phase, where) {
    const name = tool(item && item.name);
    const input = (item && item.input) || {};
    const ok = phase === "end" && item.status !== "error";
    const pm = where && where.tab === "project";
    // the status column shows on Now only; elsewhere the Project bar's icon stands for its section
    const col = (sec) => (pm && where.page === "now" ? `status:${sec}` : `page:${COLUMN[sec]}`);
    const out = [];
    const goPage = (page) => { if (!pm || where.page !== page) out.push({go: {tab: "project", page}}); };

    if (EDITS.has(name)) {
      const file = input.file_path || input.notebook_path || "";
      const plan = planPath(file);
      if (plan) {
        if (phase === "start") {
          goPage("plans");
          // a plan being written is not on the page yet: the page's head instead
          out.push({point: `plan:${plan}`, words: name === "Write" ? "writing" : "editing", or: "pagehead"});
        } else if (ok) {
          // what changed in it is lit by `changed`; "saved" only when nothing else was
          out.push({refresh: true}, {point: `plan:${plan}`, words: "saved", soft: true, or: "pagehead"});
        }
      } else if (MATRIX.test(file)) {
        if (phase === "start") { goPage("checklist"); out.push({point: "page:checklist", words: "editing rows"}); }
        else if (ok) out.push({refresh: true});
      } else if (QUESTIONS.test(file)) {
        if (phase === "start") { goPage("questions"); out.push({point: "page:questions", words: "editing"}); }
        else if (ok) out.push({refresh: true});
      }
      return out;
    }
    if (name === "Read") {
      const plan = planPath(input.file_path);
      if (plan && pm && phase === "start") out.push({point: `plan:${plan}`, words: "reading"});
      return out;
    }
    if (name === "Bash") {
      const cmd = String(input.command || "");
      if (/\bgit\s+commit\b/.test(cmd)) {
        if (phase === "start") out.push({point: col("changes"), words: "committing"});
        else if (ok) out.push({refresh: true}, {point: "commit:new", words: "committed", soft: true, or: col("changes")});
      } else if (/\b(pytest|brd\s+check|operonx-project\s+plans)\b/.test(cmd)) {
        if (phase === "start") out.push({point: col("checklist"), words: "checking"});
      }
      return out;
    }
    if (name === "studio:project_status" && phase === "start") {
      const secs = pm && where.page === "now" ? Object.keys(COLUMN) : ["needs", "plans", "checklist", "changes"];
      for (const s of secs) out.push({point: col(s), words: "reading", quick: true});
      return out;
    }
    if (name === "studio:board_act" && input.op === "answer" && phase === "start") {
      goPage("questions");
      const key = typeof input.answer === "object" && input.answer ? input.answer.choice : null;
      out.push(key ? {press: `qopt:${input.ref}:${key}`, words: "answering"} : {point: `q:${input.ref}`, words: "answering"});
      return out;
    }
    if (name === "studio:board_status" && input.milestone && phase === "start") {
      goPage("plans");
      out.push({point: `ms:${input.milestone}`, words: "reading"});
    }
    return out;
  }

  /* What changed between two status documents: the targets to light once, newest first. */
  function changed(before, after) {
    if (!before || !after) return [];
    const out = [];
    const old = new Map((before.plans || []).map((p) => [p.path || `m:${p.milestone}`, p]));
    for (const p of after.plans || []) {
      const was = old.get(p.path || `m:${p.milestone}`);
      const target = p.path ? `plan:${p.path}` : `ms:${p.milestone}`;
      if (!was) out.push({point: target, words: "new plan"});
      else if (was.status !== p.status || was.done !== p.done) out.push({point: target, words: p.status === "done" ? "done" : `${p.done}/${p.total}`});
    }
    const seen = new Set((before.changes || []).map((c) => c.sha));
    for (const c of (after.changes || []).slice(0, 3)) if (!seen.has(c.sha)) out.push({point: `commit:${c.sha}`, words: "new"});
    const rows = new Map(((before.checklist || {}).open || []).map((r) => [r.id, r.status]));
    for (const r of (after.checklist || {}).open || []) if (rows.has(r.id) && rows.get(r.id) !== r.status) out.push({point: `row:${r.id}`, words: r.status.replace(/_/g, " ")});
    const closed = [...rows.keys()].filter((id) => !((after.checklist || {}).open || []).some((r) => r.id === id));
    if (closed.length) out.push({point: "status:checklist", words: `${closed.length} closed`});
    return out.slice(0, 4);
  }

  const api = {steps, changed, planPath};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
