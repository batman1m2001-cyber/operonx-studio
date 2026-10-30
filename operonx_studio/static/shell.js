/* operonx studio — the shell: tabs, the side panel, the legend, the
 * switcher, find, loading, the pulse and the UI actions. Split from
 * studio.js, same bundle, same order. */

/* ── tabs, graph switch, pan/zoom, live reload ────────────────────── */

/* Screens other files add (settings.js, runs.js, …): each registers
 * {el, show} here and switchTab shows and hides it like the built-ins. */
const PANES = {};
function registerPane(name, pane) { PANES[name] = pane; }

/* A revisited screen shows its last picture at once, and refreshes under
 * it. Through the tunnel a screen's data is a request away (~0.75 s), and
 * Runs, Monitor, Settings and the Playground used to go blank or say
 * "Loading…" for that long on every revisit (measured). The picture is a
 * copy laid over the screen, inert, while the screen rebuilds beneath it
 * at its real size; once what is underneath has settled (nothing still
 * loading) the copy lifts, and rows the copy did not have are marked. */
const LOADING = /Loading|Starting the|Connecting/;
const covers = new Set();            // the lift of every cover up: leaving a screen lifts its cover
function coverWhileFresh(elm) {
  if (!elm || elm.hidden || !(elm.textContent || "").trim() || elm._cover) return;
  const parent = elm.offsetParent;
  if (!parent) return;
  const cover = elm.cloneNode(true);
  cover.removeAttribute("id");
  for (const n of cover.querySelectorAll("[id]")) n.removeAttribute("id");
  cover.classList.add("revisit-cover");
  cover.inert = true;
  cover.setAttribute("aria-hidden", "true");
  Object.assign(cover.style, {position: "absolute", left: `${elm.offsetLeft}px`, top: `${elm.offsetTop}px`,
    width: `${elm.offsetWidth}px`, height: `${elm.offsetHeight}px`, margin: "0"});
  const seen = new Set([...elm.querySelectorAll("[data-key]")].map(n => n.dataset.key));
  const scroll = elm.scrollTop;
  elm.after(cover);
  cover.scrollTop = scroll;
  elm._cover = cover;
  let frame = 0;
  const settled = () => (elm.textContent || "").trim().length > 40 && !LOADING.test(elm.textContent);
  const lift = () => {
    covers.delete(lift);
    if (elm._cover !== cover) return;
    observer.disconnect();
    clearTimeout(cap);
    elm._cover = null;
    elm.scrollTop = scroll;
    cover.remove();
    // what the last picture did not have: marked, quietly, for a moment
    if (seen.size) for (const n of elm.querySelectorAll("[data-key]")) if (!seen.has(n.dataset.key)) n.classList.add("fresh");
  };
  const check = () => { frame = 0; if (settled()) lift(); };
  const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(check); });
  observer.observe(elm, {childList: true, subtree: true, characterData: true});
  const cap = setTimeout(lift, 6000);
  covers.add(lift);
  requestAnimationFrame(() => requestAnimationFrame(check));
}

function switchTab(name, opts) {
  // the Board lives in Project mode now: a milestone opens on its Plans page (docs/PROJECT_MODE_PLAN.md P4)
  if (name === "board") { switchTab("project", {page: "plans", mid: (opts && opts.mid) || recall(`board:${PID}`, {}).mid || ""}); return; }
  // the playground runs a service's code: not a viewer's (D11); every way in stops here
  if (name === "playground" && window.Account && Account.viewOnly) { Account.toast(Account.VIEW_ONLY, true); return; }
  // where the Flow tab was: a run's pane borrows the canvas, and moving
  // it resets its scroll (hiding it does not)
  if (state.tab === "flow" && !state.workflowOn && canvasShown()) {
    const st = $("#stage");
    state.flowView = {scale: state.view.scale, x: st.scrollLeft, y: st.scrollTop};
  }
  leaveWorkflow();
  for (const lift of [...covers]) lift();
  state.tab = name;
  if (name !== "traces") { state.execPanelRun = null; state.execSel = null; }
  if (window.oxRailLabel) window.oxRailLabel(name);
  for (const b of document.querySelectorAll(".tabs button[data-tab], [data-tabbtn]")) {
    const on = (b.dataset.tab || b.dataset.tabbtn) === name;
    b.classList.toggle("active", on);
    b.setAttribute(b.dataset.tab ? "aria-selected" : "aria-pressed", String(on));
  }
  $("#stage").style.display = name === "flow" ? "" : "none";
  $("#traces").hidden = name !== "traces";
  $("#jobs").hidden = name !== "jobs";
  $("#resources").hidden = name !== "resources";
  for (const [n, p] of Object.entries(PANES)) p.el.hidden = n !== name;
  // a revisit: the last picture while the screen refreshes (not for a run
  // the caller is about to open, nor the canvas)
  if (!(opts && opts.quiet)) coverWhileFresh(PANES[name] ? PANES[name].el : name === "traces" ? $("#traces") : null);
  if (PANES[name]) PANES[name].show(opts);
  // quiet: the caller is about to fill the Traces pane itself
  if (name === "traces" && !(opts && opts.quiet)) showTraces();
  if (name === "jobs") showJobs(state.jobSel);
  if (name === "resources") showResources();
  // on a phone the sheet belongs to the screen it was opened on
  if (MOBILE.matches && recall("sideTab", "assistant") === "inspect") store(panelKey(), false);
  syncChrome();
  applyPanels();
  // a canvas left stale while hidden is drawn now, at its final size —
  // callers read it right after this
  if (name === "flow") flushCanvas();
  // the inspector speaks about what is on screen: a canvas selection
  // does not follow the user into the Traces list
  if (name !== "flow" && state.sel) { state.sel = state.dfFocus = null; refreshSelection(); }
  renderFlowInfo();
  pushView();
}

