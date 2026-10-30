/* operonx studio — what waits on the owner, on every page (plan D18).
 *
 * One cheap route, /api/boards/waiting, read across every project's board:
 *   - the count of open questions leads the tab title: "(2) tipcalc · studio";
 *   - a browser notification fires for each question this browser has not
 *     seen, while any studio tab is open (foreground or not), once the
 *     owner allowed it ("Notify me");
 *   - each project card on the home page carries its board's line, and
 *     the project page's Project tab the count waiting in that project.
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

  /* a board's line: its newest milestone, and what waits on the owner */
  function line(board) {
    const box = mk("div", "projboard");
    const m = board.milestones[board.milestones.length - 1];
    if (m) box.append(mk("span", null, `board ${m.id} · ${m.title} — ${STATE[m.state] || m.state}`
      + (m.cards ? ` · ${m.done}/${m.cards} cards` : "")));
    else if (board.error) box.append(mk("span", null, board.error));
    else box.append(mk("span", null, "board: no milestones yet"));
    if (board.waiting.length) {
      const q = mk("a", "chip cwarn", `${board.waiting.length} waiting on you`);
      q.href = `/p/${board.pid}/board`;
      q.title = board.waiting.slice(0, 3).map((w) => `${w.qid || "?"} ${w.problem}`).join("\n");
      q.onclick = (ev) => ev.stopPropagation();  // the row opens the project; this opens its board
      box.append(q);
    }
    return box;
  }

  function draw() {
    // the home page: "Notify me" by the projects, a board line on each card
    const slot = document.getElementById("notify-slot");
    if (slot && !slot.firstChild) { const b = button(); if (b) slot.append(b); }
    const byPid = new Map(data.boards.map((b) => [b.pid, b]));
    for (const row of document.querySelectorAll("#projects .projrow")) {
      const old = row.querySelector(".projboard");
      const board = byPid.get(row.dataset.pid);
      const now = board ? line(board) : null;
      if (old) old.remove();
      if (now) row.querySelector(".projmain").append(now);
    }
    // a project page: the count on its Project tab
    const pid = (location.pathname.match(/^\/p\/([^/]+)/) || [])[1];
    const tab = document.querySelector('.tabs button[data-tab="project"]');
    if (pid && tab) {
      const n = (byPid.get(pid) || {waiting: []}).waiting.length;
      let badge = tab.querySelector(".tabbadge");
      if (n && !badge) { badge = mk("span", "tabbadge"); tab.append(badge); }
      if (badge) { badge.hidden = !n; badge.textContent = String(n); }
      tab.title = n ? `Project — ${n > 1 ? `${n} questions wait` : "a question waits"} for you` : "Project — build it by talking to the assistant";
    }
  }
  // the home page draws its rows after this file: draw again when they land
  document.addEventListener("ox:projects", draw);

  poll();
  return {poll, button, draw, get data() { return data; }};
})();
