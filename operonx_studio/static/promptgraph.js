/* The Prompts page's graph (Operon docs/PROMPT_OBJECTS_PLAN.md O2): each prompt
 * object is a box (a text, or a composite of links), each link a plain wire —
 * a use has no label, a pick carries its case, a when its variable.
 *
 * layout() has no DOM: tests/js/promptgraph.test.mjs runs it in node. draw()
 * builds the SVG and runs only in the page. */
const PromptGraph = (() => {
  const W = 196, H = 46, GX = 200, GY = 14, PAD = 8, STUB = 104;

  /* cards: [{name, kind, links: [{how, var, case, name}]}] as /api/p/<pid>/prompts
   * lists them. focus: a name — that object, what it links (all the way down)
   * and what links it (one level up) — or "" for every object. Returns boxes in
   * columns by depth (a link goes left to right) and one wire per linked pair. */
  function layout(cards, focus) {
    const by = new Map(cards.map(c => [c.name, c]));
    const pairs = new Map();          // "from\0to" → wire; two cases to one object are one wire
    for (const c of cards) {
      for (const l of c.links || []) {
        if (!l.name || !by.has(l.name) || l.name === c.name) continue;
        const key = `${c.name}\0${l.name}`;
        // on the wire: a pick's case, a when's variable; the whole of it is the wire's tooltip
        const label = l.how === "pick" ? String(l.case) : l.how === "when" ? `if ${l.var}` : "";
        const full = l.how === "pick" ? `pick ${l.var} = ${l.case}` : l.how === "when" ? `when ${l.var} is true` : "use";
        const got = pairs.get(key);
        if (got) {
          if (label && !got.labels.includes(label)) got.labels.push(label);
          if (!got.full.includes(full)) got.full.push(full);
        } else pairs.set(key, {from: c.name, to: l.name, how: l.how, labels: label ? [label] : [], full: [full]});
      }
    }
    const kids = new Map(), parents = new Map();
    for (const e of pairs.values()) {
      (kids.get(e.from) || kids.set(e.from, []).get(e.from)).push(e.to);
      (parents.get(e.to) || parents.set(e.to, []).get(e.to)).push(e.from);
    }
    let keep;
    if (focus && by.has(focus)) {
      keep = new Set([focus]);
      const down = [focus];
      while (down.length) for (const k of kids.get(down.pop()) || []) if (!keep.has(k)) { keep.add(k); down.push(k); }
      for (const p of parents.get(focus) || []) keep.add(p);
    } else keep = new Set(by.keys());
    const edges = [...pairs.values()].filter(e => keep.has(e.from) && keep.has(e.to));
    const ins = new Map();
    for (const e of edges) (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e.from);

    // a box's column: the longest chain of links into it (composites cannot link in a circle)
    const depth = new Map();
    const col = (n, seen = new Set()) => {
      if (depth.has(n)) return depth.get(n);
      if (seen.has(n)) return 0;
      seen.add(n);
      const d = Math.max(0, ...(ins.get(n) || []).map(p => col(p, seen) + 1));
      depth.set(n, d);
      return d;
    };
    const names = [...keep].sort();
    names.forEach(n => col(n));
    const columns = [];
    for (const n of names) (columns[depth.get(n)] ||= []).push(n);
    // each column ordered by where its parents sit, so wires cross as little as one pass can make them
    const row = new Map();
    columns.forEach((names, i) => {
      if (i) {
        const at = (n) => { const ps = ins.get(n) || []; return ps.length ? ps.reduce((s, p) => s + row.get(p), 0) / ps.length : 1e9; };
        names.sort((a, b) => at(a) - at(b) || (a < b ? -1 : 1));
      }
      names.forEach((n, j) => row.set(n, j));
    });
    const tallest = Math.max(1, ...columns.map(c => c.length));
    const height = tallest * (H + GY) - GY;
    const nodes = [], place = new Map();
    columns.forEach((names, i) => {
      const top = PAD + (height - (names.length * (H + GY) - GY)) / 2;
      names.forEach((n, j) => {
        const c = by.get(n);
        const box = {name: n, kind: c.kind || "text", x: PAD + i * (W + GX), y: top + j * (H + GY), w: W, h: H,
                     focus: n === focus, error: !!c.error};
        nodes.push(box);
        place.set(n, box);
      });
    });
    const wires = edges.map(e => {
      const a = place.get(e.from), b = place.get(e.to);
      return {from: e.from, to: e.to, how: e.how, label: e.labels.join(", "), title: `${e.from} → ${e.to}: ${e.full.join("; ")}`,
              x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: b.y + b.h / 2};
    });
    return {nodes, edges: wires, w: PAD * 2 + Math.max(1, columns.length) * (W + GX) - GX, h: PAD * 2 + height};
  }

  /* Who links *name*: [{name, how, labels}] — the composites that use, pick or when it. */
  function linkedBy(cards, name) {
    const out = [];
    for (const c of cards) {
      const ls = (c.links || []).filter(l => l.name === name);
      if (ls.length) out.push({name: c.name, how: ls.map(l => (l.how === "pick" ? `pick ${l.var} = ${l.case}` : l.how === "when" ? `when ${l.var}` : "use")).join(", ")});
    }
    return out;
  }

  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  /* The SVG for a layout; a click on a box calls open(name). */
  function draw(m, open) {
    const NS = "http://www.w3.org/2000/svg";
    const mk = (tag, attrs, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
      if (text != null) e.textContent = text;
      return e;
    };
    const svg = mk("svg", {class: "pgraph", width: m.w, height: m.h, viewBox: `0 0 ${m.w} ${m.h}`, role: "img",
                           "aria-label": "Prompt objects and the links between them"});
    const wires = mk("g", {class: "pgwires"});
    for (const e of m.edges) {
      // a straight stub into the box it reaches: its label sits there, where no other wire runs
      const xm = e.x2 - Math.min(STUB, (e.x2 - e.x1) / 2), dx = Math.max(24, (xm - e.x1) / 2);
      const w = mk("path", {class: `pgwire ${e.how}`, d: `M${e.x1},${e.y1} C${e.x1 + dx},${e.y1} ${xm - dx},${e.y2} ${xm},${e.y2} L${e.x2},${e.y2}`});
      w.append(mk("title", null, e.title));
      wires.append(w);
    }
    svg.append(wires);
    const labels = mk("g", {class: "pglabels"});
    for (const e of m.edges) {
      if (!e.label) continue;
      // on the stub, beside the box the wire reaches: two wires into one box are one wire
      const t = mk("text", {x: e.x2 - 8, y: e.y2 - 6, "text-anchor": "end"}, short(e.label, 16));
      t.append(mk("title", null, e.title));
      labels.append(t);
    }
    for (const n of m.nodes) {
      const g = mk("g", {class: `pgnode ${n.kind === "text" ? "text" : "composite"}${n.focus ? " focus" : ""}${n.error ? " bad" : ""}`,
                         transform: `translate(${n.x},${n.y})`, tabindex: "0", role: "button"});
      g.append(mk("title", null, `${n.name} — ${n.kind === "text" ? "text" : n.kind + " composite"}: open it`));
      g.append(mk("rect", {width: n.w, height: n.h, rx: 8}));
      g.append(mk("text", {class: "pgname", x: 12, y: 19}, short(n.name, 25)));
      g.append(mk("text", {class: "pgkind", x: 12, y: 35}, n.error ? "cannot be read" : n.kind === "text" ? "text" : `${n.kind} · composite`));
      g.addEventListener("click", () => open(n.name));
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(n.name); } });
      svg.append(g);
    }
    svg.append(labels);
    return svg;
  }

  return {layout, linkedBy, draw};
})();
if (typeof module !== "undefined") module.exports = PromptGraph;
