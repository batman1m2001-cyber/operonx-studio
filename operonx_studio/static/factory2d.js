/* operonx studio — the Factory picture, drawn flat (NEURAL_FACTORY_PLAN, mock 14).
 *
 * Everything drawn is the factory model (factorymodel.js), nothing else:
 *   workflow   a glass platform, a recessed plate, a crystal core and a few prisms. The prisms say how
 *              large it is (log₂ of its ops), never how many ops it has — the card lists those
 *              (past 30 flows a platform is a domain, and its size is its flows)
 *   shared     between the two wings of workflows, on one diamond lattice: a store (a junction), a shared
 *              block, a resource
 *   door       a service (a flat rhombus) or a job (a dial; with hands when a schedule starts it), in ranks
 *              along its workflow's outer outline
 *   silk       ONE thin dim filament per relationship, and one small bright pulse that goes the way the
 *              data or the call goes. Never a bundle.
 * Where things stand is factorylayout.js. Drag pans, the wheel moves, ctrl+wheel zooms, F fits.
 * Hovering lights a thing's own relationships and dims the rest (nothing is hidden); a click keeps
 * that and opens its card; a double click on a workflow opens it in the editor. / finds by name.
 *
 * It has to run on a machine with no GPU: one 2D canvas, drawn only when something changed (while the
 * picture moves the last frame is slid in place), no blur, and the pulses are not part of the frame at
 * all — they are elements on a CSS offset-path.
 *
 * An ES module, loaded on demand by factory.js.
 * mount(host, ir, stats, {onOpen(flow, node), onRuns(door), onDoor(service), onSelect(id), cardHost}) → {pause, resume, fit, select, reveal, setStats, cost, dispose}. */

export function mount(host, ir, stats, opts = {}) {
const FactoryModel = window.FactoryModel, FL = window.FactoryLayout, NAME = ir.name || "";
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
host.textContent = "";
const canvas = mk("canvas", "fx-gl"), stage = mk("div", "fx-stage"), silk = mk("div", "fx-silk"), names = mk("div", "fx-names"), doorList = mk("div", "fx-doors"),
  hud = mk("div", "fx-hud"), legend = mk("div", "fx-legend"), resetBtn = mk("button", "fx-reset", "Reset view");
resetBtn.type = "button"; resetBtn.title = "Fit the whole project  (F)"; canvas.setAttribute("aria-label", "The project as one picture: drag to move, scroll to zoom");
const titleEl = mk("h2"), countsEl = mk("p"); hud.append(titleEl, countsEl); stage.append(silk, names, doorList); host.append(canvas, stage, hud, legend, resetBtn);
doorList.hidden = true;
const g = canvas.getContext("2d"); canvas.style.transformOrigin = "0 0";
const vw = () => host.clientWidth || 1, vh = () => host.clientHeight || 1;
const css = getComputedStyle(host);
document.body.classList.add("fx-soft");                              // nothing behind the studio's glass is blurred (factory.css)
const BIG = 30, MANY = 12;
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const hash = FL.hash;
/* the picture's inks, in one place. Lavender is the studio's; cool blue is a service and a resource. */
const INK = {bg: "#05050c", data: "158,154,240", call: "134,160,244", uses: "186,182,226", needs: "134,170,244", error: "255,90,79",
  edge: "200,194,244", name: "242,238,255", sub: "168,158,214", store: "206,194,250"};
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace";

const model = FactoryModel.build(ir, stats);
const grouped = model.flows.length > BIG;

// ── what stands where ─────────────────────────────────────────────
/* the shared: shared blocks, the resources in use (by kind when there are many), the stores */
const core = [], boxOfRes = new Map();
for (const b of model.blocks.filter(b => b.shared)) core.push({id: b.id, name: b.name, kind: "block"});
const used = model.resources.filter(r => r.flows.length);
if (used.length <= MANY) for (const r of used) { core.push({id: r.id, name: r.name, kind: "resource"}); boxOfRes.set(r.id, r.id); }
else { const kinds = new Map(); for (const r of used) { if (!kinds.has(r.kind)) kinds.set(r.kind, []); kinds.get(r.kind).push(r); }
  for (const [k, rs] of kinds) { const id = rs.length > 1 ? `k:${k}` : rs[0].id; core.push({id, name: rs.length > 1 ? `${k} ×${rs.length}` : rs[0].name, kind: "resource"}); for (const r of rs) boxOfRes.set(r.id, id); } }
for (const s of model.stores.filter(s => s.writers.length || s.readers.length)) core.push({id: s.id, name: s.name, kind: "store"});

const doorsOf = (ids) => { const seen = new Set(ids.flatMap(i => model.upstream(i).filter(x => /^[sj]:/.test(x)))); return [...seen].map(i => model.by.get(i)); };
const clusters = grouped
  ? model.domains.map(d => ({id: d.id, name: d.name || "(no module)", members: d.flows, size: d.flows.length, sub: `${d.flows.length} flows`, doors: doorsOf(d.flows)}))
  : model.flows.map(f => ({id: f.id, name: f.name, members: [f.id], size: f.ops || 1, sub: `${f.ops} ops`, doors: doorsOf([f.id])}));
const asked = new Map(); for (const d of model.unresolved) { if (!asked.has(d.asks)) asked.set(d.asks, new Set()); asked.get(d.asks).add(d); for (const l of model.into(d.id)) asked.get(d.asks).add(model.by.get(l.src)); }
for (const [name, ds] of asked) clusters.push({id: `?:${name}`, name, members: [], size: 1, sub: "not among this project's graphs", doors: [...ds], ghost: true});

const clusterOf = new Map(); for (const c of clusters) for (const m of c.members) clusterOf.set(m, c.id);
const boxOf = (id) => { const e = model.by.get(id); if (!e) return null; if (e.type === "flow") return clusterOf.get(id); if (e.type === "block") return e.shared ? id : null; if (e.type === "resource") return boxOfRes.get(id) || null; if (e.type === "store") return e.flows.length ? id : null; return null; };
const strandKind = (k) => (k === "reads" || k === "writes" ? "data" : k);
const pairs = FactoryModel.pairs(model, boxOf);
const scheduled = new Set(model.links.filter(l => l.kind === "schedules").map(l => l.dst));

const L = FL.layout(clusters.map(c => ({id: c.id, size: c.size, doors: c.doors.map(d => ({id: d.id, type: d.type}))})), core.map(it => ({id: it.id})), pairs);
const spot = new Map(); for (const it of core) { Object.assign(it, L.at.get(it.id)); spot.set(it.id, it); it.deg = pairs.filter(p => p.dst === it.id).length; }
for (const c of clusters) { Object.assign(c, L.at.get(c.id)); spot.set(c.id, c); c.prisms = FL.prismsOf(c.size); c.more = L.more.get(c.id) || 0; }
const doors = []; for (const c of clusters) for (const d of c.doors) { const at = L.doors.get(d.id); if (at) doors.push({id: d.id, e: d, name: d.name, type: d.type, kind: d.kind, sched: scheduled.has(d.id), owner: c, x: at.x, y: at.y}); }
const doorAt = new Map(doors.map(d => [d.id, d]));
const edgeOf = (f, tx, ty) => { const dx = tx - f.x, dy = ty - (f.y + 6), s = 1 / (Math.abs(dx) / f.a + Math.abs(dy) / (f.a / 2) || 1); return {x: f.x + dx * s, y: f.y + 6 + dy * s}; };
/* the silk: one filament per relationship */
const fils = pairs.map(p => { const f = spot.get(p.src), s = spot.get(p.dst), st = L.starts.get(p), twin = pairs.some(o => o !== p && o.src === p.src && o.dst === p.dst);
  const d = Math.hypot(s.x - st.x, s.y - st.y), side = (s.x * f.y - s.y * f.x) > 0 ? 1 : -1;
  const bow = twin ? (p.kind === "writes" ? 1 : p.kind === "reads" ? -1 : 0.4) * Math.min(22, d * 0.1) : side * Math.min(20, d * 0.06);
  return {p, f, s, kind: strandKind(p.kind), pts: FL.curve(st, s, bow), back: p.kind === "reads"}; });
for (const d of doors) { const e = edgeOf(d.owner, d.x, d.y), b = (hash(d.id + "b") - 0.5) * 0.16 * Math.hypot(e.x - d.x, e.y - d.y); d.pts = FL.curve({x: d.x, y: d.y}, e, b, 12); }

// ── the view ──────────────────────────────────────────────────────
const view = {cx: 0, cy: 0, zoom: 1};
const sidePanel = document.getElementById("sidebar");
function covered() { const h = host.getBoundingClientRect(), r = sidePanel && sidePanel.getBoundingClientRect();
  const w = r && r.width && r.height && r.left > h.left + 200 && r.left < h.right ? Math.round(h.right - r.left) : 0; host.style.setProperty("--fx-right", `${w}px`); return w; }
const ZMIN = 0.12, ZMAX = 6;
function fit() { const [x0, y0, x1, y1] = [L.bounds[0] - 46, L.bounds[1], L.bounds[2] + 46, L.bounds[3] + 34], iL = Math.max(0, hud.offsetLeft - 14), iT = Math.max(0, hud.offsetTop - 10) + 70, iR = covered(), iB = 24;
  const fw = Math.max(200, vw() - iL - iR - 40), fh = Math.max(200, vh() - iT - iB);
  view.zoom = Math.max(ZMIN, Math.min(1.25, fw / (x1 - x0), fh / (y1 - y0)));          // a small project is not blown up to fill the screen
  view.cx = (x0 + x1) / 2 - (iL - iR) / 2 / view.zoom; view.cy = (y0 + y1) / 2 - (iT - iB) / 2 / view.zoom; apply(); }
const toWorld = (e) => { const r = host.getBoundingClientRect(); return {x: (e.clientX - r.left - r.width / 2) / view.zoom + view.cx, y: (e.clientY - r.top - r.height / 2) / view.zoom + view.cy}; };

// ── drawing ───────────────────────────────────────────────────────
let focus = null, sel = null, selLine = null, hover = null, lit = null;
const on = (id) => !lit || lit.has(id);
const dim = (id) => (on(id) ? 1 : 0.16);
const wiredFil = (f) => !focus || (focus.line ? f.p.src === focus.line.owner && f.kind === focus.line.kind : f.p.src === focus.id || f.p.dst === focus.id);
const wiredDoor = (d) => !focus || focus.id === d.id || (!focus.line && focus.id === d.owner.id);
const poly = (pts, fill, stroke, lw = 0.5) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); } };
const stars = Array.from({length: 240}, (_, i) => [hash("sx" + i), hash("sy" + i), hash("sa" + i)]);
function backdrop(w, h) {
  g.fillStyle = INK.bg; g.fillRect(0, 0, w, h);
  const neb = (x, y, r, c) => { const q = g.createRadialGradient(x, y, 0, x, y, r); q.addColorStop(0, c); q.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = q; g.fillRect(x - r, y - r, r * 2, r * 2); };
  neb(w / 2, h / 2, Math.max(w, h) * 0.34, "rgba(54,42,132,.17)"); neb(w * 0.1, h * 0.9, h * 0.4, "rgba(40,34,120,.10)"); neb(w * 0.92, h * 0.1, h * 0.42, "rgba(48,38,130,.10)");
  for (const [x, y, s] of stars) { g.fillStyle = `rgba(200,196,255,${0.05 + s * s * 0.3})`; g.fillRect(x * w, y * h, 0.7, 0.7); }
}
const px = (w) => w / Math.min(1, view.zoom);                     // a width in screen pixels, when the picture is drawn small
function strand(pts, i0, rgb, a, lw) { lw = px(lw); g.beginPath(); g.moveTo(pts[i0].x, pts[i0].y); for (let i = i0 + 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.strokeStyle = `rgba(${rgb},${a})`; g.lineWidth = lw; g.stroke(); }
/* where a filament meets its platform it parts into three short roots */
function foot(pts, rgb, a) { let i = 0, run = 0; while (run < 10 && i < pts.length - 1) { run += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); i++; }
  const from = pts[i], tip = pts[0], dx = tip.x - from.x, dy = tip.y - from.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
  for (let n = 0; n < 3; n++) { const o = (n - 1) * 4; g.strokeStyle = `rgba(${rgb},${a * 0.8})`; g.lineWidth = px(0.45); g.beginPath(); g.moveTo(from.x, from.y);
    g.quadraticCurveTo(from.x + dx * 0.5 + nx * o * 0.2, from.y + dy * 0.5 + ny * o * 0.2, tip.x + nx * o, tip.y + ny * o); g.stroke(); }
  return i; }
