/* operonx studio — what waits on the owner, on every page (plan D18).
 *
 * One cheap route, /api/boards/waiting, read across every project's board:
 *   - the count of open questions leads the tab title: "(2) tipcalc · studio";
 *   - a browser notification fires for each question this browser has not
 *     seen, while any studio tab is open (foreground or not), once the
 *     owner allowed it ("Notify me");
 *   - the home page draws its Boards list from the same answer (#boards).
 *
 * A closed phone is Telegram's job, not this file's. Self-contained: the
 * home page has none of studio.js's helpers. */

"use strict";

const Waiting = (() => {
  const SEEN = "ox:waiting:seen";
  const STATE = {
    created: "created", discovering: "discovering", requirements: "requirements", planning: "planning",
    awaiting_approval: "waits for your approval", running: "running", waiting_human: "waiting on you",
    paused: "paused", verifying: "verifying", done: "done", failed: "failed", cancelled: "cancelled",
    budget_exhausted: "budget spent", waiting_dependency: "waits for another board",
  };
  let data = {count: 0, boards: []};
  let timer = null;

  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function seen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN) || "null") || []); } catch { return null; }
  }
  function remember(ids) {
    try { localStorage.setItem(SEEN, JSON.stringify([...ids].slice(-500))); } catch { /* private window */ }
  }

  /* the title: "(n) " in front of whatever the page calls itself */
  function title() {
    const bare = document.title.replace(/^\(\d+\) /, "");
    const want = data.count ? `(${data.count}) ${bare}` : bare;
    if (document.title !== want) document.title = want;
  }
  const t = document.querySelector("title");
  if (t) new MutationObserver(title).observe(t, {childList: true});

  const allowed = () => "Notification" in window && Notification.permission === "granted";
  const askable = () => "Notification" in window && Notification.permission === "default";

  function notify(fresh) {
    if (!allowed()) return;
    for (const {board, q} of fresh.slice(0, 5)) {
      try {
        const n = new Notification(`${board.name}: ${q.qid || "a question"} waits for you`, {
          body: `${q.milestone}${q.card ? `/${q.card}` : ""} — ${q.problem}`, tag: q.id,
        });
        n.onclick = () => { window.focus(); location.href = `/p/${board.pid}/board`; n.close(); };
      } catch { /* a browser that wants a service worker for this: the title count still says it */ }
    }
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const res = await fetch("/api/boards/waiting");
      if (res.ok) {
        data = await res.json();
        const ids = data.boards.flatMap((b) => b.waiting.map((q) => q.id));
        const before = seen();
        if (before) {  // the first visit only remembers: no burst for questions already on the boards
          const fresh = data.boards.flatMap((board) => board.waiting.filter((q) => !before.has(q.id))
            .map((q) => ({board, q})));
          notify(fresh);
        }
        remember(new Set([...(before || []), ...ids]));
        title();
        draw();
        document.dispatchEvent(new CustomEvent("ox:waiting", {detail: data}));
      }
    } catch { /* offline for a moment: the next tick tries again */ }
    timer = setTimeout(poll, document.hidden ? 45000 : 15000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

  /* "Notify me": the browser asks only on a tap */
  function button() {
    if (!askable()) return null;
    const b = mk("button", "needs-edit", "Notify me");
    b.type = "button";
    b.title = "A browser notification when a board asks you something, while a studio tab is open";
    b.onclick = async () => {
      try { await Notification.requestPermission(); } catch { /* old Safari: the callback form */ }
      b.remove();
      draw();
    };
    return b;
  }

  /* the home page's Boards list */
  function draw() {
    const box = document.getElementById("boards");
    if (!box) return;
    const sec = box.closest("section");
    if (sec) sec.hidden = !data.boards.length;
    box.textContent = "";
    const head = document.getElementById("boards-actions");
    if (head) { head.textContent = ""; const b = button(); if (b) head.append(b); }
    for (const board of data.boards) {
      const row = mk("a", "boardrow");
      row.href = `/p/${board.pid}/board`;
      const top = mk("div", "boardtop");
      top.append(mk("b", null, board.name));
      if (board.waiting.length) top.append(mk("span", "chip cwarn", `${board.waiting.length} waiting on you`));
      row.append(top);
      for (const m of board.milestones.slice(-3)) {
        row.append(mk("div", "boardms", `${m.id} · ${m.title} — ${STATE[m.state] || m.state}`
          + (m.cards ? ` · ${m.done}/${m.cards} cards` : "")));
      }
      for (const q of board.waiting.slice(0, 3)) {
        row.append(mk("div", "boardq", `${q.qid || "?"} ${q.milestone}${q.card ? `/${q.card}` : ""}: ${q.problem}`));
      }
      if (board.error) row.append(mk("div", "boardq", board.error));
      box.append(row);
    }
  }

  poll();
  return {poll, button, get data() { return data; }};
})();
