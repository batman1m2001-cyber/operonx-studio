/* operonx studio — the assistant's hand (docs/ALIVE_ASSISTANT_PLAN.md D1).
 *
 * The only thing that moves the screen for the assistant, so it is seen
 * working: `go` switches the screen the way the user would (the cursor
 * presses the menu's icon first), `point` glides a small cursor to an
 * element and rings it with two or three words, `press` adds the click.
 * A press is a picture of what the assistant did through its tools: the
 * hand never fires the button, so nothing happens twice.
 *
 * Elements are named, not found: `data-ox-target="plan:docs/X_PLAN.md"`.
 * A gesture waits up to 3 s for its target to be drawn, then gives up
 * quietly. Gestures run one after another, each long enough to follow;
 * a backlog keeps only the newest few.
 *
 * The user stays in charge (D4): following is a switch (remembered), and
 * the moment the user clicks, scrolls or types outside the conversation,
 * the hand stops for the rest of that turn and says so, with a way back.
 * Reduced motion: no glide, the ring only.
 */

"use strict";

const Hand = (() => {
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
  const DWELL = 900;        // ms a gesture stays before the next (quick ones: 380)
  const LINGER = 4000;      // the ring fades after this, if nothing follows
  const WAIT = 3000;        // how long a target may take to be drawn
  const MAX_QUEUE = 6;

  const cursor = el("div", "ox-hand");
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8-6.2 1.6L9.6 19z"/></svg>';
  const ring = el("div", "ox-ring");
  ring.setAttribute("aria-hidden", "true");
  const label = el("span", "ox-ring-words");
  ring.append(label);
  const live = el("div", "ox-hand-live");      // what the hand does, for a screen reader
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  const paused = el("div", "ox-hand-paused");
  paused.hidden = true;
  document.body.append(cursor, ring, live, paused);

  let queue = [];
  let running = false;
  let lit = null;           // the element ringed now
  let litTarget = null;     // its name: a redraw replaces the element, the name finds the new one
  let fade = null;
  let stopped = false;      // the user took over for this turn
  let follow = recall("handFollow", true);
  let at = null;            // the cursor's place {x, y}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (n) => !!n && n.isConnected && n.getClientRects().length > 0;

  /* the element a target names: the page's own before the status column's, a visible one first */
  function find(target) {
    let all;
    const [kind, ...rest] = target.split(":");
    const name = CSS.escape(rest.join(":"));
    if (kind === "tab") all = [...document.querySelectorAll(`#rail [data-tab="${name}"]`)];
    else if (kind === "page") all = [...document.querySelectorAll(`#prail [data-ppage="${name}"]`)];
    else if (target === "commit:new") all = [...document.querySelectorAll('[data-ox-target^="commit:"]')];
    else all = [...document.querySelectorAll(`[data-ox-target="${CSS.escape(target)}"]`)];
    all = all.filter(visible);
    return all.find((n) => n.closest(".pm-page")) || all[0] || null;
  }
  async function wait(target, ms) {
    const t0 = Date.now();
    for (;;) {
      const n = find(target);
      if (n) return n;
      if (Date.now() - t0 > ms) return null;
      await sleep(120);
    }
  }

  function moveTo(x, y, quick) {
    cursor.classList.add("on");
    const glide = !REDUCED.matches && at;
    cursor.style.transition = glide ? `transform ${quick ? 260 : 520}ms cubic-bezier(.3,.7,.2,1)` : "none";
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    at = {x, y};
    return sleep(glide ? (quick ? 260 : 520) : 0);
  }

  function place() {
    if (lit && !visible(lit) && litTarget) lit = find(litTarget);
    if (!lit || !visible(lit)) { ring.classList.remove("on"); return; }
    const r = lit.getBoundingClientRect();
    Object.assign(ring.style, {left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px`});
    // a small element (an icon in a bar) keeps its words beside it, not cut off above it
    ring.classList.toggle("side", r.width < 90);
    requestAnimationFrame(place);
  }
  function light(n, target, words) {
    clearTimeout(fade);
    lit = n;
    litTarget = target;
    label.textContent = words || "";
    label.hidden = !words;
    ring.classList.remove("on");
    void ring.offsetWidth;   // restart the ring's arrival
    ring.classList.add("on");
    place();
    fade = setTimeout(() => { ring.classList.remove("on"); cursor.classList.remove("on"); lit = litTarget = null; }, LINGER);
  }

  const lastLit = new Map();   // target → when it was last ringed
  async function point(target, words, opts) {
    opts = opts || {};
    // a soft gesture gives way to one on the same element lit after it was asked for ("2/5" before "saved")
    if (opts.soft && (lastLit.get(target) || 0) > (opts.asked || 0)) return false;
    if (typeof ProjectMode !== "undefined" && ProjectMode.reveal) ProjectMode.reveal(target);
    let n = await wait(target, opts.or ? 1200 : WAIT);
    if (!n && opts.or) { n = await wait(opts.or, 600); target = opts.or; }
    if (!n || (!active() && !opts.force)) return false;
    lastLit.set(target, Date.now());
    // the canvas pans itself (select_op centres the op); scrolling its plane would shift the picture
    if (!n.closest("#plane")) n.scrollIntoView({block: "nearest", inline: "nearest", behavior: REDUCED.matches ? "auto" : "smooth"});
    await sleep(REDUCED.matches ? 0 : 160);
    const r = n.getBoundingClientRect();
    await moveTo(r.left + Math.min(28, r.width / 2), r.top + Math.min(r.height / 2, 18), opts.quick);
    light(n, target, words);
    live.textContent = words ? `${words}: ${target.split(":").slice(1).join(":")}` : "";
    if (opts.press) {
      cursor.classList.remove("click"); void cursor.offsetWidth; cursor.classList.add("click");
      n.classList.remove("ox-pressed"); void n.offsetWidth; n.classList.add("ox-pressed");
      await sleep(260);
    }
    return true;
  }

  /* switch the screen the way the user would: the cursor presses the bar's icon first */
  // the user is writing something: the screen stays where it is (points still land where they can)
  const typing = () => { const a = document.activeElement; return !!a && /TEXTAREA|INPUT/.test(a.tagName) && !!a.value; };

  async function go(where) {
    if (typing()) return;
    if (where.tab === "project") {
      if (state.tab !== "project") {
        await point("tab:project", null, {press: true, quick: true});
        switchTab("project", {page: where.page || "now"});
      } else if (where.page && typeof ProjectMode !== "undefined" && ProjectMode.page() !== where.page) {
        await point(`page:${where.page}`, null, {press: true, quick: true});
        ProjectMode.go(where.page);
      }
    } else if (where.tab && where.tab !== state.tab) {
      await point(`tab:${where.tab}`, null, {press: true, quick: true});
      switchTab(where.tab, where.opts);
    }
    await sleep(REDUCED.matches ? 0 : 220);
  }

  function active() { return follow && !stopped && !document.hidden; }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const s = queue.shift();
        // the user's own click (a link that points) plays though following is off
        if (!active() && !s.force) { queue = queue.filter((x) => x.force); continue; }
        if (s.refresh && typeof ProjectMode !== "undefined") { await ProjectMode.refresh(); continue; }
        if (s.go) { await go(s.go); continue; }
        if (s.run) { try { await s.run(); } catch { /* the action's own error shows where it ran */ } continue; }
        const done = await point(s.point || s.press, s.words, {press: !!s.press, quick: s.quick, or: s.or, soft: s.soft, asked: s.asked, force: s.force});
        if (done) await sleep(s.quick ? 380 : DWELL);
      }
    } finally { running = false; }
  }

  /* gestures to play, in order; a long backlog keeps its newest. `front`: before what waits (what just happened) */
  function play(steps, opts) {
    const force = !!(opts && opts.force);
    if (!steps || !steps.length || (!active() && !force)) return;
    const asked = Date.now();
    steps = steps.map((s) => ({asked, force, ...s}));
    if (opts && opts.front) queue.unshift(...steps);
    else queue.push(...steps);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    drain();
  }

  /* the user's own hand wins: a real click, wheel or key outside the conversation stops the hand for this turn */
  const mine = (ev) => ev.target && ev.target.closest && ev.target.closest(".ax, #prail, .ox-hand-paused, .ox-follow");
  function takeOver(ev) {
    if (!ev.isTrusted || stopped || !running && !queue.length || mine(ev)) return;
    stopped = true;
    queue = [];
    ring.classList.remove("on");
    cursor.classList.remove("on");
    paused.hidden = false;
  }
  for (const t of ["pointerdown", "wheel", "keydown"]) document.addEventListener(t, takeOver, true);
  paused.append(el("span", null, "You took over; the assistant keeps working"));
  const back = el("button", "linkbtn", "Follow it again");
  back.type = "button";
  back.onclick = () => { stopped = false; paused.hidden = true; };
  paused.append(back);
  // a new turn: the hand follows again
  document.addEventListener("oxassistant", (ev) => {
    if (ev.detail && ev.detail.busy) { stopped = false; paused.hidden = true; }
    else setTimeout(() => { paused.hidden = true; }, 2500);
  });

  function setFollow(on) {
    follow = !!on;
    store("handFollow", follow);
    if (!follow) { queue = []; ring.classList.remove("on"); cursor.classList.remove("on"); }
    document.dispatchEvent(new CustomEvent("oxhandfollow", {detail: {on: follow}}));
  }

  return {play, point: (t, w) => play([{point: t, words: w}]), go: (w) => play([{go: w}]),
          follow: () => follow, setFollow, active, busy: () => running || queue.length > 0};
})();
