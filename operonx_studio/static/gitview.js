/* operonx studio — Project mode › Git (docs/WORKSPACE_PLAN.md W2).
 *
 * The repo as the owner works it (operonx_studio/gitview.py): what changed and is not committed, staged and
 * not, with line diffs; commit as the project's identity; fetch, pull, push; the history as a graph, a commit
 * the assistant made for a card marked with it; the branches (switch, merge, rebase, delete), the remotes and
 * worktrees; the open pull requests. Whatever would drop work or push to a protected branch asks first.
 */

const GitPage = (() => {
  const enc = encodeURIComponent;
  const K = () => `git:${PID}`;
  let host = null;
  let timer = null;
  let st = null;          // the last status
  let commits = [];
  let prs = null;
  let v = null;           // {tab, cwd, sel: {path, staged} | {commit}}
  const TABS = {changes: "Changes", history: "History", branches: "Branches", prs: "Pull requests"};

  function button(cls, text, onclick, title) {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.onclick = onclick;
    return b;
  }
  const save = () => store(K(), v);
  const q = (extra) => `cwd=${enc(v.cwd || "")}${extra ? `&${extra}` : ""}`;
  const ago = (t) => {
    const s = Math.max(0, Date.now() / 1000 - t);
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  };

  async function mount(page) {
    host = page;
    v = Object.assign({tab: "changes", cwd: "", sel: null}, recall(K(), {}));
    page.textContent = "";
    page.append(el("p", "pm-quiet", "Reading the repo…"));
    try { await load(); }
    catch (err) {
      if (host !== page) return;
      v.cwd = ""; save();
      page.textContent = "";
      page.append(el("p", "pm-quiet", (err.data || {}).error || err.message));
      return;
    }
    if (host !== page) return;
    draw();
    clearInterval(timer);
    timer = setInterval(tick, 5000);
  }
  function unmount() { clearInterval(timer); timer = null; host = null; }

  async function load() {
    st = await api(`/api/p/${PID}/repo?${q()}`);
    if (v.tab === "history") commits = (await api(`/api/p/${PID}/repo/log?${q("n=200")}`)).commits;
  }
  async function tick() {
    if (!host || document.hidden) return;
    const typing = host.contains(document.activeElement) && /TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName);
    if (typing) return;
    const before = JSON.stringify(st);
    try { await load(); } catch { return; }
    if (JSON.stringify(st) !== before) draw();
  }

  async function act(body, busy) {
    const say = host.querySelector(".gv-said");
    if (busy) busy.disabled = true;
    say.className = "gv-said"; say.textContent = `${body.op}…`;
    try {
      let got = await api(`/api/p/${PID}/repo`, {cwd: v.cwd, ...body});
      if (got.needs_confirm) {
        if (!confirm(got.needs_confirm)) { say.textContent = ""; return null; }
        got = await api(`/api/p/${PID}/repo`, {cwd: v.cwd, ...body, confirm: true});
      }
      st = {...st, ...got.status};
      if (v.tab === "history") commits = (await api(`/api/p/${PID}/repo/log?${q("n=200")}`)).commits;
      draw();
      const line = (got.said || "").trim().split("\n").filter(Boolean).slice(-2).join(" · ");
      const s2 = host.querySelector(".gv-said");
      s2.textContent = line ? `${body.op}: ${line}` : `${body.op}: done`;
      return got;
    } catch (err) {
      say.className = "gv-said err";
      say.textContent = (err.data || {}).error || err.message;
      return null;
    } finally { if (busy) busy.disabled = false; }
  }

  /* ── the head: where, the branch, the remote's buttons ────────────── */
  function draw() {
    if (!host) return;
    const keep = host.querySelector(".gv-msg");
    const msg = keep ? keep.value : "";
    host.textContent = "";
    const head = el("div", "pm-pagehead gv-head");
    head.append(el("h2", "pm-title", "Git"));
    const br = el("span", "gv-branch", st.branch || `detached ${st.sha}`);
    br.title = st.upstream ? `tracks ${st.upstream}` : "no upstream: Push sets one";
    head.append(br);
    if (st.ahead) head.append(el("span", "chip", `↑${st.ahead}`));
    if (st.behind) head.append(el("span", "chip warn", `↓${st.behind}`));
    if (st.places.length > 1) {
      const where = el("select", "tm-where");
      where.title = "The checkout or one of its worktrees";
      for (const p of st.places) where.append(new Option(p === st.places[0] ? "checkout" : p.split("/").slice(-2).join("/"), p));
      where.value = st.cwd;
      where.onchange = () => { v.cwd = where.value; v.sel = null; save(); mount(host); };
      head.append(where);
    }
    const tools = el("span", "gv-tools");
    const fetchB = button("pm-chip", "Fetch", () => act({op: "fetch"}, fetchB), "git fetch --all --prune");
    const pullB = button("pm-chip", "Pull", () => act({op: "pull"}, pullB), "git pull --ff-only");
    const pushB = button("pm-chip", "Push", () => act({op: "push"}, pushB),
      st.protected.includes(st.branch) ? `${st.branch} is protected: asks first` : "git push");
    tools.append(fetchB, pullB, pushB);
    head.append(tools);
    host.append(head);
    if (st.state) {
      const bar = el("div", "gv-state");
      const n = st.files.filter((f) => f.conflict).length;
      bar.append(el("b", null, st.state), el("span", null, n ? ` · ${n} conflicted file(s): fix them, stage them, then Continue` : " · ready to continue"));
      bar.append(button("pm-chip", "Continue", (e) => act({op: "continue"}, e.target)),
        button("pm-chip", "Abort", (e) => confirm(`Abort the ${st.state.replace(/ing$/, "")}?`) && act({op: "abort"}, e.target)));
      host.append(bar);
    }
    const tabs = el("div", "gv-tabs");
    for (const [k, label] of Object.entries(TABS)) {
      let text = label;
      if (k === "changes" && st.files.length) text += ` ${st.files.length}`;
      tabs.append(button("pm-chip" + (v.tab === k ? " on" : ""), text, async () => {
        v.tab = k; v.sel = null; save();
        if (k === "history") { try { commits = (await api(`/api/p/${PID}/repo/log?${q("n=200")}`)).commits; } catch { commits = []; } }
        draw();
      }));
    }
    tabs.append(el("span", "gv-said"));
    host.append(tabs);
    const grid = el("div", "pm-fgrid gv-grid");
    const left = el("div", "pm-ftree gv-left");
    const right = el("div", "pm-fview gv-right");
    grid.append(left, right);
    host.append(grid);
    if (v.tab === "changes") changes(left, right, msg);
    else if (v.tab === "history") history(left, right);
    else if (v.tab === "branches") branches(left, right);
    else pulls(left, right);
  }

  /* ── Changes: conflicts, staged, not staged; the commit box ─────── */
  function changes(left, right, msg) {
    const groups = [
      ["Conflicts", st.files.filter((f) => f.conflict), false],
      ["Staged", st.files.filter((f) => f.staged && !f.conflict), true],
      ["Changes", st.files.filter((f) => f.unstaged && !f.conflict), false],
    ];
    if (!st.files.length) left.append(el("p", "pm-quiet gv-pad", "Nothing changed since the last commit."));
    for (const [name, files, staged] of groups) {
      if (!files.length) continue;
      const h = el("div", "gv-group");
      h.append(el("span", null, `${name} · ${files.length}`));
      const paths = files.map((f) => f.path);
      if (name === "Staged") h.append(button("linkbtn", "Unstage all", () => act({op: "unstage", paths})));
      else h.append(button("linkbtn", "Stage all", () => act({op: "stage", paths})));
      left.append(h);
      for (const f of files) {
        const row = el("div", "pm-frow gv-file" + (v.sel && v.sel.path === f.path && !!v.sel.staged === staged ? " on" : ""));
        const letter = f.conflict ? "!" : f.untracked ? "U" : staged ? f.x : f.y;
        row.append(el("span", `gv-x x-${letter === "?" ? "U" : letter}`, letter === "?" ? "U" : letter));
        const name = el("span", "pm-fname", f.path);
        name.title = f.orig ? `${f.orig} → ${f.path}` : f.path;
        row.append(name);
        if (staged) row.append(button("gv-act", "−", (e) => { e.stopPropagation(); act({op: "unstage", paths: [f.path]}); }, "Unstage"));
        else {
          if (!f.conflict) row.append(button("gv-act", "↺", (e) => { e.stopPropagation(); act({op: "discard", paths: [f.path]}); }, "Discard the change (asks; a copy is kept)"));
          row.append(button("gv-act", "+", (e) => { e.stopPropagation(); act({op: "stage", paths: [f.path]}); }, f.conflict ? "Mark resolved (stage)" : "Stage"));
        }
        row.onclick = () => { v.sel = {path: f.path, staged}; save(); draw(); };
        left.append(row);
      }
    }
    const box = el("div", "gv-commit");
    const ta = el("textarea", "gv-msg");
    ta.rows = 3;
    ta.placeholder = "What this commit does";
    ta.value = msg;
    const nstaged = st.files.filter((f) => f.staged).length;
    const who = st.identity ? `as ${st.identity.name} <${st.identity.email}>` : "set Commit as in Settings › Git first";
    const go = button("primary", nstaged ? `Commit ${nstaged} staged` : "Commit all changes", async () => {
      const got = await act({op: "commit", message: ta.value, all: !nstaged}, go);
      if (got) { const t = host.querySelector(".gv-msg"); if (t) t.value = ""; }
    }, who);
    go.disabled = !st.files.length || !st.identity;
    box.append(ta, go, el("span", "gv-who", who));
    if (st.stash) box.append(button("linkbtn", `Pop the stash (${st.stash})`, () => act({op: "stash_pop"})));
    if (st.files.length) box.append(button("linkbtn", "Stash all", () => act({op: "stash"}), "Put every change aside (git stash -u)"));
    left.append(box);
    if (v.sel && v.sel.path) showDiff(right, `path=${enc(v.sel.path)}&staged=${v.sel.staged ? "true" : "false"}`, v.sel.path);
    else right.append(el("p", "pm-quiet", "Pick a file to see its change."));
  }

  async function showDiff(right, query, title) {
    right.textContent = "";
    const head = el("div", "pm-fhead");
    head.append(el("span", "pm-fpath", title));
    right.append(head, el("p", "pm-quiet", "Reading…"));
    let got;
    try { got = await api(`/api/p/${PID}/repo/diff?${q(query)}`); }
    catch (err) { right.lastChild.textContent = (err.data || {}).error || err.message; return; }
    right.lastChild.remove();
    right.append(paint(got.diff || "(no change)"));
    if (got.cut) right.append(el("p", "pm-quiet", "Cut: the change is longer than the page shows."));
  }

  function paint(text) {
    const pre = el("pre", "gv-diff");
    for (const line of text.split("\n")) {
      let cls = "";
      if (line.startsWith("@@")) cls = "hunk";
      else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) cls = "meta";
      else if (line.startsWith("+")) cls = "add";
      else if (line.startsWith("-")) cls = "del";
      pre.append(el("span", cls ? `gl ${cls}` : "gl", line + "\n"));
    }
    return pre;
  }

  /* ── History: the commits as a graph ───────────────────────────── */
  function lanes(list) {
    let cur = [];
    let width = 1;
    const rows = list.map((c) => {
      const before = cur.slice();
      let col = before.indexOf(c.sha);
      if (col < 0) { col = before.indexOf(null); if (col < 0) col = before.length; }
      const after = before.map((s) => (s === c.sha ? null : s));
      after[col] = c.parents[0] || null;
      for (const p of c.parents.slice(1)) {
        if (after.includes(p)) continue;
        let free = after.indexOf(null);
        if (free < 0) free = after.length;
        after[free] = p;
      }
      while (after.length && after[after.length - 1] === null) after.pop();
      cur = after;
      width = Math.max(width, before.length, after.length, col + 1);
      return {c, col, before, after};
    });
    return {rows, width: Math.min(width, 12)};
  }

  function graphCell(r, width) {
    const W = 12, H = 26, M = H / 2;
    const x = (i) => 7 + Math.min(i, 11) * W;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(width * W + 6));
    svg.setAttribute("height", String(H));
    svg.classList.add("gv-graph");
    const line = (x1, y1, x2, y2, i) => {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
      p.setAttribute("class", `ln c${i % 6}`);
      svg.append(p);
    };
    r.before.forEach((s, i) => { if (s !== null) line(x(i), 0, s === r.c.sha ? x(r.col) : x(i), M, s === r.c.sha ? r.col : i); });
    r.after.forEach((s, j) => {
      if (s === null) return;
      if (r.c.parents.includes(s) && (j === r.col || !r.before.includes(s))) line(x(r.col), M, x(j), H, j);
      else line(x(j), M, x(j), H, j);
    });
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", String(x(r.col)));
    dot.setAttribute("cy", String(M));
    dot.setAttribute("r", r.c.parents.length > 1 ? "3" : "4");
    dot.setAttribute("class", `dot c${r.col % 6}${r.c.parents.length > 1 ? " merge" : ""}`);
    svg.append(dot);
    return svg;
  }

  function history(left, right) {
    left.classList.add("gv-hist");
    if (!commits.length) left.append(el("p", "pm-quiet gv-pad", "No commits yet."));
    const {rows, width} = lanes(commits);
    for (const r of rows) {
      const c = r.c;
      const row = el("div", "gv-crow" + (v.sel && v.sel.commit === c.sha ? " on" : ""));
      row.dataset.oxTarget = `commit:${c.sha}`;
      row.append(graphCell(r, width));
      const text = el("span", "gv-csub");
      for (const ref of c.refs) {
        const name = ref.replace(/^HEAD -> /, "");
        const kind = ref.startsWith("HEAD") ? "head" : ref.startsWith("tag: ") ? "tag" : name.includes("/") ? "remote" : "local";
        text.append(el("span", `gv-ref ${kind}`, name.replace(/^tag: /, "")));
      }
      if (c.card) { const k = el("span", "chip", c.card); k.title = "made by the assistant for this card"; text.append(k); }
      text.append(document.createTextNode(c.subject));
      row.append(text, el("span", "gv-cmeta", `${c.sha.slice(0, 7)} · ${c.author} · ${ago(c.at)}`));
      row.title = `${c.sha} · ${c.author} · ${new Date(c.at * 1000).toLocaleString()}`;
      row.onclick = () => { v.sel = {commit: c.sha}; save(); draw(); };
      left.append(row);
    }
    if (v.sel && v.sel.commit) showDiff(right, `commit=${enc(v.sel.commit)}`, v.sel.commit);
    else right.append(el("p", "pm-quiet", "Pick a commit to see it."));
  }

  /* ── Branches: switch, merge, rebase, delete; remotes; worktrees ── */
  function branches(left, right) {
    const nb = el("div", "gv-commit gv-nb");
    const name = el("input", "pm-search");
    name.placeholder = "new-branch-name";
    const mk = button("primary", "New branch", () => name.value.trim() && act({op: "branch", name: name.value.trim()}, mk),
      `A branch from ${st.branch || "here"}, switched to`);
    nb.append(name, mk);
    left.append(nb, el("div", "gv-group", `Local · ${st.branches.length}`));
    for (const b of st.branches) {
      const row = el("div", "pm-frow gv-file" + (b.current ? " on" : ""));
      row.append(el("span", "pm-fname", b.name));
      if (b.ahead) row.append(el("span", "chip", `↑${b.ahead}`));
      if (b.behind) row.append(el("span", "chip warn", `↓${b.behind}`));
      if (b.gone) row.append(el("span", "chip", "upstream gone"));
      row.title = `${b.sha} ${b.subject}${b.upstream ? `\ntracks ${b.upstream}` : ""}`;
      row.onclick = () => { v.sel = {branch: b.name}; save(); draw(); };
      left.append(row);
    }
    left.append(el("div", "gv-group", `Remote · ${st.remote_branches.length}`));
    for (const b of st.remote_branches) {
      const row = el("div", "pm-frow gv-file");
      row.append(el("span", "pm-fname", b.name), el("span", "gv-cmeta", ago(b.at)));
      row.title = `${b.sha} ${b.subject}`;
      row.onclick = () => { v.sel = {branch: b.name, remote: true}; save(); draw(); };
      left.append(row);
    }
    const info = el("div", "gv-pad");
    info.append(el("h3", "pm-h", "Remotes"));
    for (const r of st.remotes) info.append(el("div", "gv-cmeta", `${r.name} · ${r.url}`));
    if (!st.remotes.length) info.append(el("p", "pm-quiet", "No remote."));
    info.append(el("h3", "pm-h", "Worktrees"));
    for (const p of st.places) info.append(el("div", "gv-cmeta", p === st.places[0] ? `${p} (the checkout)` : p));
    const sel = v.sel && v.sel.branch ? [...st.branches, ...st.remote_branches].find((b) => b.name === v.sel.branch) : null;
    if (sel) {
      const card = el("div", "gv-bcard");
      card.append(el("h3", "pm-h", sel.name), el("p", "gv-cmeta", `${sel.sha} · ${sel.subject} · ${ago(sel.at)}`));
      const here = st.branch;
      const acts = el("div", "gv-tools");
      if (!sel.current) {
        const target = v.sel.remote ? sel.name.split("/").slice(1).join("/") : sel.name;
        acts.append(button("pm-chip", "Switch to it", (e) => act({op: "switch", branch: target}, e.target),
          v.sel.remote ? `A local ${target} tracking ${sel.name}` : "git switch (refused if it would overwrite uncommitted work)"));
        if (here) {
          acts.append(button("pm-chip", `Merge into ${here}`, (e) => confirm(`Merge ${sel.name} into ${here}?`) && act({op: "merge", branch: sel.name}, e.target)));
          acts.append(button("pm-chip", `Rebase ${here} onto it`, (e) => confirm(`Rebase ${here} onto ${sel.name}? Its commits are rewritten.`) && act({op: "rebase", onto: sel.name}, e.target)));
        }
        if (!v.sel.remote) acts.append(button("pm-chip", "Delete", (e) => confirm(`Delete ${sel.name}? (refused if not merged)`) && act({op: "delete_branch", branch: sel.name}, e.target)));
      } else acts.append(el("span", "pm-quiet", "the branch you are on"));
      card.append(acts);
      right.append(card);
    }
    right.append(info);
  }

  /* ── Pull requests ─────────────────────────────────────────────── */
  async function pulls(left, right) {
    left.append(el("p", "pm-quiet gv-pad", "Reading the pull requests…"));
    const form = el("div", "gv-pad gv-prform");
    form.append(el("h3", "pm-h", `Open a pull request from ${st.branch || "this branch"}`));
    const title = el("input", "pm-search");
    title.placeholder = "Title";
    const body = el("textarea", "gv-msg");
    body.rows = 5;
    body.placeholder = "What it changes and why";
    const base = el("input", "pm-search");
    base.placeholder = "base branch (empty: the repo's default)";
    const go = button("primary", "Open the pull request", async () => {
      const got = await act({op: "pr", title: title.value, body: body.value, base: base.value.trim()}, go);
      if (got) { prs = null; pulls(host.querySelector(".gv-left"), host.querySelector(".gv-right")); }
    }, "gh pr create; push the branch first");
    form.append(title, body, base, go);
    right.textContent = "";
    right.append(form);
    try { prs = prs || await api(`/api/p/${PID}/repo/prs`); }
    catch (err) { prs = {prs: [], error: (err.data || {}).error || err.message}; }
    if (!host || v.tab !== "prs") return;
    left.textContent = "";
    if (prs.error) left.append(el("p", "pm-quiet gv-pad", prs.error));
    else if (!prs.prs.length) left.append(el("p", "pm-quiet gv-pad", "No open pull request."));
    for (const p of prs.prs) {
      const row = el("a", "gv-crow gv-pr");
      row.href = p.url; row.target = "_blank"; row.rel = "noopener";
      row.append(el("span", "gv-csub", `#${p.number} ${p.title}${p.isDraft ? " (draft)" : ""}`),
        el("span", "gv-cmeta", `${p.headRefName} → ${p.baseRefName} · ${(p.author || {}).login || ""}`));
      left.append(row);
    }
  }

  return {mount, unmount};
})();
