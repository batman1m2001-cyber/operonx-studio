/* Compound layered layout for the flow canvas — positions first, wires after.
 *
 * Given an IR graph, the set of opened containers and every card's REAL
 * size (measured in the page), this places every card of every open level
 * and plans every wire along a path the placement reserved for it:
 *
 * 1. Bottom-up: an opened GraphOp's inner graph is laid out first; its box
 *    (START knob row on top, END knob row below) is then ONE node of that
 *    size in its parent's graph. Nothing is shifted afterwards, so nothing
 *    a lane was planned around moves.
 * 2. Each level is layered (longest path; a level's START/END terminals are
 *    rows of their own), long edges become chains of dummy lanes, a loop's
 *    return gets a lane chain pinned just right of its two cards, rows are
 *    ordered by barycentre sweeps (starting from the server's order, so a
 *    graph keeps its look), and x is assigned by order-preserving
 *    alignment. A decision card's routes leave by exits along its bottom
 *    edge, in route order: each target is ordered and placed under its
 *    own exit, so the wires drop straight down and never cross. (A card
 *    whose rows leave by its sides reserves room beside it for their lanes.)
 * 3. A row is as tall as its tallest card and cards are top-aligned, so the
 *    channel between two rows holds no card at all. A wire is vertical runs
 *    through its own reserved slots plus y-monotone curves inside channels:
 *    it cannot meet a card that is not its own end. No detours.
 *
 * Pure data → data: the same graph, open set and sizes give the same
 * picture (and opening then closing a container gives back the same
 * coordinates). Tested in node: tests/js/flowlayout.test.mjs. */
