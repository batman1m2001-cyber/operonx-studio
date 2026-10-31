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

  /* the head: the chip, "3 of 5 steps", the bar, and the words a screen reader hears.
     A skipped step leaves the total (VISUAL_CHAT_PLAN D12): the bar is done/total, a count, never an estimate */
  function summary(steps, live) {
    const n = steps.filter((s) => s.state !== "skipped").length;
    const done = steps.filter((s) => s.state === "done").length;
    // [word, tone]: the tone is blocks.js status()'s (VISUAL_CHAT_PLAN D3)
    const chip = steps.some((s) => s.state === "failed") ? ["Failed", "err"]
      : steps.some((s) => s.state === "waiting") ? ["Needs you", "warn"]
      : steps.some((s) => s.state === "blocked") ? ["Blocked", "blocked"]
      : steps.length && done === n ? ["Completed", "ok"] : live ? ["Executing", "run"] : ["Stopped", "pending"];
    const at = steps.findIndex((s) => s.state === "active" || s.state === "waiting" || s.state === "blocked");
    return {chip, done, n, pct: n ? Math.round(done / n * 100) : steps.length ? 100 : 0,
      say: at >= 0 ? `Step ${at + 1} of ${steps.length}: ${steps[at].title}` : `${chip[0]}: ${done} of ${n} steps`};
  }

  /* D12: what one step did, from facts only — its tool calls (the ones made while it was active, or inside its
     started…ended window), the files they changed, its last test run per runner, the commands with their exit
     status, and its progress: the subtasks done, else the last run's passed/total, else none */
  function stepFacts(step, seqs, items, touched, rel = (p) => p) {
    const mine = new Set(seqs || []);
    const end = step.ended != null ? step.ended : Infinity;
    const calls = items.filter((it) => it.kind === "tool" && it.name !== "ToolSearch" && (mine.has(it.seq)
      || (step.started != null && it.created != null && it.created >= step.started && it.created <= end)));
    const files = new Map();
    for (const it of calls) {
      const c = T.classOf(it, touched);
      if (!/^(edit|create|delete)$/.test(c.cls) || !c.res || c.res.kind !== "file" || it.status === "error") continue;
      const p = rel(c.res.value);
      const how = (touched && touched.get(p)) || (c.cls === "create" ? "created" : c.cls === "delete" ? "deleted" : "modified");
      files.set(p, how === "read" ? "modified" : how);
    }
    const runs = new Map();
    for (const it of calls) if (it.tests) runs.set(it.tests.runner, it.tests);
    const tests = [...runs.values()];
    const commands = calls.filter((it) => it.name === "Bash").map((it) =>
      ({seq: it.seq, cmd: T.mainCommand(String(T.inputOf(it).command || "")), exit: T.exitOf(it), ms: it.ms}));
    let progress = null;
    const sub = (step.sub || []).filter((t) => t.state !== "skipped");
    if (sub.length) progress = {kind: "sub", done: sub.filter((t) => t.state === "done").length, total: sub.length};
    else if (tests.length) {
      const t = tests[tests.length - 1];
      const total = t.passed + t.failed + t.errors;
      if (total) progress = {kind: "tests", done: t.passed, total};
    }
    return {calls, files: [...files].map(([path, how]) => ({path, how})), tests, commands, progress,
      ms: step.ms != null ? step.ms : null};
  }

  /* D12: a plan whose steps say what they wait on (after, numbered from 1) is a structure; null when none does */
  function structure(steps) {
    if (!steps.some((s) => s.after && s.after.length)) return null;
    const id = (i) => "s" + (i + 1);
    const nodes = steps.map((s, i) => ({id: id(i), label: `${i + 1}  ${s.title}`, state: s.state}));
    const edges = [];
    steps.forEach((s, i) => {
      for (const a of s.after || []) if (a >= 1 && a <= steps.length && a - 1 !== i) edges.push({from: id(a - 1), to: id(i)});
    });
    return {nodes, edges, groups: {}, direction: "down"};
  }

  const base = (p) => String(p || "").split("/").pop();
  // an item's input is clipped JSON text (assistant.py _clip): a clipped one reads as nothing
  function inputOf(item) {
    if (item.input && typeof item.input === "object") return item.input;
    try { return JSON.parse(item.input || "{}"); } catch { return {}; }
  }

  // the tool classes (VISUAL_CHAT_PLAN D5): a global in the page, required in node
  const T = typeof oxTools !== "undefined" ? oxTools : require("./tools.js");

  /* what one tool call did, as the step it belongs to: {kind, words} */
  function kindOf(item) {
    const n = item.name || "";
    const inp = inputOf(item);
    const studio = /^mcp__studio__(.+)$/.exec(n);
    if (studio) {
      const tool = studio[1];
      if (tool === "board_act" && inp.card) return {kind: "act:" + inp.card, words: `Moved ${inp.card}`};
      if (tool === "board_act" && inp.question) return {kind: "q:" + inp.question, words: `Answered ${inp.question}`};
      if (tool === "board_card" && inp.card) return {kind: "card:" + inp.card, words: `Read ${inp.card}`};
      const words = tool.replace(/_/g, " ");
      return {kind: "studio:" + tool, words: words[0].toUpperCase() + words.slice(1)};
    }
    const c = T.classOf(item);
    const f = c.res && c.res.kind === "file" ? base(c.res.value) : "";
    if (c.cls === "read" || c.cls === "search") return {kind: "read", file: c.cls === "read" ? f : ""};
    if (c.cls === "edit" || c.cls === "create") return {kind: "edit:" + f, words: f ? `Edited ${f}` : "Edited files"};
    if (c.cls === "delete") return {kind: "delete:" + f, words: f ? `Deleted ${f}` : "Deleted files"};
    if (c.cls === "test") return {kind: "test", words: "Ran the tests"};
    if (c.cls === "build") return {kind: "build", words: "Built the project"};
    if (c.cls === "git") return {kind: "git", words: `Ran git ${c.sub}`.trim()};
    if (c.cls === "run") return {kind: "run"};
    if (c.cls === "web") return {kind: "web", words: "Looked it up on the web"};
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

  const api = {targetWords, summary, stepFacts, structure, fallback, kindOf};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxProgress = oxProgress;