function drawSilk() { g.lineCap = "round";
  for (const f of fils) { const hot = focus && wiredFil(f), a = (hot ? 0.5 : 0.17) * (focus && !hot ? 0.45 : 1), rgb = INK[f.kind];
    const i = foot(f.pts, rgb, a); strand(f.pts, i, rgb, a, hot ? 0.7 : 0.6); }
}
function drawShared() {
  if (core.length > 1) { g.strokeStyle = `rgba(170,166,236,${focus ? 0.1 : 0.2})`; g.lineWidth = 0.5; const k = L.lattice.k;      // registration marks where the lattice's cells meet
    for (let i = 0; i <= k; i++) for (let j = 0; j <= k; j++) { const x = (i - j) * 94, y = (i + j - k) * 76; g.beginPath(); g.moveTo(x - 3.5, y); g.lineTo(x + 3.5, y); g.moveTo(x, y - 1.75); g.lineTo(x, y + 1.75); g.stroke(); } }
  for (const s of core) { const hot = focus && on(s.id), r = 2.4 + Math.min(2.2, Math.sqrt(s.deg) * 0.45), t0 = hash(s.id) * 1.5;
    g.save(); g.globalAlpha = dim(s.id);
    poly([s.x - 15, s.y, s.x, s.y - 7.5, s.x + 15, s.y, s.x, s.y + 7.5], "rgba(30,26,78,.5)", `rgba(176,170,240,${hot ? 0.7 : 0.26})`);
    if (s.kind === "store") {                                   // a junction: a nucleus, three or four short terminals
      g.strokeStyle = `rgba(196,182,250,${hot ? 0.85 : 0.5})`; g.lineWidth = 0.6; g.lineCap = "round"; const nt = hash(s.id + "t") < 0.4 ? 3 : 4;
      for (let k = 0; k < nt; k++) { const an = t0 + k * Math.PI * 2 / nt + (k % 2 ? 0.18 : -0.12), R = r + 6.5 + (k % 2) * 1.5;
        g.beginPath(); g.moveTo(s.x + Math.cos(an) * (r + 1), s.y + Math.sin(an) * (r + 1)); g.lineTo(s.x + Math.cos(an) * R, s.y + Math.sin(an) * R); g.stroke();
        g.fillStyle = `rgba(214,204,255,${hot ? 0.95 : 0.7})`; g.beginPath(); g.arc(s.x + Math.cos(an) * R, s.y + Math.sin(an) * R, 0.95, 0, 7); g.fill(); }
      g.globalCompositeOperation = "lighter";
      const halo = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3.2); halo.addColorStop(0, `rgba(190,172,255,${hot ? 0.55 : 0.2})`); halo.addColorStop(1, "rgba(110,90,240,0)"); g.fillStyle = halo; g.beginPath(); g.arc(s.x, s.y, r * 3.2, 0, 7); g.fill();
      const c = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r); c.addColorStop(0, "rgba(255,255,255,1)"); c.addColorStop(0.65, "rgba(214,202,255,.9)"); c.addColorStop(1, "rgba(150,124,255,0)"); g.fillStyle = c; g.beginPath(); g.arc(s.x, s.y, r, 0, 7); g.fill();
    } else if (s.kind === "block") {                            // a shared block: a small solid rhombus, silver
      poly([s.x - 5.5, s.y, s.x, s.y - 2.75, s.x + 5.5, s.y, s.x, s.y + 2.75], "rgba(206,202,236,.9)", "rgba(255,255,255,.8)");
    } else {                                                    // a resource: a small hexagon, cool blue
      g.beginPath(); for (let k = 0; k < 6; k++) { const an = k * Math.PI / 3; g.lineTo(s.x + Math.cos(an) * 4.6, s.y + Math.sin(an) * 4.6); } g.closePath();
      g.fillStyle = "rgba(24,28,70,.97)"; g.fill(); g.strokeStyle = `rgba(160,196,255,${hot ? 1 : 0.9})`; g.lineWidth = 0.7; g.stroke(); g.fillStyle = "rgba(196,220,255,.95)"; g.beginPath(); g.arc(s.x, s.y, 1.2, 0, 7); g.fill();
    }
    g.restore(); }
}
function drawService(ws, hot) { const face = (w, fill, stroke) => poly([-w, 0, 0, -w / 2, w, 0, 0, w / 2], fill, stroke, 0.6);
  face(5.2, "rgba(24,26,66,.98)", `rgba(176,204,255,${hot ? 1 : 0.95})`);
  if (ws) { g.save(); g.translate(-1.7, -0.85); face(1.5, "rgba(196,220,255,.95)"); g.translate(3.4, 1.7); face(1.5, "rgba(196,220,255,.95)"); g.restore(); } else face(2.1, "rgba(196,220,255,.95)"); }
