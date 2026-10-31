/* The assistant's blocks (docs/VISUAL_CHAT_PLAN.md D2, D3): one registry for
   the visual blocks a reply can hold, and one status vocabulary for every
   step, row, card, node and callout.

   A block registers itself by name: a fence language (```ox-graph) or an
   item kind. md() and append() in assistant.js ask here before their own
   rendering, so a new visual type is one file that calls register().

     register(name, {validate(body) → {ok, value} | {ok: false, reason},
                     render(value, ctx) → node,
                     partial(body, ctx) → node,     while the fence is open
                     update(value, ctx) → bool})    an update by id (D10)

   ctx carries the page's helpers (el, icon, codeBlock, …), so the logic
   here needs no DOM: tests/js/blocks.test.mjs runs it in node. */
const oxBlocks = (() => {
  const reg = new Map();

  function register(name, spec) {
    reg.set(name, spec);
    return spec;
  }
  const has = (name) => reg.has(name);
  const get = (name) => reg.get(name) || null;

  /* D3: every status the page shows, as a tone (the --st-* token it is
     drawn in), an icon and a word. Colour is never alone. */
  const TONE = {
    ok: ["ok", "check", "Done"],
    done: ["ok", "check", "Completed"],
    passed: ["ok", "check", "Passed"],
    success: ["ok", "check", "Success"],
    warn: ["warn", "alert", "Warning"],
    warning: ["warn", "alert", "Warning"],
    recovered: ["warn", "refresh", "Recovered"],
    waiting: ["warn", "alert", "Needs you"],
    err: ["err", "x", "Failed"],
    error: ["err", "x", "Failed"],
    failed: ["err", "x", "Failed"],
    fatal: ["err", "alert", "Stopped"],
    run: ["run", null, "Running"],
    running: ["run", null, "Running"],
    active: ["run", null, "In progress"],
    pending: ["pending", "dot", "Pending"],
    stopped: ["pending", "stop", "Stopped"],
    blocked: ["blocked", "ban", "Blocked"],
    skip: ["skip", "skip", "Skipped"],
    skipped: ["skip", "skip", "Skipped"],
    note: ["info", "info", "Note"],
    finding: ["run", "spark", "Finding"],
  };

  /* status("failed") → {kind, tone, icon, word, spin}; an unknown kind is pending */
  function status(kind) {
    const k = String(kind || "pending").toLowerCase();
    const [tone, icon, word] = TONE[k] || TONE.pending;
    return {kind: TONE[k] ? k : "pending", tone, icon, word, spin: tone === "run" && !icon};
  }

  /* D3 callouts: a blockquote whose first line is [!NOTE], [!WARNING],
     [!ERROR], [!SUCCESS] or [!FINDING], with an optional title after it */
  const CALLOUT = {NOTE: "note", WARNING: "warning", ERROR: "error", SUCCESS: "success", FINDING: "finding"};
  function callout(lines) {
    const m = /^\s*\[!(NOTE|WARNING|ERROR|SUCCESS|FINDING)\]\s*(.*)$/i.exec(lines[0] || "");
    if (!m) return null;
    const kind = CALLOUT[m[1].toUpperCase()];
    const word = kind === "error" ? "Error" : status(kind).word;
    return {kind, title: m[2].trim() || word, body: lines.slice(1).join("\n")};
  }

  /* a fence md() met: the registered block for its language, a placeholder
     while it streams, or the code as written with why it could not be
     drawn. null when no block owns the language. */
  function fence(lang, body, closed, ctx) {
    const spec = reg.get(lang);
    if (!spec) return null;
    if (!closed) return spec.partial ? spec.partial(body, ctx) : placeholder(lang, ctx);
    let v;
    try { v = spec.validate ? spec.validate(body, ctx) : {ok: true, value: body}; }
    catch (e) { v = {ok: false, reason: String((e && e.message) || e)}; }
    if (!v || !v.ok) return fallback(lang, body, (v && v.reason) || "invalid", ctx);
    try { return spec.render(v.value, ctx); }
    catch (e) { return fallback(lang, body, String((e && e.message) || e), ctx); }
  }

  function placeholder(lang, ctx, height) {
    const box = ctx.el("div", "ax-blk-wait");
    if (height) box.style.minHeight = `${height}px`;
    box.append(ctx.el("span", "ax-spin"), ctx.el("span", null, `Drawing ${lang.replace(/^ox-/, "")}…`));
    return box;
  }

  function fallback(lang, body, reason, ctx) {
    const box = ctx.el("div", "ax-blk-fail");
    box.append(ctx.codeBlock(lang, body), ctx.el("div", "ax-blk-why", `could not draw: ${reason}`));
    return box;
  }

  /* an item kind append() met: the registered renderer's node, or null */
  function item(kind, it, ctx) {
    const spec = reg.get("item:" + kind);
    return spec ? spec.render(it, ctx) : null;
  }

  const api = {register, has, get, status, callout, fence, item, placeholder, fallback, TONE};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})();
if (typeof window !== "undefined") window.oxBlocks = oxBlocks;
