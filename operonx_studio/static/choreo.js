/* operonx studio — what the screen does while the assistant works
 * (docs/ALIVE_ASSISTANT_PLAN.md D3).
 *
 * The assistant's tool calls reach the page live (an item with `name` and
 * `input` when it starts, its `status` when it ends). `opSteps(item, phase,
 * ops)` turns an edit into gestures for the hand (hand.js), and `focus`
 * turns the steps plan into them. Pure: no DOM, so it is tested on its own.
 *
 *   {go: {tab}}                            switch the screen
 *   {point: target, words}                 ring an element (data-ox-target)
 *   {press: target, words}                 the same, with the cursor's click
 *
 * A point may carry `or` (the target to ring when its own is not drawn) and
 * `soft` (skip it when that element was just ringed by something fresher).
 * Reading moves nothing (an assistant reads many files); writing goes where
 * the change is.
 */

"use strict";

const Choreo = (() => {
  const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  /* A tool's input reaches the page as the server clipped it: JSON text, cut off when long (a heredoc). The
   * fields that matter are read from the text when it no longer parses. */
  const FIELDS = ["file_path", "notebook_path", "command", "old_string", "new_string", "content", "op", "ref"];
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
    // or its call site in the graph (`fields = unpack(item=…, max_chars=500)`): the binding names the op
    const bound = mine.filter((o) => new RegExp(`\\b${o.name}\\s*=\\s*${o.fn || o.name}\\(`).test(text));
    const op = touched[0] || bound[0] || (mine.length === 1 ? mine[0] : null);
    if (!op) return [];
    // a setting the edit changes (`param=value`): the op is selected, its inspector shows the field (D6)
    const param = changedParams(`${input.old_string || ""}`, `${input.new_string || ""}${input.content || ""}`, op.params)[0];
    if (param && phase === "start") {
      return [{point: `op:${op.name}`, words: "editing"}, {select: op.name}, {point: `field:${op.name}/${param}`, words: "editing", or: `op:${op.name}`}];
    }
    // ended: once the studio has re-read the code (`fresh`), the field again — its new value, the old one struck
    if (param) return [{select: op.name, fresh: true}, {point: `field:${op.name}/${param}`, words: "saved", or: `op:${op.name}`}];
    return phase === "start" ? [{point: `op:${op.name}`, words: "editing"}] : [{point: `op:${op.name}`, words: "saved", soft: true}];
  }

  /* the op's params whose `name=value` (or `name: type = value`) the new text sets differently from the old */
  function changedParams(oldText, newText, params) {
    const valueOf = (text, p) => {
      const m = new RegExp(`\\b${p}\\s*(?::[^=\\n,()]*)?=(?!=)\\s*([^,\\n)]+)`).exec(text);
      return m ? m[1].trim() : null;
    };
    return (params || []).filter((p) => /^\w+$/.test(p)).filter((p) => {
      const now = valueOf(newText, p);
      return now !== null && now !== valueOf(oldText, p);
    });
  }

  /* where a target lives: the screen to go to before pointing at it (null: anywhere, as it is) */
  const TAB_OF = {op: "flow", field: "flow", run: "traces", job: "jobs", eval: "evals", setting: "projectsettings"};
  // setting:<section>/<name> on a settings screen of its own; a bare setting:<name> is the project's settings
  const SECTION_TAB = {retention: "settings"};
  function where(target) {
    const kind = String(target || "").split(":")[0];
    const section = /^setting:([\w-]+)\//.exec(String(target || ""));
    if (section && SECTION_TAB[section[1]]) return {tab: SECTION_TAB[section[1]]};
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
      if (there && !(here && here.tab === there.tab)) out.push({go: there});
      const field = /^field:([^/]+)\//.exec(now.target);
      if (field) out.push({select: field[1]});
      out.push({point: now.target, words: short(now.title), ...(field ? {or: `op:${field[1]}`} : {})});
    }
    return out;
  }

  const api = {where, opSteps, inputOf, focus, changedParams};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