/* The chrome follows what is on screen: the body carries the tab, and
 * `data-stage` while the canvas shows (the Flow tab, or a run's workflow
 * view) — the canvas toolbar appears only then. */
function syncChrome() {
  document.body.dataset.tab = state.tab;
  // a run painted on the canvas: its header's switch says Workflow or Data Flow
  document.body.classList.toggle("runwf", !!state.workflowOn);
  const stageOn = state.tab === "flow" || !!state.workflowOn;
  if (stageOn) document.body.dataset.stage = "";
  else delete document.body.dataset.stage;
  // the Flow screen's chrome floats over the canvas as glass (a run's
  // canvas sits in its pane, under a solid head)
  document.body.classList.toggle("floatframe", state.tab === "flow" && !state.workflowOn);
  if (!stageOn) { $("#find").hidden = true; $("#legend").hidden = true; }
}

/* ── the side panel: one panel on the right, two tabs ──────────────
   Inspect is the project summary or the selected op; Assistant is the
   chat. The panel is optional; the tab is remembered. Selecting an op
   brings the Inspect tab forward, the chat bubble brings Assistant.
   On a phone the panel is a bottom sheet over the canvas: closed by
   default, opened by a selection, remembered on its own key so a
   desktop preference never covers a phone screen. Where there is
   nothing to inspect (Jobs, Resources) the panel is the assistant's or
   nobody's — an inspector with nothing in it only costs width. */

const MOBILE = window.matchMedia("(max-width: 760px)");
// the screens that are mostly data (a run, the monitor, the evals) want the
// width: there the panel is closed until it is opened there, and that
// choice is remembered apart from the other screens' (docs/STUDIO_EXPERIENCE_PLAN.md T2)
const DENSE = new Set(["traces", "monitor", "evals", "resources"]);
const panelKey = () => (MOBILE.matches ? "panelRightM" : "panelRight") + (DENSE.has(state.tab) ? ":dense" : "");
// open by default only where it fits beside the content (a tablet gets
// it as an overlay, opened from the Ask bar)
const WIDE = window.matchMedia("(min-width: 1100px)");
const panelWanted = () => recall(panelKey(), WIDE.matches && !DENSE.has(state.tab));
const inspectable = () => state.tab === "flow" || state.tab === "traces";

function panelState() {
  const tab = recall("sideTab", "assistant");
  const on = panelWanted() && !(tab === "inspect" && !inspectable());
  return {on, tab};
}

function applyPanels() {
  const {on, tab} = panelState();
  $("#sidebar").classList.toggle("off", !on);
  $("#btn-right").classList.toggle("active", on);
  $("#btn-right").setAttribute("aria-pressed", String(on));
  for (const b of document.querySelectorAll("#sidetabs button[data-side]")) {
    b.classList.toggle("active", b.dataset.side === tab);
    b.setAttribute("aria-selected", String(b.dataset.side === tab));
  }
  $("#inspector").hidden = tab !== "inspect";
  // `on`: the chat is showing; `panel`: the sidebar is open at all — the
  // floating bubble stays away whenever the panel is open, since the
  // Assistant tab is one click away inside it
  document.dispatchEvent(new CustomEvent("oxdock", {detail: {on: on && tab === "assistant", panel: on}}));
}
function showSide(tab) {
  store(panelKey(), true);
  store("sideTab", tab);
  applyPanels();
}
function hideSide() {
  store(panelKey(), false);
  applyPanels();
}
window.oxSide = {
  show: showSide,
  hide: (tab) => { if (tab) store("sideTab", tab); hideSide(); },
  state: panelState,
  toggle: () => {
    const {on, tab} = panelState();
    if (on) hideSide();
    else showSide(tab === "inspect" && !inspectable() ? "assistant" : tab);
  },
};
$("#btn-right").onclick = window.oxSide.toggle;
$("#side-close").onclick = () => { hideSide(); if (state.sel) deselect(); };
for (const b of document.querySelectorAll("#sidetabs button[data-side]"))
  b.onclick = () => showSide(b.dataset.side);
MOBILE.addEventListener("change", applyPanels);

/* ── the legend: the visual language, written down on screen ──────── */

function legendSample(cls, dash) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 64 12");
  svg.setAttribute("class", "wires lsample");
  const d = "M 2 6 L 62 6";
  if (dash) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    p.setAttribute("class", cls);
    svg.append(p);
  } else {
    energyEdge(svg, d, cls);
  }
  return svg;
}

