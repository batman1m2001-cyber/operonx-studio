/* operonx studio — the Playground: toys on a service's doors.
 *
 * A toy drives one door of a declared service the way a client would:
 * Chat holds a session open and sends text, Form sends one JSON payload
 * and shows the reply. The run happens in a bridge process under the
 * project's own interpreter (operonx.app.play), through the service's
 * real door ops, gate and trace consumers — so every session is a real
 * run, filed under origin=playground, that can be opened or replayed.
 *
 * Events (opened, out, ended, refused) are polled by cursor while the
 * pane is on screen; re-runs of one op (the run view's "Re-run") wait on
 * the same stream by request id.
 */

"use strict";

const PlayView = (() => {
  const box = $("#playground");
  const K = `play:${PID}`;
  const v = Object.assign({service: "", toy: ""}, recall(K, {}));
  let doors = null;
  let cursor = null;
  let polling = false;
  const waiters = new Map();          // rerun request id → resolve
  const early = new Map();            // results that beat their waiter (a fast op answers
                                      // before the POST that asked for it has returned)
  const sessions = new Map();         // sid → {service, toy, t0, events, ended}
  let chatSid = null;                 // the chat session on screen
  let ui = null;                      // the rendered pane's live parts

  const save = () => store(K, v);
  const door = () => (doors || []).find(d => d.service === v.service);
  const short = (x, n = 90) => { const s = typeof x === "string" ? x : JSON.stringify(x); return s.length > n ? s.slice(0, n) + "…" : s; };

  /* ── the event stream ── */
  async function startPolling() {
    if (polling) return;
    polling = true;
    try {
      if (cursor == null) cursor = (await api(`/api/p/${PID}/play/events`)).cursor;
      while (!box.hidden || waiters.size) {
        let got;
        try { got = await api(`/api/p/${PID}/play/events?cursor=${cursor}`); }
        catch { await new Promise(r => setTimeout(r, 1500)); continue; }
        cursor = got.cursor;
        for (const e of got.events) dispatch(e);
        if (ui) ui.status(got);
      }
    } finally { polling = false; }
  }

  function dispatch(e) {
    if (e.t === "rerun" && e.id) {
      if (waiters.has(e.id)) { waiters.get(e.id)(e); waiters.delete(e.id); }
      else { early.set(e.id, e); if (early.size > 20) early.delete(early.keys().next().value); }
      return;
    }
    if (e.t === "bridge_restart" || e.t === "bridge_exit") { if (ui) ui.note(e); return; }
    const s = sessions.get(e.sid);
    if (!s) return;
    s.events.push(e);
    if (e.t === "ended" || e.t === "refused") s.ended = e;
    if (ui) ui.event(e, s);
  }

  /* one op, again — for the run view; resolves with the bridge's answer */
  async function rerun(run, op, inputs) {
    if (cursor == null) cursor = (await api(`/api/p/${PID}/play/events`)).cursor;
    const {rid} = await api(`/api/p/${PID}/play/rerun`, {run, op, inputs});
    if (early.has(rid)) { const e = early.get(rid); early.delete(rid); return e; }
    const done = new Promise((resolve) => waiters.set(rid, resolve));
    startPolling();
    return done;
  }

  /* ── sessions ── */
  async function open(body) {
    if (cursor == null) cursor = (await api(`/api/p/${PID}/play/events`)).cursor;
    const {sid} = await api(`/api/p/${PID}/play/open`, body);
    sessions.set(sid, {service: body.service, toy: body.toy, t0: Date.now(), events: [], ended: null});
    startPolling();
    return sid;
  }

  function queryOf() {
    const q = {};
    for (const row of (ui && ui.queryRows()) || []) if (row.k) q[row.k] = row.v;
    v.query = v.query || {};
    v.query[v.service] = q;
    save();
    return q;
  }

  /* ── rendering ── */
  async function show() {
    box.textContent = "";
    ui = null;
    const head = el("div", "panehead playhead");
    head.append(el("h2", null, "Playground"));
    box.append(head);
    const loading = el("div", "note", "Starting the playground…");
    box.append(loading);
    try {
      doors = (await api(`/api/p/${PID}/play/doors`)).doors;
    } catch (err) {
      loading.replaceWith(paneNote("The playground could not start", err.message));
      return;
    }
    loading.remove();
    const usable = doors.filter(d => d.toys.length);
    if (!doors.length) {
      box.append(paneNote("No services to play with",
        "The playground drives a service's doors. Declare one with [[serve]] in operonx.toml, or Service(...) in Python."));
      return;
    }
    if (!door()) v.service = (usable[0] || doors[0]).service;
    const d = door();
    if (!d.toys.includes(v.toy)) v.toy = d.toys[0] || "";
    save();

    const pick = el("select", "montarget");
    pick.setAttribute("aria-label", "Service");
    for (const x of doors) {
      const o = el("option", null, x.toys.length ? x.service : `${x.service} (no toy)`);
      o.value = x.service;
      o.selected = x.service === v.service;
      pick.append(o);
    }
    pick.onchange = () => { v.service = pick.value; chatSid = null; save(); show(); };
    const toys = el("span", "tlmodes");
    for (const t of d.toys) {
      const b = el("button", t === v.toy ? "on" : "", t === "chat" ? "Chat" : t === "form" ? "Form" : t);
      b.type = "button";
      b.onclick = () => { v.toy = t; save(); show(); };
      toys.append(b);
    }
    const state = el("span", "playstate");
    const restart = Icons.button("refresh", undefined, "", "Restart the playground (reloads the project's code)");
    restart.onclick = async () => {
      restart.disabled = true;
      try { await api(`/api/p/${PID}/play/restart`, {}); toast("Playground restarted"); }
      catch (err) { toast(err.message, true); }
      restart.disabled = false;
    };
    head.append(pick, toys, state, restart);

    const desc = el("div", "playdoor");
    desc.append(el("span", "mono", `${d.kind}${d.kind === "http" ? " POST" : ""} ${d.path || ""}`),
                el("span", "vsep", "·"),
                el("span", null, d.session === "per_connection" ? "one run per session" : "one run per request"));
    if (d.description) desc.append(el("span", "vsep", "·"), el("span", null, d.description));
    box.append(desc);

    if (!d.toys.length) {
      box.append(paneNote("This door has no toy",
        d.codec_error ? `Its playground codec failed to load: ${d.codec_error}`
          : "Its transport speaks a protocol of its own. Declare a codec that translates toy messages for it:",
        d.codec_error ? null : `Service("${d.service}", ..., playground=MyCodec)   # operonx.app.play.Codec`));
      return;
    }

    const grid = el("div", "playgrid");
    const main = el("div", "playmain");
    const side = el("div", "playside");
    grid.append(main, side);
    box.append(grid);

    // the connection: what on_session sees as the query string
    const conn = el("details", "playconn");
    conn.open = !(v.query && v.query[d.service] && Object.keys(v.query[d.service]).length) && !!d.inputs.length;
    conn.append(el("summary", null, d.custom_hook ? "Connection — query the service's on_session hook reads"
                                                   : "Connection — the graph's inputs, as the query string"));
    const rows = el("div", "playrows");
    const saved = (v.query && v.query[d.service]) || {};
    const keys = [...new Set([...(d.custom_hook ? [] : d.inputs), ...Object.keys(saved)])];
    const rowEls = [];
    const addRow = (k = "", val = "") => {
      const r = el("div", "playrow");
      const ki = el("input", "mono"); ki.value = k; ki.placeholder = "key"; ki.setAttribute("aria-label", "Query key");
      const vi = el("input", "mono"); vi.value = val; vi.placeholder = "value"; vi.setAttribute("aria-label", "Query value");
      r.append(ki, vi);
      rows.append(r);
      rowEls.push([ki, vi]);
    };
    for (const k of keys) addRow(k, saved[k] ?? "");
    if (!keys.length) addRow();
    const more = el("button", "linkbtn", "+ add a key");
    more.type = "button";
    more.onclick = () => addRow();
    conn.append(rows, more);
    main.append(conn);

    // the events column, and recent sessions under it
    const evHead = el("div", "stitle", "Events");
    const evList = el("div", "playevents");
    evList.append(el("div", "note", "What the door sends that is not a reply, and each session's start and end."));
    const recent = el("div", "playrecent");
    side.append(evHead, evList, el("div", "stitle", "Recent sessions"), recent);

    ui = {
      queryRows: () => rowEls.map(([k, x]) => ({k: k.value.trim(), v: x.value})),
      status(got) {
        state.textContent = got.alive ? (got.live.length ? `${got.live.length} live` : "ready") : "stopped";
        state.className = "playstate " + (got.alive ? "on" : "");
      },
      note(e) {
        evRow(e.t === "bridge_exit" ? "stopped" : "restart", e.t === "bridge_exit" ? `the bridge exited: ${e.text || ""}` : e.reason || "restarted", "", e.t === "bridge_exit");
      },
      event(e, s) {
        // offsets on the bridge's clock, from the session's first event
        if (s.at0 == null) s.at0 = e.at;
        const at = `+${Math.max(0, e.at - s.at0).toFixed(2)}s`;
        if (e.t === "opened") evRow("opened", `${s.toy || ""} session on ${s.service}`, at);
        else if (e.t === "refused") evRow("refused", e.reason, at, true);
        else if (e.t === "out" && !(s.toy === "chat" && e.msg.kind === "text")) evRow(e.msg.kind, short(e.msg.value ?? e.msg.text ?? `${e.msg.size} bytes`), at);
        else if (e.t === "ended") evEnded(e, at);
        if (s.render) s.render(e);
      },
    };

    function evRow(kind, text, at, bad) {
      const r = el("div", "playev" + (bad ? " bad" : ""));
      r.append(el("span", "evat mono", at || ""), el("span", "evkind", kind), el("span", "evtext mono", text || ""));
      if (evList.firstChild && evList.firstChild.classList.contains("note")) evList.textContent = "";
      evList.append(r);
      evList.scrollTop = evList.scrollHeight;
      return r;
    }
    function evEnded(e, at) {
      const r = evRow("ended", e.status === "error" ? (e.error || "failed") : `ok · ${fmtMs(e.ms)}`, at, e.status === "error");
      const acts = el("span", "evacts");
      const openBtn = el("button", "linkbtn", "Open run");
      openBtn.type = "button";
      openBtn.onclick = () => performUi("open_run", {run: e.trace_id, quiet: true});
      const replay = el("button", "linkbtn", "Replay");
      replay.type = "button";
      replay.onclick = () => replayRun(e.trace_id);
      acts.append(openBtn, replay);
      r.append(acts);
      // the store rescans at most every 2 s; ask again once it has
      setTimeout(loadRecent, 2200);
    }

    async function loadRecent() {
      let got;
      try { got = await api(`/api/p/${PID}/runs?origin=playground&name=${encodeURIComponent(d.service)}&limit=8`); }
      catch { return; }
      recent.textContent = "";
      if (!got.runs.length) { recent.append(el("div", "note", "Sessions you run here are kept 7 days.")); return; }
      for (const r of got.runs) {
        const md = r.metadata || {};
        const row = el("div", "playrun");
        const what = md.toy === "rerun" ? `re-run of ${md.op}`
          : `${md.replay_of ? "replay" : md.toy || "session"} · ${(md.playground_script || []).length} sent`;
        row.append(el("span", "status " + (r.status === "error" ? "s-bad" : "s-ok"), r.status === "error" ? "failed" : "ok"),
                   el("span", "prwhat", what), el("span", "prwhen", fmtAgo(r.started_at * 1000)));
        const acts = el("span", "evacts");
        const o = el("button", "linkbtn", "Open"); o.type = "button";
        o.onclick = () => performUi("open_run", {run: r.trace_id, quiet: true});
        acts.append(o);
        if (md.playground_script) {
          const rp = el("button", "linkbtn", "Replay"); rp.type = "button";
          rp.onclick = () => replayRun(r.trace_id, md);
          acts.append(rp);
        }
        // one message in, the reply out: that is a case for an eval
        if ((md.playground_script || []).filter(m => m.kind !== "bytes").length === 1 && r.status !== "error") {
          const add = el("button", "linkbtn", "Add to dataset"); add.type = "button";
          add.onclick = () => addForm(row, r.trace_id, add);
          acts.append(add);
        }
        row.append(acts);
        recent.append(row);
      }
    }

    async function addForm(row, run, btn) {
      if (row.querySelector(".playadd")) return;
      btn.disabled = true;
      let names = [];
      try { names = (await api(`/api/p/${PID}/evals`)).datasets.map(x => x.name); } catch { /* a new one, then */ }
      const form = el("div", "playadd");
      const pick = el("select");
      pick.setAttribute("aria-label", "Dataset");
      for (const n of names) { const o = el("option", null, n); o.value = n; pick.append(o); }
      const other = el("option", null, "New dataset…"); other.value = ""; pick.append(other);
      const fresh = el("input"); fresh.type = "text"; fresh.placeholder = "dataset name";
      fresh.setAttribute("aria-label", "New dataset name");
      fresh.hidden = names.length > 0;
      pick.onchange = () => { fresh.hidden = pick.value !== ""; if (!fresh.hidden) fresh.focus(); };
      const exp = el("label");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
      exp.append(cb, "the reply is the expected output");
      const go = el("button", "primary", "Add"); go.type = "button";
      const cancel = el("button", "linkbtn", "Cancel"); cancel.type = "button";
      cancel.onclick = () => { form.remove(); btn.disabled = false; };
      go.onclick = async () => {
        const name = pick.value || fresh.value.trim();
        if (!name) { fresh.focus(); return; }
        go.disabled = true;
        try {
          const got = await api(`/api/p/${PID}/datasets/${encodeURIComponent(name)}/rows`, {from_run: run, expected: cb.checked});
          toast(got.added.length ? `Added a case to ${name}` : `${name} already has this case`);
          form.remove(); btn.disabled = false;
        } catch (err) { toast(err.message, true); go.disabled = false; }
      };
      form.append(pick, fresh, exp, go, cancel);
      row.append(form);
    }

    async function replayRun(run, md) {
      try {
        const sid = await open({replay_of: run, service: d.service, toy: (md && md.toy) || v.toy});
        const s = sessions.get(sid);
        if (s && v.toy === "chat" && chatView) chatView.attach(sid, s, (md && md.playground_script) || []);
        toast("Replaying with the current code");
      } catch (err) { toast(err.message, true); }
    }

    let chatView = null;
    if (v.toy === "chat") chatView = chatToy(main, d);
    else formToy(main, d);
    loadRecent();
    startPolling();
  }

  /* Chat: one session held open; each message is one item on the door. */
  function chatToy(main, d) {
    const wrap = el("div", "playchat");
    const log = el("div", "playlog");
    const bar = el("div", "playbar");
    const sess = el("div", "playsess");
    const form = el("form", "playcompose");
    const input = el("input", "chat-input");
    input.placeholder = "Say something to the service…";
    input.setAttribute("aria-label", "Message");
    const send = Icons.button("send", undefined, "chat-send", "Send");
    send.type = "submit";
    form.append(input, send);
    bar.append(sess, form);
    wrap.append(log, bar);
    main.append(wrap);

    const bubble = (who, text, cls) => {
      const b = el("div", `chat-msg ${who === "me" ? "from-me" : "from-bot"} ${cls || ""}`, text);
      log.append(b);
      log.scrollTop = log.scrollHeight;
      return b;
    };
    const empty = el("div", "note playempty",
      d.session === "per_connection" ? "Your first message opens a session; it stays open until you end it."
                                     : "Each message is its own request.");
    log.append(empty);

    const paintSess = () => {
      sess.textContent = "";
      const s = chatSid && sessions.get(chatSid);
      if (s && !s.ended) {
        sess.append(el("span", "livedot"), el("span", null, "Session live"));
        const end = el("button", "linkbtn", "End session");
        end.type = "button";
        end.onclick = () => api(`/api/p/${PID}/play/end`, {sid: chatSid}).catch(() => {});
        sess.append(end);
      } else if (s && s.ended) {
        sess.append(el("span", null, s.ended.t === "refused" ? "Refused" : `Session ended · ${s.ended.status === "error" ? "failed" : "ok"}`));
        if (s.ended.trace_id) {
          const o = el("button", "linkbtn", "Open run"); o.type = "button";
          o.onclick = () => performUi("open_run", {run: s.ended.trace_id, quiet: true});
          sess.append(o);
        }
        const again = el("button", "linkbtn", "New session"); again.type = "button";
        again.onclick = () => { chatSid = null; log.textContent = ""; paintSess(); input.focus(); };
        sess.append(again);
      }
    };

    // a stream of text items (TTS chunks, tokens) reads as one reply:
    // items that follow within 400 ms join the same bubble, which says
    // how many items it holds — the frame boundaries stay visible
    let run = null;
    const render = (e) => {
      if (e.t === "out") {
        empty.remove();
        if (e.msg.kind === "text") {
          if (run && e.at - run.at < 0.4) {
            run.n += 1; run.at = e.at;
            run.body.textContent += " " + e.msg.text;
            run.count.textContent = `${run.n} items`;
            log.scrollTop = log.scrollHeight;
          } else {
            const b = bubble("bot", "");
            const body = el("span", null, e.msg.text);
            const count = el("span", "playcount", "");
            b.append(body, count);
            run = {at: e.at, n: 1, body, count};
          }
        } else { run = null; bubble("bot", short(e.msg.value ?? `${e.msg.size} bytes`, 400), "json"); }
      } else if (e.t === "refused") bubble("bot", `Refused: ${e.reason}`, "from-err");
      else if (e.t === "ended" && e.status === "error") bubble("bot", e.error || "the run failed", "from-err");
      if (e.t === "ended" || e.t === "refused" || e.t === "opened") paintSess();
    };

    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      empty.remove();
      run = null;
      bubble("me", text);
      const msg = {kind: "text", text};
      const s = chatSid && sessions.get(chatSid);
      try {
        if (s && !s.ended && d.session === "per_connection") {
          await api(`/api/p/${PID}/play/send`, {sid: chatSid, msg});
        } else {
          const perRequest = d.session !== "per_connection";
          chatSid = await open({service: d.service, toy: "chat", query: queryOf(), send: [msg], end: perRequest});
          sessions.get(chatSid).render = render;
        }
      } catch (err) { bubble("bot", err.message, "from-err"); }
      paintSess();
    };

    // a session still open from before (the pane was re-rendered)
    const prev = chatSid && sessions.get(chatSid);
    if (prev && prev.service === d.service) {
      empty.remove();
      prev.render = render;
      for (const e of prev.events) render(e);
      paintSess();
    }
    return {
      attach(sid, s, script) {
        chatSid = sid; log.textContent = "";
        for (const m of script) if (m.kind === "text") bubble("me", m.text);
        s.render = render;
        paintSess();
      },
    };
  }

  /* Form: one JSON payload in, the reply shown. */
  function formToy(main, d) {
    const key = `${K}:form:${d.service}`;
    const card = el("div", "playform");
    card.append(el("div", "stitle", "Payload"));
    const ta = el("textarea", "mono playjson");
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "JSON payload");
    ta.value = recall(key, "{\n  \n}");
    const err = el("div", "fielderr");
    const acts = el("div", "priceacts");
    const go = el("button", "primary", "Send");
    go.type = "button";
    acts.append(go);
    const reply = el("div", "playreply");
    card.append(ta, err, acts, reply);
    main.append(card);

    go.onclick = async () => {
      let value;
      try { value = JSON.parse(ta.value); err.textContent = ""; }
      catch (e) { err.textContent = `Not JSON: ${e.message}`; return; }
      store(key, ta.value);
      go.disabled = true;
      reply.textContent = "";
      const line = el("div", "note", "Running…");
      reply.append(line);
      try {
        const sid = await open({service: d.service, toy: "form", query: queryOf(),
                                send: [{kind: "json", value}], end: true});
        const outs = [];
        sessions.get(sid).render = (e) => {
          if (e.t === "out") outs.push(e.msg);
          if (e.t === "ended" || e.t === "refused") {
            go.disabled = false;
            reply.textContent = "";
            const top = el("div", "execverdict");
            if (e.t === "refused") top.append(el("span", "status s-bad", "refused"), el("span", null, e.reason));
            else {
              top.append(el("span", "status " + (e.status === "error" ? "s-bad" : "s-ok"), e.status === "error" ? "failed" : "ok"),
                         el("span", "vsep", "·"), el("span", "strong", fmtMs(e.ms)));
              const o = el("button", "linkbtn", "Open run"); o.type = "button";
              o.onclick = () => performUi("open_run", {run: e.trace_id, quiet: true});
              top.append(o);
            }
            reply.append(top);
            if (e.error) reply.append(el("div", "errbox", e.error));
            for (const m of outs) reply.append(el("pre", "mono playout", m.kind === "json" ? JSON.stringify(m.value, null, 2) : m.text ?? `${m.size} bytes`));
            if (!outs.length && e.t === "ended" && e.status !== "error") reply.append(el("div", "note", "The door sent nothing back."));
          }
        };
      } catch (e2) { go.disabled = false; reply.textContent = ""; reply.append(el("div", "errbox", e2.message)); }
    };
  }

  /* Re-run one op of a recorded run: its recorded inputs, editable (the
   * ones the graph never kept are named and left for the user to fill),
   * then the result beside what it did the first time. */
  function rerunSection(run, e, recorded) {
    const sec = el("section", "rerunsec");
    sec.append(el("div", "stitle", "Re-run"));
    const start = el("button", null, "Re-run this op…");
    start.type = "button";
    const hint = el("div", "note", "Run it again with the inputs it had, in the current code — no call, no job.");
    sec.append(hint, start);
    start.onclick = async () => {
      start.disabled = true;
      let plan;
      try { plan = await api(`/api/p/${PID}/play/rerun-plan?run=${encodeURIComponent(run)}&op=${encodeURIComponent(e.op)}`); }
      catch (err) { start.replaceWith(el("div", "errbox", err.message)); return; }
      const ex = plan.executions.find(x => Math.abs((x.duration_ms ?? -1) - e.dur_ms) < 0.001) || plan.executions[0];
      const inputs = Object.assign({}, ex.inputs);
      for (const k of ex.missing) inputs[k] = null;
      const box2 = el("div", "rerunbox");
      if (ex.missing.length) {
        box2.append(el("div", "rerunmiss",
          `Not recorded: ${ex.missing.join(", ")} — the graph never keeps it (a transient stream, or too large). Fill it in.`));
      }
      const ta = el("textarea", "mono playjson");
      ta.spellcheck = false;
      ta.setAttribute("aria-label", "Inputs for the re-run");
      ta.value = JSON.stringify(inputs, null, 2);
      const err = el("div", "fielderr");
      const acts = el("div", "priceacts");
      const go = el("button", "primary", "Run");
      go.type = "button";
      acts.append(go);
      const res = el("div", "rerunres");
      box2.append(ta, err, acts, res);
      start.replaceWith(box2);
      hint.textContent = `In ${plan.target.service ? `service ${plan.target.service}` : `job ${plan.target.job}`}'s graph, current code.`;
      go.onclick = async () => {
        let given;
        try { given = JSON.parse(ta.value); err.textContent = ""; }
        catch (x) { err.textContent = `Not JSON: ${x.message}`; return; }
        go.disabled = true;
        res.textContent = "";
        res.append(el("div", "note", "Running…"));
        let got;
        try { got = await rerun(run, e.op, given); }
        catch (x) { res.textContent = ""; res.append(el("div", "errbox", x.message)); go.disabled = false; return; }
        go.disabled = false;
        res.textContent = "";
        const top = el("div", "execverdict");
        top.append(el("span", "status " + (got.status === "error" ? "s-bad" : "s-ok"), got.status === "error" ? "failed" : "ok"),
                   el("span", "vsep", "·"), el("span", "strong", fmtMs(got.ms)),
                   el("span", "note", `was ${fmtMs(e.dur_ms)}${e.status === "error" ? ", failed" : ""}`));
        if (got.trace_id) {
          const o = el("button", "linkbtn", "Open re-run"); o.type = "button";
          o.onclick = () => performUi("open_run", {run: got.trace_id, quiet: true});
          top.append(o);
        }
        res.append(top);
        const pair = el("div", "rerunpair");
        const side = (title, body, bad) => {
          const c = el("div");
          c.append(el("div", "stitle", title), el("pre", "mono" + (bad ? " bad" : ""), body));
          return c;
        };
        const was = e.status === "error" ? (String(e.error || "").trim().split("\n").pop()) : JSON.stringify(recorded.outputs ?? ex.outputs, null, 2);
        const now = got.status === "error" ? got.error : JSON.stringify(got.outputs, null, 2);
        pair.append(side("Then", was, e.status === "error"), side("Now", now, got.status === "error"));
        res.append(pair);
      };
    };
    return sec;
  }

  registerPane("playground", {el: box, show});
  return {rerun, rerunSection, show};
})();
