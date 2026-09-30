/* operonx studio — light, dark, or as the system says.
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
  const read = () => { try { return localStorage.getItem(KEY) || "system"; } catch { return "system"; } };
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
  function picker() {
    const box = document.createElement("div");
    box.className = "themepick";
    box.setAttribute("role", "radiogroup");
    box.setAttribute("aria-label", "Theme");
    const paint = (choice) => {
      for (const b of box.children) {
        const on = b.dataset.choice === choice;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
    for (const [choice, label] of CHOICES) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.choice = choice;
      b.setAttribute("role", "radio");
      b.textContent = label;
      b.onclick = () => set(choice);
      box.append(b);
    }
    paint(read());
    listeners.add(paint);
    return box;
  }

  // the header's button: the choice in a small menu
  function button() {
    const wrap = document.createElement("span");
    wrap.className = "themebtn-wrap";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "iconbtn themebtn";
    b.title = "Theme";
    b.setAttribute("aria-label", "Theme");
    b.setAttribute("aria-haspopup", "true");
    if (window.Icons) b.append(Icons.svg("theme"));
    const menu = document.createElement("div");
    menu.className = "popover thememenu";
    menu.hidden = true;
    const title = document.createElement("div");
    title.className = "thememenu-title";
    title.textContent = "Theme";
    menu.append(title, picker());
    b.onclick = (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener("pointerdown", (ev) => { if (!wrap.contains(ev.target)) menu.hidden = true; });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") menu.hidden = true; });
    wrap.append(b, menu);
    return wrap;
  }

  // a CSS colour token's value now (for drawings made in script)
  const token = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };

  // the page's header has a place for the button
  const slot = document.getElementById("themeslot");
  if (slot) slot.replaceWith(button());

  return {get: read, set, resolve, picker, button, token};
})();