function drawJob(sched, hot) { g.beginPath(); g.arc(0, 0, 3, 0, 7); g.fillStyle = "rgba(24,20,60,.97)"; g.fill(); g.strokeStyle = `rgba(214,204,255,${hot ? 1 : 0.92})`; g.lineWidth = 0.65; g.stroke();
  if (sched) { g.strokeStyle = "rgba(232,224,255,.95)"; g.lineWidth = 0.6; g.lineCap = "round"; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -2); g.moveTo(0, 0); g.lineTo(1.5, 0.7); g.stroke(); }
  else { g.fillStyle = "rgba(232,224,255,.95)"; g.beginPath(); g.arc(0, 0, 0.9, 0, 7); g.fill(); } }
function drawDoors() { if (view.zoom < 0.3) return;
  g.lineCap = "round";
  for (const d of doors) { const hot = focus && wiredDoor(d); strand(d.pts, 0, INK.call, (hot ? 0.5 : 0.16) * (focus && !hot ? 0.45 : 1), 0.55); }
  for (const d of doors) { const hot = focus && wiredDoor(d);
    g.save(); g.globalAlpha = focus && !hot ? 0.16 : 1; g.translate(d.x, d.y); { const k = 1.4 * Math.max(1, Math.min(1.3, 0.92 / view.zoom)); g.scale(k, k); }
    if (d.type === "service") drawService(d.kind === "websocket", hot); else drawJob(d.sched, hot); g.restore(); }
  for (const c of clusters) if (c.more) { g.save(); g.globalAlpha = dim(c.id); g.font = `600 8.5px ${MONO}`; g.textAlign = "center"; g.fillStyle = `rgba(${INK.sub},.9)`; g.fillText(`+${c.more} more`, c.x + c.sg * (c.a + 30), c.y - c.rise - 6); g.restore(); }
}
/* a workflow: a clean slab, an inset glass plate, a faceted core, a few prisms round it */
function drawCluster(f) { const hot = focus && focus.id === f.id, a = f.a, cx = f.x, cy = f.y + 6, bad = f.bad;
  const slab = (k, z, t, top, edge) => { const w = a * k, y = cy - z;
    poly([cx - w, y, cx, y + w / 2, cx, y + w / 2 + t, cx - w, y + t], "rgba(50,48,100,.96)"); poly([cx + w, y, cx, y + w / 2, cx, y + w / 2 + t, cx + w, y + t], "rgba(28,26,66,.96)");
    poly([cx - w, y, cx, y - w / 2, cx + w, y, cx, y + w / 2], top, edge, 0.7); };
  g.save(); g.globalAlpha = dim(f.id) * (f.ghost ? 0.5 : 1);
  const tg = g.createLinearGradient(cx - a, cy - a / 2, cx + a, cy + a / 2); tg.addColorStop(0, "rgba(44,38,108,.96)"); tg.addColorStop(1, "rgba(20,17,54,.96)");
  slab(1, 0, 3.5, tg, bad ? `rgba(${INK.error},.85)` : `rgba(${INK.edge},${hot ? 0.95 : 0.55})`);
  if (f.ghost) { g.restore(); return; }
  const pg = g.createLinearGradient(cx - a, cy - a / 2, cx + a, cy + a / 2); pg.addColorStop(0, "rgba(84,72,176,.5)"); pg.addColorStop(1, "rgba(44,38,112,.5)");
  slab(0.6, 2, 2, pg, "rgba(210,204,250,.4)");
  g.save(); g.globalCompositeOperation = "lighter"; const glow = g.createRadialGradient(cx, cy - 2, 0, cx, cy - 2, a * 0.42);
  glow.addColorStop(0, "rgba(170,154,255,.3)"); glow.addColorStop(1, "rgba(110,90,240,0)"); g.fillStyle = glow; g.beginPath(); g.ellipse(cx, cy - 2, a * 0.42, a * 0.21, 0, 0, 7); g.fill(); g.restore();
  const K = f.prisms, w = Math.max(3, a * 0.085), t0 = hash(f.name) * 6.28, items = [{nuc: true, pz: 0}];
  if (view.zoom >= 0.3) for (let i = 0; i < K; i++) { const th = t0 + i * 6.283 / K, rr = a * 0.29; items.push({px: Math.cos(th) * rr, pz: Math.sin(th) * rr, h: f.rise * (0.42 + 0.18 * (i % 3)) + 2}); }
  items.sort((p, q) => p.pz - q.pz);
  for (const it of items) {
    if (it.nuc) { const wn = Math.max(4, a * 0.1), hn = f.rise * 0.95 + 9, by = cy - 2, ym = by - hn * 0.4, tp = by - hn;
      poly([cx - wn, ym, cx, ym + wn / 2, cx, tp], "rgba(226,218,255,.9)", "rgba(255,255,255,.7)", 0.45); poly([cx + wn, ym, cx, ym + wn / 2, cx, tp], "rgba(176,160,252,.76)", "rgba(255,255,255,.7)", 0.45);
      poly([cx - wn, ym, cx, ym + wn / 2, cx, by + 1], "rgba(160,144,246,.66)", "rgba(255,255,255,.55)", 0.45); poly([cx + wn, ym, cx, ym + wn / 2, cx, by + 1], "rgba(120,104,230,.56)", "rgba(255,255,255,.55)", 0.45); continue; }
    const x = cx + it.px, y = cy - 2 + it.pz / 2, h = it.h;
    let q = g.createLinearGradient(0, y - h, 0, y + w / 2); q.addColorStop(0, "rgba(170,156,252,.2)"); q.addColorStop(1, "rgba(170,156,252,.42)"); poly([x - w, y, x, y + w / 2, x, y + w / 2 - h, x - w, y - h], q);
    q = g.createLinearGradient(0, y - h, 0, y + w / 2); q.addColorStop(0, "rgba(150,136,246,.1)"); q.addColorStop(1, "rgba(150,136,246,.24)"); poly([x + w, y, x, y + w / 2, x, y + w / 2 - h, x + w, y - h], q);
    poly([x - w, y - h, x, y - w / 2 - h, x + w, y - h, x, y + w / 2 - h], "rgba(208,198,255,.42)", "rgba(236,230,255,.42)", 0.45);
  }
  g.restore(); }