function buildLegend() {
  const box = $("#legend");
  box.textContent = "";
  const title = el("div", "ltitle", "Reading the canvas");
  const close = Icons.button("x", undefined, "chat-close", "Close");
  close.onclick = () => { box.hidden = true; };
  title.append(close);
  box.append(title);

  const row = (sample, text) => {
    const r = el("div", "lrow");
    r.append(sample, el("span", null, text));
    box.append(r);
  };
  row(legendSample(""), "data flows this way — the output feeds the next op");
  row(legendSample("cond"), "if/else route — a router is a patch panel with a zone per route, in route order. Each clause of a condition is a book (read top to bottom); under them, each and (&, solid) / or (|, dashed) is a bracket joining its books, nesting as the condition does, and the last one's stem runs to the route's socket. The socket's light is on for the route a run took. Point at a zone for its condition, click it to find it in the decision table");
  row(legendSample("ecore cond relse", true), "else — fires only when no condition matched");
  row(legendSample("soft", true), "soft merge — may not fire at all");
  row(el("span", "lglyph lzone", "↺"), "a violet zone is a loop: the steps inside run again every turn; its header says where the loop exits and on what condition");
  row(el("span", "lglyph", "next turn"), "the violet return wire goes back to the start of the loop for another turn; \"exit loop\" marks the route that leaves it");
  row(el("span", "lglyph", "⚡"), "generator (a card with a stack behind it): one call, many yields — consumers run per yield");
  row(el("span", "lglyph", "≋ ∥ ⧉"), "streaming edge · parallel fan-out · collect-into-list");
  row(el("span", "lglyph", "▣"), "a nested graph — click its badge (or double-click) to open it in place");
  row(el("span", "lglyph", "▶"), "START / END terminals are a graph's own ports — the main flow and every opened GraphOp have them; the dotted ties from START are session-start dispatch");
  row(el("span", "lglyph", "⇥"), "framed doors are the serve boundary: the ingress wears the transport's name, the reply leaves egress toward the client");
  row(el("span", "lheat"), "with a run painted: warmer border = slower average, red = errored, faded = did not run");

  box.append(el("div", "ltitle lkeys", "Data"));
  row(el("span", "lglyph ldata", "─⚡─"), "a data wire: a value going from the op that makes it to the op that reads it; its spark runs the way the data goes");
  row(el("span", "lglyph ldata", "─◯<"), "a split point: one value read by several ops leaves its op once and splits here");
  row(el("span", "lglyph ldata", ">◯─"), "a merge ring: several ops feed one input (alternative branches); their wires meet here, then go in as one");
  row(el("span", "lglyph ldata", "◉ x"), "click an op to see all its data wires; point at a variable or a wire to single it out; click a variable to follow its value through the graph");
  row(el("span", "lglyph ldata", "x ◉"), "a router's inputs plug straight into the condition that reads them; the same variable in other conditions wears the same colour, and lights with it");

  box.append(el("div", "ltitle lkeys", "Keys"));
  box.append(el("div", "lrow lkeysrow",
    "/ or Ctrl+K find · space+drag or middle-drag pan · ctrl+scroll zoom · "
    + "0 fit · 1 = 100% · D Workflow ⇄ Data Flow · ↑ ↓ walk the wires · Esc close"));
}

$("#btn-legend").onclick = () => {
  const box = $("#legend");
  if (box.hidden) buildLegend();
  box.hidden = !box.hidden;
};

/* ── quick switcher: change project without the round trip home ───── */

/* The projects are fetched once, when the page opens, so the switcher
 * opens at once (behind a tunnel a fetch is a second); each opening
 * refreshes them quietly and redraws only if they changed. */
let projectsSeen = null;
const fetchProjects = () => api("/api/projects")
  .then(({projects}) => { projectsSeen = projects.filter(x => x.exists); return projectsSeen; })
  .catch(() => projectsSeen);
fetchProjects();
// a path as a reader scans it: the home folder as ~, the last two folders
const shortPath = (root) => {
  const p = String(root || "").replace(/^\/(?:home\/[^/]+|root)(?=\/|$)/, "~");
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
};
function renderSwitcher(keep) {
  const list = projectsSeen || [];
  menuList($("#switcher"), {
    placeholder: list.length ? "Find a project" : "Loading projects…",
    sections: [{title: "Projects", icon: "folder", rows: list.map(p => ({
      name: p.name, sub: shortPath(p.root), title: p.root, current: p.id === PID,
      pick: () => { if (p.id !== PID) location.href = `/p/${p.id}`; else $("#switcher").hidden = true; },
    }))}],
    footer: {name: "All projects", pick: () => { location.href = "/"; }},
  }, keep);
}
$("#pname").onclick = () => {
  const menu = $("#switcher");
  if (!menu.hidden) { menu.hidden = true; $("#pname").setAttribute("aria-expanded", "false"); return; }
  $("#pmenu").hidden = true;
  renderSwitcher(false);
  menu.hidden = false;
  $("#pname").setAttribute("aria-expanded", "true");
  const before = JSON.stringify(projectsSeen);
  fetchProjects().then(() => {
    if (!menu.hidden && JSON.stringify(projectsSeen) !== before) renderSwitcher(true);
  });
};
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#switcher") && !ev.target.closest("#pname")) {
    $("#switcher").hidden = true;
    $("#pname").setAttribute("aria-expanded", "false");
  }
});
for (const b of document.querySelectorAll(".tabs button[data-tab]"))
  b.onclick = () => switchTab(b.dataset.tab);

