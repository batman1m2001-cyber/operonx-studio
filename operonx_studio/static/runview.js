/* operonx studio — one run: the answer first, then one question at a time.
 *
 * The header answers "was this run OK?" in one line (status, time, cost,
 * LLM calls, tokens, errors) and names the slowest and the most expensive
 * op. On the canvas, a lens picks the ONE thing the cards show — the path
 * taken, time, errors, cost or values — instead of all of them at once.
 * A timeline strip replaces the turn dropdown: turns are segments, and
 * clicking or dragging across them repaints the canvas for that moment.
 * Two runs can be compared op by op.
 *
 * Everything here renders from what /tree and /compare return; the
 * canvas itself stays in studio.js and reads `state.lens`.
 */

"use strict";

const RunView = (() => {
  // the path, and one heat on it; a failed op is marked whatever is
  // picked, and an op's values are in the step panel beside the canvas
  const LENSES = [
    ["path", "Path", "Which ops ran — the rest fade"],
    ["time", "Time", "Each op's time in this run, the three slowest ranked"],
    ["cost", "Cost", "Only ops that cost money"],
  ];

  function money(cost, unpriced) {
    if (cost == null) return unpriced ? "unpriced" : null;
    const txt = cost === 0 ? "$0" : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
    return unpriced ? `${txt} + ${unpriced} unpriced` : txt;
  }
  const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const ordinal = (n) => {
    const v = n % 100;
    return n + (["th", "st", "nd", "rd"][(v - 20) % 10] || ["th", "st", "nd", "rd"][v] || "th");
  };

  /* A fact as a pill: a quiet label and its value (Langfuse's trace and
   * observation headers read this way — latency, cost, tokens at a glance). */
  function pill(value, label, cls, title) {
    const p = el("span", "pill" + (cls ? " " + cls : ""));
    if (label) p.append(el("span", "pill-k", label));
    p.append(el("span", "pill-v", value));
    if (title) p.title = title;
    return p;
  }

  /* A run or step id, with one click to copy it. */
  function copyId(text, title) {
    const b = Icons.button("copy", undefined, "small ghost idcopy", title || "Copy the id");
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast("Copied"); }
      catch { toast(text); }
    };
    return b;
  }

  /* A parked run's questions (its trace's metadata.interrupted), each
   * answered here: Approve, Deny, or any JSON. The answer resumes the run
   * through the project's bridge, which checks the journal still waits;
   * the page then reads the run again, the whole of it. */
  function questions(run, s, mode) {
    const asked = ((s.metadata || {}).interrupted || []);
    const box = el("div", "waitcard");
    const head = el("div", "waitcard-head");
    head.append(el("strong", null, asked.length > 1 ? `Waiting for ${asked.length} answers` : "Waiting for an answer"));
    head.append(el("span", "muted", "The run stopped here and holds nothing while it waits."));
    box.append(head);
    const note = el("div", "waitcard-note");
    const canAnswer = !(window.Account && Account.viewOnly);
    async function send(q, value, buttons) {
      buttons.forEach(b => { b.disabled = true; });
      note.className = "waitcard-note";
      note.textContent = "Sending the answer — the run goes on…";
      let got;
      try {
        got = await api(`/api/p/${PID}/runs/answer`, {run_id: run, answers: {[q.id]: value}});
      } catch (err) {
        note.className = "waitcard-note bad";
        note.textContent = String(err.message || err);
        buttons.forEach(b => { b.disabled = false; });
        return;
      }
      toast(got.status === "interrupted" ? "Answered — it asks again"
        : got.status === "error" ? "Answered — the run failed after it" : "Answered — the run finished");
      return mode === "workflow" ? showRunWorkflow(run) : showRunTree(run);
    }
    for (const q of asked) {
      const item = el("div", "waitq");
      const op = String(q.op || "").replace(/^\./, "").split(".").pop();
      item.append(el("div", "waitq-op", op ? `Question from ${op}` : "The run asks"));
      const payload = el("pre", "waitq-payload");
      payload.textContent = typeof q.payload === "string" ? q.payload : JSON.stringify(q.payload, null, 2);
      item.append(payload);
      if (canAnswer) {
        const row = el("div", "waitq-actions");
        const yes = el("button", "btn primary small", "Approve");
        const no = el("button", "btn small", "Deny");
        const other = el("button", "btn ghost small", "Answer…");
        [yes, no, other].forEach(b => { b.type = "button"; });
        yes.title = 'Answer "approve"';
        no.title = 'Answer "deny"';
        other.title = "Answer with any JSON value";
        const free = el("div", "waitq-free");
        free.hidden = true;
        const text = el("textarea", "mono");
        text.rows = 3;
        text.placeholder = '{"approved": true, "note": "ok"}  — any JSON; plain text is sent as a string';
        text.setAttribute("aria-label", "Your answer, as JSON");
        const go = el("button", "btn primary small", "Send");
        go.type = "button";
        free.append(text, go);
        const all = [yes, no, other, go];
        yes.onclick = () => send(q, "approve", all);
        no.onclick = () => send(q, "deny", all);
        other.onclick = () => { free.hidden = !free.hidden; if (!free.hidden) text.focus(); };
        go.onclick = () => {
          const raw = text.value.trim();
          if (!raw) { text.focus(); return; }
          let value = raw;
          try { value = JSON.parse(raw); } catch { /* plain text: a string */ }
          send(q, value, all);
        };
        row.append(yes, no, other);
        item.append(row, free);
      }
      box.append(item);
    }
    if (!asked.length) box.append(el("div", "muted", "Its questions are not in this trace (recorded by an older operonx)."));
    else if (!canAnswer) box.append(el("div", "muted", "A viewer cannot answer; an editor can."));
    box.append(note);
    return box;
  }

  /* A failed run kept in a journal runs again from its failed op, with the
   * code as it is now: what ended before the failure is not done again
   * (a charge stays charged). The page then reads the run again — the
   * failed attempt and the retry in one run. */
  function retryButton(run, mode) {
    const b = Icons.button("refresh", "Retry from the failure", "small",
      "Run it again from the op that failed, with the code as it is now — the ops that ended before it are not run again");
    b.onclick = async () => {
      b.disabled = true;
      toast("Running it again from the failure…");
      let got;
      try {
        got = await api(`/api/p/${PID}/runs/retry`, {run_id: run});
      } catch (err) {
        b.disabled = false;
        toast(String(err.message || err));
        return;
      }
      toast(got.status === "ok" ? "It went through this time"
        : got.status === "interrupted" ? "It went on, and now waits for an answer"
        : `It failed again${got.error ? `: ${got.error}` : ""}`);
      return mode === "workflow" ? showRunWorkflow(run) : showRunTree(run);
    };
    return b;
  }

  /* The header: title row, the verdict, the two highlights, the origin. */
  function header(run, data, mode, extras) {
    const s = data.summary || {};
    const head = el("div", "tlhead runhead");
    const top = el("div", "runhead-top");
    const back = Icons.button("back", "Runs", "small ghost", "Back to all runs");
    back.onclick = () => showTraces();
    top.append(back, el("span", "tltitle", run), copyId(run, "Copy the run id"));
    const statusSlot = el("span", "runhead-status");
    top.append(statusSlot);
    top.append(viewSwitch(run, mode));
    for (const x of extras || []) top.append(x);
    head.append(top);

    const recs = execsOf(data.rows || []);
    const errs = s.errors != null ? s.errors : recs.filter(r => r.status === "error").length;
    const records = data.errors || [];
    // a run can fail with no failed execution: a structured LLM step that
    // returned `error`, a subgraph failing around its children
    const failed = !!errs || records.length > 0 || s.status === "error";
    // one line of facts under the title, Langfuse's way: plain text, a dot
    // between; the status sits beside the run's name
    const line = el("div", "verdict runfacts");
    // a run still going (or whose process died) has no verdict yet
    const running = s.status === "running";
    // a journalled run parked on a question: neither failed nor done
    const waiting = s.status === "interrupted" && !failed;
    const status = el("span", "pill status " + (running ? "s-run" : waiting ? "s-wait" : failed ? "s-bad" : "s-ok"),
      running ? "running" : waiting ? "waiting" : failed ? "failed" : "ok");
    statusSlot.append(status);
    line.append(pill(fmtMs(s.duration_ms || data.total_ms || 0), "Took"));
    const cost = money(s.cost_usd, s.unpriced);
    if (cost) line.append(pill(cost, "Cost", "p-cost"));
    if (s.llm_calls) line.append(pill(`${s.llm_calls} LLM call${s.llm_calls > 1 ? "s" : ""}`));
    if (s.tokens_in || s.tokens_out) {
      line.append(pill(`${compact(s.tokens_in || 0)} → ${compact(s.tokens_out || 0)}`, "Tokens", null,
        `${s.tokens_in || 0} in, ${s.tokens_out || 0} out${s.tokens_cached ? `, ${s.tokens_cached} cached` : ""}`));
    }
    line.append(pill(`${recs.length} step${recs.length === 1 ? "" : "s"}`));
    const origin = originLine(s);
    if (s.started_at) {
      const at = new Date(s.started_at * 1000);
      line.append(pill(at.toLocaleString([], {hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"}),
        null, null, `Started ${at.toISOString()}`));
    }
    // where it came from (the service, its door, the session, the code) ends the line
    if (origin) line.append(origin);
    if (failed && (s.metadata || {}).durable && ["job", "service", "playground"].includes(s.origin)
        && !(window.Account && Account.viewOnly)) {
      line.append(retryButton(run, mode));
    }
    if (errs) {
      line.append(pill(`${errs} error${errs > 1 ? "s" : ""}`, null, "p-bad"));
      const next = Icons.button("right", "Next error", "small danger", "Select the failed ops one by one");
      next.classList.add("verdict-next");
      next.onclick = () => (mode === "workflow" ? walkErrors() : nextTreeError());
      line.append(next);
    }
    head.append(line);
    if (waiting) head.append(questions(run, s, mode));
    if (records.length) head.append(errorList(records, mode));

    const rolls = data.rollups || [];
    const total = Math.max(1, s.duration_ms || data.total_ms || 1);
    // an op that spans the whole session (a heartbeat, the audio source)
    // is not "slow": its wall time is the call's length, not latency
    // a service that names its key ops (the latencies a caller feels) is
    // read by them; "slowest" of a session is only its longest wait
    const svc = (state.ir && (state.ir.services || []).find(x => x.name === s.service)) || null;
    const keyOps = ((svc && svc.key_ops) || []).map(k => rolls.find(r => r.op === k)).filter(Boolean);
    const slow = keyOps.length ? null : rolls.find(r => !background(r, total));
    const dear = rolls.filter(r => r.cost_usd).sort((a, b) => b.cost_usd - a.cost_usd)[0];
    if (keyOps.length) {
      const hl = el("div", "highlights");
      // on the steps page the label is the filter: only the key ops' steps
      if (mode === "workflow") hl.append(el("span", "hl-k", "Key ops"));
      else {
        const k = el("button", "hl-k hl-keytoggle", "Key ops");
        k.type = "button";
        k.title = "Show only the key ops' steps (again: every step)";
        k.setAttribute("aria-pressed", "false");
        k.onclick = () => RunTree.toggleKey();
        hl.append(k);
      }
      keyOps.forEach((r) => {
        const per = r.count ? r.total_ms / r.count : 0;
        const p = el("span", "pill hl-op");
        p.append(opLink(r.op), el("span", "pill-v", fmtMs(per)));
        // its spread on hover: the line stays one line
        if (r.count > 1) p.title = `${r.op}: average of ${r.count} runs · max ${fmtMs(r.max_ms)}`;
        hl.append(p);
      });
      head.append(hl);
    }
    if (slow || dear) {
      const hl = el("div", "highlights");
      const fact = (label, op, value) => {
        hl.append(el("span", "hl-k", label));
        const p = el("span", "pill hl-op");
        p.append(opLink(op), el("span", "pill-v", value));
        hl.append(p);
      };
      if (slow) fact("Slowest", slow.op, `${fmtMs(slow.total_ms)} (${Math.round(100 * slow.total_ms / total)}%)`);
      if (dear) fact("Most expensive", dear.op, money(dear.cost_usd, 0));
      head.append(hl);
    }
    return head;
  }

  /* One switch for every way to read a run: the conversation (when it was
   * one), the tree of steps, their timeline, and the flow painted with it,
   * as Workflow or Data Flow. The tree page's three and the canvas's two
   * were switches of their own, nested; "Tree" and "Workflow" each said
   * twice. */
  const VIEWS = [
    ["conversation", "Conversation", "Chat", "What was said, in order: a line opens the step that produced it"],
    ["tree", "Tree", "Tree", "What ran for what, in order"],
    ["timeline", "Timeline", "Timeline", "Every step by when it started"],
    ["workflow", "Workflow", "Workflow", "The flow with this run painted on it  ( D )"],
    ["data", "Data Flow", "Data", "What each op read and fed in this run  ( D )"],
  ];
  const TREE_VIEWS = new Set(["conversation", "tree", "timeline"]);
  let switchEl = null;
  const conversations = new Map();

  /* The run's conversation, once per run: its lines, or null when it was
   * not one (both sides must speak; a batch job has neither). */
  function conversation(run) {
    if (!conversations.has(run)) {
      conversations.set(run, api(`/api/p/${PID}/review/run/${encodeURIComponent(run)}`).then((got) => {
        const turns = (got && got.turns) || [];
        return turns.some(t => t.who === "user") && turns.some(t => t.who === "bot") ? turns : null;
      }).catch(() => null));
    }
    return conversations.get(run);
  }

  /* the view on screen: the canvas's when the run is painted on it, else the tree page's */
  function currentView(mode) {
    if (mode === "workflow") return canvasView === "data" ? "data" : "workflow";
    const t = RunTree.current();
    return (t && t.mode) || "tree";
  }

  function openView(run, mode, view) {
    if (TREE_VIEWS.has(view)) {
      if (mode !== "workflow" && RunTree.current() && RunTree.current().run === run) { RunTree.setMode(view); return; }
      store("runTreeMode", view);
      showRunTree(run);
      return;
    }
    if (mode === "workflow") { setCanvasView(view); return; }
    if (canvasView !== view) { canvasView = view; store(`canvasView:${PID}`, view); showViewSeg(); }
    showRunWorkflow(run);
  }

  function viewSwitch(run, mode) {
    const box = el("span", "tlmodes runviews");
    box.setAttribute("role", "tablist");
    box.setAttribute("aria-label", "Read the run as");
    for (const [key, label, short, title] of VIEWS) {
      // a phone's narrower words (the canvas switch's way)
      const b = el("button");
      b.append(el("span", "vlong", label), el("span", "vshort", short));
      b.setAttribute("aria-label", label);
      b.type = "button";
      b.title = title;
      b.dataset.view = key;
      b.setAttribute("role", "tab");
      b.onclick = () => openView(run, mode, key);
      // the conversation is offered once its lines say it was one
      if (key === "conversation") b.hidden = true;
      box.append(b);
    }
    switchEl = {box, mode, run};
    conversation(run).then((turns) => {
      if (!turns || !box.isConnected) return;
      box.querySelector('[data-view="conversation"]').hidden = false;
    });
    syncViews();
    return box;
  }

  function syncViews() {
    // (the header is marked while it is being built, before it is on the page)
    if (!switchEl) return;
    const on = currentView(switchEl.mode);
    for (const b of switchEl.box.querySelectorAll("button[data-view]")) {
      b.classList.toggle("on", b.dataset.view === on);
      b.setAttribute("aria-selected", String(b.dataset.view === on));
    }
  }

  /* What failed, one line per op: its type, the op (a link to the
   * execution that failed first), how many times, the last line of the
   * error; the traceback — the user's frames only — folds under it. */
  function errorList(records, mode) {
    const box = el("div", "errlist");
    box.setAttribute("aria-label", "Errors");
    for (const e of records) {
      const item = el("details", "erritem");
      const sum = el("summary");
      sum.append(el("span", "errtype mono", e.type || "Error"));
      const go = el("button", "linkbtn mono", e.name || e.op);
      go.type = "button";
      go.title = e.op_id ? `Open the execution that failed first (${e.first_ctx})` : `Select ${e.op}`;
      go.onclick = (ev) => { ev.preventDefault(); focusExec(e, mode); };
      sum.append(go);
      if (e.count > 1) {
        const n = el("span", "errcount", `×${e.count}`);
        n.title = `${e.op} failed ${e.count} times in this run`;
        sum.append(n);
      }
      sum.append(el("span", "errlast mono", errorLine(e.message, e.type)));
      item.append(sum);
      const pre = el("pre", "errtrace mono", String(e.message || "").trim());
      item.append(pre);
      box.append(item);
    }
    return box;
  }

  /* The exception's own line, without its type (shown beside it): the
   * last line that is not indented — an exception whose message spans
   * lines (operonx's PromptError) indents the rest under it. */
  function errorLine(message, type) {
    const lines = String(message || "").trim().split("\n").filter(l => l.trim() && !/^\s/.test(l));
    const last = lines.length ? lines[lines.length - 1] : "";
    const prefix = new RegExp(`^(?:[\\w.]*\\.)?${String(type || "").replace(/\W/g, "")}: `);
    return type ? last.replace(prefix, "") : last;
  }

  /* an error's execution: its tree row by trace id, else its op */
  function focusExec(e, mode) {
    if (mode !== "workflow" && e.op_id && RunTree.selectId(e.op_id)) return;
    focusOp(e.name || e.op);
  }

  function opLink(op) {
    const b = el("button", "linkbtn mono", op);
    b.type = "button";
    b.title = "Select it";
    b.onclick = () => focusOp(op);
    return b;
  }

  /* select an op wherever the run is showing — a tree row, or a card */
  function focusOp(op) {
    if (state.workflowOn) {
      let found = [...state.rendered.values()].find(x => x.node.name === op);
      if (!found) { expandAll(true); found = [...state.rendered.values()].find(x => x.node.name === op); }
      if (found) { select(found.key); centerOn(found); }
      return;
    }
    RunTree.selectOp(op);
  }

  function nextTreeError() {
    RunTree.nextError();
  }

  /* A session-long op: one or two executions spanning most of the run —
   * a heartbeat, a stream source. Its time is the session's, not work. */
  function background(roll, totalMs) {
    if (!roll) return false;
    // a generator's time is every yield's wait summed over the session
    // (a prompt stream that waits for silence): not latency
    const node = irNodeByName(roll.op);
    if (node && node.is_gen && roll.total_ms >= 0.5 * totalMs) return true;
    return roll.count <= 2 && totalMs > 0 && roll.total_ms >= 0.8 * totalMs;
  }

  /* The lens control: which one thing the cards show. */
  function lensBar() {
    const bar = el("span", "tlmodes lensbar");
    bar.setAttribute("role", "radiogroup");
    bar.setAttribute("aria-label", "What the cards show");
    const current = state.lens || "path";
    for (const [key, label, title] of LENSES) {
      const b = el("button", key === current ? "on" : "", label);
      b.type = "button";
      b.title = title;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(key === current));
      b.onclick = () => {
        state.lens = key;
        store("lens", key);
        for (const x of bar.children) {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-checked", String(x === b));
        }
        render();
        // errors and cost point at a few ops: bring the first into view
        if (key === "errors" || key === "cost") {
          const card = document.querySelector(key === "errors" ? "#nodes .node.errorlit" : "#nodes .node .badge.cost");
          const name = card && (card.closest(".node") || card).dataset.name;
          const it = name && [...state.rendered.values()].find(x => x.node.name === name);
          if (it) centerOn(it);
        }
      };
      bar.append(b);
    }
    return bar;
  }

  /* The timeline strip: the run's turns as segments on one time axis.
   * Click or drag across it to paint that turn; the reset shows the
   * whole run. */
  function timeline(turns, totalMs, onPick) {
    const wrap = el("div", "tlstrip");
    if (!turns || !turns.length) { wrap.hidden = true; return wrap; }
    const whole = el("button", "tlwhole on", "Whole run");
    whole.type = "button";
    const track = el("div", "tltrack");
    track.setAttribute("role", "listbox");
    track.setAttribute("aria-label", "Turns");
    const total = Math.max(1, totalMs);
    const segs = [];
    const pick = (key) => {
      whole.classList.toggle("on", !key);
      for (const s of segs) s.classList.toggle("on", s.dataset.key === key);
      onPick(key || null);
    };
    turns.forEach((t, i) => {
      const seg = el("div", "tlseg");
      seg.dataset.key = t.key;
      seg.style.left = `${(100 * t.start_ms / total).toFixed(3)}%`;
      seg.style.width = `${Math.max(0.6, 100 * (t.end_ms - t.start_ms) / total).toFixed(3)}%`;
      seg.title = `${t.label} · ${fmtMs(t.end_ms - t.start_ms)} · ${t.count} executions`;
      seg.setAttribute("role", "option");
      if (i % 2) seg.classList.add("alt");
      segs.push(seg);
      track.append(seg);
    });
    // click or drag: the segment under the pointer is the turn painted
    let down = false;
    const at = (ev) => {
      const x = ev.clientX;
      const hit = segs.find(s => { const r = s.getBoundingClientRect(); return x >= r.left && x <= r.right; });
      if (hit && !hit.classList.contains("on")) pick(hit.dataset.key);
    };
    track.addEventListener("pointerdown", (ev) => { down = true; track.setPointerCapture(ev.pointerId); at(ev); });
    track.addEventListener("pointermove", (ev) => { if (down) at(ev); });
    track.addEventListener("pointerup", () => { down = false; });
    whole.onclick = () => pick(null);
    const label = el("span", "tllabel", `${turns.length} turn${turns.length > 1 ? "s" : ""}`);
    const axis = el("div", "tlaxis");
    axis.append(el("span", null, "0"), el("span", null, fmtMs(total)));
    const body = el("div", "tlbody");
    body.append(track, axis);
    wrap.append(label, whole, body);
    return wrap;
  }

  /* What stands out about one execution among its op's executions. */
  function anomalies(e, mine) {
    const flags = [];
    if (e.status === "error") flags.push(["bad", "Failed"]);
    const durs = mine.map(x => x.dur_ms || 0).sort((a, b) => a - b);
    const median = durs.length ? durs[Math.floor((durs.length - 1) / 2)] : 0;
    if (mine.length >= 3 && median > 0 && (e.dur_ms || 0) > 3 * median)
      flags.push(["warn", `${((e.dur_ms || 0) / median).toFixed(1)}× slower than this op's median`]);
    const outs = e.outputs || {};
    const textKeys = Object.keys(outs).filter(k => typeof outs[k] === "string");
    for (const k of textKeys) {
      if (outs[k] !== "") continue;
      const usually = mine.filter(x => x !== e && x.outputs && typeof x.outputs[k] === "string" && x.outputs[k] !== "").length;
      if (usually > mine.length / 2) flags.push(["warn", `Empty ${k} — usually has text`]);
    }
    if (outs.model_used && outs.model_requested && outs.model_used !== outs.model_requested)
      flags.push(["warn", `Fell back to ${outs.model_used}`]);
    return flags;
  }

  function rank(e, mine) {
    if (mine.length < 2) return null;
    const sorted = [...mine].sort((a, b) => (b.dur_ms || 0) - (a.dur_ms || 0));
    const i = sorted.indexOf(e) + 1;
    return i === 1 ? `the slowest of ${mine.length}` : `${ordinal(i)} slowest of ${mine.length}`;
  }

  /* The op's other executions as dots on one duration axis. */
  function dots(e, mine, onPick) {
    const box = el("div", "rundots");
    const max = Math.max(1, ...mine.map(x => x.dur_ms || 0));
    for (const x of mine.slice(0, 400)) {
      const d = el("button", "rundot" + (x === e ? " on" : "") + (x.status === "error" ? " bad" : ""));
      d.type = "button";
      d.style.left = `${(100 * (x.dur_ms || 0) / max).toFixed(2)}%`;
      d.title = `${fmtMs(x.dur_ms || 0)} · +${fmtMs(x.start_ms)}${x.ctx ? " · " + x.ctx : ""}`;
      d.setAttribute("aria-label", d.title);
      d.onclick = () => onPick(x);
      box.append(d);
    }
    const axis = el("div", "tlaxis");
    axis.append(el("span", null, "0"), el("span", null, fmtMs(max)));
    const wrap = el("div");
    wrap.append(box, axis);
    return wrap;
  }

  /* Two runs, op by op. */
  async function compare(a, b) {
    leaveWorkflow();
    const box = $("#traces");
    box.textContent = "";
    state.tracesView = {};
    const mine = state.tracesView;
    box.append(el("div", "note", "Comparing…"));
    let data;
    try { data = await api(`/api/p/${PID}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); }
    catch (e) { box.textContent = ""; box.append(el("div", "errbox", e.message)); return; }
    if (state.tracesView !== mine) return;
    box.textContent = "";
    const top = el("div", "runhead-top");
    const back = Icons.button("back", "Runs", "small ghost", "Back to all runs");
    back.onclick = () => showTraces();
    top.append(back, el("h2", "cmptitle", "Compare runs"));
    box.append(top);

    const cards = el("div", "cmpcards");
    for (const [label, s] of [["A", data.a], ["B", data.b]]) {
      const c = el("div", "cmpcard");
      const h = el("div", "cmpcardhead");
      h.append(el("span", "cmpbadge", label));
      const open = el("button", "linkbtn mono", s.trace_id);
      open.type = "button";
      open.onclick = () => showRunTree(s.trace_id);
      h.append(open);
      c.append(h);
      const facts = [fmtMs(s.duration_ms || 0), s.status === "error" ? "failed" : s.status === "running" ? "running" : "ok"];
      const cost = money(s.cost_usd, s.unpriced);
      if (cost) facts.push(cost);
      if (s.version) facts.push(`@${String(s.version).slice(0, 7)}${s.version_dirty ? "*" : ""}`);
      if (s.started_at) facts.push(fmtWhen(s.started_at * 1000));
      c.append(el("div", "cmpfacts", facts.join(" · ")));
      cards.append(c);
    }
    box.append(cards);
    const d = data.d_ms || 0;
    box.append(el("p", "cmpsum", d === 0 ? "Same total time."
      : `B took ${fmtMs(Math.abs(d))} ${d > 0 ? "longer" : "less"} than A${data.a.duration_ms ? ` (${d > 0 ? "+" : "−"}${Math.round(100 * Math.abs(d) / data.a.duration_ms)}%)` : ""}.`));

    const wrap = el("div", "tablewrap");
    const table = el("table", "datatable cmptable");
    const hr = el("tr");
    for (const [h, cls] of [["Op"], ["A", "num"], ["B", "num"], ["Change", "num"], ["Cost A", "num hide-sm"], ["Cost B", "num hide-sm"]])
      hr.append(el("th", cls || null, h));
    const thead = el("thead"); thead.append(hr); table.append(thead);
    const tbody = el("tbody");
    for (const r of data.ops) {
      const tr = el("tr");
      tr.append(el("td", "mono", r.op));
      const side = (x) => el("td", "num" + (x ? "" : " dim"), x ? `${fmtMs(x.total_ms)}${x.count > 1 ? ` ×${x.count}` : ""}` : "did not run");
      tr.append(side(r.a), side(r.b));
      const delta = el("td", "num");
      if (r.d_ms != null) {
        const pct = r.a.total_ms ? r.d_ms / r.a.total_ms : 0;
        delta.textContent = Math.abs(r.d_ms) < 0.05 ? "—" : `${r.d_ms > 0 ? "+" : "−"}${fmtMs(Math.abs(r.d_ms))}`;
        // colour only a change that matters: 20% of the op AND 5 ms
        if (Math.abs(pct) >= 0.2 && Math.abs(r.d_ms) >= 5) delta.classList.add(r.d_ms > 0 ? "worse" : "better");
      } else {
        delta.textContent = r.a ? "only in A" : "only in B";
        delta.classList.add("dim");
      }
      tr.append(delta);
      tr.append(el("td", "num hide-sm", r.a ? money(r.a.cost_usd, r.a.unpriced) || "—" : ""));
      tr.append(el("td", "num hide-sm", r.b ? money(r.b.cost_usd, r.b.unpriced) || "—" : ""));
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    box.append(wrap);
    box.append(codeDiff(a, b, data.a, data.b));
  }

  /* What changed in the code between the two runs: git diff between the
   * commits they recorded, asked for only when opened. */
  function codeDiff(a, b, sa, sb) {
    const sec = el("section", "cmpcode");
    const short = (v) => String(v || "").slice(0, 7);
    const dirty = [[sa, "A"], [sb, "B"]].filter(([s]) => s.version_dirty).map(([, l]) => l);
    const dirtyNote = dirty.length
      ? el("div", "note", `Run ${dirty.join(" and ")} ran with uncommitted changes, which no commit holds — they are not in this diff.`)
      : null;
    sec.append(el("div", "stitle", "Code"));
    if (!sa.version || !sb.version) {
      sec.append(el("div", "note", "A run did not record its commit, so the code cannot be compared."));
      return sec;
    }
    if (sa.version === sb.version) {
      sec.append(el("div", "note", `Same commit (${short(sa.version)}).`));
      if (dirtyNote) sec.append(dirtyNote);
      return sec;
    }
    const open = el("button", null, `Show what changed: ${short(sa.version)} → ${short(sb.version)}`);
    open.type = "button";
    sec.append(open);
    if (dirtyNote) sec.append(dirtyNote);
    open.onclick = async () => {
      open.disabled = true;
      let d;
      try { d = await api(`/api/p/${PID}/compare/code?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`); }
      catch (e) { open.replaceWith(el("div", "errbox", e.message)); return; }
      const body = el("div", "cmpcodebody");
      if (d.why) body.append(el("div", "note", d.why));
      else if (!d.files.length) body.append(el("div", "note", "No change in this project's files between the two commits."));
      if ((d.commits || []).length) {
        const log = el("div", "cmpcommits");
        for (const c of d.commits) {
          const row = el("div", "cmpcommit");
          row.append(el("span", "mono", c.sha), el("span", null, c.subject));
          log.append(row);
        }
        body.append(log);
      }
      for (const f of d.files) {
        const det = el("details", "cmpfile");
        const sum = el("summary");
        sum.append(el("span", "mono", f.path));
        sum.append(el("span", "cmpfile-n add", f.added == null ? "binary" : `+${f.added}`));
        if (f.removed != null) sum.append(el("span", "cmpfile-n del", `−${f.removed}`));
        det.append(sum);
        const pre = el("pre", "mono cmppatch");
        // git's own header lines repeat the file's name above them
        const lines = String(f.patch || "").split("\n").filter(l => !/^(diff --git |index |--- |\+\+\+ |similarity |rename |new file|deleted file)/.test(l));
        for (const line of lines) {
          const cls = line.startsWith("+") && !line.startsWith("+++") ? "add"
            : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : null;
          pre.append(el("span", cls ? `pl ${cls}` : "pl", line));
        }
        det.append(pre);
        body.append(det);
      }
      if (d.truncated) body.append(el("div", "note", "The diff is long: the rest is cut. Run git diff for all of it."));
      open.replaceWith(body);
      if (d.files.length === 1) body.querySelector("details").open = true;
    };
    return sec;
  }

  function render() {
    if (state.workflowOn) { window.render(); }
  }

  state.lens = recall("lens", "path");
  if (!LENSES.some(([k]) => k === state.lens)) state.lens = "path";   // a retired lens (errors, values)
  return {header, conversation, syncViews, pill, copyId, lensBar, timeline, anomalies, rank, dots, compare, money, focusOp, focusExec, background, LENSES};
})();
