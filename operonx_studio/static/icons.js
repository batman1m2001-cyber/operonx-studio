/* operonx studio — the icon set.
 *
 * Line icons drawn on one 24px grid with one stroke, so every button in
 * the chrome reads as the same family. Inline SVG, no font and no CDN:
 * emoji glyphs rendered as empty boxes on machines without an emoji font,
 * and a toolbar of boxes explains nothing. Markup that is already in the
 * page uses `<i data-icon="name"></i>`, which `Icons.hydrate()` fills.
 */

"use strict";

const Icons = (() => {
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
    unfold: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
    fold: '<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9"/><path d="M12 17.2h.01"/>',
    panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    right: '<path d="m9 6 6 6-6 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
    play: '<path d="M7 4.8v14.4a.6.6 0 0 0 .9.5l11.3-7.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5Z" fill="currentColor" stroke="none"/>',
    resume: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 3.5v5h5"/>',
    trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    spark: '<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9Z"/>',
    send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    expand: '<path d="M15 4h5v5M9 20H4v-5M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
    new: '<path d="M12 20h8"/><path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1 1-4Z"/>',
    graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.3 7.2 15.7 11M8.3 16.8l7.4-3.8"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  };

  /** One icon as an SVG element; `cls` is added to the `icon` class. */
  function svg(name, cls) {
    const wrap = document.createElement("span");
    wrap.innerHTML = '<svg class="icon' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" '
      + 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true" focusable="false">' + (P[name] || "") + "</svg>";
    return /** @type {Element} */ (wrap.firstChild);
  }

  /** A button with an icon, and a visible label when `label` is given;
   * an icon-only button carries its name as aria-label and tooltip. */
  function button(name, label, cls, title) {
    const b = document.createElement("button");
    b.type = "button";
    if (cls) b.className = cls;
    b.append(svg(name));
    if (label) {
      const s = document.createElement("span");
      s.textContent = label;
      b.append(s);
    } else {
      b.classList.add("iconbtn");
      b.setAttribute("aria-label", title || name);
    }
    if (title) b.title = title;
    return b;
  }

  /** Fill every `<i data-icon>` placeholder in `root`. */
  function hydrate(root) {
    for (const i of (root || document).querySelectorAll("i[data-icon]")) {
      const s = svg(i.getAttribute("data-icon") || "", i.className || "");
      i.replaceWith(s);
    }
  }

  /** Swap the icon inside a button (a toggle that changes meaning). */
  function set(btn, name) {
    const old = btn.querySelector("svg.icon");
    const s = svg(name);
    if (old) old.replaceWith(s); else btn.prepend(s);
  }

  hydrate(document);
  return {svg, button, hydrate, set};
})();
// a top-level const is a global binding but not a window property —
// chat.js, which also runs on pages without this file, reads it there
/** @type {any} */ (window).Icons = Icons;
