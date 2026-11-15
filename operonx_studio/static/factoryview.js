/* operonx studio — the Factory picture: a project's architecture on one screen.
 *
 * Four columns, the way work moves through a project (docs/SPATIAL_FACTORY_PLAN.md):
 *   doors → flows → shared blocks → resources
 * Every card is an entity of the factory model (factorymodel.js) and every line one of its links;
 * links between the same two cards are one line, thicker the more there are. A project too large
 * to list flow by flow is listed by domain, and many resources by kind; a group opens in place.
 * Pointing at a card shows what leads to it and what it leads to; a click keeps that. Cards wear
 * the flow canvas's own glass. */

window.FactoryView = (() => {
  const BIG = 30;                      // more flows than this: one row per domain
  const MANY = 12;                     // more resources in use than this: one card per kind
  const DENSE = 60;                    // more lines than this: they rest faint, and light on a card
  const DOOR = {http: ["globe", "http"], websocket: ["pulse", "websocket"], asgi: ["server", "asgi"], scheduled: ["clock", "scheduled"],
    schedule: ["clock", "schedule"], job: ["box", "job"], eval: ["evals", "eval"]};
  const SVG = "http://www.w3.org/2000/svg";
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = (name) => (window.Icons ? Icons.svg(name, "kglyph") : h("span"));
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;
  const count = (n) => (n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

  function mount(host, ir, stats, opts = {}) {
    const model = FactoryModel.build(ir, stats);
    const grouped = model.flows.length > BIG;
    const open = new Set();            // opened groups: a domain "d:…", a resource kind "k:…"
    let locked = null, hot = null, moreRes = false;
    const root = h("div", "fv");
    host.append(root);

    /* a card: the canvas's glass cell — the kind's band and icon, a name, a line of what it holds */
    function card(id, kind, ico, name, sub, cls) {
      const c = h("div", `fv-card ${cls || ""}`); c.dataset.id = id; c.style.setProperty("--kind", `var(--k-${kind})`);
      const band = h("span", "fv-band"); band.append(icon(ico));
      const body = h("span", "fv-body"); body.append(h("span", "fv-name", name));
      if (sub) body.append(typeof sub === "string" ? h("span", "fv-sub", sub) : sub);
      c.append(band, body); c.title = name;
      return c;
    }
    const sub = (...parts) => { const s = h("span", "fv-sub"); parts.filter(Boolean).forEach((p, i) => { if (i) s.append(" · "); s.append(p); }); return s; };
    const errs = (n) => { if (!n) return null; const e = h("span", "fv-err", count(n)); e.title = `${plural(n, "error")} in the last 7 days`; return e; };
    const twist = (c) => { const t = h("span", "fv-twist"); t.append(icon("chevron")); c.append(t); return c; };
    const chip = (cls, ico, bold, rest, title) => { const c = h("span", `fv-chip ${cls}`); c.append(icon(ico), h("b", null, bold), rest || ""); c.title = title; return c; };

    /* the ways into one row. A flow's: by kind with a count, or by name when there are one or two.
     * A domain's (coarse): its services and its jobs, two numbers. */
    function doorChips(ids, coarse) {
      const box = h("div", "fv-doors");
      let doors = ids.map(i => model.by.get(i)).filter(d => d && (d.type === "service" || d.type === "job"));
      if (!doors.length) return box;
      if (coarse) {
        for (const [type, ico, word] of [["service", "globe", "service"], ["job", "box", "job"]]) {
          const list = doors.filter(d => d.type === type); if (!list.length) continue;
          const kinds = new Map(); for (const d of list) kinds.set(d.kind, (kinds.get(d.kind) || 0) + 1);
          box.append(chip(type, ico, count(list.length), ` ${list.length === 1 ? word : word + "s"}`, [...kinds].map(([k, n]) => `${n} ${k}`).join(", ")));
        }
        return box;
      }
      // a schedule and the job it runs are one way in: one chip, "scheduled"
      const here = new Set(doors.map(d => d.id)), timed = new Map();
      for (const d of doors) if (d.type === "service" && d.job && here.has(d.job)) timed.set(d.job, d);
      doors = doors.filter(d => !(d.type === "service" && d.job && here.has(d.job)));
      const kinds = new Map();
      for (const d of doors) { const k = timed.has(d.id) ? "scheduled" : d.kind in DOOR ? d.kind : d.type === "job" ? "job" : "http"; if (!kinds.has(k)) kinds.set(k, []); kinds.get(k).push(d); }
      for (const k of Object.keys(DOOR)) {
        const list = kinds.get(k); if (!list) continue;
        const one = doors.length <= 2 && list.length === 1 ? list[0] : null;
        box.append(chip(list[0].type, DOOR[k][0], one ? (one.type === "service" && one.path && one.path !== "/" ? one.path : one.name) : String(list.length), one ? "" : ` ${DOOR[k][1]}`,
          list.map(d => (timed.has(d.id) ? `${timed.get(d.id).name} → ${d.name}` : `${d.name}${d.path ? "  " + d.path : ""}`)).join("\n")));
      }
      return box;
    }

    function render() {
      root.textContent = "";
      const groups = new Map();        // a group card's id → the entities it stands for
      const groupOf = new Map();       // an entity → the group card that can stand for it
      const group = (id, members) => { groups.set(id, members); for (const m of members) groupOf.set(m, id); };

      const heads = h("div", "fv-heads");
      for (const [t, n] of [
        ["Doors", `${plural(model.counts.services, "service")} · ${plural(model.counts.jobs, "job")}`],
        ["Flows", grouped ? `${plural(model.counts.flows, "flow")} in ${plural(model.counts.domains, "domain")}` : plural(model.counts.flows, "flow")],
        ["Shared blocks", model.counts.sharedBlocks ? `${model.counts.sharedBlocks} used by more than one flow` : "none"],
        ["Resources", plural(model.counts.resources, "resource")]]) {
        const c = h("div", "fv-head"); c.append(h("b", null, t), h("span", null, n)); heads.append(c);
      }
      const stage = h("div", "fv-stage"), wires = document.createElementNS(SVG, "svg");
      wires.setAttribute("class", "fv-wires");
      const main = h("div", "fv-main"), colB = h("div", "fv-col"), colR = h("div", "fv-col");
      stage.append(wires, main, colB, colR); root.append(heads, stage);
      const toggle = (c, id) => c.addEventListener("click", (ev) => { ev.stopPropagation(); if (open.has(id)) open.delete(id); else open.add(id); locked = null; render(); });

      // ── doors and flows: one row each; flows that share a block sit together, then those that name a resource ──
      const firstBlock = (f) => { const i = model.blocks.findIndex(b => b.shared && b.flows.includes(f.id)); return i < 0 ? 1e9 : i; };
      const needs = (f) => (model.outOf(f.id).some(l => l.kind === "needs") ? 0 : 1);
      const doorsOf = (fid) => model.upstream(fid).filter(i => /^[sj]:/.test(i));
      const order = (fs) => fs.slice().sort((a, b) => firstBlock(a) - firstBlock(b) || needs(a) - needs(b) || doorsOf(b.id).length - doorsOf(a.id).length || (a.name < b.name ? -1 : 1));
      const row = (chips, c, cls) => { const r = h("div", `fv-row ${cls || ""}`); r.append(chips, c); main.append(r); return r; };
      const flowCard = (f) => card(f.id, "graph", "graph", f.name, sub(plural(f.steps || f.ops, "op"), f.runs ? `${count(f.runs)} runs` : "", errs(f.errors)), "flow");
      if (!grouped) for (const f of order(model.flows)) row(doorChips(doorsOf(f.id)), flowCard(f));
      else for (const d of model.domains) {
        const fs = d.flows.map(i => model.by.get(i)), isOpen = open.has(d.id);
        group(d.id, d.flows);
        const c = twist(card(d.id, "agraph", "folder", d.name || "(no module)", sub(plural(fs.length, "flow"), errs(sum(fs, f => f.errors))), `domain group ${isOpen ? "open" : ""}`));
        toggle(c, d.id);
        row(doorChips([...new Set(fs.flatMap(f => doorsOf(f.id)))], true), c);
        if (isOpen) for (const f of order(fs)) row(doorChips(doorsOf(f.id)), flowCard(f), "inner");
      }
      // doors that ask for a graph the project does not list, by the name they ask for
      const asked = new Map();
      for (const d of model.unresolved) { if (!asked.has(d.asks)) asked.set(d.asks, []); asked.get(d.asks).push(d.id); }
      for (const [name, ids] of asked) row(doorChips([...ids, ...ids.flatMap(i => model.into(i).map(l => l.src))], ids.length > 40),
        card(`?:${name}`, "default", "alert", name, "not among this project's graphs", "ghost"), "ghostrow");
      const loose = model.doors.filter(d => !d.flow && !d.job && !d.asks && !(d.type === "job" && model.into(d.id).length));
      if (loose.length) { const r = row(doorChips(loose.map(d => d.id), loose.length > 4), h("span", "fv-note", "no flow of its own"), "looserow"); r.title = "These serve the application itself."; }

      // ── shared blocks ──
      const blocks = model.blocks.filter(b => b.shared);
      for (const b of blocks) colB.append(card(b.id, b.kind === "op" ? "func" : b.kind === "agent" ? "agraph" : "graph", b.kind === "op" ? "code2" : "graphop", b.name,
        sub(b.kind === "op" ? (b.opKind || "op").replace(/Op$/, "") : plural(b.ops, "op"), `${count(b.uses.length)} uses`, plural(b.flows.length, "flow")), "block"));
      const inner = model.blocks.length - blocks.length;
      if (inner) colB.append(h("div", "fv-note", `${plural(inner, "more block")} repeat inside one flow`));
      if (!blocks.length && !inner) colB.append(h("div", "fv-note", "No flow shares a part with another."));

      // ── resources: each one, or one card per kind when there are many ──
      const used = model.resources.filter(r => r.flows.length), idle = model.resources.filter(r => !r.flows.length);
      const resCard = (r, cls) => card(r.id, r.kind === "llm" ? "llm" : "res", r.kind === "llm" ? "spark" : "database", r.name,
        r.kind === r.name ? "" : r.kind, `resource ${cls || ""}`);
      if (used.length <= MANY) for (const r of used) colR.append(resCard(r));
      else {
        const kinds = new Map(); for (const r of used) { if (!kinds.has(r.kind)) kinds.set(r.kind, []); kinds.get(r.kind).push(r); }
        const flowsOf = (rs) => new Set(rs.flatMap(r => r.flows)).size;
        for (const [kind, rs] of [...kinds].sort((a, b) => flowsOf(b[1]) - flowsOf(a[1]))) {
          if (rs.length === 1) { colR.append(resCard(rs[0])); continue; }
          const id = `k:${kind}`, isOpen = open.has(id); group(id, rs.map(r => r.id));
          const c = twist(card(id, kind === "llm" ? "llm" : "res", kind === "llm" ? "spark" : "database", kind, `×${rs.length}`, `resource group ${isOpen ? "open" : ""}`));
          toggle(c, id);
          const box = h("div", "fv-group"); box.append(c);
          if (isOpen) for (const r of rs) box.append(resCard(r, "inner"));
          colR.append(box);
        }
      }
      if (idle.length) { const m = h("button", "fv-more", moreRes ? "Hide the ones no flow names" : `${idle.length} more, named by no flow`);
        m.onclick = (ev) => { ev.stopPropagation(); moreRes = !moreRes; render(); }; colR.append(m); }
      if (moreRes) for (const r of idle) colR.append(resCard(r, "idle"));

      // ── which card stands for an entity right now: itself, or its group while that is closed ──
      const boxOf = (id) => { const e = model.by.get(id); if (!e) return null;
        if (e.type === "block" && !e.shared) return null;
        if (e.type !== "flow" && e.type !== "block" && e.type !== "resource") return null;
        const g = groupOf.get(id); return g && !open.has(g) ? g : id; };
      const cards = new Map([...root.querySelectorAll(".fv-card")].map(c => [c.dataset.id, c]));
      const pairs = FactoryModel.pairs(model, boxOf).filter(p => cards.has(p.src) && cards.has(p.dst));
      const dense = pairs.length > DENSE;
      root.style.setProperty("--fv-rest", dense ? Math.max(0.07, Math.min(0.5, 18 / pairs.length)).toFixed(2) : "0.5");

      // a dependency sits level with the rows that use it; then the column is spread so nothing overlaps
      const top0 = stage.getBoundingClientRect().top;
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top - top0 + r.height / 2; };
      const into = new Map(); for (const p of pairs) { if (!into.has(p.dst)) into.set(p.dst, []); into.get(p.dst).push(mid(cards.get(p.src))); }
      const settle = (col) => {
        const items = [...col.children].map(el => {
          const ys = (el.dataset.id ? [el.dataset.id] : [...el.querySelectorAll(".fv-card")].map(c => c.dataset.id)).flatMap(i => into.get(i) || []);
          return {el, hgt: el.offsetHeight, want: ys.length ? sum(ys, y => y) / ys.length - el.offsetHeight / 2 : null}; });
        const linked = items.filter(i => i.want != null).sort((a, b) => a.want - b.want);
        let y = 0; for (const it of linked) { it.y = Math.max(y, it.want); y = it.y + it.hgt + 12; }
        // cards pushed down drag the stack low: slide it back by the average miss, never above the top
        const shift = linked.length ? Math.min(sum(linked, it => it.y - it.want) / linked.length, linked[0].y) : 0;
        for (const it of linked) { it.y -= shift; it.el.style.top = `${Math.round(it.y)}px`; }
        y = linked.length ? linked[linked.length - 1].y + linked[linked.length - 1].hgt + 14 : 0;
        for (const it of items.filter(i => i.want == null)) { it.el.style.top = `${Math.round(y)}px`; y += it.hgt + 10; }
        col.style.height = `${Math.round(y)}px`; };
      settle(colB); settle(colR);

      // ── lines: one per pair of cards on screen, and one from each row's doors to its card ──
      const draw = () => {
        wires.textContent = "";
        const o = stage.getBoundingClientRect();
        wires.setAttribute("width", stage.scrollWidth); wires.setAttribute("height", stage.scrollHeight);
        const at = (el, side) => { const r = el.getBoundingClientRect(); return [side === "l" ? r.left - o.left : r.right - o.left, r.top - o.top + r.height / 2]; };
        const line = (a, b, cls, n, src, dst) => {
          const dx = Math.max(40, (b[0] - a[0]) * 0.5), p = document.createElementNS(SVG, "path");
          p.setAttribute("d", `M${a[0]} ${a[1]} C${a[0] + dx} ${a[1]} ${b[0] - dx} ${b[1]} ${b[0]} ${b[1]}`);
          p.setAttribute("class", `fv-wire ${cls}`); p.style.strokeWidth = (1.2 + (dense ? Math.min(1.4, Math.log2(n) * 0.22) : Math.min(3, Math.log2(n) * 0.7))).toFixed(1);
          p.dataset.src = src; p.dataset.dst = dst; wires.append(p);
          if (n > 1) { const t = document.createElementNS(SVG, "text"); t.setAttribute("x", (a[0] + b[0]) / 2); t.setAttribute("y", (a[1] + b[1]) / 2 + 3.5); t.setAttribute("class", `fv-count ${cls}`);
            t.dataset.src = src; t.dataset.dst = dst; t.textContent = `×${count(n)}`; wires.append(t); }
        };
        for (const p of pairs) line(at(cards.get(p.src), "r"), at(cards.get(p.dst), "l"), p.kind, p.count, p.src, p.dst);
        for (const r of main.querySelectorAll(".fv-row")) { const d = r.querySelector(".fv-doors"), c = r.querySelector(".fv-card");
          if (d && c && d.lastElementChild) line(at(d.lastElementChild, "r"), at(c, "l"), "door", 1, `row:${c.dataset.id}`, c.dataset.id); }
        light();
      };

      // ── what is lit: the pointed-at or kept card, with everything that leads to it and from it ──
      const light = () => {
        const id = hot || locked;
        let on = null;
        if (id && cards.has(id)) {
          on = new Set([id]);
          for (const m of groups.get(id) || [id]) for (const x of [m, ...model.upstream(m), ...model.downstream(m)]) { const b = boxOf(x); if (b) on.add(b); }
        }
        root.classList.toggle("fv-focus", !!on);
        for (const [cid, c] of cards) { c.classList.toggle("on", !!on && on.has(cid)); c.classList.toggle("kept", cid === locked); }
        for (const r of main.querySelectorAll(".fv-row")) { const c = r.querySelector(".fv-card"); r.classList.toggle("on", !!on && !!c && on.has(c.dataset.id)); }
        for (const w of wires.children) { const s = w.dataset.src, d = w.dataset.dst; w.classList.toggle("on", !!on && on.has(d) && (s.startsWith("row:") || on.has(s))); }
      };
      for (const [cid, c] of cards) {
        c.addEventListener("mouseenter", () => { hot = cid; light(); });
        c.addEventListener("mouseleave", () => { hot = null; light(); });
        if (c.classList.contains("group")) continue;
        c.addEventListener("click", (ev) => { ev.stopPropagation(); locked = locked === cid ? null : cid; light(); if (opts.onSelect) opts.onSelect(locked ? model.by.get(locked) : null, model); });
        if (c.classList.contains("flow") && opts.onOpen) c.addEventListener("dblclick", () => opts.onOpen(model.by.get(cid)));
      }
      root.onclick = () => { locked = null; light(); };
      draw();
      view.redraw = draw;
    }
    const view = {model, root, redraw: () => {}, select: (id) => { locked = id; hot = null; render(); }, open: (id) => { open.add(id); render(); },
      destroy: () => { ro.disconnect(); root.remove(); }};
    const ro = new ResizeObserver(() => view.redraw());
    render(); ro.observe(root);
    return view;
  }
  return {mount};
})();
