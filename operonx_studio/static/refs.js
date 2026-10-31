/* What the assistant's text names (docs/VISUAL_CHAT_PLAN.md D4): inline code
   the model marked, classified against the studio's real state first and by
   its shape second.

     classify(code, world, sentence) → {kind, …}
       file     {path, line, end, touch}   a path in the project's tree
       point    {target}                   a checklist row, plan, phase or question
       op       {name}                     one of the project's ops
       command  {}                         starts with a known executable, or chains / flags
       config   {}                         KEY=…, or a.b with a toml/yaml file in the sentence
       symbol   {}                         name(), Name.attr, a CamelCase name
       code     {}                         anything else: as written

   world = {files: index(paths) | null, root, ops: Set, points: Map(id → target),
            touched: Map(path → "read" | "modified" | "created" | "deleted")}

   A path not in the tree stays code: nothing is guessed into a link. No DOM
   here, so tests/js/refs.test.mjs runs it in node. */
const oxRefs = (() => {
  /* the tree, indexed by base name so a short `triage.py` resolves when one file has that name */
  function index(paths) {
    const all = new Set(paths || []);
    const byBase = new Map();
    for (const p of all) {
      const b = p.slice(p.lastIndexOf("/") + 1);
      (byBase.get(b) || byBase.set(b, []).get(b)).push(p);
    }
    return {all, byBase};
  }

  const LINE = /^(.+?)(?::(\d+)(?:[-:](\d+))?|#L(\d+)(?:-L?(\d+))?)$/;

  // a project-relative path: ./a → a, <root>/a → a
  function rel(path, root) {
    let p = String(path).trim().replace(/^\.\//, "");
    if (root && p.startsWith(root.replace(/\/$/, "") + "/")) p = p.slice(root.replace(/\/$/, "").length + 1);
    return p;
  }

  /* the file a path names in the tree: itself, or the one file whose path ends with it */
  function resolve(path, idx, root) {
    if (!idx || !path || /\s/.test(path)) return null;
    const p = rel(path, root);
    if (idx.all.has(p)) return p;
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (!/\./.test(base)) return null;
    const hits = (idx.byBase.get(base) || []).filter((f) => f === p || f.endsWith("/" + p));
    return hits.length === 1 ? hits[0] : null;
  }

  function file(code, world) {
    const idx = world.files || (world.touched && world.touched.size ? index([...world.touched.keys()]) : null);
    const whole = resolve(code, idx, world.root);
    let path = whole, line = 0, end = 0;
    if (!path) {
      const m = LINE.exec(code);
      if (!m) return null;
      path = resolve(m[1], idx, world.root);
      line = +(m[2] || m[4] || 0);
      end = +(m[3] || m[5] || 0);
    }
    if (!path) return null;
    const touch = (world.touched && world.touched.get(path)) || "";
    return {kind: "file", path, line, end, touch};
  }

  const EXEC = new Set(["git", "pytest", "uv", "uvx", "npm", "npx", "pnpm", "yarn", "python", "python3", "pip", "node",
    "make", "cargo", "go", "docker", "kubectl", "curl", "bash", "sh", "ls", "cd", "cat", "grep", "rg", "sed", "awk",
    "operonx", "ruff", "mypy", "tsc", "vite", "gh", "ssh", "rm", "mv", "cp", "mkdir", "chmod", "export", "source"]);

  function classify(code, world, sentence) {
    const c = String(code || "").trim();
    world = world || {};
    if (!c) return {kind: "code"};
    const target = world.points && world.points.get(c);
    if (target) return {kind: "point", target};
    const f = file(c, world);
    if (f) return f;
    const bare = c.replace(/\(\)$/, "");
    if (world.ops && world.ops.has(bare)) return {kind: "op", name: bare};
    const first = c.split(/\s+/)[0];
    if (EXEC.has(first) && (c === first || /\s/.test(c)) || /&&|\|\||\s--?[a-z]/i.test(c) && /\s/.test(c)) return {kind: "command"};
    if (/^[A-Z][A-Z0-9_]*=/.test(c)) return {kind: "config"};
    if (/^[a-z_][\w-]*(\.[\w-]+)+$/.test(c) && /\.(toml|ya?ml)\b/i.test(sentence || "")) return {kind: "config"};
    if (/^[A-Za-z_][\w.]*\(\)$/.test(c) || /^[A-Z]\w*\.[a-z_]\w*$/.test(c) || /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(c))
      return {kind: "symbol"};
    return {kind: "code"};
  }

  /* studio:file/<path>#L<n>[-<m>] → {path, line, end} */
  function fileHref(href) {
    const m = /^(?:studio:)?file\/([^#]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(String(href || ""));
    return m ? {path: decodeURIComponent(m[1]), line: +(m[2] || 0), end: +(m[3] || 0)} : null;
  }

  /* what this turn did to files, from its facts: tool inputs and the changes item (D7 adds deletes) */
  function touched(items, root) {
    const out = new Map();
    const rank = {read: 1, modified: 2, created: 3, deleted: 4};
    const put = (p, how) => {
      if (!p) return;
      const k = rel(p, root);
      if (!out.has(k) || rank[how] > rank[out.get(k)]) out.set(k, how);
    };
    for (const it of items || []) {
      if (it.kind === "tool") {
        let inp = it.input;
        if (typeof inp === "string") { try { inp = JSON.parse(inp); } catch { inp = null; } }
        if (it.name === "Bash" && inp && it.status !== "error") {
          // a read-class shell call: cat / head / tail / sed -n / wc / less on a file, not into one
          const m = /^(?:cat|head|tail|less|wc|sed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+))\s+(?:-\S+\s+)*(['"]?)([\w./-]+\.\w+)\1\s*$/
            .exec(String(inp.command || "").trim().split(/\s*(?:&&|;)\s*/).filter((c) => !/^cd\b/.test(c))[0] || "");
          if (m) put(m[2], "read");
          continue;
        }
        const p = inp && (inp.file_path || inp.notebook_path);
        if (!p || it.status === "error") continue;
        if (it.name === "Read") put(p, "read");
        else if (/^(Edit|MultiEdit|NotebookEdit)$/.test(it.name)) put(p, "modified");
        else if (it.name === "Write") put(p, "modified");
      } else if (it.kind === "changes") {
        for (const f of it.files || []) put(f.path, f.deleted ? "deleted" : f.new ? "created" : "modified");
      }
    }
    return out;
  }

  const api = {index, classify, resolve, fileHref, touched, rel, EXEC};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxRefs = oxRefs;
