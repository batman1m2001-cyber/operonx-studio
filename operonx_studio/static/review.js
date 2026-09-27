/* operonx studio — Review: read runs as conversations, judge them, move on.
 *
 * The queue is the project's runs (by origin and name, unreviewed first);
 * a run reads as what the user said and what the product answered, not as
 * a trace tree. Good or bad, labels, a note — saved beside the runs with
 * who wrote it — and the next run opens. A bad run is one click from a
 * dataset case. Keys: g good · b bad · j / k next / previous.
 */

"use strict";

const ReviewView = (() => {
  const box = $("#review");
  const K = `review:${PID}`;
  const v = Object.assign({verdict: "unreviewed", target: "", run: ""}, recall(K, {}));
  let queue = [];
  let token = 0;
  let current = null;       // {run, review, turns, summary}
  const save = () => store(K, v);

  async function show() {
    const mine = ++token;
    const [origin, name] = v.target ? v.target.split(":") : ["", ""];
    let got, groups;
    try {
      [got, groups] = await Promise.all([
        api(`/api/p/${PID}/review/queue?verdict=${v.verdict}&origin=${origin}&name=${encodeURIComponent(name || "")}&limit=200&open=${encodeURIComponent(v.run || "")}`),
        api(`/api/p/${PID}/runs/groups`).catch(() => ({groups: []})),
      ]);
    } catch (err) { box.textContent = ""; box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    queue = got.runs;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Review"));
    const pick = el("select", "montarget");
    pick.setAttribute("aria-label", "Which runs");
    const opt = (label, value) => { const o = el("option", null, label); o.value = value; o.selected = value === v.target; pick.append(o); };
    opt("Every run", "");
    for (const g of (groups.groups || [])) if (g.origin && g.name) opt(`${g.origin} · ${g.name}`, `${g.origin}:${g.name}`);
    pick.onchange = () => { v.target = pick.value; v.run = ""; save(); show(); };
    const modes = el("span", "tlmodes");
    for (const [k, label] of [["unreviewed", `To review ${got.counts.unreviewed}`], ["bad", `Bad ${got.counts.bad}`], ["good", `Good ${got.counts.good}`], ["all", "All"]]) {
      const b = el("button", k === v.verdict ? "on" : "", label);
      b.type = "button";
      b.onclick = () => { v.verdict = k; v.run = ""; save(); show(); };
      modes.append(b);
    }
    head.append(pick, modes);
    box.append(head);

    const grid = el("div", "revgrid");
    const list = el("div", "revlist");
    const main = el("div", "revmain");
    grid.append(list, main);
    box.append(grid);
    if (!queue.length) {
      list.append(el("div", "note", v.verdict === "unreviewed" ? "Nothing left to review here." : "No runs."));
      main.append(paneNote(v.verdict === "unreviewed" ? "All caught up" : "Nothing here",
        "Pick other runs above, or come back when more have been recorded."));
      return;
    }
    for (const r of queue) {
      const row = el("button", "revrow" + (r.run === v.run ? " sel" : ""));
      row.type = "button";
      row.dataset.run = r.run;
      const verdict = (r.review || {}).verdict;
      row.append(el("span", "revdot " + (verdict || (r.status === "error" ? "err" : ""))),
                 el("span", "revid mono", r.run.slice(0, 13)),
                 el("span", "revwhat", `${r.origin} · ${r.name}${r.key ? " · " + r.key : ""}`),
                 el("span", "revwhen", fmtAgo(r.started_at * 1000)));
      row.onclick = () => open(r.run);
      list.append(row);
    }
    if (!queue.find(r => r.run === v.run)) v.run = queue[0].run;
    await open(v.run, main, got.detail && got.detail.run === v.run ? got.detail : null);
  }

  async function open(run, mainEl, pre) {
    v.run = run;
    save();
    const main = mainEl || box.querySelector(".revmain");
    for (const r of box.querySelectorAll(".revrow")) r.classList.toggle("sel", r.dataset.run === run);
    box.querySelector(".revrow.sel")?.scrollIntoView({block: "nearest"});
    let got = pre;
    if (!got) {
      try { got = await api(`/api/p/${PID}/review/run/${encodeURIComponent(run)}`); }
      catch (err) { main.textContent = ""; main.append(el("div", "errbox", err.message)); return; }
    }
    current = {run, ...got};
    main.textContent = "";
    const s = got.summary;
    const top = el("div", "revtop");
    top.append(el("span", "status " + (s.status === "error" ? "s-bad" : "s-ok"), s.status === "error" ? "failed" : "ok"),
               el("b", "mono", s.run), el("span", "note", `${s.origin} · ${s.name} · ${fmtAgo(s.started_at * 1000)} · ${fmtMs(s.duration_ms)}`));
    const openRun = el("button", "linkbtn", "Open the trace");
    openRun.type = "button";
    openRun.onclick = () => performUi("open_run", {run: s.run, quiet: true});
    top.append(openRun);
    main.append(top);
    if (s.first_error) main.append(el("div", "errbox", s.first_error));

    const convo = el("div", "playlog revconvo");
    if (!got.turns.length) convo.append(el("div", "note", "Nothing said was recorded in this run — open the trace to read it."));
    for (const t of got.turns) {
      const b = el("div", `chat-msg ${t.who === "user" ? "from-me" : "from-bot"}`);
      b.append(el("span", null, t.text));
      b.append(el("span", "revop mono", t.op));
      convo.append(b);
    }
    main.append(convo);

    // the verdict, labels, a note
    const rev = got.review || {};
    const form = el("div", "revform");
    const vb = el("div", "revverdict");
    let verdict = rev.verdict || null;
    const good = el("button", "revgood" + (verdict === "good" ? " on" : ""), "Good");
    const bad = el("button", "revbad" + (verdict === "bad" ? " on" : ""), "Bad");
    good.type = bad.type = "button";
    good.title = "Good  (g)"; bad.title = "Bad  (b)";
    const paint = () => { good.classList.toggle("on", verdict === "good"); bad.classList.toggle("on", verdict === "bad"); };
    good.onclick = () => { verdict = verdict === "good" ? null : "good"; paint(); };
    bad.onclick = () => { verdict = verdict === "bad" ? null : "bad"; paint(); };
    vb.append(good, bad);
    const labels = el("input", "mono");
    labels.placeholder = "labels, comma separated — e.g. wrong-intent, too-slow";
    labels.value = (rev.labels || []).join(", ");
    labels.setAttribute("aria-label", "Labels");
    const note = el("textarea", "playjson revnote");
    note.placeholder = "What went wrong, or right — for whoever fixes it";
    note.value = rev.note || "";
    note.setAttribute("aria-label", "Note");
    const acts = el("div", "priceacts");
    const saveBtn = el("button", "primary", "Save & next");
    saveBtn.type = "button";
    const ds = el("button", null, "Add to dataset…");
    ds.type = "button";
    acts.append(saveBtn, ds);
    const who = el("div", "note", rev.user ? `Last reviewed by ${rev.user} · ${fmtAgo(rev.at * 1000)}` : "");
    form.append(vb, labels, note, acts, who);
    main.append(form);

    const persist = () => api(`/api/p/${PID}/review/run/${encodeURIComponent(run)}`,
                              {verdict, labels: labels.value, note: note.value});
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try { await persist(); toast(verdict ? `Marked ${verdict}` : "Saved"); }
      catch (err) { toast(err.message, true); saveBtn.disabled = false; return; }
      const i = queue.findIndex(r => r.run === run);
      const next = queue[i + 1];
      if (v.verdict === "unreviewed" && verdict) {
        queue.splice(i, 1);
        box.querySelector(`.revrow[data-run="${CSS.escape(run)}"]`)?.remove();
      }
      if (next) open(next.run); else show();
    };
    ds.onclick = async () => {
      let names = [];
      try { names = (await api(`/api/p/${PID}/evals`)).datasets.map(x => x.name); } catch { /* a new one */ }
      const name = prompt(`Add this run to which dataset?${names.length ? `\n(existing: ${names.join(", ")})` : ""}`, names[0] || "reviewed");
      if (!name) return;
      try {
        await persist();
        const got2 = await api(`/api/p/${PID}/review/run/${encodeURIComponent(run)}/dataset`, {dataset: name.trim()});
        toast(got2.added.length ? `Added a case to ${name}` : `${name} already has this case`);
      } catch (err) { toast(err.message, true); }
    };
    current.mark = (x) => { verdict = x; paint(); };
    current.focus = () => labels.focus();
  }

  // g good · b bad · j / k next / previous — never while typing
  document.addEventListener("keydown", (ev) => {
    if (box.hidden || !current || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((ev.target || {}).tagName || "")) return;
    const i = queue.findIndex(r => r.run === current.run);
    if (ev.key === "g") current.mark("good");
    else if (ev.key === "b") current.mark("bad");
    else if (ev.key === "j" && queue[i + 1]) open(queue[i + 1].run);
    else if (ev.key === "k" && i > 0) open(queue[i - 1].run);
    else return;
    ev.preventDefault();
  });

  registerPane("review", {el: box, show});
  return {show};
})();