/* The rail: the screens grouped by what they are for. Slim (icons, the
 * name on hover, the groups as thin lines) unless the user widened it
 * (docs/PROJECT_MODE_PLAN.md D4); on a phone a drawer the header's screen
 * button opens, which closes again once a screen is picked. */
(function rail() {
  const r = $("#rail"), shade = $("#railshade"), btn = $("#btn-screen");
  const apply = () => {
    const pref = recall("railSlim", null);
    document.body.classList.toggle("railslim", !MOBILE.matches && (pref ?? true));
    const slim = document.body.classList.contains("railslim");
    $("#rail-slim").title = slim ? "Expand the menu" : "Collapse the menu";
    $("#rail-slim").setAttribute("aria-label", $("#rail-slim").title);
  };
  $("#rail-slim").onclick = () => { store("railSlim", !document.body.classList.contains("railslim")); apply(); };
  MOBILE.addEventListener("change", apply);
  apply();
  const close = () => { document.body.classList.remove("railopen"); shade.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.onclick = () => {
    const open = !document.body.classList.contains("railopen");
    document.body.classList.toggle("railopen", open);
    shade.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  shade.onclick = close;
  for (const b of r.querySelectorAll(".tabs button[data-tab]")) b.addEventListener("click", close);
  // slim, each icon says its name on hover, beside it (the rail scrolls, so the label floats over the page)
  const tip = el("div");
  tip.id = "railtip";
  tip.hidden = true;
  document.body.append(tip);
  const slimNow = (b) => !MOBILE.matches && (b.closest("#prail") || document.body.classList.contains("railslim"));
  for (const b of document.querySelectorAll("#rail .tabs button, #rail .railtoggle, #prail .tabs button")) {
    b.addEventListener("mouseenter", () => {
      const name = b.querySelector("span");
      if (!slimNow(b) || !name) return;
      const box = b.getBoundingClientRect();
      tip.textContent = name.textContent;
      tip.style.left = `${box.right + 8}px`;
      tip.style.top = `${box.top + box.height / 2}px`;
      tip.hidden = false;
    });
    b.addEventListener("mouseleave", () => { tip.hidden = true; });
    b.addEventListener("click", () => { tip.hidden = true; });
  }
  window.oxRailLabel = (name) => {
    const b = r.querySelector(`.tabs button[data-tab="${name}"] span`);
    $("#screen-label").textContent = b ? b.textContent : name ? name[0].toUpperCase() + name.slice(1) : "";
  };
})();

$("#graph-pick").onchange = (ev) => {
  state.flowHome = null;   // a graph picked by hand is the one to come back to
  state.graph = state.ir.graphs.find(g => g.name === ev.target.value);
  state.sel = state.dfFocus = null;
  state.expanded.clear();
  $("#inspector").classList.remove("open");
  // the side panel speaks about the graph on screen, not the last one
  render(); fit(); renderFlowInfo(); pushView();
};

for (const b of document.querySelectorAll(".viewseg button")) b.onclick = () => setCanvasView(b.dataset.view);
showViewSeg();
{
  const b = $("#btn-flowdots");
  const show = () => { b.setAttribute("aria-pressed", String(flowDotsOn)); b.classList.toggle("on", flowDotsOn); document.body.classList.toggle("nodots", !flowDotsOn); };
  show();
  b.onclick = () => {
    flowDotsOn = !flowDotsOn;
    store("ox:flowdots", flowDotsOn);
    show();
    for (const dot of document.querySelectorAll(".eflow")) dot.style.display = flowDotsOn ? "" : "none";
    if (flowDotsOn && !document.querySelector(".eflow")) render();
  };
}
/* One zoom control: the percentage opens a menu of in, out, 100% and fit
 * (each keeps its key: + − 1 0, and ctrl+wheel and pinch still zoom). */
(() => {
  const btn = $("#btn-zoom-pct"), menu = $("#zoommenu");
  const show = (open) => {
    // above the percentage, kept inside the bar's own width
    const bar = btn.offsetParent;
    menu.style.left = `${Math.max(0, Math.min(btn.offsetLeft, (bar ? bar.offsetWidth : 0) - 190))}px`;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.onclick = (ev) => {
    ev.stopPropagation();
    show(menu.hidden);
    if (!menu.hidden) menu.querySelector("button").focus();
  };
  for (const b of menu.querySelectorAll("button[data-zoom]")) b.onclick = (ev) => {
    ev.stopPropagation();
    const c = stageCenter(), z = b.dataset.zoom;
    if (z === "in") zoomAt(c.x, c.y, 1.25);
    else if (z === "out") zoomAt(c.x, c.y, 0.8);
    else if (z === "100") zoomAt(c.x, c.y, 1 / state.view.scale);   // back to exactly 100%
    else fit();
    // in and out are pressed again and again: the menu stays for them
    if (z === "100" || z === "fit") { show(false); btn.focus(); }
  };
  menu.addEventListener("keydown", (ev) => {
    const items = [...menu.querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (ev.key === "Escape") { ev.stopPropagation(); show(false); btn.focus(); }
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault(); ev.stopPropagation();
      items[(i + (ev.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  document.addEventListener("click", (ev) => { if (!menu.hidden && !ev.target.closest("#zoommenu")) show(false); });
})();

(() => {
  const stage = $("#stage");
  let drag = null;
  let spaceHeld = false;

  // The stage scrolls natively (wheel, trackpad, scrollbars); only
  // ctrl+wheel — and a trackpad pinch, which the browser reports as
  // exactly that — is intercepted, to zoom about the cursor.
  stage.addEventListener("wheel", (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top,
             Math.exp(-ev.deltaY * 0.0022));
    }
  }, {passive: false});

  stage.addEventListener("mousedown", (ev) => {
    // an opened GraphOp's body is canvas — it pans like the background;
    // only its title strip (select, collapse) is a control
    const hit = ev.target.closest(".node");
    const overNode = hit && hit.classList.contains("container") && !ev.target.closest(".chead") ? null : hit;
    const panButton = ev.button === 1 || (ev.button === 0 && spaceHeld);
    if (overNode && !panButton && ev.button === 0) return;  // node click
    if (ev.button !== 0 && ev.button !== 1) return;
    ev.preventDefault();
    drag = {x: ev.clientX, y: ev.clientY,
            sl: stage.scrollLeft, st: stage.scrollTop, moved: false};
    stage.classList.add("panning");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    drag.moved = drag.moved || Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3;
    stage.scrollLeft = drag.sl - (ev.clientX - drag.x);
    stage.scrollTop = drag.st - (ev.clientY - drag.y);
  });
  window.addEventListener("mouseup", () => { drag = null; stage.classList.remove("panning"); });

  window.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault(); openFind(); return;
    }
    if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
    if (ev.key === "Escape") {
      if (dfPort) { dfPort = null; drawDataLayer(); return; }
      if (state.dfTermPort != null) { state.dfTermPort = null; drawDataLayer(); return; }
      if (dfPlatePin) { dfPlatePin = null; drawDataLayer(); return; }
      if (state.dfTerm) { toggleTerm(state.dfTerm); return; }
      if (!$("#find").hidden) closeFind();
      else if (!$("#legend").hidden) $("#legend").hidden = true;
      else if (state.sel) deselect();
      return;
    }
    if (ev.key === "/") { ev.preventDefault(); openFind(); return; }
    if ((ev.key === "d" || ev.key === "D") && !ev.ctrlKey && !ev.metaKey && !ev.altKey && (state.tab === "flow" || state.workflowOn)) {
      setCanvasView(canvasView === "data" ? "workflow" : "data"); return;
    }
    if (ev.key === " ") { spaceHeld = true; stage.classList.add("panmode"); ev.preventDefault(); return; }
    // walk the wires: ↓/→ follows an outgoing edge, ↑/← an incoming one
    if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft"
         || ev.key === "ArrowDown" || ev.key === "ArrowUp") && state.sel) {
      const fwd = ev.key === "ArrowRight" || ev.key === "ArrowDown";
      const hop = state.edgeEls.find(g => (fwd ? g.a : g.b) === state.sel);
      if (hop) {
        const next = fwd ? hop.b : hop.a;
        select(next);
        const item = state.rendered.get(next);
        if (item) centerOn(item);
      }
      ev.preventDefault();
      return;
    }
    const c = stageCenter();
    if (ev.key === "+" || ev.key === "=") zoomAt(c.x, c.y, 1.25);
    else if (ev.key === "-" || ev.key === "_") zoomAt(c.x, c.y, 0.8);
    else if (ev.key === "0") fit();
    else if (ev.key === "1") zoomAt(c.x, c.y, 1 / state.view.scale);
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === " ") { spaceHeld = false; stage.classList.remove("panmode"); }
  });

  stage.addEventListener("click", (ev) => {
    if (ev.target.closest(".node") || ev.target.closest("#find")
        || ev.target.closest("#legend")) return;
    if (dfPort) { dfPort = null; drawDataLayer(); }
    if (state.dfTerm) { toggleTerm(state.dfTerm); return; }
    deselect();
  });
  // the second press of a double-click fell off the card the first one
  // moved (canvas.js doubleClickKey): it still opens that card
  stage.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".node")) return;
    openOp(doubleClickKey(null, ev));
  });
})();