/* on a lit relationship: which way it goes, in a word */
function drawTags() { if (!focus || view.zoom < 0.55) return; g.textAlign = "center"; g.textBaseline = "top"; g.font = `600 7.5px ${MONO}`;
  for (const f of fils) { if (!wiredFil(f) || f.kind !== "data") continue; const p = f.pts[focus.id === f.p.dst ? 9 : 38], text = f.p.kind, tw = g.measureText(text).width;
    g.fillStyle = "rgba(5,5,12,.82)"; g.fillRect(p.x - tw / 2 - 3, p.y - 7, tw + 6, 12); g.fillStyle = f.p.kind === "writes" ? "rgba(236,226,255,.95)" : "rgba(160,190,255,.95)"; g.fillText(text, p.x, p.y - 5); }
  for (const r of listRows) { g.strokeStyle = "rgba(150,172,246,.34)"; g.lineWidth = 0.5; g.beginPath(); g.moveTo(r.d.x + (r.left ? -7 : 7), r.d.y); g.lineTo(r.x, r.y); g.stroke(); }
}
let listRows = [];
let drawn = null, dirty = true, lastMove = 0, spent = 0, frames = 0, raf = 0, live = true, dpr = 1;
function draw() { const t0 = performance.now(), w = vw(), h = vh(), z = view.zoom;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); backdrop(w, h);
  g.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 - view.cx * z), dpr * (h / 2 - view.cy * z));
  drawSilk(); drawShared(); drawDoors(); for (const c of byDepth) drawCluster(c); drawTags();
  spent = performance.now() - t0; frames++; drawn = {cx: view.cx, cy: view.cy, zoom: z}; canvas.style.transform = ""; dirty = false;
  if (spent > 120 && dpr > 1) { dpr = 1; canvas.width = w; canvas.height = h; drawn = null; dirty = true; }       // a dense screen, a slow machine: one pixel per pixel
  host.dataset.ready = "1"; }
const byDepth = clusters.slice().sort((a, b) => a.y - b.y);
function frame() { raf = 0; if (!live || !host.clientWidth) return;
  if (dirty && (!drawn || spent < 14 || performance.now() - lastMove > 110)) draw();
  if (dirty) raf = requestAnimationFrame(frame); }
const kick = () => { if (live && !raf) raf = requestAnimationFrame(frame); };
let restT = 0;
const stir = () => { document.body.classList.remove("fx-rest"); clearTimeout(restT); restT = setTimeout(() => document.body.classList.add("fx-rest"), 320); };
const redraw = () => { dirty = true; stir(); kick(); };
function apply() { const z = view.zoom, w = vw(), h = vh();
  stage.style.transform = `translate(${(w / 2 - view.cx * z).toFixed(2)}px, ${(h / 2 - view.cy * z).toFixed(2)}px) scale(${z.toFixed(4)})`;
  stage.style.setProperty("--s", Math.max(0.8, Math.min(1.6, 1 / z)).toFixed(2)); stage.style.setProperty("--ls", Math.max(1, Math.min(1.35, 0.95 / z)).toFixed(3));   // and a name stays readable       // a pulse stays a point at any zoom
  host.dataset.far = z < 0.55 ? "1" : "0";
  if (drawn) { const k = z / drawn.zoom; canvas.style.transform = `translate(${(w / 2 * (1 - k) + (drawn.cx - view.cx) * z).toFixed(2)}px, ${(h / 2 * (1 - k) + (drawn.cy - view.cy) * z).toFixed(2)}px) scale(${k.toFixed(4)})`; }
  lastMove = performance.now(); redraw(); under(); }
function resize() { covered(); dpr = Math.min(2, window.devicePixelRatio || 1); canvas.width = Math.round(vw() * dpr); canvas.height = Math.round(vh() * dpr); drawn = null; canvas.style.transform = ""; apply(); }
const sized = new ResizeObserver(() => { if (host.clientWidth) resize(); }); sized.observe(host); if (sidePanel) sized.observe(sidePanel);

// ── the pulses: one per relationship, on its own path ─────────────
const BUDGET = 320;                                                 // past this many, a pulse runs only on what is lit
const calm = fils.length + doors.length <= BUDGET;
function spark(d, len, key, cls) { const i = mk("i", cls); i.style.offsetPath = `path("${d}")`; const t = Math.max(2.4, len / 46) * (0.85 + hash(key) * 0.5);
  i.style.animationDuration = `${t.toFixed(2)}s`; i.style.animationDelay = `${(-hash(key + "d") * t).toFixed(2)}s`; silk.append(i); return i; }
const pathLen = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return s; };
for (const f of fils) if (f.kind !== "uses") f.el = spark(f.back ? f.pts.rd : f.pts.d, pathLen(f.pts), f.p.src + f.p.dst + f.p.kind, f.kind);   // nothing moves along "uses" at run time
for (const d of doors) d.el = spark(d.pts.d, pathLen(d.pts) * 2.2, d.id, "call");
function paintSparks() { for (const f of fils) if (f.el) { const w = wiredFil(f); f.el.classList.toggle("quiet", focus ? !w : !calm); f.el.classList.toggle("hot", !!focus && w); }
  for (const d of doors) { const w = wiredDoor(d); d.el.classList.toggle("quiet", focus ? !w : !calm); d.el.classList.toggle("hot", !!focus && w); } }

