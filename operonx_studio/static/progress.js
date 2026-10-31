/* The progress card's logic (docs/ASSISTANT_PROGRESS_PLAN.md D3, D4): what
   the card says about a plan, and the plan the page makes from a turn's tool
   calls when the assistant posted none. No DOM: assistant.js draws it, and
   tests/js/progress.test.mjs checks it. */
const oxProgress = (() => {
  const TARGET_KIND = {op: "op", row: "requirement", q: "question", qopt: "question", plan: "plan", phase: "phase",
    run: "run", commit: "commit", setting: "setting", card: "card", field: "field", job: "job", eval: "eval",
    ms: "milestone", page: "", tab: "", status: ""};

  /* a target in words: op:score_news → "op score_news" */
  function targetWords(t) {
    const m = /^(\w+):(.+)$/.exec(t || "");
    if (!m) return t || "";
    const kind = TARGET_KIND[m[1]];
    return kind ? `${kind} ${m[2]}` : m[2];
  }

  /* the head: the chip, "3 of 5 steps completed", the percentage, and the words a screen reader hears */
  function summary(steps, live) {
    const n = steps.length;
    const done = steps.filter((s) => s.state === "done").length;
    const finished = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
    const chip = steps.some((s) => s.state === "failed") ? ["Failed", "bad"]
      : steps.some((s) => s.state === "waiting") ? ["Needs you", "warn"]
      : n && finished === n ? ["Completed", "ok"] : live ? ["Executing", "run"] : ["Stopped", "off"];
    const at = steps.findIndex((s) => s.state === "active" || s.state === "waiting");
    return {chip, done, n, pct: n ? Math.round(finished / n * 100) : 0,
      say: at >= 0 ? `Step ${at + 1} of ${n}: ${steps[at].title}` : `${chip[0]}: ${done} of ${n} steps`};
  }

  const base = (p) => String(p || "").split("/").pop();
  // an item's input is clipped JSON text (assistant.py _clip): a clipped one reads as nothing
  function inputOf(item) {
    if (item.input && typeof item.input === "object") return item.input;
    try { return JSON.parse(item.input || "{}"); } catch { return {}; }
  }

  /* what one tool call did, as the step it belongs to: {kind, words} */
  function kindOf(item) {
    const n = item.name || "";
    const inp = inputOf(item);
    if (/^(Read|Grep|Glob|LS)$/.test(n)) return {kind: "read", file: base(inp.file_path || inp.path || "")};
    if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) {
      const f = base(inp.file_path || inp.notebook_path || "");
      return {kind: "edit:" + f, words: f ? `Edited ${f}` : "Edited files"};
    }
    if (n === "Bash") return {kind: "run"};
    if (/^Web/.test(n)) return {kind: "web", words: "Looked it up on the web"};
    const studio = /^mcp__studio__(.+)$/.exec(n);
    if (studio) {
      const tool = studio[1];
      if (tool === "board_act" && inp.card) return {kind: "act:" + inp.card, words: `Moved ${inp.card}`};
      if (tool === "board_act" && inp.question) return {kind: "q:" + inp.question, words: `Answered ${inp.question}`};
      if (tool === "board_card" && inp.card) return {kind: "card:" + inp.card, words: `Read ${inp.card}`};
      const words = tool.replace(/_/g, " ");
      return {kind: "studio:" + tool, words: words[0].toUpperCase() + words.slice(1)};
    }
    return {kind: "tool:" + n, words: n ? `Used ${n}` : "Used a tool"};
  }

  /* D3: a turn's tool calls grouped into steps — consecutive calls that did
     the same kind of thing are one step; the running one is active */
  function fallback(items) {
    const steps = [];
    for (const item of items) {
      if (item.kind !== "tool" || item.name === "ToolSearch") continue;
      const k = kindOf(item);
      let step = steps[steps.length - 1];
      if (!step || step.kind !== k.kind) {
        step = {key: `#${steps.length}`, kind: k.kind, words: k.words, files: [], seqs: [], n: 0};
        steps.push(step);
      }
      step.seqs.push(item.seq);
      step.n++;
      if (k.file && !step.files.includes(k.file)) step.files.push(k.file);
      step.last = item;
      step.ms = (step.ms || 0) + (item.ms || 0);
    }
    return steps.map((s) => {
      const title = s.kind === "read" ? (s.files.length === 1 ? `Read ${s.files[0]}` : s.files.length
        ? `Read ${s.files.length} files` : "Looked through the code")
        : s.kind === "run" ? (s.n === 1 ? "Ran a command" : `Ran ${s.n} commands`) : s.words;
      const state = s.last.status === "running" ? "active" : s.last.status === "error" ? "failed" : "done";
      return {key: s.key, title, state, seqs: s.seqs, ...(state === "done" && s.ms ? {ms: s.ms} : {})};
    });
  }

  const api = {targetWords, summary, fallback, kindOf};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxProgress = oxProgress;