/* ── find a node by name ──────────────────────────────────────────── */

function openFind() {
  const box = $("#find"), input = $("#find-input");
  box.hidden = false;
  input.value = "";
  input.focus();
}

function closeFind() {
  $("#find").hidden = true;
  for (const c of document.querySelectorAll("#nodes .node.dimmed")) c.classList.remove("dimmed");
}

function centerOn(item) {
  const stage = $("#stage");
  const r = stage.getBoundingClientRect(), i = stageInset();
  const s = state.view.scale, ex = state.extent;
  // the middle of the open part, clear of the floating chrome
  stage.scrollLeft = (item.x + item.w / 2 - ex.minX) * s + VIEW_PAD - (r.width - i.l - i.r) / 2;
  stage.scrollTop = (item.y + item.h / 2 - ex.minY) * s + VIEW_PAD - (r.height - i.t - i.b) / 2;
}

(() => {
  const input = $("#find-input");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    for (const c of document.querySelectorAll("#nodes .node")) {
      const name = (c.dataset.name || "").toLowerCase();
      c.classList.toggle("dimmed", !!q && !name.includes(q));
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { closeFind(); return; }
    if (ev.key !== "Enter") return;
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    // the exact name first, then a name that starts with it, then any
    // that contains it ("out" found "router" before "out"); among equals
    // the shallowest wins — the top-level op, not a container's twin
    const rank = (item) => {
      const name = item.node.name.toLowerCase();
      return (name === q ? 0 : name.startsWith(q) ? 1 : 2) * 100 + item.depth;
    };
    let best = null;
    for (const [, item] of state.rendered) {
      if (!item.node.name.toLowerCase().includes(q)) continue;
      if (!best || rank(item) < rank(best)) best = item;
    }
    if (best) { closeFind(); select(best.key); centerOn(state.rendered.get(best.key)); }
  });
})();