// ── words: names stand under what they name ───────────────────────
const labels = [];
for (const c of clusters) labels.push({owner: c.id, title: c.name.replace(/_flow$/, ""), full: c.name, sub: c.ghost ? "NOT IN THIS PROJECT" : `${grouped ? "DOMAIN" : "WORKFLOW"} · ${c.sub}`, cls: c.ghost ? "ghost" : "", x: c.x, y: c.y + 6 + c.a / 2 + 8, flows: c.members});
for (const s of core) labels.push({owner: s.id, title: s.name, cls: `item ${s.kind}`, x: s.x, y: s.y + 11});
for (const l of labels) { const d = mk("div", `nf ${l.cls}`); d.append(mk("b", null, l.title)); if (l.sub) { l.subEl = mk("span", null, l.sub); d.append(l.subEl); }
  d.style.left = `${l.x.toFixed(1)}px`; d.style.top = `${l.y.toFixed(1)}px`; d.tabIndex = 0; d.setAttribute("role", "button");       // Tab reaches every name; Enter selects it and moves on into its card
  d.onkeydown = (e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); e.stopPropagation(); select(l.owner); const b = card.querySelector(".fx-go, button.fx-row"); if (b) b.focus(); };
  d.onclick = () => select(l.owner); d.ondblclick = () => { if (/^f:/.test(l.owner) && opts.onOpen) opts.onOpen(l.full); };
  d.onpointerenter = () => setHover(l.owner); d.onpointerleave = () => setHover(null);
  names.append(d); l.el = d; }
/* a name under the studio's side panel steps back */
function under() { const edge = vw() - covered(), left = Math.max(0, hud.offsetLeft - 14), z = view.zoom;
  for (const l of labels) { const sx = (l.x - view.cx) * z + vw() / 2; l.el.classList.toggle("under", sx > edge + 8 || sx < left - 8); } }
titleEl.textContent = model.name || NAME;
countsEl.textContent = `${model.counts.flows.toLocaleString()} flows${grouped ? ` in ${model.counts.domains} domains` : ""} · ${model.counts.services} services · ${model.counts.jobs} jobs · ${model.counts.sharedBlocks} shared blocks · ${model.counts.resources} resources${model.counts.stores ? ` · ${model.counts.stores} store${model.counts.stores > 1 ? "s" : ""}` : ""}`;
function setStats(st) { const fl = (st && st.flows) || {}, days = (st && st.days) || 7;
  for (const f of model.flows) { const x = fl[f.name] || {}; f.runs = x.runs || 0; f.errors = x.errors || 0; f.avgMs = x.avg_ms == null ? null : x.avg_ms; }
  let failing = 0;
  for (const l of labels) { if (!l.flows || !l.subEl) continue; const fs = l.flows.map(i => model.by.get(i)), runs = sum(fs, f => f.runs), bad = fs.filter(f => f.errors).length, errs = sum(fs, f => f.errors);
    failing += bad; spot.get(l.owner).bad = bad > 0;
    l.subEl.textContent = [l.sub, runs ? `${runs.toLocaleString()} runs` : "", bad ? (grouped ? `${bad} failing` : `${errs.toLocaleString()} failed`) : ""].filter(Boolean).join(" · "); l.el.classList.toggle("bad", bad > 0); }
  const has = (k) => core.some(c => c.kind === k);
  legend.innerHTML = [[grouped ? "domain" : "workflow", "wf"], ...(has("store") ? [["store", "st"]] : []), ...(has("block") ? [["shared block", "bk"]] : []), ...(has("resource") ? [["resource", "rs"]] : []),
    ...(doors.some(d => d.type === "service") ? [["service", "sv"]] : []), ...(doors.some(d => d.type === "job") ? [["job", "jb"]] : []), ...(failing ? [[`failed in ${days} days`, "er"]] : [])]
    .map(([t, c]) => `<span><i class="k-${c}"></i>${t}</span>`).join("") + `<span class="note">a platform's prisms show its size, not its ops · click one to see them</span>`;
  redraw(); if (sel) describe(); }

// ── hover and selection: a thing's own relationships stay lit, the rest goes quiet ──
const QUIET = 0.2;
const docked = opts.cardHost || null;
const card = mk("aside", "fx-card"); card.hidden = true; (docked || host).append(card);
if (docked) for (const n of ["text", "text-2", "sig-agent", "sig-store", "sig-error", "obsidian", "titanium", "graphite"]) docked.style.setProperty(`--fx-${n}`, css.getPropertyValue(`--fx-${n}`));
function refocus() { const id = hover || sel; focus = null; lit = null;
  if (id) { const line = id.startsWith("l:") ? {owner: id.slice(2, id.lastIndexOf("|")), kind: id.slice(id.lastIndexOf("|") + 1)} : null, door = doorAt.get(id);
    focus = {id, line, door}; lit = new Set([line ? line.owner : id]);
    if (door) lit.add(door.owner.id);
    else for (const p of pairs) { if (line) { if (p.src === line.owner && strandKind(p.kind) === line.kind) lit.add(p.dst); } else { if (p.src === id) lit.add(p.dst); if (p.dst === id) lit.add(p.src); } } }
  for (const l of labels) { l.el.classList.toggle("quiet", !!lit && !lit.has(l.owner)); l.el.classList.toggle("picked", !!sel && l.owner === sel); }
  paintSparks(); listDoors(); redraw(); }
function setHover(id) { if (id && !id.startsWith("l:") && !spot.has(id) && !doorAt.has(id)) id = null;   // a name this picture does not hold lights nothing, and dims nothing
  if (id === hover) return; hover = id; refocus(); }
/* a lit workflow's services and jobs by name, where the list covers least: other workflows, their doors and
 * names, the lit shared items and the lit filaments are all in its way */
function listDoors() { doorList.textContent = ""; listRows = []; doorList.hidden = true; doorList.style.transform = ""; doorList.style.width = ""; doorList.style.columnCount = "";
  const one = focus && doorAt.get(focus.id), c = focus && !focus.line && (one ? null : spot.get(focus.id));
  if (one) { const t = mk("div", "fx-doortag"); t.append(mk("b", null, one.name), mk("span", null, `${kindOf(one)} → ${one.owner.name.replace(/_flow$/, "")}`)); t.style.left = `${one.x}px`; t.style.top = `${one.y - 12}px`; doorList.append(t); doorList.hidden = false; return; }
  if (!c || !c.members || view.zoom < 0.55) return; const mine = doors.filter(d => d.owner === c); if (!mine.length) return;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); const rows = mine.slice().sort((a, b) => a.y - b.y), lk = Math.max(1, Math.min(1.6, 1 / view.zoom)), cols = rows.length > 12 ? 2 : 1, ph = Math.ceil(rows.length / cols) * 15 * lk;   // a long list is two columns: half as tall, so it fits beside its workflow
  const pw = Math.max(...rows.map(d => { g.font = `500 10px ${MONO}`; const n = g.measureText(d.name).width; g.font = `600 8px ${MONO}`; return n + g.measureText(kindOf(d)).width + 16; })), pwAll = pw * cols + (cols - 1) * 14, pwk = pwAll * lk; g.restore();
  const boxOfC = (f) => { const ds = doors.filter(d => d.owner === f); return [Math.min(f.x - Math.max(f.a, 62), ...ds.map(d => d.x - 9)), Math.min(f.y - f.rise - 18, ...ds.map(d => d.y - 9)), Math.max(f.x + Math.max(f.a, 62), ...ds.map(d => d.x + 9)), Math.max(f.y + 6 + f.a / 2 + 40, ...ds.map(d => d.y + 9))]; };
  const near = clusters.filter(f => f !== c).map(boxOfC), obst = clusters.map(boxOfC).concat(near, near,   // a neighbouring workflow counts three times: the list goes anywhere before it goes over one
    core.filter(s => on(s.id)).map(s => [s.x - 42, s.y - 14, s.x + 42, s.y + 30]));
  { const hr = host.getBoundingClientRect(), z = view.zoom; for (const el of host.querySelectorAll(".fx-hud, .fx-find, .fx-legend")) { const r = el.getBoundingClientRect(); if (r.width) obst.push([view.cx + (r.left - hr.left - vw() / 2) / z, view.cy + (r.top - hr.top - vh() / 2) / z, view.cx + (r.right - hr.left - vw() / 2) / z, view.cy + (r.bottom - hr.top - vh() / 2) / z]); } }   // the title, the legend and the find box are in the way too
  for (const f of fils) if (wiredFil(f)) for (let i = 1; i < f.pts.length; i += 1) obst.push([f.pts[i].x - 7, f.pts[i].y - 7, f.pts[i].x + 7, f.pts[i].y + 7]);
  const z = view.zoom, b = [view.cx - vw() / 2 / z + Math.max(0, hud.offsetLeft) / z + 8, view.cy - vh() / 2 / z + 96 / z, view.cx + (vw() / 2 - covered()) / z - 8, view.cy + (vh() / 2 - 64) / z];
  const at = FL.placePanel(boxOfC(c), obst, pwk, ph, b);
  doorList.hidden = false; doorList.style.left = `${at.rect[0]}px`; doorList.style.top = `${at.rect[1]}px`; doorList.style.width = `${pwAll}px`; doorList.style.columnCount = cols; doorList.style.transformOrigin = "0 0"; doorList.style.transform = `scale(${lk})`; doorList.dataset.side = at.left ? "left" : "right";
  rows.forEach((d, i) => { const r = mk("div", "fx-doorrow"); r.append(mk("b", null, d.name), mk("span", d.type, kindOf(d))); doorList.append(r);
    if (cols === 1) listRows.push({d, left: at.left ? d.x > at.rect[2] : d.x > at.rect[0] + pwk / 2, x: d.x > at.rect[0] + pwk / 2 ? at.rect[2] + 3 : at.rect[0] - 3, y: at.rect[1] + (i * 15 + 7) * lk}); }); }