(function (global) {
  "use strict";

  const C = {
    NODE_W: 260, NODE_H: 64,
    H_GAP: 56,          // between two cards in a row
    V_GAP: 78,          // channel between two rows
    MARGIN: 48,
    KB: 26,             // a container's START/END knob
    HEADER: 34,         // a container's title strip
    B_W: 66, B_H: 28,   // the main flow's START/END pills
    CPAD: 24,           // container side padding
    CMIN_W: 300,        // container minimum width (its title strip)
    DW: 4,              // half width of a dummy lane slot
    GAP_DD: 14,         // lane to lane
    GAP_DC: 22,         // lane to card
    ROW_OUT: 14,        // a condition row's first lane, past the card edge
    ROW_STEP: 8,        // between a card's row lanes
    LABEL_W: 66,        // room right of a loop lane for "next turn"
    SWEEPS: 8,
    ZPAD: 14,           // a loop zone around its member cards
    ZPAD_B: 16,         // … below its last row
    ZOUT: 20,           // a non-member card to a loop zone's edge
    ZHX: 10,            // the zone header's left inset
    ZHY: 8,             // … its top/bottom inset in the header band
    ZLH: 15,            // … one header line
    ZWRAP: 380,         // a header line wraps past this
    PART_X: 112,        // an opened agent: its card's right edge to its parts column
    PART_GAP: 18,       // … between two parts
  };

  // ── loops: what repeats, and where it stops ──────────────────────
  /* A synthetic loop (the compiler's rewrite of an authored cycle) is
   * inlined for display: its members carry n.loop = {group, mode, …}. The
   * way OUT of the loop is a branch inside it whose route leads outside
   * it (or to END) — that route's condition is the loop's stop rule. */
  function loopsOf(g) {
    const nodes = (g && g.nodes) || [];
    const byGroup = new Map();
    for (const n of nodes) {
      const lp = n.loop;
      if (!lp || !lp.group) continue;
      if (!byGroup.has(lp.group)) {
        byGroup.set(lp.group, {group: lp.group, mode: lp.mode || "synthetic",
          synthetic: (lp.mode || "synthetic") === "synthetic",
          max_iterations: lp.max_iterations ?? null, until: lp.until ?? null, members: []});
      }
      byGroup.get(lp.group).members.push(n.name);
    }
    for (const info of byGroup.values()) {
      const set = new Set(info.members);
      info.exits = [];
      for (const n of nodes) {
        if (!set.has(n.name) || !n.routes) continue;
        n.routes.forEach((r, i) => {
          if (!set.has(r.target)) {
            info.exits.push({from: n.name, route: i, condition: r.condition,
                             target: r.target === "__END__" ? "END" : r.target});
          }
        });
      }
    }
    return [...byGroup.values()];
  }

  const exitText = (x) => `exits at ${x.from} ${x.condition === "else" ? "otherwise" : "when " + x.condition} → ${x.target}`;

  /* The zone's header, as lines no wider than `room` where it can. */
  function loopHeader(info, room, textWidth) {
    const tw = textWidth || ((t) => t.length * 6.4);
    let head = info.exits.length ? "↺ repeats each turn" : "↺ repeats until no step continues";
    if (!info.synthetic && info.until != null) head += ` · until ${info.until}`;
    if (!info.synthetic && info.max_iterations != null) head += ` · max ${info.max_iterations}`;
    const tails = info.exits.map(exitText);
    const one = [head, ...tails].join(" · ");
    if (tw(one) <= room) return [one];
    const wrap = Math.max(room, C.ZWRAP);
    const out = [];
    for (const line of [head, ...tails]) {
      let cur = "";
      for (const word of line.split(" ")) {
        const next = cur ? cur + " " + word : word;
        if (cur && tw(next) > wrap) { out.push(cur); cur = "  " + word; } else cur = next;
      }
      out.push(cur);
    }
    return out;
  }

  const f = (v) => Math.round(v * 10) / 10;

  // ── path building: all M + C, vertical tangents between segments ──
  class Path {
    constructor(x, y) { this.x0 = x; this.y0 = y; this.x = x; this.y = y; this.segs = []; }
    c(x1, y1, x2, y2, x, y) {
      // a vertical run straight after a vertical run is one run: fewer
      // segments, a lighter path for the browser to lay out and animate
      const last = this.segs[this.segs.length - 1];
      const vert = x1 === this.x && x2 === this.x && x === this.x;
      if (vert && last && last.vert && (y - this.y) * (last.y - last.y0) > 0) {
        last.y = y;
        const k = (y - last.y0) / 3;
        last.p = [x, last.y0 + k, x, y - k, x, y];
      } else {
        this.segs.push({p: [x1, y1, x2, y2, x, y], vert, y0: this.y, y});
      }
      this.x = x; this.y = y;
    }
    get d() {
      return `M ${f(this.x0)} ${f(this.y0)}` + this.segs.map(s =>
        ` C ${f(s.p[0])} ${f(s.p[1])}, ${f(s.p[2])} ${f(s.p[3])}, ${f(s.p[4])} ${f(s.p[5])}`).join("");
    }
    get pts() {
      const out = [[this.x0, this.y0]];
      for (const s of this.segs) out.push([s.p[0], s.p[1]], [s.p[2], s.p[3]], [s.p[4], s.p[5]]);
      return out;
    }
    // straight vertical run (as a curve)
    v(y) {
      if (Math.abs(y - this.y) < 0.5) return;
      const k = (y - this.y) / 3;
      this.c(this.x, this.y + k, this.x, y - k, this.x, y);
    }
    // inside a channel: vertical tangent out, vertical tangent in, y-monotone
    to(x, y) {
      if (Math.abs(x - this.x) < 0.5) return this.v(y);
      const ym = (this.y + y) / 2;
      this.c(this.x, ym, x, ym, x, y);
    }
    // horizontal departure at the current point, turning into the lane at lx
    turnInto(lx, dir, q) { this.c(lx, this.y, lx, this.y, lx, this.y + dir * q); }
    // from the lane, turning out horizontally into (px, py)
    turnOut(px, py) { this.c(this.x, py, this.x, py, px, py); }
  }

  // ── one node: a card, an opened container, an opened agent ─────────
  function itemOf(n, key, depth, opts) {
    if (n.graph && opts.expanded.has(key)) {
      const sub = buildLevel(n.graph, key + "/", depth + 1, opts, true);
      // opts.padOf: extra side room a container needs (the data views'
      // plates sit there, clear of its inner cards)
      const extra = (opts.padOf && opts.padOf(key)) || 0;
      return {id: n.id, key, node: n, kind: "container", sub,
              w: Math.max(C.CMIN_W, sub.w + 2 * (C.CPAD + extra)), h: sub.h};
    }
    if (n.parts && n.parts.length && opts.expanded.has(key)) return agentBlock(n, key, depth, opts);
    const s = opts.sizeOf(key, n) || {};
    return {id: n.id, key, node: n, kind: "card",
            w: s.w || C.NODE_W, h: s.h || C.NODE_H,
            rows: (s.rows || []).filter(r => r && r.w > 0)};
  }

  /* An opened agent: its card, and its parts (the model, its memory, each
   * tool — extract.py `_agent_parts`) in one column to the card's right,
   * each part the op it is (a card, an opened graph, an opened agent).
   * The block is ONE node of its level whose axis is the CARD's centre,
   * so the flow runs straight down through the card and the parts hang
   * beside it. The card sits level with the middle of the column the
   * parts make folded: opening a part grows the column down and never
   * moves the card. */
  function agentBlock(n, key, depth, opts) {
    const s = opts.sizeOf(key, n) || {};
    const card = {w: s.w || C.NODE_W, h: s.h || C.NODE_H};
    const parts = n.parts.map((p) => {
      const P = itemOf(p, key + "/" + p.id, depth + 1, opts);
      P.part = p.part || "tool";
      P.depth = depth + 1;
      P.folded = (opts.sizeOf(P.key, p) || {}).h || C.NODE_H;
      return P;
    });
    let y = 0, folded = 0;
    for (const P of parts) { P.py = y; y += P.h + C.PART_GAP; folded += P.folded + C.PART_GAP; }
    const colH = y - C.PART_GAP;
    const cardY = Math.max(0, (folded - C.PART_GAP - card.h) / 2);
    const colX = card.w + C.PART_X;
    const colW = Math.max(0, ...parts.map(P => P.w));
    return {id: n.id, key, node: n, kind: "agent", card, parts, cardY, colX,
            w: colX + colW, h: Math.max(colH, cardY + card.h), axis: card.w / 2};
  }

  // ── one level ──────────────────────────────────────────────────────
  function buildLevel(g, prefix, depth, opts, inner) {
    const N = [];
    const byId = new Map();
    (g.nodes || []).forEach((n, i) => {
      const L = itemOf(n, prefix + n.id, depth, opts);
      L.hint = typeof n.x === "number" ? n.x : i * 300;
      L.idx = i;
      L.depth = depth;
      N.push(L); byId.set(n.id, L);
    });
    const byName = new Map();
    for (const L of N) if (!byName.has(L.node.name)) byName.set(L.node.name, L);

    // loop zones: each loop's members, kept together in one clear box
    const zones = loopsOf(g).map(info => ({info,
      set: new Set(info.members.map(nm => byName.get(nm)).filter(Boolean))}))
      .filter(Z => Z.set.size);
    const inZone = (Z, x) => x.dummy
      ? !x.wire.tie && Z.set.has(x.wire.a) && Z.set.has(x.wire.b)
      : Z.set.has(x);

    let S = null, E = null;
    const term = (which) => {
      const knob = inner;
      const L = {id: `__${which}__`, kind: knob ? "knob" : "pill",
                 key: knob ? `${prefix}__${which}` : `__main/__${which}`,
                 node: {id: `__${which}__`, name: which.toUpperCase(), kind: "__boundary__",
                        boundary: which, ...(knob ? {knob: true} : {})},
                 w: knob ? C.KB : C.B_W, h: knob ? C.KB : C.B_H, hint: 0, idx: -1,
                 depth: knob ? depth : 0, term: which};
      return L;
    };
    const entries = (g.entries || []).map(nm => byName.get(nm)).filter(Boolean);
    const exits = (g.exits || []).map(nm => byName.get(nm)).filter(Boolean);
    if (inner) { S = term("start"); E = term("end"); }
    else {
      if (entries.length) S = term("start");
      if (exits.length) E = term("end");
    }

    // ── wires ──
    const meaning = (e) => (e.soft ? 0 : 2) + (e.type === "condition" ? 1 : 0) + (e.origin === "back_edge" || e.back ? 1 : 0);
    const W = [];
    const seen = new Map();
    const firstRow = (L, target) => (L.rows || []).find(r => r.target === target) || null;
    for (const e of g.edges || []) {
      const a = byId.get(e.src), b = byId.get(e.dst);
      if (!a || !b) continue;
      const k = `${a.key}→${b.key}|${e.id || ""}`;
      const prev = seen.get(k);
      if (prev) {
        if (meaning(e) > meaning(prev.e)) prev.e = e;
        continue;
      }
      const w = {k, a, b, e, tie: false};
      seen.set(k, w);
      W.push(w);
    }
    for (const w of W) {
      const {a, b, e} = w;
      // the row a decision card's wire leaves by (studio.js draws it there)
      const routes = a.kind === "card" ? a.node.routes : null;
      const routeOf = routes && e.route != null ? routes[e.route] : null;
      const condish = !!routeOf || (routes && e.type === "condition"
        && routes.some(r => r.target === b.node.name));
      const byRoute = routeOf ? (a.rows || []).find(r => r.route === e.route) : null;
      w.row = routes && (condish || e.origin === "back_edge" || e.back)
        ? byRoute || firstRow(a, b.node.name) : null;
      w.condish = !!condish;
    }
    const tie = (a, b) => {
      const w = {k: `${a.key}⇢${b.key}`, a, b, e: null, tie: true, row: null};
      if (b.term === "end" && a.kind === "card" && a.node.routes) w.row = firstRow(a, "__END__");
      W.push(w);
    };
    if (inner) {
      for (const L of N) if (L.node.start) tie(S, L);
      for (const L of N) if (L.node.end) tie(L, E);
    } else {
      if (S) for (const L of entries) tie(S, L);
      if (E) for (const L of exits) tie(L, E);
    }

    // ── layering ──
    const all = [...(S ? [S] : []), ...N, ...(E ? [E] : [])];
    const fwd = new Map(all.map(L => [L, []]));
    for (const w of W) {
      if (w.e && w.e.origin === "back_edge") continue;
      if (w.a === w.b) continue;
      if (!fwd.get(w.a).includes(w.b)) fwd.get(w.a).push(w.b);
    }
    // DFS back-edge detection (lookback edges the rewrite left alone)
    const cyc = new Set();
    {
      const colour = new Map(all.map(L => [L, 0]));
      for (const root of all) {
        if (colour.get(root)) continue;
        const stack = [[root, 0]];
        while (stack.length) {
          const top = stack[stack.length - 1];
          const [node, i] = top;
          if (i === 0) colour.set(node, 1);
          const nb = fwd.get(node);
          if (i < nb.length) {
            top[1]++;
            const nx = nb[i];
            if (colour.get(nx) === 1) cyc.add(node.key + "→" + nx.key);
            else if (colour.get(nx) === 0) stack.push([nx, 0]);
          } else { colour.set(node, 2); stack.pop(); }
        }
      }
    }
    const layer = new Map();
    {
      const indeg = new Map(all.map(L => [L, 0]));
      const acyc = new Map(all.map(L => [L, fwd.get(L).filter(b => !cyc.has(L.key + "→" + b.key))]));
      for (const [, bs] of acyc) for (const b of bs) indeg.set(b, indeg.get(b) + 1);
      for (const L of all) layer.set(L, L === S ? 0 : S ? 1 : 0);
      const queue = all.filter(L => indeg.get(L) === 0);
      for (let qi = 0; qi < queue.length; qi++) {
        const u = queue[qi];
        for (const b of acyc.get(u)) {
          if (layer.get(b) < layer.get(u) + 1) layer.set(b, layer.get(u) + 1);
          indeg.set(b, indeg.get(b) - 1);
          if (indeg.get(b) === 0) queue.push(b);
        }
      }
      if (E) {
        let mx = 0;
        for (const L of all) if (L !== E) mx = Math.max(mx, layer.get(L));
        layer.set(E, mx + 1);
      }
    }
    for (const w of W) {
      w.back = !w.tie && (w.e.origin === "back_edge" || cyc.has(w.a.key + "→" + w.b.key)
        || layer.get(w.b) <= layer.get(w.a));
    }

    // ── rows, dummies ──
    const nrows = Math.max(...all.map(L => layer.get(L))) + 1;
    const rows = Array.from({length: nrows}, () => []);
    for (const L of all) { L.layer = layer.get(L); rows[L.layer].push(L); }
    for (const r of rows) r.sort((p, q) => p.hint - q.hint || p.idx - q.idx);
    const up = new Map(), down = new Map();
    const link = (p, q) => {   // p in row r, q in row r+1
      if (!down.has(p)) down.set(p, []);
      if (!up.has(q)) up.set(q, []);
      if (!down.get(p).includes(q)) down.get(p).push(q);
      if (!up.get(q).includes(p)) up.get(q).push(p);
    };
    // a decision card's bottom exits: where on the card each route's wire
    // leaves (px from its centre, and as a fraction of its width), so its
    // targets are ordered, and hang, under their own exits
    const portPx = new Map(), portFr = new Map();
    const setPort = (p, q, row) => {
      if (!portPx.has(p)) { portPx.set(p, new Map()); portFr.set(p, new Map()); }
      if (portPx.get(p).has(q)) return;
      portPx.get(p).set(q, row.cx - p.w / 2);
      portFr.get(p).set(q, 0.9 * (row.cx / p.w - 0.5));
    };
    const pxOf = (p, q) => (portPx.has(p) && portPx.get(p).get(q)) || 0;
    const frOf = (p, q) => (portFr.has(p) && portFr.get(p).get(q)) || 0;
    const pinned = [];   // [dummy, anchor]
    let did = 0;
    const dummy = (r, wire, hint) => {
      const D = {id: `\0${did++}`, dummy: true, layer: r, wire, wl: C.DW, wr: C.DW, h: 0, w: 0, hint, idx: 1e6 + did};
      rows[r].push(D);
      return D;
    };
    for (const w of W) {
      const la = w.a.layer, lb = w.b.layer;
      w.lanes = [];
      if (!w.back) {
        let prev = w.a;
        for (let r = la + 1; r < lb; r++) {
          const t = (r - la) / (lb - la);
          const D = dummy(r, w, w.a.hint + (w.b.hint - w.a.hint) * t);
          w.lanes.push(D);
          if (prev === w.a && w.row && w.row.down) setPort(w.a, D, w.row);
          link(prev, D); prev = D;
        }
        if (prev === w.a && w.row && w.row.down) setPort(w.a, w.b, w.row);
        link(prev, w.b);
      } else if (la === lb) {
        const ds = dummy(la, w, w.a.hint), dd = dummy(la, w, w.b.hint);
        ds.pin = w.a; dd.pin = w.b;
        pinned.push(ds, dd);
        w.lanes.push(ds, dd);
      } else {
        const step = la < lb ? 1 : -1;
        let prev = null;
        for (let r = la; ; r += step) {
          const D = dummy(r, w, w.a.hint + 200);
          if (r === la) { D.pin = w.a; pinned.push(D); }
          if (r === lb) { D.pin = w.b; pinned.push(D); }
          if (prev) (step > 0 ? link(prev, D) : link(D, prev));
          w.lanes.push(D);
          prev = D;
          if (r === lb) break;
        }
      }
      if (w.back) {
        // the "↺ loop" label rides the lane in the middle row of its span
        const mid = w.lanes[Math.floor((w.lanes.length - 1) / 2)];
        mid.wr += C.LABEL_W;
        w.labelLane = mid;
      }
    }
    for (const r of rows) r.sort((p, q) => p.hint - q.hint || p.idx - q.idx);
    for (const Z of zones) {
      const ls = [...Z.set].map(L => L.layer);
      Z.lo = Math.min(...ls); Z.hi = Math.max(...ls);
    }
    // a loop's members (and its own lanes) sit side by side in every row
    // they span; everything else in those rows goes left or right of them
    const groupRow = (row, r) => {
      for (const Z of zones) {
        if (r < Z.lo || r > Z.hi) continue;
        const mine = [], at = [];
        row.forEach((x, i) => { if (inZone(Z, x)) { mine.push(x); at.push(i); } });
        if (!mine.length || mine.length === row.length) continue;
        const mean = at.reduce((s, i) => s + i, 0) / at.length;
        const left = row.filter((x, i) => !inZone(Z, x) && i < mean);
        const right = row.filter((x, i) => !inZone(Z, x) && i >= mean);
        row.splice(0, row.length, ...left, ...mine, ...right);
      }
    };

    // a loop lane sits right next to its card, so the return's stub
    // between card and lane crosses nothing
    const repin = (row) => {
      const mine = row.filter(x => x.pin);
      if (!mine.length) return;
      const rest = row.filter(x => !x.pin);
      for (const D of mine) {
        let at = rest.indexOf(D.pin) + 1;
        while (at < rest.length && rest[at].pin === D.pin) at++;
        rest.splice(at, 0, D);
      }
      row.splice(0, row.length, ...rest);
    };
    rows.forEach(repin);
    rows.forEach(groupRow);

    // ── ordering: barycentre sweeps, fewest crossings kept ──
    const crossings = () => {
      let total = 0;
      for (let r = 0; r + 1 < nrows; r++) {
        const pos = new Map(rows[r + 1].map((x, i) => [x, i]));
        const es = [];
        rows[r].forEach((u, i) => { for (const v of down.get(u) || []) if (pos.has(v)) es.push([i + frOf(u, v), pos.get(v)]); });
        for (let a = 0; a < es.length; a++) for (let b = a + 1; b < es.length; b++)
          if ((es[a][0] - es[b][0]) * (es[a][1] - es[b][1]) < 0) total++;
      }
      return total;
    };
    {
      let best = rows.map(r => [...r]), bestCount = crossings(), stale = 0;
      for (let sweep = 0; sweep < C.SWEEPS && bestCount > 0; sweep++) {
        const downward = sweep % 2 === 0;
        const order = [...rows.keys()];
        if (!downward) order.reverse();
        for (const r of order) {
          const ref = rows[downward ? r - 1 : r + 1];
          if (!ref) continue;
          const pos = new Map(ref.map((x, i) => [x, i]));
          const nb = downward ? up : down;
          const cur = new Map(rows[r].map((x, i) => [x, i]));
          const key = new Map(rows[r].map(x => {
            const ps = (nb.get(x) || []).filter(p => pos.has(p))
              .map(p => pos.get(p) + (downward ? frOf(p, x) : -frOf(x, p)));
            return [x, ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : cur.get(x)];
          }));
          rows[r].sort((p, q) => key.get(p) - key.get(q) || cur.get(p) - cur.get(q));
          repin(rows[r]);
          groupRow(rows[r], r);
        }
        const count = crossings();
        if (count < bestCount) { bestCount = count; stale = 0; best = rows.map(r => [...r]); }
        else if (++stale >= 2) break;
      }
      best.forEach((r, i) => { rows[i] = r; });
    }

    // ── extents ──
    const used = new Map();   // card → rows its wires leave by
    for (const w of W) if (w.row && !w.row.down) {
      if (!used.has(w.a)) used.set(w.a, new Set());
      used.get(w.a).add(w.row);
    }
    for (const L of all) {
      const u = used.has(L) ? used.get(L).size : 0;
      L.margin = u ? C.ROW_OUT + C.ROW_STEP * (u - 1) + 10 : 0;
      // an opened agent's axis is its card's centre: its parts are all right of it
      const ax = L.axis != null ? L.axis : L.w / 2;
      L.wl = ax + L.margin; L.wr = L.w - ax + L.margin;
    }
    const gap = (a, b) => (a.dummy && b.dummy ? C.GAP_DD : a.dummy || b.dummy ? C.GAP_DC : C.H_GAP);
    const sep = (a, b) => a.wr + gap(a, b) + b.wl;

    // ── x: centred seed, then children hang under parents ──
    const cx = new Map();
    {
      const rowW = (row) => row.reduce((s, x, i) => s + (i ? sep(row[i - 1], x) : 0), 0)
        + (row.length ? row[0].wl + row[row.length - 1].wr : 0);
      const span = Math.max(...rows.map(rowW));
      for (const row of rows) {
        let c = (span - rowW(row)) / 2 + (row.length ? row[0].wl : 0);
        row.forEach((x, i) => { if (i) c += sep(row[i - 1], x); cx.set(x, c); });
      }
    }
    const spread = (row, want) => {
      const cl = [];
      row.forEach((_, k) => {
        cl.push({m: [k], off: [0], first: want[k]});
        while (cl.length > 1) {
          const a = cl[cl.length - 2], b = cl[cl.length - 1];
          const need = sep(row[a.m[a.m.length - 1]], row[b.m[0]]);
          if (b.first - (a.first + a.off[a.off.length - 1]) >= need) break;
          const base = a.off[a.off.length - 1] + need;
          a.m.push(...b.m);
          a.off.push(...b.off.map(o => base + o));
          a.first = a.m.reduce((s, m, i) => s + want[m] - a.off[i], 0) / a.m.length;
          cl.pop();
        }
      });
      const out = new Array(row.length);
      for (const c of cl) c.m.forEach((m, i) => { out[m] = c.first + c.off[i]; });
      return out;
    };
    const align = (order, nb) => {
      for (const r of order) {
        const row = rows[r];
        const want = row.map(x => {
          const ps = (nb.get(x) || []).filter(p => cx.has(p));
          // under a bottom exit: under the exit, not the card's centre
          const at = (p) => cx.get(p) + (nb === up ? pxOf(p, x) : -pxOf(x, p));
          return ps.length ? ps.reduce((s, p) => s + at(p), 0) / ps.length : cx.get(x);
        });
        spread(row, want).forEach((v, i) => cx.set(row[i], v));
      }
    };
    const idx = [...rows.keys()];
    align(idx, up);
    align([...idx].reverse(), down);
    align(idx, up);

    // ── loop zones: the box, its header, and nothing else inside ──
    for (const Z of zones) {
      let zl = Infinity, zr = -Infinity, entry = Infinity;
      for (let r = Z.lo; r <= Z.hi; r++) for (const x of rows[r]) {
        if (!inZone(Z, x)) continue;
        zl = Math.min(zl, cx.get(x) - x.wl); zr = Math.max(zr, cx.get(x) + x.wr);
        if (r === Z.lo && !x.dummy) entry = Math.min(entry, cx.get(x));
      }
      zl -= C.ZPAD; zr += C.ZPAD;
      // the header sits top-left, clear of the wires that enter the loop's
      // first cards at their top centres: the zone widens to hold it
      const room = entry - 12 - (zl + C.ZHX);
      Z.lines = loopHeader(Z.info, room, opts.textWidth);
      const hw = Math.max(...Z.lines.map(t => (opts.textWidth || ((u) => u.length * 6.4))(t)));
      if (zl + C.ZHX + hw + 12 > entry) zl = entry - 12 - hw - C.ZHX;
      Z.l = zl; Z.r = zr;
      Z.band = Z.lines.length * C.ZLH + 2 * C.ZHY;
      const mid = (zl + zr) / 2;
      for (let r = Z.lo; r <= Z.hi; r++) {
        const row = rows[r];
        const m = row.map(x => inZone(Z, x));
        const first = m.indexOf(true), last = m.lastIndexOf(true);
        const lefts = [], rights = [];
        row.forEach((x, i) => {
          if (m[i]) return;
          if (first < 0 ? cx.get(x) < mid : i < first) lefts.push(i);
          else if (first < 0 || i > last) rights.push(i);
        });
        const gz = (x) => (x.dummy ? C.GAP_DD : C.ZOUT);
        for (let k = lefts.length - 1; k >= 0; k--) {
          const x = row[lefts[k]];
          const bound = k === lefts.length - 1 ? zl - gz(x) - x.wr
            : cx.get(row[lefts[k + 1]]) - sep(x, row[lefts[k + 1]]);
          if (cx.get(x) > bound) cx.set(x, bound);
        }
        for (let k = 0; k < rights.length; k++) {
          const x = row[rights[k]];
          const bound = k === 0 ? zr + gz(x) + x.wl
            : cx.get(row[rights[k - 1]]) + sep(row[rights[k - 1]], x);
          if (cx.get(x) < bound) cx.set(x, bound);
        }
      }
    }

    // knobs centre over what they hold
    const isContent = (x) => !x.term;
    {
      const content = [].concat(...rows).filter(isContent);
      if (inner && content.length) {
        const lo = Math.min(...content.map(x => cx.get(x) - x.wl));
        const hi = Math.max(...content.map(x => cx.get(x) + x.wr));
        cx.set(S, (lo + hi) / 2); cx.set(E, (lo + hi) / 2);
      }
    }
    {
      const everything = [].concat(...rows);
      const lo = Math.min(...everything.map(x => cx.get(x) - x.wl), ...zones.map(Z => Z.l));
      const shift = (inner ? 0 : C.MARGIN) - lo;
      for (const x of everything) cx.set(x, cx.get(x) + shift);
      for (const Z of zones) { Z.l += shift; Z.r += shift; }
    }
    const width = Math.max(...[].concat(...rows).map(x => cx.get(x) + x.wr), ...zones.map(Z => Z.r))
      + (inner ? 0 : C.MARGIN);

    // ── y: rows as tall as their tallest card, channels between ──
    const H = rows.map(row => Math.max(0, ...row.map(x => x.h || 0)));
    const through = new Array(nrows).fill(0);   // wires in the channel below row r
    for (const w of W) {
      const lo = Math.min(w.a.layer, w.b.layer), hi = Math.max(w.a.layer, w.b.layer);
      for (let r = lo; r < hi; r++) through[r]++;
      if (lo === hi && w.back && lo > 0) through[lo - 1]++;
    }
    const G = through.map(n => C.V_GAP + Math.min(120, Math.max(0, n - 8) * 4));
    // a loop zone's header band sits at the foot of the channel above it
    const band = new Array(nrows).fill(0);
    for (const Z of zones) band[Z.lo] = Math.max(band[Z.lo], Z.band);
    for (let r = 1; r < nrows; r++) G[r - 1] += band[r];
    const top = [];
    let y = band[0];
    for (let r = 0; r < nrows; r++) { top.push(y); y += H[r] + G[r]; }
    let oy = 0;
    if (!inner) oy = C.MARGIN - (S ? top[1] || 0 : 0);
    for (let r = 0; r < nrows; r++) top[r] += oy;
    const height = top[nrows - 1] + H[nrows - 1] + (inner ? 0 : C.MARGIN);

    for (const L of all) { L.cx = cx.get(L); L.y = top[L.layer]; }
    for (const row of rows) for (const x of row) if (x.dummy) x.cx = cx.get(x);

    return {N, S, E, W, rows, top, H, G, band, zones, prefix, w: width, h: inner ? top[nrows - 1] + H[nrows - 1] : height, inner};
  }

  // ── absolute placement and wire paths ─────────────────────────────
  function emit(lv, ox, oy, out) {
    const item = new Map();
    const place = (L) => {
      put(L, ox + L.cx - (L.axis != null ? L.axis : L.w / 2), oy + L.y);
    };
    const put = (L, x, y) => {
      let it;
      if (L.kind === "agent") {
        // the card is the node the flow's wires meet; each part is placed
        // as what it is, and remembered with the socket it hangs from
        it = {key: L.key, node: L.node, depth: L.depth, kind: "card", inner: null,
              x, y: y + L.cardY, w: L.card.w, h: L.card.h,
              block: {x, y, w: L.w, h: L.h}, parts: []};
        out.items.push(it);
        for (const P of L.parts) {
          const pi = put(P, x + L.colX, y + P.py);
          it.parts.push(pi);
          out.parts.push({agent: it, item: pi, part: P.part});
        }
      } else if (L.kind === "container") {
        it = {key: L.key, node: L.node, depth: L.depth, kind: "container", inner: true,
              x, y: y + C.KB / 2, w: L.w, h: L.h - C.KB, box: {x, y, w: L.w, h: L.h}};
        out.items.push(it);
        const sub = emit(L.sub, x + (L.w - L.sub.w) / 2, y, out);
        it.bIn = sub.get(L.sub.S); it.bOut = sub.get(L.sub.E);
      } else {
        it = {key: L.key, node: L.node, depth: L.depth, kind: L.kind, inner: null, x, y, w: L.w, h: L.h};
        if (L.kind === "pill") out.pills.push(it); else out.items.push(it);
      }
      item.set(L, it);
      return it;
    };
    if (lv.S) place(lv.S);
    for (const L of lv.N) place(L);
    if (lv.E) place(lv.E);

    // condition rows: the side each one's wire leaves by, and its lane.
    // A wire leaves toward where it goes NEXT: its first lane when it spans
    // several layers (that lane may sit on the other side from its target),
    // else its target. Leaving toward the target and then crossing back over
    // the card to reach the lane is the detour this avoids.
    const sideOf = new Map();
    const rowWire = new Map();
    for (const w of lv.W) if (w.row && !w.back) rowWire.set(w.row, w);
    for (const L of lv.N) {
      if (!L.rows || !L.rows.length) continue;
      const it = item.get(L);
      const mid = it.x + it.w / 2;
      const backTo = new Set(lv.W.filter(w => w.a === L && w.back).map(w => w.b.node.name));
      const sides = L.rows.map(r => {
        if (r.down) return 0;   // a bottom exit: straight down
        if (backTo.has(r.target)) return 1;
        const w = rowWire.get(r);
        const next = w && w.lanes.length ? w.lanes[0] : w ? w.b : lv.N.find(o => o.node.name === r.target && o !== L);
        if (next) return ox + next.cx < mid ? -1 : 1;
        return r.target === "__END__" ? -1 : 1;
      });
      L.rows.forEach((r, i) => sideOf.set(r, sides[i]));
      out.rowSides.set(L.key, L.rows.map((r, i) => ({row: r, side: sides[i]})));
    }
    const laneOf = new Map();
    {
      const rowsUsed = new Map();
      for (const w of lv.W) if (w.row && !w.back && !w.row.down) {
        if (!rowsUsed.has(w.a)) rowsUsed.set(w.a, []);
        if (!rowsUsed.get(w.a).includes(w.row)) rowsUsed.get(w.a).push(w.row);
      }
      for (const [, used] of rowsUsed) {
        for (const side of [-1, 1]) {
          const mine = used.filter(r => sideOf.get(r) === side).sort((p, q) => p.top - q.top);
          // upper rows take the outer lanes: no row's run crosses another's
          mine.forEach((r, i) => laneOf.set(r, mine.length - 1 - i));
        }
      }
    }

    // loop zones, absolute; every member item knows its zone
    const zoneOf = new Map();
    for (const Z of lv.zones) {
      const y0 = oy + lv.top[Z.lo] - Z.band;
      const z = {group: Z.info.group, info: Z.info, lines: Z.lines,
                 key: lv.prefix + Z.info.group,
                 x: ox + Z.l, y: y0, w: Z.r - Z.l,
                 h: oy + lv.top[Z.hi] + lv.H[Z.hi] + C.ZPAD_B - y0,
                 head: {x: ox + Z.l + C.ZHX, y: y0 + C.ZHY, lh: C.ZLH},
                 members: [...Z.set].map(L => L.key)};
      out.zones.push(z);
      for (const L of Z.set) { zoneOf.set(L, z); item.get(L).zone = z; }
    }
    const T = (r) => oy + lv.top[r];
    // into a row under a zone's header: curve above the band, then straight down
    const down = (p, x, r, y) => {
      const b = lv.band[r] || 0;
      if (b) { p.to(x, y - b); p.v(y); } else p.to(x, y);
    };
    const B = (r) => oy + lv.top[r] + lv.H[r];
    const X = (D) => ox + D.cx;
    const portOut = (L) => { const it = item.get(L); return it.bOut || it; };
    const portIn = (L) => { const it = item.get(L); return it.bIn || it; };

    for (const w of lv.W) {
      const A = portOut(w.a), Bt = w.back ? portIn(w.b) : portIn(w.b);
      let p;
      const fromRow = w.row && !(item.get(w.a).bOut);
      const dot = !fromRow ? null : w.row.down ? {x: A.x + w.row.cx, y: A.y + A.h} : {
        x: A.x + (sideOf.get(w.row) < 0 ? w.row.left - 1 : w.row.left + w.row.w + 1),
        y: A.y + w.row.top + w.row.h / 2,
      };
      let label = null;
      if (!w.back) {
        const la = w.a.layer, lb = w.b.layer;
        if (dot && w.row.down) {
          p = new Path(dot.x, dot.y);
        } else if (dot) {
          const side = sideOf.get(w.row);
          const lx = side < 0 ? A.x - C.ROW_OUT - C.ROW_STEP * laneOf.get(w.row)
            : A.x + A.w + C.ROW_OUT + C.ROW_STEP * laneOf.get(w.row);
          p = new Path(dot.x, dot.y);
          p.turnInto(lx, 1, Math.max(1, Math.min(12, B(la) - dot.y)));
        } else {
          p = new Path(A.x + A.w / 2, A.y + A.h);
        }
        p.v(B(la));
        for (const D of w.lanes) { down(p, X(D), D.layer, T(D.layer)); p.v(B(D.layer)); }
        // an opened agent's card may sit below its row's top: the turn is
        // made in the channel, then the wire drops straight onto the card
        if (Bt.y > T(lb) + 0.5) { down(p, Bt.x + Bt.w / 2, lb, T(lb)); p.v(Bt.y); }
        else down(p, Bt.x + Bt.w / 2, lb, Bt.y);
      } else {
        const la = w.a.layer, lb = w.b.layer;
        const x1 = dot ? dot.x : A.x + A.w, y1 = dot ? dot.y : A.y + A.h / 2;
        const x2 = Bt.x + Bt.w, y2 = Bt.y + Bt.h / 2;
        // an opened agent's right side is its parts column: a return leaves
        // its card by the bottom and comes into one over the top, turning in
        // the channel next to the row
        const fromAg = !dot && !!A.block, toAg = !!Bt.block;
        const ax = A.x + A.w / 2, bx = Bt.x + Bt.w / 2;
        const hop = (r) => Math.min(lv.G[r] || C.V_GAP, C.V_GAP) * 0.6;
        const lanes = w.lanes;
        if (fromAg) {
          p = new Path(ax, A.y + A.h);
          p.v(B(la));
        } else p = new Path(x1, y1);
        // out of a bottom exit: drop clear of the card before turning
        if (dot && w.row.down) p.v(y1 + 10);
        // from the agent's foot, round under it into the lane, heading up
        const underInto = (lx) => {
          const h = hop(la);
          p.c(ax, B(la) + h, lx, B(la) + h, lx, B(la));
        };
        // from the lane at the top of row r, round over into the agent's top
        const overInto = (r) => {
          const h = Math.min(lv.G[r - 1] || C.V_GAP, C.V_GAP) * 0.6;
          p.c(p.x, T(r) - h, bx, T(r) - h, bx, T(r));
          p.v(Bt.y);
        };
        if (la === lb) {
          const [ds, dd] = lanes;
          if (fromAg) underInto(X(ds));
          else p.turnInto(X(ds), -1, Math.max(1, Math.min(12, y1 - T(la))));
          p.v(T(la));
          if (toAg) overInto(la);
          else {
            const h = Math.min(lv.G[la - 1] || C.V_GAP, C.V_GAP) * 0.6;
            p.c(X(ds), T(la) - h, X(dd), T(la) - h, X(dd), T(la));
            p.v(y2 - Math.max(1, Math.min(12, y2 - T(la))));
            p.turnOut(x2, y2);
          }
        } else if (la > lb) {
          if (fromAg) underInto(X(lanes[0]));
          else p.turnInto(X(lanes[0]), -1, Math.max(1, Math.min(12, y1 - T(la))));
          p.v(T(la));
          for (let i = 1; i < lanes.length; i++) {
            const D = lanes[i];
            p.to(X(D), B(D.layer));
            if (i < lanes.length - 1) p.v(T(D.layer));
          }
          if (toAg) { p.v(T(lb)); overInto(lb); }
          else {
            p.v(y2 + Math.max(1, Math.min(12, B(lb) - y2)));
            p.turnOut(x2, y2);
          }
        } else {
          if (!fromAg) {
            p.turnInto(X(lanes[0]), 1, Math.max(1, Math.min(12, B(la) - y1)));
            p.v(B(la));
          }
          const last = toAg ? lanes.length - 1 : lanes.length;
          for (let i = 1; i < last; i++) {
            const D = lanes[i];
            p.to(X(D), T(D.layer));
            if (i < lanes.length - 1) p.v(B(D.layer));
          }
          if (toAg) { p.to(bx, T(lb)); p.v(Bt.y); }
          else {
            p.v(y2 - Math.max(1, Math.min(12, y2 - T(lb))));
            p.turnOut(x2, y2);
          }
        }
        const LL = w.labelLane;
        label = {x: X(LL) + 18, y: (T(LL.layer) + B(LL.layer)) / 2};
        if (LL.layer === la) label.y = Math.min(label.y, y1 - 14);
      }
      // a route out of a loop: from a member, to what is not one
      const za = zoneOf.get(w.a);
      let exit = null;
      if (za && zoneOf.get(w.b) !== za && !w.back && w.a.node.routes) {
        const tname = w.b.term === "end" ? "__END__" : w.b.node.name;
        const ri = w.e && w.e.route != null ? w.e.route : null;
        if (w.a.node.routes.some((r, i) => r.target === tname && (ri == null || ri === i))) exit = za;
      }
      out.wires.push({
        key: w.k, a: item.get(w.a), b: item.get(w.b), e: w.e, tie: w.tie, back: w.back,
        fromRow: !!dot, row: w.row, d: p.d, pts: p.pts, label, exit,
      });
    }
    return item;
  }

  /* graph: an IR graph; opts.expanded: Set of opened container keys;
   * opts.sizeOf(key, node) → {w, h, rows: [{target, route, left, top, w, h}]};
   * a row with `down` (and `cx`, its exit's x on the card) leaves by the
   * card's bottom edge instead of its side, and its target hangs under it.
   * Returns absolute items (cards, containers, knobs), the main flow's
   * pills, every wire with its path, and each decision card's row sides. */
  function layout(graph, opts) {
    // opts.spacing: wider gaps for one layout (the data views need room
    // for their wires between cards); the defaults come back after
    const keep = {H_GAP: C.H_GAP, V_GAP: C.V_GAP};
    if (opts.spacing) Object.assign(C, opts.spacing);
    try {
      const lv = buildLevel(graph, "", 0, opts, false);
      const out = {items: [], pills: [], wires: [], zones: [], parts: [], rowSides: new Map(), w: lv.w, h: lv.h};
      emit(lv, 0, 0, out);
      out.start = out.pills.find(p => p.node.boundary === "start") || null;
      out.end = out.pills.find(p => p.node.boundary === "end") || null;
      return out;
    } finally { Object.assign(C, keep); }
  }

  const api = {layout, loopsOf, loopHeader, exitText, C};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.FlowLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