/* ── resizable inspector ──────────────────────────────────────────── */

(() => {
  // the side panel sits on the RIGHT; its handle drags leftward
  const bar = $("#dragbar"), panel = $("#sidebar");
  const saved = recall("panelW", null);
  if (saved) panel.style.width = `${saved}px`;
  if (recall("panelWide", false)) panel.classList.add("wide");
  let dragging = false;
  bar.addEventListener("pointerdown", (ev) => {
    dragging = true;
    bar.setPointerCapture(ev.pointerId);
    document.body.classList.add("resizing");
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const right = $(".main").getBoundingClientRect().right;
    const width = Math.min(720, Math.max(300, right - ev.clientX));
    panel.style.width = `${width}px`;
  });
  bar.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    // a click without a drag leaves no width behind (it used to store 340px)
    if (panel.style.width) store("panelW", parseInt(panel.style.width, 10));
  });
  // back to the default: 380px, 420px on a large screen (studio.css)
  bar.addEventListener("dblclick", () => {
    panel.style.width = "";
    store("panelW", null);
  });
})();

syncChrome();
applyPanels();

async function load(first) {
  // the first picture rides in the page itself (app.py project_page)
  const boot = first ? document.getElementById("ir-boot") : null;
  let data = null;
  if (boot) {
    try { data = JSON.parse(boot.textContent); } catch { data = null; }
    boot.remove();
  }
  if (!data) data = await api(`/api/p/${PID}/ir`);
  $("#pname").textContent = "";
  $("#pname").append(el("span", null, data.name || "project"));
  document.title = `${data.name} — operonx studio`;
  if (data.error) {
    $("#nodes").textContent = "";
    $("#edges").textContent = "";
    // the error, not the wall: last line big, traceback folded away
    const box = el("div", "errbox");
    const lines = String(data.error).trim().split("\n");
    box.append(el("div", "errhead", lines[lines.length - 1]));
    if (lines.length > 1) {
      const fold = el("details");
      fold.append(el("summary", null, "full traceback"));
      fold.append(el("pre", "mono", data.error));
      box.append(fold);
    }
    box.append(el("div", "note",
      "Fix the file and save — the studio re-extracts and redraws on its own."));
    box.style.position = "absolute";
    box.style.maxWidth = "700px";
    $("#stage").append(box);
    $("#live").classList.add("stale");
    $("#live-text").textContent = "Extraction failed";
    $("#live").title = "Extraction failed: " + lines[lines.length - 1];
    state.stamp = data.stamp;
    return;
  }
  for (const b of document.querySelectorAll("#stage .errbox")) b.remove();
  $("#live").classList.remove("stale");
  $("#live-text").textContent = "Live";
  $("#live").title = "Watching the project's code: the studio redraws when it changes";
  // which ops' code changed since the last extraction — the canvas
  // outlines them for a while, so an edit (the assistant's or anyone's)
  // shows where it landed
  if (state.ir && !first) {
    const codeOf = (ir) => {
      const m = new Map();
      for (const g of ir.graphs || []) (function walk(gr) {
        for (const n of (gr && gr.nodes) || []) { m.set(n.name, n.code || ""); if (n.graph) walk(n.graph); }
      })(g);
      return m;
    };
    const before = codeOf(state.ir), after = codeOf(data);
    const changed = [...after].filter(([k, c]) => before.has(k) ? before.get(k) !== c : true).map(([k]) => k);
    if (changed.length) document.dispatchEvent(new CustomEvent("oxflowchanged", {detail: {ops: changed}}));
    if (changed.length && changed.length < 40) {
      state.changedOps = new Set(changed);
      clearTimeout(state._changedTimer);
      state._changedTimer = setTimeout(() => { state.changedOps = null; render(); }, 60000);
      toast(`${changed.length} op${changed.length > 1 ? "s" : ""} changed: ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""}`);
    }
  }
  state.ir = data;
  state.stamp = data.stamp;

  const pick = $("#graph-pick");
  const current = state.graph && state.graph.name;
  pick.textContent = "";
  for (const g of data.graphs) {
    const opt = el("option", null, `${g.name} (${g.nodes.length})`);
    opt.value = g.name;
    pick.append(opt);
  }
  // The convention is ONE main served graph per project, so with one
  // graph there is nothing to pick — the chrome would only suggest a
  // choice that does not exist. The picker returns if a project ever
  // declares extra unserved [[graph]] entries.
  pick.hidden = data.graphs.length <= 1;
  // one graph: on a phone the header gives its room to the project's name
  document.body.classList.toggle("onegraph", data.graphs.length <= 1);
  state.graph = data.graphs.find(g => g.name === current) || data.graphs[0];
  if (state.graph) pick.value = state.graph.name;
  $("#btn-project").title = `${data.graphs.length} operons · ${(data.services || []).length} services · ${(data.jobs || []).length} jobs`;
  render();
  // opened on a hidden canvas (the assistant in focus): fit it when it shows
  if (first) { if (state.renderPending) state.viewPending = true; else initView(); }
  pushView();
  renderFlowInfo();
}