const kindOf = (d) => (d.type === "service" ? (d.kind || "http").toUpperCase() : d.sched ? "JOB · SCHEDULED" : "JOB");
function select(id) { const line = typeof id === "string" && id.startsWith("l:") ? {owner: id.slice(2, id.lastIndexOf("|")), kind: id.slice(id.lastIndexOf("|") + 1)} : null;
  if (id && doorAt.has(id)) id = doorAt.get(id).owner.id;           // a door's card is its workflow's
  sel = line ? (spot.has(line.owner) ? id : null) : id && spot.has(id) ? id : null; selLine = sel && line ? line : null;
  refocus(); describe(); if (sel && docked) setTimeout(() => { uncover(); listDoors(); redraw(); }, 260); }   // the list is placed again once the panel is open: it stays out from under it
/* the side panel opens over the right of the picture: what was picked moves out from under it */
function uncover() { if (!sel) return; const t = spot.get(selLine ? selLine.owner : sel); if (!t) return;
  const cw = covered(), sx = (t.x - view.cx) * view.zoom + vw() / 2, edge = vw() - cw - 150;
  if (cw > 0 && sx > edge) { view.cx += (sx - edge) / view.zoom; apply(); } }
/* a workflow's real ops, as its graph holds them: a small map of the graph, then every op by name */
function opsOf(name) { const gr = (ir.graphs || []).find(x => x.name === name); if (!gr || !gr.nodes.length) return;
  const W = 268, H = Math.max(40, Math.min(130, (gr.height || 300) * W / Math.max(300, gr.width || 300) + 24)), cv = mk("canvas", "fx-map"), k = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * k; cv.height = H * k; cv.style.width = `${W}px`; cv.style.height = `${H}px`; const c = cv.getContext("2d"); c.scale(k, k);
  const xs = gr.nodes.map(n => n.x || 0), ys = gr.nodes.map(n => n.y || 0), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const at = new Map(gr.nodes.map(n => [n.id, [10 + ((n.x || 0) - x0) / (x1 - x0 || 1) * (W - 20), 10 + ((n.y || 0) - y0) / (y1 - y0 || 1) * (H - 20)]]));
  c.strokeStyle = `rgba(${INK.data},.4)`; c.lineWidth = 0.7;
  for (const e of gr.edges || []) { const a = at.get(e.src), b = at.get(e.dst); if (!a || !b) continue; c.beginPath(); c.moveTo(a[0], a[1]); c.bezierCurveTo(a[0], (a[1] + b[1]) / 2, b[0], (a[1] + b[1]) / 2, b[0], b[1]); c.stroke(); }
  for (const n of gr.nodes) { const [x, y] = at.get(n.id), br = /Branch/.test(n.kind || ""), w = br || n.graph ? 4 : 3;
    c.beginPath(); c.moveTo(x - w, y); c.lineTo(x, y - w / 2); c.lineTo(x + w, y); c.lineTo(x, y + w / 2); c.closePath(); c.fillStyle = br ? "rgba(150,176,255,.95)" : n.graph ? "rgba(96,84,190,.95)" : "rgba(206,196,255,.9)"; c.fill(); }
  card.append(mk("h4", null, `Ops · ${gr.nodes.length}`), cv);
  const ul = mk("div", "fx-rows"), order = gr.nodes.slice().sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0));
  for (const n of order.slice(0, 60)) { const b = mk("button", "fx-row"); b.type = "button"; b.title = "Open the flow at this op"; b.onclick = () => opts.onOpen && opts.onOpen(name, n.id);
    b.append(mk("b", null, n.name), mk("span", null, n.graph ? `sub-graph · ${n.subgraph_ops || n.graph.nodes.length} ops` : (n.kind || "op").replace(/Op$/, "").toLowerCase())); ul.append(b); }
  if (order.length > 60) ul.append(mk("div", "fx-row more", `and ${order.length - 60} more`)); card.append(ul); }
/* the card (docs/FACTORY_PANELS.md): what the selected thing is, in its own words; what comes in; what goes out;
 * what it works with — every row goes somewhere */
