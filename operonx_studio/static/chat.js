/* operonx studio — the assistant, wired.
 *
 * The floating ✦ fronts a real Claude Code session on the studio host.
 * Delivery is turn-based polling — the free tunnel kills any response
 * after ~10s, so POST starts the turn and short GET polls drain its
 * events by cursor. The agent outlives the connection: a reload or a
 * tunnel hiccup mid-task just resumes polling (the turn id and cursor
 * live in localStorage, like the transcript and resume session id).
 */

(function () {
  "use strict";

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const m = location.pathname.match(/^\/p\/([^/]+)/);
  const pid = m ? m[1] : null;
  const scope = pid || "home";
  const endpoint = pid ? `/api/p/${pid}/chat` : "/api/chat";
  const K_LOG = `oxchat:${scope}:log`;
  const K_SESSION = `oxchat:${scope}:session`;
  const K_TURN = `oxchat:${scope}:turn`;

  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    },
    drop(key) { try { localStorage.removeItem(key); } catch {} },
  };

  /* Tiny markdown: fences → <pre>, then inline code / bold / links /
   * list bullets. textContent everywhere — nothing the model says is
   * ever parsed as HTML. */
  const inline = (parent, text) => {
    const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
    for (const part of parts) {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        parent.append(el("code", "", part.slice(1, -1)));
      } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        parent.append(el("b", "", part.slice(2, -2)));
      } else if (part) {
        parent.append(document.createTextNode(part));
      }
    }
  };
  const renderMd = (target, text) => {
    target.textContent = "";
    const chunks = text.split(/```(?:\w*\n)?/);
    chunks.forEach((chunk, i) => {
      if (i % 2 === 1) {                       // inside a fence
        target.append(el("pre", "", chunk.replace(/\n$/, "")));
        return;
      }
      for (const line of chunk.split("\n")) {
        const p = el("div", "chat-line");
        inline(p, line.replace(/^(\s*)[-*] /, "$1• "));
        target.append(p);
      }
    });
  };

  /* ── furniture ── */
  const fab = el("button", "chat-fab", "✦");
  fab.title = "operonx assistant";
  const panel = el("div", "chat-panel");
  const head = el("div", "chat-head");
  head.append(el("span", "chat-title", "✦ assistant"));
  const maxi = el("button", "chat-new", "⤢");
  maxi.title = "expand / shrink";
  maxi.onclick = () => panel.classList.toggle("max");
  const fresh = el("button", "chat-new", "⟳");
  fresh.title = "new conversation";
  const close = el("button", "chat-close", "✕");
  head.append(maxi, fresh, close);

  // the left edge drags: code blocks deserve more than 400px
  const grip = el("div", "chat-grip");
  grip.title = "drag to resize";
  panel.append(grip);
  // in dock mode the grip resizes the dock; floating, the panel itself
  const sized = () => document.getElementById("chatdock") || panel;
  const savedW = store.get("oxchat:w", null);
  if (savedW) sized().style.width = `${savedW}px`;
  let gripping = false;
  grip.onpointerdown = (ev) => { gripping = true; grip.setPointerCapture(ev.pointerId); };
  grip.onpointermove = (ev) => {
    if (!gripping) return;
    const pad = document.getElementById("chatdock") ? 0 : 22;
    const w = Math.min(900, Math.max(320, window.innerWidth - ev.clientX - pad));
    sized().style.width = `${w}px`;
  };
  grip.onpointerup = () => {
    gripping = false;
    store.set("oxchat:w", parseInt(sized().style.width, 10) || 380);
  };
  const log = el("div", "chat-log");
  const bar = el("form", "chat-bar");
  const input = el("input", "chat-input");
  input.placeholder = pid ? "ask, or give me a task…" : "ask about your projects…";
  const send = el("button", "chat-send", "➤");
  send.type = "submit";
  bar.append(input, send);
  panel.append(head, log, bar);

  const scrolled = () => { log.scrollTop = log.scrollHeight; };

  /* Chips show WHAT the agent touched, not the raw invocation — a long
   * `uv run python -c ...` one-liner as 11px nowrap text reads as
   * noise. Paths shrink to their last segments, commands to their first
   * words; the full text lives in the tooltip. */
  const shortHint = (hint) => {
    if (!hint) return "";
    if (hint.startsWith("/") || hint.startsWith("~")) {
      const seg = hint.split("/").filter(Boolean);
      return seg.length > 2 ? "…/" + seg.slice(-2).join("/") : hint;
    }
    return hint.length > 44 ? hint.slice(0, 44) + "…" : hint;
  };

  const bubble = (item) => {
    if (item.w === "tool") {
      const chip = el("div", "chat-tool");
      chip.append(el("b", "", "⚙ " + (item.name || "tool")));
      if (item.hint) {
        chip.append(el("span", "", shortHint(item.hint)));
        chip.title = item.hint;
      }
      log.append(chip);
      return chip;
    }
    if (item.w === "meta") {           // cost line: small, honest, out of the way
      const meta = el("div", "chat-meta", item.text || "");
      log.append(meta);
      return meta;
    }
    const msg = el("div", "chat-msg " +
      (item.w === "me" ? "from-me" : item.w === "err" ? "from-err" : "from-bot"));
    if (item.w === "bot") {
      // markdown renders into an inner body so streaming re-renders
      // never wipe the copy button
      const body = el("div", "chat-body");
      renderMd(body, item.text || "");
      msg.append(body);
      msg._body = body;
      const copy = el("button", "chat-copy", "⧉");
      copy.title = "copy this reply";
      copy.onclick = () => {
        navigator.clipboard?.writeText(item.text || "").then(
          () => { copy.textContent = "✓"; setTimeout(() => copy.textContent = "⧉", 1200); },
          () => {});
      };
      msg.append(copy);
    } else {
      msg.textContent = item.text || "";
    }
    log.append(msg);
    return msg;
  };

  const history = store.get(K_LOG, []);
  if (history.length === 0) {
    bubble({ w: "bot", text: pid
      ? "Hi — I'm a real agent on the studio host, primed with this "
        + "project's graphs and traces. Ask me anything, or give me a task."
      : "Hi — open a project and I'll know its graphs and traces; from "
        + "here I can tell you about the projects this studio knows." });
  } else {
    history.forEach(bubble);
  }

  const remember = (item) => { history.push(item); store.set(K_LOG, history); };

  /* ── the wire ── */
  let running = null;   // {id, stop} while a turn is in flight

  const setBusy = (busy) => {
    send.textContent = busy ? "■" : "➤";
    send.title = busy ? "stop" : "send";
    input.disabled = busy;
    fab.classList.toggle("busy", busy);   // panel closed ≠ task forgotten
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Drain one turn's events by cursor until it finishes. Poll failures
   * are retried — a tunnel hiccup must not orphan a running agent. */
  const follow = async (turnId, cursor) => {
    const state = { id: turnId, stop: false };
    running = state;
    setBusy(true);
    const thinking = el("div", "chat-think", "…");
    log.append(thinking);
    scrolled();

    let botItem = null, botEl = null, finished = false, misses = 0;

    /* Deltas arrive in poll-round-trip batches (1-2s of text at once
     * over the tunnel); a typewriter drain reveals them at reading
     * pace instead of popping whole paragraphs in. It hurries when it
     * falls behind and is flushed whenever ordering matters. */
    let queue = "", drainTimer = null;
    const grow = (text) => {
      if (!botEl) {
        botItem = { w: "bot", text: "" };
        botEl = bubble(botItem);
      }
      botItem.text += text;
      renderMd(botEl._body || botEl, botItem.text);
      scrolled();
    };
    const drain = () => {
      if (!queue) { drainTimer = null; return; }
      const step = Math.max(3, Math.ceil(queue.length / 25));
      grow(queue.slice(0, step));
      queue = queue.slice(step);
      drainTimer = setTimeout(drain, 24);
    };
    const flush = () => {
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      if (queue) { grow(queue); queue = ""; }
    };

    const feed = (event) => {
      if (event.t === "delta") {
        queue += event.text;
        if (!drainTimer) drain();
      } else if (event.t === "tool") {
        // a tool call ends the current text block; the next delta opens a new one
        flush();
        if (botItem) { remember(botItem); botItem = null; botEl = null; }
        const item = { w: "tool", name: event.name, hint: event.hint };
        bubble(item); remember(item); scrolled();
      } else if (event.t === "start" && event.session) {
        store.set(K_SESSION, event.session);
      } else if (event.t === "done") {
        finished = true;
        flush();
        if (event.session) store.set(K_SESSION, event.session);
        if (event.error) {
          const item = { w: "err", text: event.error };
          bubble(item); remember(item);
        }
        if (typeof event.cost === "number") {
          const item = { w: "meta", text: `$${event.cost.toFixed(2)}` };
          bubble(item); remember(item);
        }
      } else if (event.t === "error") {
        finished = true;
        flush();
        const item = { w: "err", text: event.text || "assistant error" };
        bubble(item); remember(item);
      }
    };

    try {
      while (!finished) {
        if (state.stop) {
          await fetch(`/api/chat/turn/${turnId}/stop`, { method: "POST" })
            .catch(() => {});
          state.stop = false;   // the kill surfaces as this turn's error event
        }
        let batch;
        try {
          const res = await fetch(`/api/chat/turn/${turnId}?cursor=${cursor}`);
          if (res.status === 404) {
            feed({ t: "error", text: "turn lost (studio restarted?)" });
            break;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          batch = await res.json();
          misses = 0;
        } catch {
          if (++misses > 20) {
            feed({ t: "error", text: "connection lost — the task may still "
                                     + "be running; reload to reattach" });
            break;
          }
          await sleep(1500);
          continue;
        }
        for (const event of batch.events) feed(event);
        cursor = batch.cursor;
        store.set(K_TURN, { id: turnId, cursor });
        if (batch.events.length) scrolled();
        if (!finished && !batch.alive && !batch.events.length) {
          feed({ t: "error", text: "turn ended unexpectedly" });
        }
        if (!finished && !batch.events.length) await sleep(200);
      }
    } finally {
      flush();
      if (botItem) remember(botItem);
      store.drop(K_TURN);
      thinking.remove();
      running = null;
      setBusy(false);
      scrolled();
      input.focus();
    }
  };

  const turn = async (text) => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text,
                               session: store.get(K_SESSION, null),
                               view: window.__oxview || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      store.set(K_TURN, { id: body.turn, cursor: 0 });
      await follow(body.turn, 0);
    } catch (err) {
      const item = { w: "err", text: String(err.message || err) };
      bubble(item); remember(item); scrolled();
    }
  };

  bar.onsubmit = (ev) => {
    ev.preventDefault();
    if (running) { running.stop = true; return; }   // ■ pressed
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const mine = { w: "me", text };
    bubble(mine); remember(mine); scrolled();
    turn(text);
  };

  fresh.onclick = () => {
    if (running) running.stop = true;
    store.drop(K_LOG); store.drop(K_SESSION); store.drop(K_TURN);
    history.length = 0;
    log.textContent = "";
    bubble({ w: "bot", text: "Fresh start — what shall we do?" });
  };

  // A turn that survived a reload: pick up where the cursor left off.
  const pending = store.get(K_TURN, null);
  if (pending && pending.id) follow(pending.id, pending.cursor || 0);

  // On the project page the assistant lives in a docked right panel,
  // VS Code style; the floating bubble remains the home-page form and
  // the way back when the dock is toggled off.
  const dock = document.getElementById("chatdock");
  if (dock) {
    maxi.hidden = true;                    // the dock resizes, it doesn't pop out
    panel.classList.add("docked", "open");
    dock.append(panel);
    document.body.append(fab);
    // studio.js fires its panel event before this script loads — read
    // the stored preference directly for the initial state
    const initialOn = store.get("panelRight", true);
    dock.hidden = !initialOn;
    fab.classList.toggle("hidden", initialOn);
    document.addEventListener("oxdock", (ev) => {
      dock.hidden = !ev.detail.on;
      fab.classList.toggle("hidden", ev.detail.on);
      if (ev.detail.on) scrolled();
    });
    const flip = () => { const b = document.getElementById("btn-right"); if (b) b.click(); };
    fab.onclick = flip;
    close.onclick = flip;
  } else {
    const toggle = (open) => {
      panel.classList.toggle("open", open);
      fab.classList.toggle("hidden", open);
      if (open) { input.focus(); scrolled(); }
    };
    fab.onclick = () => toggle(true);
    close.onclick = () => toggle(false);
    document.body.append(fab, panel);
  }
})();
