/* operonx studio — the assistant, wired.
 *
 * The floating ✦ now fronts a real Claude Code session running on the
 * studio host. The server relays SSE events (chat.py); this side keeps
 * the transcript and the resume id in localStorage per project, renders
 * streamed markdown, and shows tool activity as it happens. Stop = abort
 * the fetch; the server kills the agent when the stream closes.
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
  const fresh = el("button", "chat-new", "⟳");
  fresh.title = "new conversation";
  const close = el("button", "chat-close", "✕");
  head.append(fresh, close);
  const log = el("div", "chat-log");
  const bar = el("form", "chat-bar");
  const input = el("input", "chat-input");
  input.placeholder = pid ? "ask, or give me a task…" : "ask about your projects…";
  const send = el("button", "chat-send", "➤");
  send.type = "submit";
  bar.append(input, send);
  panel.append(head, log, bar);

  const scrolled = () => { log.scrollTop = log.scrollHeight; };
  const bubble = (item) => {
    if (item.w === "tool") {
      const chip = el("div", "chat-tool");
      chip.append(el("b", "", "⚙ " + (item.name || "tool")));
      if (item.hint) chip.append(el("span", "", " · " + item.hint));
      log.append(chip);
      return chip;
    }
    const msg = el("div", "chat-msg " +
      (item.w === "me" ? "from-me" : item.w === "err" ? "from-err" : "from-bot"));
    if (item.w === "bot") renderMd(msg, item.text || "");
    else msg.textContent = item.text || "";
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
  let streaming = null;   // AbortController while a turn is in flight

  const setBusy = (busy) => {
    send.textContent = busy ? "■" : "➤";
    send.title = busy ? "stop" : "send";
    input.disabled = busy;
  };

  const turn = async (text) => {
    const controller = new AbortController();
    streaming = controller;
    setBusy(true);

    const thinking = el("div", "chat-think", "…");
    log.append(thinking);
    scrolled();

    let botItem = null, botEl = null, buffer = "";
    const feed = (event) => {
      if (event.t === "delta") {
        if (!botEl) {
          botItem = { w: "bot", text: "" };
          botEl = bubble(botItem);
        }
        buffer += event.text;
        botItem.text = buffer;
        renderMd(botEl, buffer);
        scrolled();
      } else if (event.t === "tool") {
        // a tool call ends the current text block; the next delta opens a new one
        if (botItem) { remember(botItem); botItem = null; botEl = null; buffer = ""; }
        const item = { w: "tool", name: event.name, hint: event.hint };
        bubble(item); remember(item); scrolled();
      } else if (event.t === "start" && event.session) {
        store.set(K_SESSION, event.session);
      } else if (event.t === "done") {
        if (event.session) store.set(K_SESSION, event.session);
        if (event.error) {
          const item = { w: "err", text: event.error };
          bubble(item); remember(item);
        }
      } else if (event.t === "error") {
        const item = { w: "err", text: event.text || "assistant error" };
        bubble(item); remember(item);
      }
    };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text,
                               session: store.get(K_SESSION, null) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n\n");
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { feed(JSON.parse(line.slice(6))); } catch {}
        }
      }
    } catch (err) {
      if (err.name === "AbortError") {
        const item = { w: "err", text: "stopped" };
        bubble(item); remember(item);
      } else {
        const item = { w: "err", text: String(err.message || err) };
        bubble(item); remember(item);
      }
    } finally {
      if (botItem) remember(botItem);
      thinking.remove();
      streaming = null;
      setBusy(false);
      scrolled();
      input.focus();
    }
  };

  bar.onsubmit = (ev) => {
    ev.preventDefault();
    if (streaming) { streaming.abort(); return; }   // ■ pressed
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const mine = { w: "me", text };
    bubble(mine); remember(mine); scrolled();
    turn(text);
  };

  fresh.onclick = () => {
    if (streaming) streaming.abort();
    store.drop(K_LOG); store.drop(K_SESSION);
    history.length = 0;
    log.textContent = "";
    bubble({ w: "bot", text: "Fresh start — what shall we do?" });
  };

  const toggle = (open) => {
    panel.classList.toggle("open", open);
    fab.classList.toggle("hidden", open);
    if (open) { input.focus(); scrolled(); }
  };
  fab.onclick = () => toggle(true);
  close.onclick = () => toggle(false);

  document.body.append(fab, panel);
})();