function describe() { card.textContent = ""; card.hidden = !sel && !docked; if (opts.onSelect) opts.onSelect(sel);
  if (!sel) { if (docked) card.append(mk("p", "fx-hint", "Click a workflow, a store, a shared block, a resource or a line on the picture: what it is, and what it works with, is shown here.")); return; }
  const head = (kind, name, sub, says) => { const x = mk("button", "fx-x", "×"); x.type = "button"; x.title = "Clear the selection  (Esc)"; x.onclick = () => select(null);
    card.append(x, mk("p", "fx-kind", kind), mk("h3", null, name)); if (says) card.append(mk("p", "fx-says", says)); if (sub) card.append(mk("p", "fx-sub", sub)); };
  const list = (title, rows, max = 60) => { if (!rows.length) return; card.append(mk("h4", null, `${title} · ${rows.length}`)); const ul = mk("div", "fx-rows");
    for (const r of rows.slice(0, max)) { const b = mk(r.go ? "button" : "div", "fx-row"); if (r.go) { b.type = "button"; b.onclick = r.go; if (r.tip) b.title = r.tip; } b.append(mk("b", null, r.name)); if (r.note) b.append(mk("span", null, r.note));
      if (r.desc) { b.classList.add("said"); b.append(mk("em", null, r.desc)); }
      if (!r.also) { ul.append(b); continue; }
      const two = mk("div", "fx-pair"), a = mk("button", "fx-also", "↗"); a.type = "button"; a.title = r.also.tip; a.setAttribute("aria-label", r.also.tip); a.onclick = r.also.go; two.append(b, a); ul.append(two); }
    if (rows.length > max) ul.append(mk("div", "fx-row more", `and ${rows.length - max} more`)); card.append(ul); };
  const open = (name, at) => () => opts.onOpen && opts.onOpen(name, at);
  const flowRow = (f) => ({name: f.name, note: [`${f.ops} ops`, f.runs ? `${f.runs.toLocaleString()} runs` : "", f.errors ? `${f.errors} failed` : ""].filter(Boolean).join(" · "), desc: f.description, go: open(f.name)});
  const doorRow = (d) => ({name: d.name, note: d.type === "job" ? d.kind : `${d.kind} ${d.path || ""}`.trim(), desc: d.description, go: opts.onRuns ? () => opts.onRuns(d) : null,
    tip: d.type === "job" ? "Open this job, with its runs" : "Open this service's runs",
    also: d.type === "service" && opts.onDoor ? {tip: "Its row on the Services screen", go: () => opts.onDoor(d)} : null});
  const toCore = (kind) => pairs.filter(p => p.src === sel && p.kind === kind).map(p => { const t = model.by.get(p.dst); return {name: spot.get(p.dst).name, note: p.count > 1 ? `×${p.count}` : "", desc: t && t.description, go: () => select(p.dst)}; });
  /* who a flow works with through the stores: the ones that read what it writes, the ones that write what it reads */
  const through = (fid, mine, theirs) => { const per = new Map();
    for (const l of model.outOf(fid)) { if (l.kind !== mine) continue; const s = model.by.get(l.dst);
      for (const w of s[theirs]) { if (w.id === fid) continue; if (!per.has(w.id)) per.set(w.id, {who: w, via: []}); per.get(w.id).via.push(s.name); } }
    return [...per.values()].map(({who, via}) => { const box = who.type === "flow" ? clusterOf.get(who.id) : null, d = model.by.get(who.id);
      return {name: who.name, note: who.type === "job" ? (who.jobs ? `${who.jobs.length} jobs` : "job") : "", desc: `through ${via.join(", ")}`, go: box ? () => select(box) : who.type === "job" && opts.onRuns ? () => opts.onRuns(d) : null}; }); };
  if (selLine) {                                                     // a line: what moves along it, one row per thing at its far end
    const cl = spot.get(selLine.owner), of = pairs.filter(p => p.src === selLine.owner && strandKind(p.kind) === selLine.kind);
    const row = (p) => { const t = model.by.get(p.dst), mine = t && t.type === "store" && !grouped ? (p.kind === "writes" ? t.writers : t.readers).find(w => w.id === selLine.owner) : null;
      return {name: spot.get(p.dst).name, note: mine && mine.ops.length ? mine.ops.join(", ") : p.count > 1 ? `×${p.count}` : "", desc: t && t.description, go: () => select(p.dst)}; };
    const says = {uses: "Code this flow is built from, that other flows are built from too. Nothing moves along it at run time: it says the flows share the block.",
      needs: "What this flow reaches out to while it runs: models, services, databases.", data: "Data this flow leaves in a store or picks up from one. The pulse runs the way the data goes."}[selLine.kind];
    head("Connection", `${cl.name} ↔ shared`, `${of.length} ${selLine.kind === "data" ? "relationship" : selLine.kind === "uses" ? "shared block" : "resource"}${of.length > 1 ? "s" : ""}`, says);
    if (selLine.kind === "data") { list("Writes", of.filter(p => p.kind === "writes").map(row)); list("Reads", of.filter(p => p.kind === "reads").map(row)); }
    else list(selLine.kind === "uses" ? "Shared blocks" : "Resources", of.map(row));
    list("From", [{name: cl.name, note: cl.sub, go: () => select(selLine.owner)}]); return; }
  const c = spot.get(sel), e = model.by.get(sel);
  if (c.ghost) { head("Not in this project", c.name, "doors ask for this graph, and the project does not list it"); list("Asked for by", c.doors.map(doorRow)); return; }
  if (c.members) {                                                   // a platform: one flow, or a domain of flows
    if (grouped) { head("Domain", c.name, c.sub); list("Flows", c.members.map(i => model.by.get(i)).sort((a, b) => b.errors - a.errors || b.runs - a.runs || b.ops - a.ops).map(flowRow), 200); }
    else { head("Workflow", c.name, [c.sub, e.runs ? `${e.runs.toLocaleString()} runs in 7 days` : "", e.errors ? `${e.errors} failed` : ""].filter(Boolean).join(" · "), e.description);
      const go = mk("button", "fx-go", "Open in the editor"); go.type = "button"; go.onclick = open(c.name); card.append(go); }
    if (!grouped) { list("Gets data from", through(e.id, "reads", "writers")); list("Passes data to", through(e.id, "writes", "readers")); }
    list("Reads", toCore("reads")); list("Writes", toCore("writes"));
    list("Comes in through", c.doors.map(doorRow), 6);
    list("Uses, shared with other flows", toCore("uses")); list("Needs", toCore("needs"));
    if (!grouped) opsOf(c.name); return; }
  const users = pairs.filter(p => p.dst === sel).map(p => ({name: spot.get(p.src).name, note: p.count > 1 ? `×${p.count}` : "", go: () => select(p.src)}));
  if (c.kind === "store") { const row = (w) => { const box = w.type === "flow" ? clusterOf.get(w.id) : null;
      return {name: w.name, note: w.type === "job" ? (w.jobs ? `${w.jobs.length} jobs` : "job") : "", desc: w.ops.join(", "), tip: w.jobs ? w.jobs.join(", ") : "", go: box ? () => select(box) : w.type === "job" && opts.onRuns ? () => opts.onRuns(model.by.get(w.id)) : null}; };
    head("Store", c.name, `${e.writers.length} write it · ${e.readers.length} read it`, e.description || "A named place where one flow leaves data and another picks it up.");
    list("Written by", e.writers.map(row)); list("Read by", e.readers.map(row)); return; }
  if (c.kind === "block") { head("Shared block", c.name, e.kind === "op" ? `one op · ${e.definedAt}` : `a nested graph of ${e.ops} ops`, e.description || "Code more than one flow is built from.");
    if (grouped) list("Used in", users); list("Used by", e.uses.map(u => ({name: model.by.get(u.flow).name, note: `as ${u.name}`, go: open(model.by.get(u.flow).name, u.at)})), 80); return; }
  const rs = model.resources.filter(r => boxOfRes.get(r.id) === sel);
  head(rs.length > 1 ? "Resources" : "Resource", c.name, rs.length > 1 ? "" : rs[0].key, "Something the project reaches out to — a model, a service, a database — declared in resources.yaml.");
  if (rs.length > 1) list("In this group", rs.map(r => ({name: r.name, note: `${r.flows.length} flows`})));
  if (grouped) list("Needed in", users); list("Needed by", [...new Set(rs.flatMap(r => r.flows))].map(i => flowRow(model.by.get(i))), 80); }