/* The pulse (app.py): one held request that answers the moment the
 * code changes, the assistant opens something, or — when following —
 * a newer run lands. It replaced two polls every 1.5 s. */
state.uiSeq = -1;
state.chatSeq = -1;
let pulseMiss = 0;
async function pulse() {
  for (;;) {
    try {
      const q = new URLSearchParams({stamp: String(state.stamp || 0), ui: String(state.uiSeq),
                                     chat: String(state.chatSeq)});
      if (state.follow) q.set("follow", (state.run && state.run.run) || "-");
      else if (state.tab === "flow" && flowLive.on) q.set("follow", flowLive.newest || "-");
      const got = await api(`/api/p/${PID}/pulse?${q}`);
      pulseMiss = 0;
      setLinkState(true);
      // a role changed while this page was open: it redraws for the new one (§2.5)
      if (got.role && window.Account && Account.me() && got.role !== Account.me().user.role) { location.reload(); return; }
      if (got.stamp !== state.stamp) await load(!state.ir);
      if (state.uiSeq < 0) state.uiSeq = got.ui_last;   // only what happens from now on
      if (state.chatSeq >= 0 && (got.chat_ended || []).length) {
        document.dispatchEvent(new CustomEvent("oxturnended", {detail: {ended: got.chat_ended}}));
      }
      state.chatSeq = got.chat_last ?? state.chatSeq;
      // the plan's limits, as last heard by any conversation
      if (got.assistant_rate) document.dispatchEvent(new CustomEvent("oxrate", {detail: got.assistant_rate}));
      for (const a of got.actions || []) {
        state.uiSeq = a.seq;
        try { await assistantUi(a.kind, a.args || {}); } catch { /* a stale action is not an error */ }
      }
      if (state.follow && got.newest && (!state.run || state.run.run !== got.newest)) {
        await showRunWorkflow(got.newest);
      } else if (!state.follow && state.tab === "flow" && got.newest) {
        flowLive.landed(got.newest, got.newest_info);
      }
    } catch {
      // the studio or the tunnel is briefly away: back off, then say so
      pulseMiss += 1;
      if (pulseMiss > 2) setLinkState(false);
      await new Promise(r => setTimeout(r, Math.min(8000, 800 * pulseMiss)));
    }
  }
}

/* The header's Live dot: it says "Reconnecting" when the pulse keeps
 * failing, instead of a page that silently stopped updating. */
function setLinkState(up) {
  const live = $("#live");
  if (!live || live.classList.contains("stale")) return;
  live.classList.toggle("down", !up);
  $("#live-text").textContent = up ? "Live" : "Reconnecting…";
  live.title = up ? "Watching the project's code: the studio redraws when it changes"
    : "Lost the studio: reconnecting…";
}

