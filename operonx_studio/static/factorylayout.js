/* The factory picture's layout — where everything stands (NEURAL_FACTORY_PLAN, mock 14).
 *
 *   workflows   two wings, left and right, in staggered columns
 *   the shared  a diamond lattice between the wings: stores, shared blocks, resources
 *   doors       a workflow's services and jobs, in ranks along its platform's outer outline:
 *               services nearest, jobs behind
 *
 * Which slot a workflow or a shared item takes is searched: fewest crossings between relationships,
 * no relationship over another workflow, then length. Pure functions of their input — the same
 * project gives the same picture — so they are tested with node (tests/js/factorylayout.test.mjs).
 * Nothing here knows about a canvas. Distances are picture units: one is a CSS pixel at zoom 1. */
(function (root) {
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const PITCH = {lx: 94, ly: 76, col: 240, row: 198};
  /* a platform's half-width grows with the root of its size (ops, or flows for a domain) and stops */
  const halfOf = (size) => Math.min(78, 22 + 5.3 * Math.sqrt(Math.max(1, size)));
  const riseOf = (size) => Math.min(34, 8 + Math.sqrt(Math.max(1, size)) * 2.3);
  /* how many prisms stand round the core: scale, not a count */
  const prismsOf = (size) => Math.max(1, Math.min(7, Math.round(Math.log2(Math.max(2, size)))));

  /* the lattice: k × k places on a diamond, the middle ones first */
  function lattice(n) {
    const k = Math.max(1, Math.ceil(Math.sqrt(n))), out = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) out.push({x: (i - j) * PITCH.lx, y: (i + j - (k - 1)) * PITCH.ly});
    out.sort((a, b) => Math.hypot(a.x, a.y * 1.2) - Math.hypot(b.x, b.y * 1.2) || a.y - b.y || a.x - b.x);
    return {k, slots: out.slice(0, n), half: (k - 1) * PITCH.lx};
  }
  /* the wings: columns going outward, the inner ones first, a column's rows centred */
  function wings(n, inner) {
    const per = Math.ceil(n / 2), rows = Math.max(3, Math.ceil(Math.sqrt(per * 2))), out = [];
    for (let c = 0, left = n; left > 0; c++) {
      const here = Math.min(left, rows * 2), L = Math.floor(here / 2), Rn = here - L;
      for (const [sg, m] of [[1, Rn], [-1, L]]) for (let r = 0; r < m; r++)
        out.push({x: sg * (inner + c * PITCH.col), y: (r - (m - 1) / 2) * PITCH.row + (c % 2 && m === rows ? PITCH.row / 2 : 0), sg});
      left -= here;
    }
    return out;
  }

  /* clusters: [{id, size, doors: [{id, type}]}] · shared: [{id}] · pairs: [{src: cluster, dst: shared, kind}]
   * → {at: id → {x, y, a, rise, sg} | {x, y}, doors: id → {x, y, owner, rank}, more: cluster → doors not drawn,
   *    starts: pair → {x, y}, bounds: [x0, y0, x1, y1]} */
  function layout(clusters, shared, pairs, opts = {}) {
    const maxDoors = opts.maxDoors || 36;
    const lat = lattice(shared.length), slots = wings(clusters.length, shared.length ? lat.half + 100 : 130);   // mock 14: a lattice ±282 wide, the inner columns at ±382
    const cs = clusters.map(c => ({...c, a: halfOf(c.size), rise: riseOf(c.size)})), ss = shared.map(s => ({...s}));
    const byId = new Map([...cs, ...ss].map(e => [e.id, e]));
    const uniq = [...new Map(pairs.filter(p => byId.has(p.src) && byId.has(p.dst)).map(p => [p.src + "|" + p.dst, {a: byId.get(p.src), b: byId.get(p.dst)}])).values()];
    let order = cs.slice().sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1)), sorder = ss.slice();
    const place = () => { order.forEach((c, i) => { c.x = slots[i].x; c.y = slots[i].y; c.sg = slots[i].sg; }); sorder.forEach((s, i) => { s.x = lat.slots[i].x; s.y = lat.slots[i].y; }); };
    const side = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const over = uniq.length * cs.length < 60000;              // "runs over another workflow" is the dear part of the cost
    const cost = () => { let c = 0;
      for (const p of uniq) c += Math.hypot(p.a.x - p.b.x, p.a.y - p.b.y) * 0.004;
      for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) { const p = uniq[i], q = uniq[j]; if (p.a === q.a || p.b === q.b) continue;
        if (side(p.a, p.b, q.a) * side(p.a, p.b, q.b) < 0 && side(q.a, q.b, p.a) * side(q.a, q.b, p.b) < 0) c += 1; }
      if (over) for (const p of uniq) for (const f of cs) { if (f === p.a) continue;
        const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, u = Math.max(0, Math.min(1, ((f.x - p.a.x) * dx + (f.y - p.a.y) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(p.a.x + dx * u - f.x, (p.a.y + dy * u - f.y) * 1.6) < f.a + 14) c += 4; }
      return c; };
    place();
    if (uniq.length) { const rnd = rng(11), per = uniq.length * uniq.length + (over ? uniq.length * cs.length : 0) + 1, tries = Math.max(200, Math.min(26000, Math.floor(6e7 / per)));
      let best = cost();
      for (let it = 0; it < tries; it++) { const arr = rnd() < 0.4 && order.length > 1 ? order : sorder; if (arr.length < 2) continue;
        const i = rnd() * arr.length | 0, j = rnd() * arr.length | 0; if (i === j) continue;
        [arr[i], arr[j]] = [arr[j], arr[i]]; place(); const c = cost(); if (c < best) best = c; else [arr[i], arr[j]] = [arr[j], arr[i]]; }
      place(); }

    const at = new Map(), doors = new Map(), more = new Map(), starts = new Map();
    for (const s of ss) at.set(s.id, {x: s.x, y: s.y});
    for (const f of cs) {
      at.set(f.id, {x: f.x, y: f.y, a: f.a, rise: f.rise, sg: f.sg});
      /* the doors: ranks along the outer outline — services first, then jobs */
      const base = f.sg < 0 ? Math.PI : 0, all = (f.doors || []).slice().sort((p, q) => (p.type === q.type ? (p.id < q.id ? -1 : 1) : p.type === "service" ? -1 : 1));
      const shown = all.slice(0, maxDoors); if (all.length > shown.length) more.set(f.id, all.length - shown.length);
      let gap = 15, k = 0;
      for (const type of ["service", "job"]) { const list = shown.filter(d => d.type === type); if (!list.length) continue;
        if (type === "job" && k) gap += 2;
        for (let i = 0; i < list.length;) {
          const step = (type === "job" ? 17 : 18.5) / (f.a * 0.72 + gap), cap = Math.max(1, Math.floor((type === "job" ? 2.5 : 1.9) / step) + 1), row = list.slice(i, i + cap);
          row.forEach((d, j) => { const an = (j - (row.length - 1) / 2 + (k % 2 && row.length === cap ? 0.5 : 0)) * step, ang = base + (f.sg < 0 ? -an : an);
            const c = Math.cos(ang), s = Math.sin(ang), q = 1 / (Math.abs(c) / f.a + Math.abs(s) / (f.a / 2));
            doors.set(d.id, {x: f.x + c * q + c * gap, y: f.y + 6 + s * q + s * gap * 0.82, owner: f.id, rank: k}); });
          i += cap; gap += 16; k++; } }
      /* where each relationship leaves the platform: its own point along the two edges that face the shared items */
      const mine = pairs.filter(p => p.src === f.id && byId.has(p.dst)).map(p => { const s = byId.get(p.dst);
        return {p, t: 0.5 + Math.atan2(s.y - f.y - 6, (s.x - f.x) * -f.sg) / Math.PI + (p.kind === "writes" ? -0.004 : p.kind === "reads" ? 0.004 : 0)}; }).sort((p, q) => p.t - q.t);
      const g = Math.min(0.075, 0.8 / Math.max(1, mine.length));
      for (const m of mine) m.t = Math.max(0.1, Math.min(0.9, m.t));
      for (let it = 0; it < 40; it++) for (let i = 1; i < mine.length; i++) { const d = g - (mine[i].t - mine[i - 1].t); if (d > 0) { mine[i - 1].t -= d / 2; mine[i].t += d / 2; } }
      const lo = Math.min(0.06, ...mine.map(m => m.t)), hi = Math.max(0.94, ...mine.map(m => m.t));
      for (const m of mine) { const tt = 0.06 + (m.t - lo) / (hi - lo) * 0.88, cy = f.y + 6, u = tt < 0.5 ? tt / 0.5 : (tt - 0.5) / 0.5;
        starts.set(m.p, tt < 0.5 ? {x: f.x - f.sg * f.a * u, y: cy - f.a / 2 * (1 - u)} : {x: f.x - f.sg * f.a * (1 - u), y: cy + f.a / 2 * u}); }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, rx, up, down) => { x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx); y0 = Math.min(y0, y - up); y1 = Math.max(y1, y + down); };
    for (const f of cs) grow(f.x, f.y, Math.max(f.a, 70), f.rise + 26, f.a / 2 + 48);
    for (const s of ss) grow(s.x, s.y, 46, 18, 30);
    for (const d of doors.values()) grow(d.x, d.y, 10, 10, 10);
    if (x0 === Infinity) { x0 = y0 = -100; x1 = y1 = 100; }
    return {at, doors, more, starts, bounds: [x0, y0, x1, y1], lattice: lat};
  }

  /* where a panel of pw × ph stands beside `own` so that it covers least: ten places are tried, the first
   * with nothing under it wins. own and obstacles are [x0, y0, x1, y1]; bounds is what must hold it. */
  function placePanel(own, obstacles, pw, ph, bounds) {
    const mid = (own[1] + own[3]) / 2 - ph / 2; let best = null, ci = 0;
    for (const [L, X, T] of [[false, own[2] + 22, mid], [true, own[0] - 22, mid], [false, own[0], own[1] - ph - 12], [true, own[2], own[1] - ph - 12], [false, own[0], own[3] + 10], [true, own[2], own[3] + 10],
                            [false, own[2] + 22, own[1] - ph * 0.7], [true, own[0] - 22, own[1] - ph * 0.7], [false, own[2] + 22, own[3] - ph * 0.3], [true, own[0] - 22, own[3] - ph * 0.3]]) {
      const r = L ? [X - pw, T, X, T + ph] : [X, T, X + pw, T + ph]; let s = ci++ * 40;
      for (const o of obstacles) s += Math.max(0, Math.min(r[2], o[2]) - Math.max(r[0], o[0])) * Math.max(0, Math.min(r[3], o[3]) - Math.max(r[1], o[1]));
      if (bounds) s += 20 * pw * (Math.max(0, bounds[0] - r[0]) + Math.max(0, r[2] - bounds[2]) + Math.max(0, bounds[1] - r[1]) + Math.max(0, r[3] - bounds[3]));
      if (!best || s < best.score) best = {left: L, x: X, top: T, rect: r, score: s};
    }
    return best;
  }
  /* a relationship's path: one gentle curve from its start to the shared item; a pair that both writes and
   * reads has two, bowed apart. Returned as points, for drawing, picking and the pulse's path alike. */
  function curve(p, s, bow, n = 48) {
    const dx = s.x - p.x, dy = s.y - p.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
    const c1 = {x: p.x + dx * 0.33 + nx * bow, y: p.y + dy * 0.33 + ny * bow}, c2 = {x: p.x + dx * 0.72 + nx * bow * 0.9, y: p.y + dy * 0.72 + ny * bow * 0.9}, out = [];
    for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t;
      out.push({x: u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * s.x, y: u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * s.y}); }
    out.d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)}C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`;
    out.rd = `M${s.x.toFixed(1)} ${s.y.toFixed(1)}C${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;   // the same path, walked back
    return out;
  }

  const api = {layout, placePanel, curve, lattice, wings, halfOf, riseOf, prismsOf, hash};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FactoryLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
