/* operonx studio — the Playground: toys on a service's doors.
 *
 * A toy drives one door of a declared service the way a client would:
 * Chat holds a session open and sends text, Form sends one JSON payload
 * and shows the reply. The run happens in a bridge process under the
 * project's own interpreter (operonx.app.play), through the service's
 * real door ops, gate and trace consumers — so every session is a real
 * run, filed under origin=playground, that can be opened or replayed.
 *
 * Voice captures the microphone, sends it at the door's rate and plays
 * what comes back; a Simulated user lets an LLM persona hold the
 * conversation; Conditions make the world worse on purpose (latency,
 * drops, noise, a failing resource).
 *
 * Events (opened, out, said, ended, refused) are polled by cursor while
 * the pane is on screen; re-runs of one op (the run view's "Re-run") wait
 * on the same stream by request id.
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
  const orphans = new Map();          // events for a session not registered yet
                                      // (a simulated user starts before the POST returns)
  let chatSid = null;                 // the chat session on screen
  let preRecent = null;               // recent sessions that came with the doors
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
      // keep listening while a session is open, even off this screen: the
      // Flow canvas follows its ops live
      while (!box.hidden || waiters.size || [...sessions.values()].some(x => !x.ended)) {
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
    if (e.t === "ops") {
      const s0 = sessions.get(e.sid);
      document.dispatchEvent(new CustomEvent("oxops", {detail: {
        service: s0 ? s0.service : null, sid: e.sid, trace_id: e.trace_id, ops: e.ops || []}}));
      return;
    }
    if (e.t === "ended" || e.t === "opened") {
      const s0 = sessions.get(e.sid);
      document.dispatchEvent(new CustomEvent("oxsession", {detail: {
        state: e.t, service: s0 ? s0.service : e.service, sid: e.sid, trace_id: e.trace_id, status: e.status}}));
    }
    if (e.t === "rerun" && e.id) {
      if (waiters.has(e.id)) { waiters.get(e.id)(e); waiters.delete(e.id); }
      else { early.set(e.id, e); if (early.size > 20) early.delete(early.keys().next().value); }
      return;
    }
    if (e.t === "bridge_restart" || e.t === "bridge_exit") { if (ui) ui.note(e); return; }
    const s = sessions.get(e.sid);
    if (!s) {
      if (e.sid) {
        if (!orphans.has(e.sid)) orphans.set(e.sid, []);
        orphans.get(e.sid).push(e);
        if (orphans.size > 50) orphans.delete(orphans.keys().next().value);
      }
      return;
    }
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
    // every toy runs under the pane's conditions and trace choice
    const {sid} = await api(`/api/p/${PID}/play/open`, {...(ui ? ui.extras() : {}), ...body});
    adopt(sid, {service: body.service, toy: body.toy});
    startPolling();
    return sid;
  }

  /* a session the page will show: register it, and hand it whatever
   * arrived before it was registered */
  function adopt(sid, info) {
    const s = Object.assign({t0: Date.now(), events: [], ended: null}, info);
    sessions.set(sid, s);
    const early2 = orphans.get(sid) || [];
    orphans.delete(sid);
    for (const e of early2) dispatch(e);
    return s;
  }

  /* the connection query: what the rows say, with `{uuid}` minted fresh */
  function queryOf() {
    const q = {};
    for (const row of (ui && ui.queryRows()) || []) if (row.k) q[row.k] = row.v;
    v.query = v.query || {};
    v.query[v.service] = q;
    save();
    const fresh = Math.random().toString(16).slice(2, 10);
    return Object.fromEntries(Object.entries(q).map(([k, x]) => [k, String(x).replaceAll("{uuid}", fresh)]));
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
    let got;
    try {
      // one round trip: the doors carry the event cursor and the recent
      // sessions of the service on screen
      got = await api(`/api/p/${PID}/play/doors?service=${encodeURIComponent(v.service || "")}`);
      doors = got.doors;
      if (cursor == null && got.cursor != null) cursor = got.cursor;
      preRecent = got.recent || null;
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
    const toyList = [...d.toys, ...(d.toys.includes("chat") ? ["simulated"] : [])];
    if (!toyList.includes(v.toy)) v.toy = toyList[0] || "";
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
    const TOY = {chat: "Chat", form: "Form", voice: "Voice", simulated: "Simulated user"};
    for (const t of toyList) {
      const b = el("button", t === v.toy ? "on" : "", TOY[t] || t);
      b.type = "button";
      b.onclick = () => { v.toy = t; save(); show(); };
      toys.append(b);
    }
    const stateEl = el("span", "playstate");
    const restart = Icons.button("refresh", undefined, "", "Restart the playground (reloads the project's code)");
    restart.onclick = async () => {
      restart.disabled = true;
      try { await api(`/api/p/${PID}/play/restart`, {}); toast("Playground restarted"); }
      catch (err) { toast(err.message, true); }
      restart.disabled = false;
    };
    head.append(pick, toys, stateEl, restart);

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
    const saved = (v.query && v.query[d.service]) || {...(d.query || {})};
    const keys = [...new Set([...(d.custom_hook ? [] : d.inputs), ...Object.keys(d.query || {}), ...Object.keys(saved)])];
    const rowEls = [];
    const addRow = (k = "", val = "") => {
      const r = el("div", "playrow");
      const ki = el("input", "mono"); ki.value = k; ki.placeholder = "key"; ki.setAttribute("aria-label", "Query key");
      const vi = el("input", "mono"); vi.value = val; vi.placeholder = "value"; vi.setAttribute("aria-label", "Query value");
      r.append(ki, vi);
      rows.append(r);
      rowEls.push([ki, vi]);
    };
    for (const k of keys) addRow(k, saved[k] ?? (d.query || {})[k] ?? "");
    if (!keys.length) addRow();
    const more = el("button", "linkbtn", "+ add a key");
    more.type = "button";
    more.onclick = () => addRow();
    conn.append(rows, more);
    main.append(conn);

    // conditions: the world made worse on purpose, per service
    const cv = Object.assign({}, (v.conds || {})[d.service] || {});
    const cond = el("details", "playconn playconds");
    const csum = el("summary");
    cond.append(csum);
    const cgrid = el("div", "condgrid");
    const field = (key, label, hint, attrs) => {
      const w = el("label", "condfield");
      w.append(el("span", null, label));
      const i = el("input", "mono");
      Object.assign(i, {type: "number", ...(attrs || {})});
      i.value = cv[key] ?? "";
      i.placeholder = hint;
      i.oninput = () => { cv[key] = i.value === "" ? undefined : Number(i.value); keep(); };
      w.append(i);
      cgrid.append(w);
    };
    field("latency_ms", "Latency before each message (ms)", "0", {min: 0, step: 50});
    field("drop", "Messages lost (%)", "0", {min: 0, max: 100, step: 5});
    if (d.audio) {
      field("noise_dbfs", "Noise in the audio (dBFS)", "off, e.g. -35", {max: 0, step: 5});
      field("silence_ms", "Silence before the first word (ms)", "0", {min: 0, step: 250});
    }
    const fw = el("label", "condfield wide");
    fw.append(el("span", null, "Resources that fail"));
    const fi = el("input", "mono");
    fi.placeholder = "e.g. llm:inhouse, tts:default";
    fi.setAttribute("list", "play-resources");
    fi.value = (cv.fail || []).join(", ");
    fi.oninput = () => { cv.fail = fi.value.split(",").map(x => x.trim()).filter(Boolean); keep(); };
    const dl = el("datalist"); dl.id = "play-resources";
    for (const [name, det] of Object.entries(((state.ir || {}).resources || {}).details || {})) {
      const o = el("option"); o.value = `${det.category || "resource"}:${name}`; dl.append(o);
    }
    fw.append(fi, dl);
    cgrid.append(fw);
    cond.append(cgrid);
    const paintCond = () => {
      const on = Object.entries(cv).filter(([k, x]) => x !== undefined && x !== "" && !(Array.isArray(x) && !x.length) && x !== 0).length;
      csum.textContent = on ? `Conditions — ${on} on` : "Conditions — latency, lost messages, noise, failing resources";
      cond.classList.toggle("on", !!on);
    };
    function keep() { v.conds = v.conds || {}; v.conds[d.service] = cv; save(); paintCond(); }
    paintCond();
    main.append(cond);
    let remoteBox = null;
    if ((d.remote_trace || []).length) {
      const lab = el("label", "playremote");
      remoteBox = el("input"); remoteBox.type = "checkbox";
      remoteBox.checked = !!(v.remote || {})[d.service];
      remoteBox.onchange = () => { v.remote = v.remote || {}; v.remote[d.service] = remoteBox.checked; save(); };
      lab.append(remoteBox, `Also send these sessions to ${d.remote_trace.join(", ")} (off: recorded here only)`);
      main.append(lab);
    }

    // the events column, and recent sessions under it
    const evHead = el("div", "stitle", "Events");
    const evList = el("div", "playevents");
    evList.append(el("div", "note", "What the door sends that is not a reply, and each session's start and end."));
    const recent = el("div", "playrecent");
    side.append(evHead, evList, el("div", "stitle", "Recent sessions"), recent);

    let beats = null;
    ui = {
      queryRows: () => rowEls.map(([k, x]) => ({k: k.value.trim(), v: x.value})),
      extras() {
        const c = {};
        for (const [k, x] of Object.entries(cv)) if (x !== undefined && x !== "") c[k] = k === "drop" ? x / 100 : x;
        return {conditions: c, remote: !!(remoteBox && remoteBox.checked)};
      },
      status(got) {
        stateEl.textContent = got.alive ? (got.live.length ? `${got.live.length} live` : "ready") : "stopped";
        stateEl.className = "playstate " + (got.alive ? "on" : "");
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
        else if (e.t === "out" && e.msg.kind === "json" && (e.msg.value || {}).event === "heartbeat") {
          // a heartbeat says the line is alive: one row that counts them
          if (!beats) { beats = evRow("heartbeat", "", at); beats.n = 0; }
          beats.n += 1;
          beats.querySelector(".evtext").textContent = `× ${beats.n}`;
        }
        else if (e.t === "out" && e.msg.kind !== "audio" && !((s.toy === "chat" || s.toy === "simulated") && e.msg.kind === "text"))
          evRow((e.msg.value || {}).event || e.msg.kind, short(e.msg.value ?? e.msg.text ?? `${e.msg.size} bytes`), at);
        else if (e.t === "said" && s.toy !== "simulated") evRow("said", short(e.text), at);
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
      let got = preRecent && preRecent.service === d.service ? preRecent : null;
      preRecent = null;       // the first paint only; later calls ask again
      if (!got) {
        try { got = await api(`/api/p/${PID}/runs?origin=playground&name=${encodeURIComponent(d.service)}&limit=8`); }
        catch { return; }
      }
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
    else if (v.toy === "voice") voiceToy(main, d);
    else if (v.toy === "simulated") simToy(main, d);
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

  /* Voice: the microphone in, at the door's own rate; what comes back is
   * played (a jitter buffer of ~120 ms) and its text written down. The
   * capture runs in an AudioWorklet, is averaged down to the door's rate,
   * and goes out in ~200 ms batches the codec cuts into the door's frames. */
  const WORKLET = "class OxCap extends AudioWorkletProcessor { process(inputs) { const c = inputs[0] && inputs[0][0]; "
    + "if (c) this.port.postMessage(c.slice(0)); return true; } } registerProcessor('ox-cap', OxCap);";
  let audioCtx = null;
  let workletReady = false;

  function voiceToy(main, d) {
    const rate = (d.audio || {}).rate || 16000;
    const wrap = el("div", "playvoice");
    const top = el("div", "voicetop");
    const mic = el("button", "voicemic");
    mic.type = "button";
    const label = el("span", null, "Start the call");
    mic.append(Icons.svg("play"), label);
    const meter = el("div", "voicemeter");
    meter.setAttribute("aria-hidden", "true");
    const lvl = el("i");
    meter.append(lvl);
    const info = el("div", "voiceinfo");
    info.append(el("b", null, `${rate / 1000} kHz`), el("span", null, " · headphones recommended — a speaker talks into the microphone"));
    top.append(mic, meter, info);
    const status = el("div", "voicestatus");
    // how much went each way: the loop is closed when both move
    const flow = el("div", "voiceflow");
    const sentEl = el("span", null, "0.0 s spoken");
    const heardEl = el("span", null, "0.0 s heard back");
    flow.append(sentEl, el("span", "vsep", "·"), heardEl);
    let sentS = 0, heardS = 0;
    const log = el("div", "playlog voicelog");
    log.append(el("div", "note playempty", "Start the call and speak. What the service says is played and written here."));
    wrap.append(top, flow, status, log);
    main.append(wrap);

    let stream = null, node = null, sid = null, pending = [], sending = false, timer = null, nextAt = 0;
    const playing = new Set();

    async function start() {
      mic.disabled = true;
      status.textContent = "";
      try {
        stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true,
                                                                    noiseSuppression: true, autoGainControl: true}});
      } catch (err) { status.textContent = `The microphone is not available: ${err.message}`; mic.disabled = false; return; }
      audioCtx = audioCtx || new AudioContext();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (!workletReady) {
        await audioCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], {type: "application/javascript"})));
        workletReady = true;
      }
      const src = audioCtx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(audioCtx, "ox-cap");
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      src.connect(node); node.connect(mute); mute.connect(audioCtx.destination);
      const ratio = audioCtx.sampleRate / rate;
      let carry = new Float32Array(0);
      node.port.onmessage = (ev) => {
        const x = ev.data;
        let sum = 0;
        for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
        lvl.style.width = `${Math.min(100, Math.sqrt(sum / x.length) * 500).toFixed(0)}%`;
        const buf = new Float32Array(carry.length + x.length);
        buf.set(carry); buf.set(x, carry.length);
        const n = Math.floor(buf.length / ratio);
        const out = new Int16Array(n);
        for (let j = 0; j < n; j++) {
          const a = Math.floor(j * ratio), b = Math.max(a + 1, Math.floor((j + 1) * ratio));
          let acc = 0;
          for (let i = a; i < b; i++) acc += buf[i];
          out[j] = Math.max(-32768, Math.min(32767, Math.round((acc / (b - a)) * 32767)));
        }
        carry = buf.slice(Math.floor(n * ratio));
        pending.push(out);
      };
      try { sid = await open({service: d.service, toy: "voice", query: queryOf()}); }
      catch (err) { status.textContent = err.message; stopCapture(); idle(); return; }
      sessions.get(sid).render = render;
      timer = setInterval(flush, 200);
      label.textContent = "End the call";
      sentS = heardS = 0;
      sentEl.textContent = "0.0 s spoken"; heardEl.textContent = "0.0 s heard back";
      mic.classList.add("live");
      mic.disabled = false;
      log.querySelector(".playempty")?.remove();
    }

    const b64 = (int16) => {
      const bytes = new Uint8Array(int16.buffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    };

    async function flush() {
      if (box.hidden && sid) { end(); return; }   // the pane was left: the call ends with it
      if (sending || !pending.length || !sid) return;
      const total = pending.reduce((n, a) => n + a.length, 0);
      const all = new Int16Array(total);
      let o = 0;
      for (const a of pending) { all.set(a, o); o += a.length; }
      pending = [];
      sending = true;
      sentS += total / rate;
      sentEl.textContent = `${sentS.toFixed(1)} s spoken`;
      try { await api(`/api/p/${PID}/play/send`, {sid, msg: {kind: "audio", b64: b64(all), rate}}); }
      catch { /* the session ended under us; its ended event says how */ }
      sending = false;
    }

    function play(m) {
      if (!audioCtx) return;
      const raw = atob(m.b64 || "");
      const n = raw.length >> 1;
      if (!n) return;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let x = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
        if (x >= 0x8000) x -= 0x10000;
        f[i] = x / 32768;
      }
      const buf = audioCtx.createBuffer(1, n, m.rate || rate);
      buf.copyToChannel(f, 0);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      nextAt = Math.max(audioCtx.currentTime + 0.12, nextAt);
      src.start(nextAt);
      nextAt += buf.duration;
      heardS += buf.duration;
      heardEl.textContent = `${heardS.toFixed(1)} s heard back`;
      playing.add(src);
      src.onended = () => playing.delete(src);
      wrap.dataset.played = String((Number(wrap.dataset.played) || 0) + 1);
    }
    function hush() {
      for (const x of playing) { try { x.stop(); } catch { /* already done */ } }
      playing.clear();
      nextAt = 0;
    }

    function render(e) {
      if (e.t === "out") {
        const m = e.msg;
        if (m.kind === "audio") {
          play(m);
          if (m.text) { log.append(el("div", "chat-msg from-bot", m.text)); log.scrollTop = log.scrollHeight; }
        } else if (m.kind === "text") {
          log.append(el("div", "chat-msg from-bot", m.text));
        } else if (m.kind === "json" && (m.value || {}).event === "interrupt") {
          hush();   // the caller spoke over it: stop what is queued
          log.append(el("div", "note", "— interrupted —"));
        }
        if (m.end) { status.textContent = "The service ended the call."; end(); }
      } else if (e.t === "refused") {
        status.textContent = `Refused: ${e.reason}`;
        stopCapture(); idle();
      } else if (e.t === "ended") {
        status.textContent = e.status === "error" ? `The call failed — ${e.error}` : `Call ended · ${fmtMs(e.ms)}`;
        const o = el("button", "linkbtn", "Open run");
        o.type = "button";
        o.onclick = () => performUi("open_run", {run: e.trace_id, quiet: true});
        status.append(" ", o);
        stopCapture(); idle();
      }
    }

    async function end() {
      stopCapture();
      await flush();
      const was = sid;
      sid = null;
      if (was) api(`/api/p/${PID}/play/end`, {sid: was}).catch(() => {});
    }
    function stopCapture() {
      clearInterval(timer);
      timer = null;
      if (stream) stream.getTracks().forEach(t => t.stop());
      stream = null;
      if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
      lvl.style.width = "0";
    }
    function idle() {
      label.textContent = "Start the call";
      mic.classList.remove("live");
      mic.disabled = false;
      sid = null;
    }
    mic.onclick = () => (sid ? end() : start());
  }

  /* Simulated user: an LLM persona plays the other side, N at once. */
  function simToy(main, d) {
    const sv = Object.assign({persona: "", llm: "", turns: 6, count: 1, first: "user"}, (v.sim || {})[d.service] || {});
    const keep = () => { v.sim = v.sim || {}; v.sim[d.service] = sv; save(); };
    const card = el("div", "playsim");
    const pl = el("label", "condfield wide");
    pl.append(el("span", null, "Who the user is, and what they want"));
    const persona = el("textarea", "playjson simpersona");
    persona.placeholder = "A busy parent who wants to move tomorrow's class to Friday evening, and is short on patience.";
    persona.value = sv.persona;
    persona.oninput = () => { sv.persona = persona.value; keep(); };
    pl.append(persona);
    const row = el("div", "condgrid");
    const llms = Object.entries(((state.ir || {}).resources || {}).details || {}).filter(([, det]) => det.category === "llm").map(([n]) => `llm:${n}`);
    const lf = el("label", "condfield");
    lf.append(el("span", null, "Played by"));
    const li = el("input", "mono");
    li.setAttribute("list", "sim-llms");
    li.placeholder = llms[0] || "llm:…";
    li.value = sv.llm || llms[0] || "";
    li.oninput = () => { sv.llm = li.value.trim(); keep(); };
    const ldl = el("datalist"); ldl.id = "sim-llms";
    for (const n of llms) { const o = el("option"); o.value = n; ldl.append(o); }
    lf.append(li, ldl);
    const num = (key, text, min, max) => {
      const f = el("label", "condfield");
      f.append(el("span", null, text));
      const i = el("input", "mono");
      Object.assign(i, {type: "number", min, max});
      i.value = sv[key];
      i.oninput = () => { sv[key] = Math.max(min, Math.min(max, Number(i.value) || min)); keep(); };
      f.append(i);
      return f;
    };
    const ff = el("label", "condfield");
    ff.append(el("span", null, "Who speaks first"));
    const fs = el("select");
    for (const [k, t] of [["user", "the user"], ["service", "the service"]]) { const o = el("option", null, t); o.value = k; o.selected = sv.first === k; fs.append(o); }
    fs.onchange = () => { sv.first = fs.value; keep(); };
    ff.append(fs);
    row.append(lf, num("turns", "Turns, at most", 1, 20), num("count", "Conversations at once", 1, 10), ff);
    const acts = el("div", "priceacts");
    const go = el("button", "primary", "Start");
    go.type = "button";
    acts.append(go);
    const err = el("div", "fielderr");
    card.append(pl, row, acts, err);
    const runs = el("div", "simruns");
    main.append(card, runs);

    go.onclick = async () => {
      if (!persona.value.trim()) { err.textContent = "Describe the user first."; persona.focus(); return; }
      if (!li.value.trim()) { err.textContent = "Name the LLM that plays them."; li.focus(); return; }
      err.textContent = "";
      go.disabled = true;
      if (cursor == null) cursor = (await api(`/api/p/${PID}/play/events`)).cursor;
      let got;
      try {
        got = await api(`/api/p/${PID}/play/simulate`, {service: d.service, persona: persona.value.trim(), llm: li.value.trim(),
          turns: sv.turns, count: sv.count, first: sv.first, query: queryOf(), ...ui.extras()});
      } catch (e2) { err.textContent = e2.message; go.disabled = false; return; }
      runs.textContent = "";
      got.sids.forEach((sid, i) => conversation(sid, i + 1));
      startPolling();
      go.disabled = false;
    };

    function conversation(sid, n) {
      const c = el("div", "simconv");
      const head = el("div", "simhead");
      const st = el("span", "simstate", "starting…");
      head.append(el("b", null, `Conversation ${n}`), st);
      const log = el("div", "playlog simlog");
      c.append(head, log);
      runs.append(c);
      let stream = null, failed = false;
      adopt(sid, {service: d.service, toy: "simulated", render(e) {
        if (e.t === "opened") st.textContent = "talking…";
        else if (e.t === "said") { stream = null; log.append(el("div", "chat-msg from-me", e.text)); }
        else if (e.t === "out" && e.msg.kind === "text") {
          if (stream && e.at - stream.at < 0.4) { stream.at = e.at; stream.el.textContent += " " + e.msg.text; }
          else { stream = {at: e.at, el: el("div", "chat-msg from-bot", e.msg.text)}; log.append(stream.el); }
        } else if (e.t === "refused") { st.textContent = "refused"; log.append(el("div", "chat-msg from-err", e.reason)); }
        else if (e.t === "error") { failed = true; log.append(el("div", "chat-msg from-err", e.text)); }
        else if (e.t === "ended") {
          // the persona failing is the conversation failing, however the run ended
          const bad = failed || e.status === "error";
          st.textContent = "";
          st.append(el("span", "status " + (bad ? "s-bad" : "s-ok"), bad ? "failed" : `done · ${fmtMs(e.ms)}`));
          const o = el("button", "linkbtn", "Open run"); o.type = "button";
          o.onclick = () => performUi("open_run", {run: e.trace_id, quiet: true});
          st.append(o);
          if (e.error) log.append(el("div", "chat-msg from-err", e.error));
        }
        log.scrollTop = log.scrollHeight;
      }});
    }
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