/* On Flow the canvas follows the assistant's edits: the op whose code it changes, ringed (choreo.js) */
document.addEventListener("oxtool", (ev) => {
  if (state.tab !== "flow" || typeof Hand === "undefined" || typeof Choreo === "undefined" || !state.rendered) return;
  const ops = [...state.rendered.values()].map((x) => {
    const at = ((x.node.source || {}).defined_at || {});
    const fn = /\bdef (\w+)\(/.exec(x.node.code || "");
    return {name: x.node.name, file: at.file || "", fn: fn ? fn[1] : ""};
  });
  Hand.play(Choreo.opSteps(ev.detail.item, ev.detail.phase, ops));
});

/* The assistant's own actions, through its hand when the screen follows it
 * (docs/ALIVE_ASSISTANT_PLAN.md D6): the menu's icon pressed, the action,
 * then the thing it is about, ringed. A click of the user's runs performUi
 * at once. */
function assistantUi(kind, args) {
  if (kind === "point" || typeof Hand === "undefined" || !Hand.active()) return performUi(kind, args);
  const TAB = {open_run: "traces", compare: "traces", open_monitor: "monitor", select_op: "flow", open_jobs: "jobs",
               open_eval: "evals", open_tab: args.tab};
  const steps = [];
  // the board's overview is Plans: reading the project's state is no reason to leave the conversation for it
  if (kind === "open_board" && !args.mid && state.tab === "project") return Promise.resolve();
  if (kind === "open_board") steps.push({go: {tab: "project", page: "plans"}});
  else if (TAB[kind]) steps.push({go: {tab: TAB[kind], opts: {quiet: true}}});
  steps.push({run: () => performUi(kind, args)});
  const what = kind === "select_op" ? `op:${args.op}` : kind === "open_jobs" ? `job:${args.job}`
    : kind === "open_eval" && args.name ? `eval:${args.name}` : kind === "open_board" && args.mid ? `ms:${args.mid}` : null;
  if (what) steps.push({point: what, words: args.words || ""});
  Hand.play(steps);
  return Promise.resolve();
}

async function performUi(kind, args) {
  if (kind === "open_run") {
    if (state.tab !== "traces") switchTab("traces", {quiet: true});
    // errors and values are no longer lenses: failures are always marked, values are in the step panel
    if (args.lens) { state.lens = ["time", "cost"].includes(args.lens) ? args.lens : "path"; store("lens", state.lens); }
    // the view: conversation, tree or timeline (the steps page), workflow or data (the canvas)
    const onCanvas = args.mode === "workflow" || args.mode === "data";
    if (onCanvas && canvasView !== args.mode) { canvasView = args.mode; store(`canvasView:${PID}`, args.mode); showViewSeg(); }
    if (["conversation", "tree", "timeline"].includes(args.mode)) store("runTreeMode", args.mode);
    await (onCanvas ? showRunWorkflow(args.run) : showRunTree(args.run));
    // an execution to select: an eval's blamed op, a deep link's `op`
    if (args.op) RunView.focusExec({op_id: args.op, op: args.op.split("#")[0].split(".").pop()},
                                   onCanvas ? "workflow" : "tree");
    if (!args.quiet) toast(`Assistant opened run ${args.run}`);
  } else if (kind === "open_monitor") {
    store(`monitor:${PID}`, {target: args.target || "", range: args.days >= 30 ? "30d" : args.days <= 1 ? "24h" : "7d"});
    switchTab("monitor");
  } else if (kind === "compare") {
    if (state.tab !== "traces") switchTab("traces", {quiet: true});
    await RunView.compare(args.a, args.b);
  } else if (kind === "select_op") {
    if (state.tab !== "flow") switchTab("flow");
    // an op is named by its node, or by the function behind it
    const def = new RegExp(`\\bdef ${String(args.op).replace(/[^\w]/g, "")}\\(`);
    const find = () => {
      const all = [...state.rendered.values()];
      return all.find(x => x.node.name === args.op) || all.find(x => def.test(x.node.code || ""));
    };
    let it = find();
    if (!it) { expandAll(true); it = find(); }
    if (it) { if (state.sel !== it.key) select(it.key); centerOn(it); }
    else toast(`No op named ${args.op} in this graph`);
  } else if (kind === "open_jobs") {
    state.jobSel = args.job; switchTab("jobs");
  } else if (kind === "open_board") {
    BoardView.open(args);
  } else if (kind === "open_tab") {
    switchTab(args.tab);
  } else if (kind === "open_eval") {
    switchTab("evals", {name: args.name, run: args.run, exp: args.exp});
  } else if (kind === "point") {
    // the assistant points on purpose (docs/ALIVE_ASSISTANT_PLAN.md D5): the hand goes there and rings it
    if (typeof Hand === "undefined" || typeof Choreo === "undefined") return;
    const to = Choreo.where(args.target);
    Hand.play([...(to ? [{go: to}] : []), {point: args.target, words: args.words || ""}], {force: !!args.byUser});
  }
}

/* `studio:` links in the assistant's replies (chat.js turns them into
 * buttons): studio:run/<id>, studio:op/<name>, studio:tab/<name>, studio:point/<target>,
 * studio:monitor/<origin>/<name>, studio:board/<milestone>[/<card>]. */
window.oxStudioLink = (href) => {
  const path = String(href).replace(/^studio:/, "");
  const [kind, ...rest] = path.split("/");
  const arg = decodeURIComponent(rest.join("/"));
  if (kind === "run") return performUi("open_run", {run: arg});
  if (kind === "op") return performUi("select_op", {op: arg});
  if (kind === "tab") return performUi("open_tab", {tab: arg === "runs" ? "traces" : arg});
  if (kind === "board") return performUi("open_board", {mid: rest[0], card: rest[1] || ""});
  if (kind === "eval") return performUi("open_eval", {name: rest[0], run: rest[1] || ""});
  // studio:point/q:Q-16 — the hand goes to it and rings it, as when the assistant points
  if (kind === "point") return performUi("point", {target: arg, byUser: true});
  if (kind === "monitor") return performUi("open_monitor", {target: rest.length > 1 ? `${rest[0]}:${decodeURIComponent(rest.slice(1).join("/"))}` : ""});
  return null;
};

state.follow = recall("follow", false);
// `/p/<pid>?run=<trace id>` opens that run: a served reply's
// `x-operonx-trace-id` header is all a client needs to link to its run;
// `&op=<execution id>` selects one execution in it (an eval's blamed op)
const linkedRun = new URLSearchParams(location.search).get("run");
const linkedOp = new URLSearchParams(location.search).get("op");
load(true).then(() => {
  if (linkedRun) return performUi("open_run", {run: linkedRun, op: linkedOp || undefined, quiet: true}).finally(Router.start);
  // `/p/<pid>/<screen>/…`: open what the address names (router.js)
  return Router.replay(location);
}).catch((err) => {
  // the first paint failed (a dropped tunnel, a dead studio): say so where
  // the canvas would be; the pulse retries and draws when it can
  const box = el("div", "errbox");
  box.append(el("div", "errhead", "Could not load this project"), el("div", "note", err.message));
  box.style.position = "absolute";
  $("#stage").append(box);
}).finally(pulse);