// ── the pointer ───────────────────────────────────────────────────
/* what is under a point of the picture: a door, a platform, a shared item — or a filament within a few pixels */
function pick(w) {
  if (view.zoom >= 0.3) for (const d of doors) if (Math.hypot(d.x - w.x, d.y - w.y) < 7.5) return d.id;
  for (let i = byDepth.length - 1; i >= 0; i--) { const c = byDepth[i], dx = Math.abs(w.x - c.x), dy = w.y - c.y - 6;
    if (dx / c.a + Math.abs(dy) / (c.a / 2) <= 1.06 || (dx < c.a * 0.4 && dy < 0 && dy > -c.rise - 14)) return c.id; }
  for (const s of core) if (Math.hypot(s.x - w.x, (s.y - w.y) * 1.4) < 16) return s.id;
  return null; }
function pickLine(w) { let best = null, bd = 6 / view.zoom;
  for (const f of fils) for (let i = 1; i < f.pts.length; i++) { const a = f.pts[i - 1], b = f.pts[i], dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / (dx * dx + dy * dy || 1))), d = Math.hypot(w.x - a.x - t * dx, w.y - a.y - t * dy);
    if (d < bd) { bd = d; best = `l:${f.p.src}|${f.kind}`; } }
  return best; }
const zoomAt = (e, f) => { const w = toWorld(e), z0 = view.zoom; view.zoom = Math.max(ZMIN, Math.min(ZMAX, z0 * f)); const k = z0 / view.zoom; view.cx = w.x - (w.x - view.cx) * k; view.cy = w.y - (w.y - view.cy) * k; apply(); };
canvas.addEventListener("wheel", (e) => { e.preventDefault(); const u = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh() : 1;
  if (e.ctrlKey || e.metaKey) return zoomAt(e, Math.exp(-e.deltaY * u * 0.0022));
  const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * u, dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * u; view.cx += dx / view.zoom; view.cy += dy / view.zoom; apply(); }, {passive: false});
let drag = null, moved = 0; const fingers = new Map(); let spread = 0;
const apart = () => { const [a, b] = [...fingers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; };
canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; moved = 0; canvas.setPointerCapture(e.pointerId); fingers.set(e.pointerId, [e.clientX, e.clientY]); if (fingers.size === 2) { spread = apart(); moved = 99; } });
canvas.addEventListener("pointermove", (e) => { if (fingers.has(e.pointerId)) fingers.set(e.pointerId, [e.clientX, e.clientY]);
  if (fingers.size === 2) { const d = apart(); view.zoom = Math.max(ZMIN, Math.min(ZMAX, view.zoom * d / spread)); spread = d; apply(); return; }
  if (!drag) { const w = toWorld(e); setHover(pick(w) || pickLine(w)); return; }
  moved += Math.abs(e.clientX - drag[0]) + Math.abs(e.clientY - drag[1]); view.cx -= (e.clientX - drag[0]) / view.zoom; view.cy -= (e.clientY - drag[1]) / view.zoom; drag = [e.clientX, e.clientY]; apply(); });
const lift = (e) => { const click = e.type === "pointerup" && drag && moved < 5 && fingers.size <= 1; fingers.delete(e.pointerId); drag = null; if (click) { const w = toWorld(e); select(pick(w) || pickLine(w)); } };
canvas.addEventListener("pointerup", lift); canvas.addEventListener("pointercancel", lift); canvas.addEventListener("pointerleave", () => { if (!drag) setHover(null); });
canvas.tabIndex = 0;
canvas.addEventListener("dblclick", (e) => { let id = pick(toWorld(e)); if (id && doorAt.has(id)) id = doorAt.get(id).owner.id; if (id && /^f:/.test(id) && opts.onOpen) opts.onOpen(model.by.get(id).name); });
resetBtn.onclick = fit;
const onKey = (e) => { if (e.ctrlKey || e.metaKey || e.altKey || !host.clientWidth) return;
  const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const here = host.contains(document.activeElement) || document.activeElement === document.body, step = vh() / view.zoom * 0.08;
  const way = here && {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key];
  if (e.key === "f" || e.key === "F") fit(); else if (e.key === "Escape" && sel) { select(null); canvas.focus(); } else if (e.key === "/") { e.preventDefault(); find.focus(); }
  else if (way) { e.preventDefault(); view.cx += way[0] * step; view.cy += way[1] * step; apply(); }
  else if (here && (e.key === "+" || e.key === "=" || e.key === "-")) { view.zoom = Math.max(ZMIN, Math.min(ZMAX, view.zoom * (e.key === "-" ? 1 / 1.2 : 1.2))); apply(); }
  else return;
  e.stopPropagation(); };
document.addEventListener("keydown", onKey);

/* go to a thing by name: its platform or shared item is selected and brought to the middle */
function reveal(id) { const e = model.by.get(id); let o = spot.has(id) ? id : null;
  if (!o && e) { const f = e.type === "flow" ? e.id : e.flow || (e.job && model.by.get(e.job).flow); o = f ? clusterOf.get(f) : e.type === "resource" ? boxOfRes.get(id) : e.asks || (e.job && model.by.get(e.job).asks) ? `?:${e.asks || model.by.get(e.job).asks}` : null; }
  if (!o || !spot.has(o)) return false; const t = spot.get(o);
  view.zoom = Math.max(view.zoom, 1); view.cx = t.x - Math.max(0, hud.offsetLeft - 14) / 2 / view.zoom; view.cy = t.y; apply(); select(o); return true; }
const find = mk("input", "fx-find"); find.type = "search"; find.placeholder = "Find a flow, service, job, block, resource…"; find.setAttribute("aria-label", "Find on the picture"); find.autocomplete = "off";
const found = mk("div", "fx-found"); found.hidden = true; hud.append(find, found);
const things = [...model.flows, ...model.blocks.filter(b => b.shared), ...model.resources.filter(r => r.flows.length), ...model.stores.filter(s => s.writers.length || s.readers.length), ...model.doors];
find.oninput = () => { const q = find.value.trim().toLowerCase(); found.textContent = ""; found.hidden = !q; if (!q) return;
  const hits = things.filter(t => `${t.name} ${t.path || ""}`.toLowerCase().includes(q)).slice(0, 8);
  if (!hits.length) found.append(mk("div", "fx-row more", "Nothing by that name"));
  for (const t of hits) { const b = mk("button", "fx-row"); b.type = "button"; b.append(mk("b", null, t.name), mk("span", null, t.type === "block" ? "shared block" : t.type));
    b.onclick = () => { if (reveal(t.id)) { find.value = ""; found.hidden = true; } }; found.append(b); } };
find.onkeydown = (e) => { if (e.key === "Enter") { const b = found.querySelector("button"); if (b) b.click(); } else if (e.key === "Escape") { find.value = ""; found.hidden = true; find.blur(); } e.stopPropagation(); };

setStats(stats);
resize(); fit(); paintSparks();
kick();
return {
  fit, select, reveal, setStats,
  hover: setHover,
  /* what a frame costs, and what is on it: for the scale checks */
  cost: () => ({software: true, drawMs: +spent.toFixed(1), frames, pixelRatio: dpr, platforms: clusters.length, shared: core.length, doors: doors.length, filaments: fils.length, relationships: pairs.length, pulses: silk.childElementCount, names: labels.length}),
  pause() { live = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
  resume() { if (!live) { live = true; kick(); } },
  dispose() { this.pause(); sized.disconnect(); document.removeEventListener("keydown", onKey); card.remove(); host.textContent = ""; delete host.dataset.ready; },
};
}
