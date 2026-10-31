/* What a tool call did (docs/VISUAL_CHAT_PLAN.md D5): its class from its
   name and input, the resource it acted on, and runs of one class folded
   into one row.

     classOf(item, touched) → {cls, verb, icon, res: {kind, value} | null, sub}
       read · edit · create · delete · search · run · test · build · git ·
       web · studio · plumbing · tool
       res.kind: file (a path) · cmd (the command) · query · url

   touched (refs.js touched()) tells a Write that made a file from one that
   rewrote it. No DOM here, so tests/js/tools.test.mjs runs it in node. */
const oxTools = (() => {
  const ICON = {read: "file", edit: "code", create: "plus", delete: "trash", search: "search", run: "terminal",
    test: "checksq", build: "box", git: "history", web: "globe", studio: "graph", plumbing: "dot", tool: "box"};

  // the same runners testreport.py reads (D6)
  const TEST = /(^|[\s;&|(/])(pytest|py\.test|jest|vitest)(?=\s|$|;|&)|python3?\s+-m\s+(pytest|unittest)\b|\bnode\s+(--[\w-]+\s+)*--test\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b/;
  const BUILD = /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\b(vite|tsc|webpack|esbuild)\b(?!\S)|\b(cargo|go)\s+build\b|^make\b|\bmake(\s+-\S+)*(\s+\w+)?$|\bdocker\s+(build|compose\s+build)\b|\buv\s+build\b|\bpython3?\s+-m\s+build\b/;

  function inputOf(item) {
    if (item.input && typeof item.input === "object") return item.input;
    try { return JSON.parse(item.input || "{}"); } catch { return {}; }
  }

  /* the command that matters: `cd x && uv run pytest` → `uv run pytest`; env assignments dropped */
  function mainCommand(cmd) {
    const parts = String(cmd || "").trim().split(/\s*(?:&&|;)\s*/).filter((p) => p && !/^(cd|export|source|set)\b/.test(p));
    return (parts[0] || String(cmd || "").trim()).replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
  }

  function bashClass(cmd) {
    const all = String(cmd || "");
    const c = mainCommand(all);
    if (TEST.test(all)) return {cls: "test", verb: "Tested"};
    const git = /^git\s+(?:-\S+\s+(?:\S+\s+)?)*?([a-z][\w-]*)(?:\s+(.*))?$/.exec(c);
    if (git && git[1] === "rm") return {cls: "delete", verb: "Deleted", file: firstPath(git[2])};
    if (git) return {cls: "git", verb: `git ${git[1]}`, sub: git[1]};
    if (/^rm\s/.test(c)) return {cls: "delete", verb: "Deleted", file: firstPath(c.slice(3))};
    const sed = /^sed\s+(?:-\S*\s+)*-i\S*\s+(?:'[^']*'|"[^"]*"|\S+)\s+(\S+)/.exec(c);
    if (sed) return {cls: "edit", verb: "Edited", file: sed[1]};
    const into = /(?:^|\s)(?:cat|echo|printf|tee)\b[^|]*?(?:>>?|\btee\s+(?:-a\s+)?)\s*['"]?([\w./-]+\.\w+)['"]?/.exec(c);
    if (into) return {cls: "edit", verb: "Wrote", file: into[1]};
    if (BUILD.test(c)) return {cls: "build", verb: "Built"};
    if (/^(grep|rg|ag|find|fd|ls|tree)\b/.test(c)) return {cls: "search", verb: "Searched"};
    return {cls: "run", verb: "Ran"};
  }

  function firstPath(rest) {
    return (String(rest || "").split(/\s+/).find((w) => w && !w.startsWith("-")) || "").replace(/^['"]|['"]$/g, "");
  }

  function classOf(item, touched) {
    const n = item.name || "";
    const inp = inputOf(item);
    const file = (p) => (p ? {kind: "file", value: p} : null);
    const out = (cls, verb, res, sub) => ({cls, verb, icon: ICON[cls], res: res || null, sub: sub || ""});
    if (n === "ToolSearch") return out("plumbing", "Loaded tools");
    if (n === "Read") return out("read", "Read", file(inp.file_path));
    if (/^(Edit|MultiEdit|NotebookEdit)$/.test(n)) return out("edit", "Edited", file(inp.file_path || inp.notebook_path));
    if (n === "Write") {
      const p = inp.file_path || "";
      const rel = touched && [...touched.keys()].find((k) => p === k || p.endsWith("/" + k));
      return touched && rel && touched.get(rel) === "created" ? out("create", "Created", file(p)) : out("edit", "Wrote", file(p));
    }
    if (n === "Grep") return out("search", "Searched", {kind: "query", value: inp.pattern || ""}, inp.path || inp.glob || "");
    if (n === "Glob") return out("search", "Found", {kind: "query", value: inp.pattern || ""}, inp.path || "");
    if (n === "LS") return out("search", "Listed", file(inp.path));
    if (n === "WebFetch") return out("web", "Fetched", {kind: "url", value: inp.url || ""});
    if (n === "WebSearch") return out("web", "Looked up", {kind: "query", value: inp.query || ""});
    const studio = /^mcp__studio__(.+)$/.exec(n);
    if (studio) {
      const w = studio[1].replace(/_/g, " ");
      return out("studio", w[0].toUpperCase() + w.slice(1), inp.card || inp.question || inp.op || inp.name
        ? {kind: "query", value: String(inp.card || inp.question || inp.op || inp.name)} : null);
    }
    if (n === "Bash") {
      const b = bashClass(inp.command);
      const res = b.file ? file(b.file) : inp.command ? {kind: "cmd", value: String(inp.command)} : null;
      return out(b.cls, b.verb, res, b.sub);
    }
    return out("tool", n || "Tool", null);
  }

  /* consecutive calls of one class → [{cls, items}]; a test run is its own row, it has its report */
  function fold(items, touched) {
    const groups = [];
    for (const item of items) {
      const c = classOf(item, touched);
      const g = groups[groups.length - 1];
      if (g && g.cls === c.cls && c.cls !== "test" && c.cls !== "tool") g.items.push(item);
      else groups.push({cls: c.cls, items: [item]});
    }
    return groups;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* a folded row's words: "Read 6 files", "Searched 3 times" */
  function words(cls, items, touched) {
    const n = items.length;
    const files = new Set(items.map((i) => classOf(i, touched).res).filter((r) => r && r.kind === "file").map((r) => r.value));
    const f = files.size || n;
    return {
      read: `Read ${plural(f, "file", "files")}`, edit: `Edited ${plural(f, "file", "files")}`,
      create: `Created ${plural(f, "file", "files")}`, delete: `Deleted ${plural(f, "file", "files")}`,
      search: `Searched ${plural(n, "time", "times")}`, run: `Ran ${plural(n, "command", "commands")}`,
      test: n === 1 ? "Ran the tests" : `Ran the tests ${n} times`, build: n === 1 ? "Built" : `Built ${n} times`,
      git: `Ran ${plural(n, "git command", "git commands")}`, web: `Looked up ${plural(n, "page", "pages")}`,
      studio: `Used the studio ${n}×`, plumbing: "Loaded tools", tool: `Used ${plural(n, "tool", "tools")}`,
    }[cls];
  }

  /* the files a run of calls acted on, in order, once each */
  function filesOf(items, touched) {
    const seen = [];
    for (const i of items) {
      const r = classOf(i, touched).res;
      if (r && r.kind === "file" && !seen.includes(r.value)) seen.push(r.value);
    }
    return seen;
  }

  /* a Bash result that failed says so first: "Exit code 2\n…" */
  function exitOf(item) {
    if (item.status === "running") return null;
    const m = /^Exit code (\d+)/.exec(item.output || "");
    return m ? +m[1] : item.status === "error" ? null : item.name === "Bash" ? 0 : null;
  }

  const api = {classOf, fold, words, filesOf, exitOf, mainCommand, inputOf, ICON};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxTools = oxTools;
