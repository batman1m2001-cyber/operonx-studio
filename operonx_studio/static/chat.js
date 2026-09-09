/* operonx studio — the assistant, as furniture.
 *
 * A floating ✦ on every page opening a chat panel. Deliberately not
 * wired to anything yet: the future editor is an agent you talk to,
 * not a drag-and-drop palette, and this is its seat at the table.
 * Sending a message gets one honest canned reply.
 */

(function () {
  "use strict";

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const fab = el("button", "chat-fab", "✦");
  fab.title = "operonx assistant";

  const panel = el("div", "chat-panel");
  const head = el("div", "chat-head");
  head.append(el("span", "chat-title", "✦ assistant"));
  const close = el("button", "chat-close", "✕");
  head.append(close);
  const log = el("div", "chat-log");
  const hello = el("div", "chat-msg from-bot");
  hello.textContent = "Xin chào! I can't act on your flow yet — soon you'll "
    + "edit graphs by talking to me instead of dragging boxes. For now the "
    + "canvas and inspector are the tools.";
  log.append(hello);
  const bar = el("form", "chat-bar");
  const input = el("input", "chat-input");
  input.placeholder = "ask about your flow…";
  const send = el("button", "chat-send", "➤");
  send.type = "submit";
  bar.append(input, send);
  panel.append(head, log, bar);

  const toggle = (open) => {
    panel.classList.toggle("open", open);
    fab.classList.toggle("hidden", open);
    if (open) input.focus();
  };
  fab.onclick = () => toggle(true);
  close.onclick = () => toggle(false);

  bar.onsubmit = (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const mine = el("div", "chat-msg from-me", text);
    log.append(mine);
    input.value = "";
    const bot = el("div", "chat-msg from-bot",
      "Not connected yet — this seat is reserved for the agent.");
    setTimeout(() => { log.append(bot); log.scrollTop = log.scrollHeight; }, 350);
    log.scrollTop = log.scrollHeight;
  };

  document.body.append(fab, panel);
})();
