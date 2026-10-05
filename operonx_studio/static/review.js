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
  let queues = {queues: []};   // operonx [[queue]]s, for the picker
  let lastSpec = null;          // the queue shown, in queue mode
  let token = 0;
  let current = null;       // {run, review, turns, summary}
  const save = () => store(K, v);

  async function show() {
    if (v.target.startsWith("queue:")) return showQueue(v.target.slice(6));
    const mine = ++token;
    const [origin, name] = v.target ? v.target.split(":") : ["", ""];
    let got, groups;
    try {
      [got, groups, queues] = await Promise.all([
        api(`/api/p/${PID}/review/queue?verdict=${v.verdict}&origin=${origin}&name=${encodeURIComponent(name || "")}&limit=200&open=${encodeURIComponent(v.run || "")}`),
        api(`/api/p/${PID}/runs/groups`).catch(() => ({groups: []})),
        api(`/api/p/${PID}/review/queues`).catch(() => ({queues: []})),
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
    addQueueOptions(pick, opt);
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
    vb.classList.add("needs-edit");
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
    acts.classList.add("needs-edit");
    if (window.Account) Account.readonly(labels, note);
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

  const go = (r) => v.target.startsWith("queue:") ? openItem(r.item_id, lastSpec) : open(r.run);

  // g good · b bad · j / k next / previous — never while typing
  document.addEventListener("keydown", (ev) => {
    if (box.hidden || !current || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((ev.target || {}).tagName || "")) return;
    const i = queue.findIndex(r => r.run === current.run);
    if (ev.key === "g") current.mark("good");
    else if (ev.key === "b") current.mark("bad");
    else if (ev.key === "j" && queue[i + 1]) go(queue[i + 1]);
    else if (ev.key === "k" && i > 0) go(queue[i - 1]);
    else return;
    ev.preventDefault();
  });

  // The picker's review queues (operonx [[queue]]), after the run groups.
  function addQueueOptions(pick, opt) {
    const qs = queues.queues || [];
    if (qs.length) {
      const g = el("optgroup"); g.label = "Review queues";
      for (const q of qs) {
        const o = el("option", null, `${q.name} — ${q.waiting} waiting`);
        o.value = `queue:${q.name}`; o.selected = o.value === v.target; g.append(o);
      }
      pick.append(g);
    }
    pick.onchange = () => { v.target = pick.value; v.run = ""; save(); show(); };
  }

  // A review queue: its items still waiting (or all), each read as the run
  // it points at; the verdict and rubric are written as operonx scores.
  async function showQueue(name) {
    const mine = ++token;
    let got;
    try {
      [got, queues] = await Promise.all([
        api(`/api/p/${PID}/review/queues/${encodeURIComponent(name)}?open=${encodeURIComponent(v.run || "")}&done=${v.verdict === "all"}`),
        api(`/api/p/${PID}/review/queues`).catch(() => ({queues: []})),
      ]);
    } catch (err) { box.textContent = ""; box.append(loadError(err, () => { v.target = ""; save(); show(); })); return; }
    if (mine !== token) return;
    const spec = got.queue;
    lastSpec = spec;
    queue = got.items.map(it => ({...it, run: it.item_id}));
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Review"));
    const pick = el("select", "montarget");
    pick.setAttribute("aria-label", "Which runs");
    const opt = (label, value) => { const o = el("option", null, label); o.value = value; pick.append(o); };
    opt("Every run", "");
    addQueueOptions(pick, opt);
    const modes = el("span", "tlmodes");
    for (const [k, label] of [["unreviewed", `Waiting ${got.waiting}`], ["all", "All"]]) {
      const b = el("button", (k === "all") === (v.verdict === "all") ? "on" : "", label);
      b.type = "button";
      b.onclick = () => { v.verdict = k; v.run = ""; save(); show(); };
      modes.append(b);
    }
    head.append(pick, modes);
    box.append(head);
    const sub = `Each item needs ${spec.reviewers} reviewer${spec.reviewers > 1 ? "s" : ""}; a review is saved as a score `
      + "(source human), where judges are measured against it.";
    box.append(el("p", "panesub", spec.description ? `${spec.description} — ${sub}` : sub));

    const grid = el("div", "revgrid");
    const list = el("div", "revlist");
    const main = el("div", "revmain");
    grid.append(list, main);
    box.append(grid);
    if (!queue.length) {
      list.append(el("div", "note", "Nothing waits in this queue."));
      main.append(paneNote("All caught up", "An online eval sends its failing runs here; "
        + "`operonx eval queue add` adds runs by hand."));
      return;
    }
    for (const it of queue) {
      const row = el("button", "revrow" + (it.item_id === v.run ? " sel" : ""));
      row.type = "button";
      row.dataset.run = it.item_id;
      row.append(el("span", "revdot " + (it.reviewed_by.length ? "good" : "")),
                 el("span", "revid mono", (it.trace_id || it.session_id || it.item_id).slice(0, 13)),
                 el("span", "revwhat", it.reason || it.source || it.target),
                 el("span", "revwhen", it.reviewed_by.length ? `${it.reviewed_by.length}/${spec.reviewers}` : fmtAgo(it.added_at * 1000)));
      row.onclick = () => openItem(it.item_id, spec);
      list.append(row);
    }
    if (!queue.find(r => r.item_id === v.run)) v.run = queue[0].item_id;
    await openItem(v.run, spec, main, got.detail && got.detail.item_id === v.run ? got.detail : null);
  }

  async function openItem(itemId, spec, mainEl, pre) {
    v.run = itemId;
    save();
    const it = queue.find(r => r.item_id === itemId);
    const main = mainEl || box.querySelector(".revmain");
    for (const r of box.querySelectorAll(".revrow")) r.classList.toggle("sel", r.dataset.run === itemId);
    main.textContent = "";
    let got = pre;
    if (!got && it.trace_id) {
      try { got = await api(`/api/p/${PID}/review/run/${encodeURIComponent(it.trace_id)}`); }
      catch (err) { main.append(el("div", "errbox", err.message)); }
    }
    current = {run: itemId};
    if (got) {
      const s = got.summary;
      const top = el("div", "revtop");
      top.append(el("span", "status " + (s.status === "error" ? "s-bad" : "s-ok"), s.status === "error" ? "failed" : "ok"),
                 el("b", "mono", s.run), el("span", "note", `${s.origin} · ${s.name} · ${fmtAgo(s.started_at * 1000)}`));
      const openRun = el("button", "linkbtn", "Open the trace");
      openRun.type = "button";
      openRun.onclick = () => performUi("open_run", {run: s.run, quiet: true});
      top.append(openRun);
      main.append(top);
      const convo = el("div", "playlog revconvo");
      if (!got.turns.length) convo.append(el("div", "note", "Nothing said was recorded in this run — open the trace to read it."));
      for (const t of got.turns) {
        const b = el("div", `chat-msg ${t.who === "user" ? "from-me" : "from-bot"}`);
        b.append(el("span", null, t.text), el("span", "revop mono", t.op));
        convo.append(b);
      }
      main.append(convo);
    } else if (!it.trace_id) {
      main.append(el("div", "note", `This item points at a ${it.target}; review it from the CLI (operonx eval queue).`));
    }
    if (it.reason) main.append(el("div", "note", `Why it is here: ${it.reason}`));

    const form = el("div", "revform");
    const vb = el("div", "revverdict needs-edit");
    let verdict = null;
    const good = el("button", "revgood", "Good"), bad = el("button", "revbad", "Bad");
    good.type = bad.type = "button";
    const paint = () => { good.classList.toggle("on", verdict === "good"); bad.classList.toggle("on", verdict === "bad"); };
    good.onclick = () => { verdict = verdict === "good" ? null : "good"; paint(); };
    bad.onclick = () => { verdict = verdict === "bad" ? null : "bad"; paint(); };
    vb.append(good, bad);
    form.append(vb);
    const answers = {};
    for (const [q, kind] of Object.entries(spec.rubric || {})) {
      const line = el("label", "revrubric");
      line.append(el("span", null, q));
      let input;
      if (kind === "bool") {
        input = el("select"); for (const [l, x] of [["—", ""], ["yes", "true"], ["no", "false"]]) { const o = el("option", null, l); o.value = x; input.append(o); }
      } else {
        input = el("input", "mono"); if (kind === "numeric") input.type = "number";
        input.placeholder = kind;
      }
      input.onchange = () => { answers[q] = input.value; };
      line.append(input);
      form.append(line);
    }
    const labels = el("input", "mono");
    labels.placeholder = "labels, comma separated";
    labels.setAttribute("aria-label", "Labels");
    const note = el("textarea", "playjson revnote");
    note.placeholder = "What went wrong, or right";
    note.setAttribute("aria-label", "Note");
    const acts = el("div", "priceacts needs-edit");
    const saveBtn = el("button", "primary", "Save & next");
    saveBtn.type = "button";
    acts.append(saveBtn);
    if (window.Account) Account.readonly(labels, note);
    const who = el("div", "note", it.reviewed_by.length ? `Reviewed by ${it.reviewed_by.join(", ")}` : "");
    form.append(labels, note, acts, who);
    main.append(form);
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        await api(`/api/p/${PID}/review/queues/${encodeURIComponent(spec.name)}/review`,
                  {item_id: itemId, verdict, labels: labels.value, note: note.value, rubric: answers});
        toast(verdict ? `Marked ${verdict}` : "Saved");
      } catch (err) { toast(err.message, true); saveBtn.disabled = false; return; }
      const i = queue.findIndex(r => r.item_id === itemId);
      const next = queue[i + 1];
      if (next) openItem(next.item_id, spec); else show();
    };
    current.mark = (x) => { verdict = x; paint(); };
  }

  registerPane("review", {el: box, show});
  return {show};
})();
