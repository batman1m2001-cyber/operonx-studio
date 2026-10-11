/* Every screen has an address (docs/STUDIO_EXPERIENCE_PLAN.md §2.3).
 *
 *   /p/<pid>/<screen>[/<run>][?view=tree|workflow][&step=<op id>][&op=<flow op>]
 *
 * `pushView()` (studio.js) already says what is on screen, in one place, for
 * the assistant; the URL follows it: a new screen or run is a history entry
 * (Back returns to it), a selection inside one replaces the current entry.
 * On load and on Back the address is read and played through `performUi`,
 * the same door the assistant's actions use. The old `?run=&op=` links keep
 * working (studio.js reads them before this). */

const Router = (() => {
  // screen names in the address; the Runs screen is the `traces` tab inside
  const SCREEN_OF_TAB = {traces: "runs"};
  const TAB_OF_SCREEN = {runs: "traces"};
  let replaying = false;
  let last = null;
  // the first picture is drawn before the address is read: until then the
  // address is what was asked for, not what is on screen
  let started = false;

  function base() {
    const parts = location.pathname.split("/");
    return `/${parts[1]}/${parts[2]}`;
  }

  /* What is on screen, as an address. */
  function addressOf(v) {
    if (!v || !v.tab) return null;
    let path = `${base()}/${SCREEN_OF_TAB[v.tab] || v.tab}`;
    const q = new URLSearchParams();
    if (v.tab === "traces" && v.run) {
      path += `/${encodeURIComponent(v.run)}`;
      if (v.mode === "workflow") q.set("view", "workflow");
      if (v.exec_id) q.set("step", v.exec_id);
    }
    if (v.tab === "flow" && v.node) q.set("op", v.node);
    if (v.tab === "yaml" && v.file) q.set("file", v.file);
    const qs = q.toString();
    return {path, full: qs ? `${path}?${qs}` : path};
  }

  /* An address, as what to show. */
  function parse(loc) {
    const parts = loc.pathname.split("/").slice(3).filter(Boolean).map(decodeURIComponent);
    const q = new URLSearchParams(loc.search);
    const screen = parts[0] || null;
    return {
      tab: screen ? (TAB_OF_SCREEN[screen] || screen) : null,
      run: parts[1] || q.get("run") || null,
      mode: q.get("view") === "workflow" ? "workflow" : "tree",
      step: q.get("step") || null,
      op: q.get("op") || null,
      file: q.get("file") || null,
    };
  }

  /* Called by pushView: write the address for what is on screen. */
  function follow(v) {
    if (!started) return;
    const a = addressOf(v);
    if (!a) return;
    const here = location.pathname + location.search;
    if (a.full === here) { last = a; return; }
    // a new screen or run is somewhere to come back to; a selection is not
    const moved = !last || last.path !== a.path;
    try {
      if (replaying || !moved) history.replaceState(null, "", a.full);
      else history.pushState(null, "", a.full);
    } catch { /* a sandboxed frame: the address is a nicety */ }
    last = a;
  }

  /* Show what the address names. */
  async function replay(loc) {
    const t = parse(loc);
    if (!t.tab) { start(); return; }
    replaying = true;
    try {
      if (t.tab === "traces" && t.run) {
        await performUi("open_run", {run: t.run, mode: t.mode, op: t.step || undefined, quiet: true});
      } else if (t.tab === "flow" && t.op) {
        await performUi("select_op", {op: t.op});
      } else if (t.tab === "yaml" && t.file) {
        state.yamlFile = t.file;
        switchTab("yaml", {file: t.file});
      } else if (t.tab !== state.tab || t.tab === "traces") {
        switchTab(t.tab);
      }
    } finally {
      replaying = false;
      start();
    }
  }

  /* From now on the address follows the screen. */
  function start() {
    started = true;
    last = addressOf(window.__oxview);
    if (last && last.full !== location.pathname + location.search) {
      try { history.replaceState(null, "", last.full); } catch { /* fine */ }
    }
  }

  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("popstate", () => { replay(location); });
  }

  return {follow, replay, start, parse, addressOf};
})();

if (typeof module !== "undefined") module.exports = Router;
