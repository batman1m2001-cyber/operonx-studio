// Geometry checks shared by the flow layout tests: the same paths the
// canvas draws (FlowLayout's `d`), sampled and tested against every box.

// parse "M x y C x1 y1, x2 y2, x y ..." into cubic segments
export function cubics(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const segs = [];
  let x = nums[0], y = nums[1];
  for (let i = 2; i + 5 < nums.length + 1; i += 6) {
    const s = [[x, y], [nums[i], nums[i + 1]], [nums[i + 2], nums[i + 3]], [nums[i + 4], nums[i + 5]]];
    segs.push(s);
    x = nums[i + 4]; y = nums[i + 5];
  }
  return segs;
}

export function sample(d, per = 24) {
  const pts = [];
  for (const [p0, p1, p2, p3] of cubics(d)) {
    for (let k = 0; k <= per; k++) {
      const t = k / per, u = 1 - t;
      pts.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
  }
  return pts;
}

const inside = (b, [x, y], m = 1) => x > b.x + m && x < b.x + b.w - m && y > b.y + m && y < b.y + b.h - m;
const under = (k, anc) => k.startsWith(anc + "/");

// every problem found in one layout: wires through cards, card overlaps
export function problems(out) {
  const bad = [];
  const leaves = [...out.items.filter(i => !i.inner), ...out.pills];
  const boxes = out.items.filter(i => i.inner);
  for (const w of out.wires) {
    const pts = sample(w.d);
    const ends = new Set([w.a.key, w.b.key, w.a.bOut && w.a.bOut.key, w.b.bIn && w.b.bIn.key].filter(Boolean));
    for (const c of leaves) {
      if (ends.has(c.key)) continue;
      if (pts.some(p => inside(c, p))) { bad.push(`wire ${w.key} through ${c.key}`); break; }
    }
    for (const c of boxes) {
      if (ends.has(c.key) || under(w.a.key, c.key) || under(w.b.key, c.key)) continue;
      if (pts.some(p => inside(c, p))) { bad.push(`wire ${w.key} through box ${c.key}`); break; }
    }
  }
  const all = [...out.items, ...out.pills];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const p = all[i], q = all[j];
    if (under(p.key, q.key) || under(q.key, p.key)) continue;
    const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
    const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
    if (ox > 0.5 && oy > 0.5) bad.push(`overlap ${p.key} / ${q.key}`);
  }
  return bad;
}

// crossings between wires of different pairs (as the views script counts)
export function crossingCount(out) {
  const lines = out.wires.map(w => [w.a.key + ">" + w.b.key, sample(w.d, 8)]);
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const cut = (a, b, c, d) => o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  let n = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    if (lines[i][0] === lines[j][0]) continue;
    const A = lines[i][1], B = lines[j][1];
    let hit = false;
    for (let a = 2; a < A.length - 3 && !hit; a++) for (let b = 2; b < B.length - 3 && !hit; b++)
      if (cut(A[a], A[a + 1], B[b], B[b + 1])) hit = true;
    if (hit) n++;
  }
  return n;
}
