/* operonx studio — light or dark: dark until the viewer picks (light, dark,
 * or the system's); and glass or solid (Glass, below).
 *
 * The choice is the viewer's (this browser: localStorage `ox:theme`), and
 * the page already wears it before its first paint: an inline script in
 * each page's <head> sets <html data-theme> from it. This file keeps it in
 * step afterwards — a new choice, or the system switching while the choice
 * is "system" — and offers the choice: a button for a page's header, and
 * a row for Settings. Screens that draw with colours of their own (the
 * Monitor's charts) listen for `oxtheme`.
 */

"use strict";

const Theme = (() => {
  const KEY = "ox:theme";
  const media = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  const read = () => { try { return localStorage.getItem(KEY) || "dark"; } catch { return "dark"; } };
  const resolve = (choice) => (choice === "system" ? (media && media.matches ? "dark" : "light") : choice);

  function apply(choice) {
    const theme = resolve(choice);
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
      document.dispatchEvent(new CustomEvent("oxtheme", {detail: {theme, choice}}));
    }
  }

  function set(choice) {
    try { localStorage.setItem(KEY, choice); } catch { /* private mode: this page only */ }
    apply(choice);
    for (const f of listeners) f(choice);
  }

  const listeners = new Set();
  if (media) media.addEventListener("change", () => { if (read() === "system") apply("system"); });
  apply(read());

  const CHOICES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

  // three buttons, one pressed: Settings' row and the header menu's body
  function radios(label, choices, get, choose, on) {
    const box = document.createElement("div");
    box.className = "themepick";
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", label);
    const paint = (choice) => {
      for (const b of box.children) {
        const pressed = b.dataset.choice === choice;
        b.classList.toggle("on", pressed);
        b.setAttribute("aria-checked", String(pressed));
      }
    };
    for (const [choice, text] of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.choice = choice;
      b.setAttribute("role", "radio");
      b.textContent = text;
      b.onclick = () => choose(choice);
      box.append(b);
    }
    paint(get());
    on.add(paint);
    return box;
  }
  const picker = () => radios("Theme", CHOICES, read, set, listeners);

  // the header's button: one click flips light and dark. Until the first
  // click the page follows the system; after it, the choice is kept.
  // (Settings still offers System, Light and Dark.)
  function button() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "iconbtn themebtn";
    if (window.Icons) b.append(Icons.svg("theme"));
    const label = () => {
      const next = resolve(read()) === "dark" ? "light" : "dark";
      b.title = `Switch to ${next}`;
      b.setAttribute("aria-label", b.title);
    };
    b.onclick = () => set(resolve(read()) === "dark" ? "light" : "dark");
    listeners.add(label);
    if (media) media.addEventListener("change", label);
    label();
    return b;
  }

  // a CSS colour token's value now (for drawings made in script)
  const token = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };

  // the page's header has a place for the button
  const slot = document.getElementById("themeslot");
  if (slot) slot.replaceWith(button());

  return {get: read, set, resolve, picker, button, token, radios};
})();

/* Glass or solid (docs/LIQUID_GLASS_PLAN.md): the chrome that floats over
 * the content — the Flow screen's bars and panel, menus, popovers — is
 * glass, unless the viewer reduces transparency. "system" follows the
 * device's Reduce Transparency and Increase Contrast; the inline script in
 * each page's <head> sets <html data-glass> before the first paint, as it
 * does the theme. */
const Glass = (() => {
  const KEY = "ox:glass";
  const media = window.matchMedia ? matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more)") : null;
  const read = () => { try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; } };
  const resolve = (choice) => (choice === "system" ? (media && media.matches ? "solid" : "glass") : choice);
  const apply = (choice) => { document.documentElement.dataset.glass = resolve(choice); };
  const listeners = new Set();
  function set(choice) {
    try { localStorage.setItem(KEY, choice); } catch { /* private mode: this page only */ }
    apply(choice);
    for (const f of listeners) f(choice);
  }
  if (media) media.addEventListener("change", () => { if (read() === "system") apply("system"); });
  apply(read());
  const CHOICES = [["system", "System"], ["glass", "Glass"], ["solid", "Solid"]];
  const picker = () => Theme.radios("Transparency", CHOICES, read, set, listeners);
  // the bending: an SVG displacement in backdrop-filter, which only Chromium
  // draws (elsewhere the pieces keep the blur). studio.css puts it on the
  // canvas bar alone, a small piece the nodes pan under.
  if (navigator.userAgentData && navigator.userAgentData.brands.some(b => b.brand === "Chromium")) {
    document.documentElement.classList.add("refract");
    const add = () => document.body.insertAdjacentHTML("beforeend",
      '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="ox-refract" x="0" y="0" width="100%" height="100%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.012 0.03" numOctaves="1" seed="7" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="14" xChannelSelector="R" yChannelSelector="G"/></filter></svg>');
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
  }
  // a menu grows out of the button that opened it: the last pressed control
  // is remembered, and a floating piece that appears scales up from that
  // point. Menus come and go by [hidden] or by being added (only [hidden]
  // is watched: the canvas toggles classes every frame it animates).
  const FLOATS = ".popover, .ax-pop, .ax-slash";
  let pressed = null;
  document.addEventListener("pointerdown", (e) => { pressed = e.target.closest("button, [role=button], a, input"); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") pressed = document.activeElement; }, true);
  const still = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  function grow(el) {
    if ((still && still.matches) || !el.getClientRects().length || el.dataset.grown) return;
    el.dataset.grown = "";
    const r = el.getBoundingClientRect();
    let ox = r.width / 2, oy = 0;
    if (pressed && pressed.isConnected && !el.contains(pressed)) {
      const b = pressed.getBoundingClientRect();
      ox = Math.min(r.width, Math.max(0, b.left + b.width / 2 - r.left));
      oy = Math.min(r.height, Math.max(0, b.top + b.height / 2 - r.top));
    }
    el.style.transformOrigin = `${ox}px ${oy}px`;
    el.animate([{transform: "scale(.86)", opacity: 0}, {transform: "scale(1.012)", opacity: 1, offset: .7}, {transform: "none", opacity: 1}],
      {duration: 260, easing: "cubic-bezier(.2,.9,.3,1)"});
  }
  function seen(node) {
    if (node.nodeType !== 1) return;
    if (node.matches(FLOATS) && !node.hidden) grow(node);
    for (const f of node.querySelectorAll(FLOATS)) if (!f.hidden) grow(f);
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(seen);
      else if (m.target.matches(FLOATS) && !m.target.hidden) grow(m.target);
      else delete m.target.dataset.grown;
    }
  }).observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"]});
  return {get: read, set, resolve, picker};
})();
