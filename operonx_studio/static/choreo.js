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
  // the shell: what writes a file, a commit (`git -c user.email=… commit`), the files a command names
  const WRITES = /(?:^|[^<>&2])>>?\s*(?!\/dev\/null)[^\s&|;>]|\btee\b|\bsed\s+(?:-\w*\s+)*-i|\bperl\s+-\w*i|\bpython3?\b[^|;&]*(?:<<|-c\b)|\bmv\b|\bcp\b/;
  const COMMIT = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b/;
  const MATRIX_NAME = /requirements_traceability\.md/;
  const QUESTIONS_NAME = /open_questions\.md/;
  function shellPlans(cmd) {
    const out = [];
    for (const m of cmd.matchAll(/[\w./-]*?([\w.-]+_PLAN\.md)\b/g)) {
      const full = m[0];
      if (/docs\/brd\//.test(full)) continue;
      const at = full.lastIndexOf("docs/");
      const plan = at >= 0 ? full.slice(at) : `docs/${m[1]}`;
      if (!out.includes(plan)) out.push(plan);
    }
    return out;
  }
  /* A tool's input reaches the page as the server clipped it: JSON text, cut off when long (a heredoc). The
   * fields that matter are read from the text when it no longer parses. */
  const FIELDS = ["file_path", "notebook_path", "command", "old_string", "new_string", "content", "op", "ref", "milestone"];
  function inputOf(item) {
    const raw = item && item.input;
    if (raw && typeof raw === "object") return raw;
    const text = String(raw || "");
    try { const got = JSON.parse(text); if (got && typeof got === "object") return got; } catch { /* clipped */ }
    const out = {};
    for (const k of FIELDS) {
      const m = new RegExp(`"${k}":\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
      if (!m) continue;
      try { out[k] = JSON.parse(`"${m[1]}"`); } catch { out[k] = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'); }
    }
    const choice = /"choice":\s*"([^"]*)"/.exec(text);
    if (choice) out.answer = {choice: choice[1]};
    return out;
  }

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
    const input = inputOf(item);
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
      // an assistant often writes with the shell: a heredoc, sed -i, a python script
      // a commit names the files it adds: it is a commit, nothing else
      const commit = COMMIT.test(cmd);
      const plans = commit ? [] : shellPlans(cmd);
      const writes = !commit && WRITES.test(cmd);
      for (const plan of plans) {
        if (writes && phase === "start") { goPage("plans"); out.push({point: `plan:${plan}`, words: "editing", or: "pagehead"}); }
        else if (writes && ok) out.push({refresh: true}, {point: `plan:${plan}`, words: "saved", soft: true, or: "pagehead"});
        else if (!writes && pm && where.page === "plans" && phase === "start") out.push({point: `plan:${plan}`, words: "reading"});
        break;   // one plan is enough to follow
      }
      if (writes && !plans.length && MATRIX_NAME.test(cmd)) {
        if (phase === "start") { goPage("checklist"); out.push({point: "page:checklist", words: "editing rows"}); }
        else if (ok) out.push({refresh: true});
      } else if (writes && !plans.length && QUESTIONS_NAME.test(cmd)) {
        if (phase === "start") { goPage("questions"); out.push({point: "page:questions", words: "editing"}); }
        else if (ok) out.push({refresh: true});
      }
      if (commit) {
        if (phase === "start") out.push({point: col("changes"), words: "committing"});
        else if (ok) out.push({refresh: true}, {point: "commit:new", words: "committed", soft: true, or: col("changes")});
      } else if (/\b(pytest|brd\s+check|check_brd\w*|operonx-project\s+plans)\b/.test(cmd)) {
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
    for (const r of (after.checklist || {}).open || []) {
      if (!rows.has(r.id)) out.push({point: `row:${r.id}`, words: "new"});
      else if (rows.get(r.id) !== r.status) out.push({point: `row:${r.id}`, words: r.status.replace(/_/g, " ")});
    }
    const closed = [...rows.keys()].filter((id) => !((after.checklist || {}).open || []).some((r) => r.id === id));
    if (closed.length) out.push({point: "status:checklist", words: `${closed.length} closed`});
    return out.slice(0, 4);
  }

  /* On Flow: an edit to the file an op is defined in rings that op. `ops`: [{name, file, code}], the canvas's.
   * The op is the one whose `def` the edit touches, or the file's only op. */
  function opSteps(item, phase, ops) {
    const name = tool(item && item.name);
    if (!EDITS.has(name) || (phase === "end" && item.status === "error")) return [];
    const input = inputOf(item);
    const file = String(input.file_path || "");
    const mine = (ops || []).filter((o) => o.file && (file === o.file || file.endsWith(`/${o.file}`)));
    if (!mine.length) return [];
    const text = `${input.old_string || ""}\n${input.new_string || ""}\n${input.content || ""}`;
    const touched = mine.filter((o) => new RegExp(`\\bdef ${o.fn || o.name}\\(`).test(text));
    const op = touched[0] || (mine.length === 1 ? mine[0] : null);
    if (!op) return [];
    return phase === "start" ? [{point: `op:${op.name}`, words: "editing"}] : [{point: `op:${op.name}`, words: "saved", soft: true}];
  }

  /* where a target lives: the screen to go to before pointing at it (null: anywhere, as it is) */
  const PAGE_OF = {status: "now", q: "questions", qopt: "questions", plan: "plans", phase: "plans", ms: "plans",
                   row: "checklist", commit: "changes", setting: "settings"};
  const TAB_OF = {op: "flow", run: "traces", job: "jobs", eval: "evals"};
  function where(target) {
    const kind = String(target || "").split(":")[0];
    if (PAGE_OF[kind]) return {tab: "project", page: PAGE_OF[kind]};
    if (TAB_OF[kind]) return {tab: TAB_OF[kind]};
    return null;
  }

  /* the screen follows the plan (docs/ASSISTANT_PROGRESS_PLAN.md D5): a step
     that ended rings what it worked on; a step that became active goes to
     its target and rings it with the step's words. `before`/`after` are the
     plans the steps tool posted (null: none yet). */
  const short = (t) => (t.length > 40 ? t.slice(0, 39) + "…" : t);
  function focus(before, after, here) {
    const was = new Map(((before && before.steps) || []).map((s) => [s.title, s.state]));
    const out = [];
    for (const s of (after && after.steps) || []) {
      if (s.target && was.get(s.title) === "active" && (s.state === "done" || s.state === "failed"))
        out.push({point: s.target, words: s.state === "done" ? "done" : "failed", soft: true});
    }
    const now = ((after && after.steps) || []).find((s) => s.state === "active" || s.state === "waiting");
    if (now && now.target && was.get(now.title) !== now.state) {
      const there = where(now.target);
      if (there && !(here && here.tab === there.tab && (!there.page || here.page === there.page))) out.push({go: there});
      out.push({point: now.target, words: short(now.title)});
    }
    return out;
  }

  const api = {steps, changed, planPath, where, opSteps, inputOf, focus};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
