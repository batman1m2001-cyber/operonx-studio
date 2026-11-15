/* The canvas minimap (docs/UX_OVERHAUL_PLAN.md U2): the whole flow as small
 * blocks in a corner, with the part on screen framed. It shows only when the
 * flow does not fit the open canvas, so a small flow never carries it. A click
 * or a drag on it moves the view.
 *
 * The model (boxes → a scaled picture) has no DOM: tests/js/minimap.test.mjs
 * runs it in node. The drawing below it runs only in the page. */
const Minimap = (() => {
  const MAX_W = 208, MAX_H = 148, PAD = 8;

  /* boxes: [{x, y, w, h, kind?, zone?}] in canvas units; content: their bounding
   * box; view: the open part of the canvas in the same units. Returns the
   * picture's size, each box scaled into it, and the framed view clipped to it. */
  function model(boxes, content, view) {
    const cw = Math.max(1, content.maxX - content.minX), ch = Math.max(1, content.maxY - content.minY);
    const k = Math.min((MAX_W - PAD * 2) / cw, (MAX_H - PAD * 2) / ch);
    const w = Math.round(cw * k + PAD * 2), h = Math.round(ch * k + PAD * 2);
    const px = (x) => (x - content.minX) * k + PAD, py = (y) => (y - content.minY) * k + PAD;
    const rects = boxes.map(b => ({
      x: px(b.x), y: py(b.y), w: Math.max(2, b.w * k), h: Math.max(2, b.h * k), kind: b.kind || "", zone: !!b.zone,
    }));
    const x0 = Math.max(0, px(view.x)), y0 = Math.max(0, py(view.y));
    const x1 = Math.min(w, px(view.x + view.w)), y1 = Math.min(h, py(view.y + view.h));
    return {
      k, w, h, rects,
      view: {x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0)},
      // nothing to navigate when the whole content is inside the view
      fits: view.x <= content.minX && view.y <= content.minY
        && view.x + view.w >= content.maxX && view.y + view.h >= content.maxY,
      // a point of the picture, back in canvas units
      at: (mx, my) => ({x: (mx - PAD) / k + content.minX, y: (my - PAD) / k + content.minY}),
    };
  }

  if (typeof document === "undefined") return {model};

  const box = document.getElementById("minimap");
  const stage = document.getElementById("stage");
  if (!box || !stage) return {model};
  const cv = box.querySelector("canvas");
  let last = null, queued = false;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // a kind colour arrives as "var(--k-func)": the canvas wants the value
  function colour(c) {
    const m = /^var\((--[\w-]+)\)$/.exec(c || "");
    return (m ? css(m[1]) : c) || css("--k-default");
  }

  function geometry() {
    const ex = state.extent, cb = state.content;
    if (!ex || !cb || state.tab !== "flow") return null;
    const s = state.view.scale, i = stageInset(), r = stage.getBoundingClientRect();
    const ow = r.width - i.l - i.r, oh = r.height - i.t - i.b;
    return {ex, cb, s, i, ow, oh,
      view: {x: (stage.scrollLeft - VIEW_PAD) / s + ex.minX, y: (stage.scrollTop - VIEW_PAD) / s + ex.minY,
             w: ow / s, h: oh / s}};
  }

  function draw() {
    queued = false;
    const g = geometry();
    if (!g || innerWidth <= 760) { box.hidden = true; return; }
    const boxes = [];
    for (const it of state.rendered.values()) {
      if (!it || !it.node || it.w == null) continue;
      boxes.push({x: it.x, y: it.y, w: it.w, h: it.h, zone: !!it.inner,
                  kind: it.node.kind === "__boundary__" ? "var(--flow-accent)" : kindColor(it.node)});
    }
    const m = last = model(boxes, g.cb, g.view);
    last.g = g;
    box.hidden = m.fits || !boxes.length;
    if (box.hidden) return;
    box.style.right = `${g.i.r + 16}px`;
    const dpr = window.devicePixelRatio || 1;
    cv.width = m.w * dpr; cv.height = m.h * dpr;
    cv.style.width = `${m.w}px`; cv.style.height = `${m.h}px`;
    const c = cv.getContext("2d");
    c.scale(dpr, dpr);
    c.clearRect(0, 0, m.w, m.h);
    for (const r of m.rects.filter(r => r.zone)) {
      c.strokeStyle = colour(r.kind); c.globalAlpha = .55; c.lineWidth = 1;
      c.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    }
    for (const r of m.rects.filter(r => !r.zone)) {
      c.fillStyle = colour(r.kind); c.globalAlpha = .8;
      c.beginPath(); c.roundRect(r.x, r.y, r.w, r.h, 1.5); c.fill();
    }
    c.globalAlpha = 1;
    c.fillStyle = css("--flow-accent-ring"); c.strokeStyle = css("--flow-accent"); c.lineWidth = 1.5;
    c.beginPath(); c.roundRect(m.view.x + 1, m.view.y + 1, Math.max(4, m.view.w - 2), Math.max(4, m.view.h - 2), 3);
    c.fill(); c.stroke();
  }
  function update() { if (!queued) { queued = true; requestAnimationFrame(draw); } }

  // the view goes where the pointer is: its centre on that point
  function go(ev) {
    if (!last) return;
    const r = cv.getBoundingClientRect(), g = last.g;
    const p = last.at(ev.clientX - r.left, ev.clientY - r.top);
    stage.scrollLeft = (p.x - g.ex.minX) * g.s + VIEW_PAD - g.ow / 2;
    stage.scrollTop = (p.y - g.ex.minY) * g.s + VIEW_PAD - g.oh / 2;
  }
  cv.addEventListener("pointerdown", (ev) => { cv.setPointerCapture(ev.pointerId); go(ev); });
  cv.addEventListener("pointermove", (ev) => { if (ev.buttons & 1) go(ev); });

  stage.addEventListener("scroll", update, {passive: true});
  window.addEventListener("resize", update);
  document.addEventListener("oxtheme", update);
  // a redraw of the flow, a zoom, a panel opening: the plane or the nodes changed
  const mo = new MutationObserver(update);
  const plane = document.getElementById("plane"), nodes = document.getElementById("nodes"), side = document.getElementById("sidebar");
  if (plane) mo.observe(plane, {attributes: true, attributeFilter: ["style"]});
  if (nodes) mo.observe(nodes, {childList: true});
  if (side) mo.observe(side, {attributes: true, attributeFilter: ["class"]});
  mo.observe(document.body, {attributes: true, attributeFilter: ["data-tab", "class"]});
  update();
  return {model, update};
})();
if (typeof module !== "undefined") module.exports = Minimap;
