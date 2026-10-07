"""The Flow canvas's auto-layout, audited like a tester would: every project,
every graph, every state that re-lays the canvas out — checked by geometry,
and screenshotted for the eye (docs/LAYOUT_HOTFIX_PLAN.md §3).

The checks run in the page, on the DOM as the user sees it (not on the
layout's own model, so a model that drifted from its cards is caught):

  ports       a decision row's wire port at the card's corner, or not at its row's dot
  side        a row's dot on the side away from its target
  model       a card's box differs from the box its wires were drawn from
  hidden      a card that is not laid out (zero size)
  overlap     two cards that are not nested overlap (tight: closer than 8 px)
  contain     a member outside its container, a knob off its border
  ends        a wire that does not start at its source's port (a decision row's dot for
              its routes, returns and ties into END) or end at its target's
  cross       a wire through a card that is not one of its ends (warn)
  owncross    a decision wire back through its own card
  escape      a wire between a container's members that leaves the container
  cut         a name or condition cut short on a card that could still grow
  extent      a card or wire outside the scrollable world
  zone        a card inside another gate's door frame
  glyph       a wire label hidden under a card (warn)
  stable      a second render with nothing changed moves something
  moved       a live replay moved a card
  view        nothing on screen after the step, or a centred node off screen
  landing     a fresh page does not land with the flow's START in view
  b5          a run of a graph the studio does not draw shown with a canvas beside its note

usage: layout_audit.py <base> <outdir> [pid ...]    (no pids: the default matrix)
       --quick        the landing and expand-all steps only
       --widths       also phone 390 and tablets 768 / 1024
       --touch        the code-change step, on scratch projects only (writes a probe file into the project)
       --touch-all    the code-change step on every project
       --sheets       contact sheets of every screenshot, for review by eye
       --dark         the whole run in the dark theme
Exits 1 when any error-severity finding is left (a gate before canvas changes).
"""
import asyncio
import json
import os
import sys
import time

import studio_login
from playwright.async_api import async_playwright


class _Skip(Exception):
    """A case with nothing to check here (not a failure)."""


ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
FLAGS = {a for a in sys.argv[1:] if a.startswith("--")}
BASE, OUT = ARGS[0], ARGS[1]
PIDS = ARGS[2:] or [
    "c3d87c6cae2e", "5f5c06a34d20", "d5e0f6b8b653",
    "adbca90511ee", "67155a45bfd6", "0c745df89ed3", "af28abc41e22", "64121f45b5db",
    "aa5476d3b0b9", "4efc1a6a2c78", "0a8872a2074a",
]
QUICK = "--quick" in FLAGS
os.makedirs(OUT, exist_ok=True)

WARN_ONLY = {"cross", "glyph", "tight"}

AUDIT_JS = r"""
() => {
  const F = [];
  const add = (check, msg, extra) => F.push(Object.assign({check, msg}, extra || {}));
  const stage = document.querySelector('#stage');
  if (!stage || !stage.offsetParent) return {skipped: 'the canvas is not on screen', findings: []};
  const r2 = (v) => Math.round(v * 10) / 10;

  // every card as the user sees it
  const keyOf = new Map();
  for (const [k, c] of state.cardEls) keyOf.set(c, k);
  const boxes = [];
  for (const c of document.querySelector('#nodes').children) {
    // a loop's zone is a backdrop under its cards, drawn to hold them and
    // the edges between them: not a card
    if (c.classList.contains('loopzone')) continue;
    let key = keyOf.get(c);
    if (!key) key = c.classList.contains('bnode') ? `__main/${c.classList.contains('b-start') ? 'start' : 'end'}`
      : c.classList.contains('serve-node') ? `__serve/${c.textContent.slice(0, 20)}` : `?${c.className}`;
    const b = {key, el: c, name: c.dataset.name || key,
               x: parseFloat(c.style.left), y: parseFloat(c.style.top), w: c.offsetWidth, h: c.offsetHeight,
               it: state.rendered.get(key) || null,
               container: c.classList.contains('container'), knob: c.classList.contains('knob')};
    boxes.push(b);
    if (!b.w || !b.h) add('hidden', `${b.name} is not laid out (${b.w}×${b.h})`, {key});
  }
  const byKey = new Map(boxes.map(b => [b.key, b]));
  const nested = (p, q) => q.key.startsWith(p.key + '/') || p.key.startsWith(q.key + '/');
  const parentKey = (k) => k.split('/').slice(0, -1).join('/');

  // the model the wires were drawn from must be the box on screen
  for (const b of boxes) {
    const it = b.it;
    if (!it || !b.w) continue;
    const dx = Math.abs(it.x - b.x), dy = Math.abs(it.y - b.y);
    const dw = Math.abs(it.w - b.w), dh = b.h - it.h;
    if (dx > 1 || dy > 1 || dw > 2 || Math.abs(dh) > 2)
      add('model', `${b.name}: model ${r2(it.x)},${r2(it.y)} ${r2(it.w)}×${r2(it.h)} vs card ${r2(b.x)},${r2(b.y)} ${b.w}×${b.h}`, {key: b.key});
  }

  // decision rows: the port each wire leaves from
  const rowDot = (b, rrow) => {
    const left = rrow.classList.contains('left');
    return {x: b.x + (left ? rrow.offsetLeft - 1 : rrow.offsetLeft + rrow.offsetWidth + 1),
            y: b.y + rrow.offsetTop + rrow.offsetHeight / 2, left};
  };
  const firstRow = new Map();   // "key|target" -> dot
  for (const b of boxes) {
    const it = b.it;
    if (!it || !it.node.routes || !it.node.routes.length) continue;
    for (const [t, p] of Object.entries(it.condPorts || {})) {
      if (Math.abs(p.x) <= 2 && Math.abs(p.y) <= 2)
        add('ports', `${b.name} → ${t}: port at the card's corner (${p.x},${p.y})`, {key: b.key});
    }
    for (const rrow of b.el.querySelectorAll('.brrow')) {
      const t = rrow.dataset.target;
      const dot = rowDot(b, rrow);
      if (!firstRow.has(`${b.key}|${t}`)) firstRow.set(`${b.key}|${t}`, dot);
      // one edge per route (edge ids `src->dst#route`): each leaves its own row
      if (rrow.dataset.route != null) firstRow.set(`${b.key}|#${rrow.dataset.route}`, dot);
      const tgt = boxes.find(o => o !== b && o.it && o.it.depth === it.depth && o.name === t
                                  && parentKey(o.key) === parentKey(b.key));
      // a route that is the loop's return keeps its dot on the right,
      // where returns bow (render: backTo)
      const backRow = tgt && state.edgeEls.some(E => E.a === b.key && E.b === tgt.key
        && E.els[0] && E.els[0].classList.contains('back'));
      if (backRow && dot.left)
        add('side', `${b.name}: the row to ${t} is the loop's return, but its dot is on the left`, {key: b.key});
      else if (tgt && !backRow) {
        // the row's wire must LEAVE outward from its dot. The layout points a
        // dot at where the wire goes first — its first lane, which may lie on
        // the far side from the target (round a card below) — so the check is
        // the drawn wire's first stretch, not the target's side: a wire that
        // heads back across its own card is the real fault.
        // this row's own wire: by its route id when it has one
        const route = rrow.dataset.route;
        const mine = state.edgeEls.filter(E => E.a === b.key && E.b === tgt.key
          && (route == null || E.id == null || String(E.id).endsWith(`#${route}`)));
        let starts = 0, any = 0;
        for (const E of mine) for (const el of E.els || []) {
          if (!el || el.tagName !== 'path' || !el.getTotalLength) continue;
          const n = el.getTotalLength();
          if (n < 20) continue;
          any++;
          const p0 = el.getPointAtLength(0);
          if (Math.hypot(p0.x - dot.x, p0.y - dot.y) > 4) continue;
          starts++;
          const q = el.getPointAtLength(14);
          if (dot.left ? q.x > dot.x + 2 : q.x < dot.x - 2)
            add('side', `${b.name}: the row to ${t} has its dot on the ${dot.left ? 'left' : 'right'}, but its wire heads back across the card`, {key: b.key});
        }
        // a dot no wire leaves from is a fault too (silence is not a pass)
        if (any && !starts && route != null)
          add('side', `${b.name}: the row to ${t}: its wire does not start at its dot`, {key: b.key});
      }
      const p = (it.condPorts || {})[t];
      const fr = firstRow.get(`${b.key}|${t}`);
      if (p && fr === dot && (Math.abs(b.x + p.x - dot.x) > 3 || Math.abs(b.y + p.y - dot.y) > 3))
        add('ports', `${b.name} → ${t}: port ${r2(b.x + p.x)},${r2(b.y + p.y)} but the row's dot is at ${r2(dot.x)},${r2(dot.y)}`, {key: b.key});
    }
  }

  // overlaps and tight gaps between cards that are not nested
  for (let i = 0; i < boxes.length; i++) {
    const p = boxes[i];
    if (!p.w) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      const q = boxes[j];
      if (!q.w || nested(p, q)) continue;
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (ox > 0.5 && oy > 0.5) add('overlap', `${p.name} and ${q.name} overlap by ${r2(ox)}×${r2(oy)}`, {key: p.key});
      else if (!p.knob && !q.knob) {
        const gap = oy > 0 ? -ox : ox > 0 ? -oy : Infinity;   // side by side, or one above the other
        if (gap < 8) add('tight', `${p.name} and ${q.name} are ${r2(gap)} px apart`, {key: p.key});
      }
    }
  }

  // containment: members inside, knobs on the border
  for (const b of boxes) {
    if (!b.it || !b.key.includes('/') || b.key.startsWith('__')) continue;
    const c = byKey.get(parentKey(b.key));
    if (!c) continue;
    if (b.knob) {
      const cy = b.y + b.h / 2, want = b.key.endsWith('__start') ? c.y : c.y + c.h;
      const cx = b.x + b.w / 2;
      if (Math.abs(cy - want) > 3 || cx < c.x || cx > c.x + c.w)
        add('contain', `${b.name} knob of ${c.name} is off its border (centre y ${r2(cy)}, border ${r2(want)})`, {key: b.key});
    } else if (b.x < c.x - 1 || b.y < c.y - 1 || b.x + b.w > c.x + c.w + 1 || b.y + b.h > c.y + c.h + 1) {
      add('contain', `${b.name} sticks out of ${c.name}`, {key: b.key});
    }
  }

  // the wires
  const inset = (b, k) => ({l: b.x + k, r: b.x + b.w - k, t: b.y + k, b: b.y + b.h - k});
  const inside = (pt, r) => pt.x > r.l && pt.x < r.r && pt.y > r.t && pt.y < r.b;
  const sample = (path, n) => {
    let len = 0; try { len = path.getTotalLength(); } catch { return []; }
    const pts = [];
    for (let i = 0; i <= n; i++) { const p = path.getPointAtLength(len * i / n); pts.push({x: p.x, y: p.y, s: len * i / n}); }
    return pts;
  };
  const near = (p, q, tol) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
  const ex = state.extent;
  // the main graph's ties to END are not in the ledger: a router's route
  // into END must still leave its row's dot (B4)
  const tieStarts = [...document.querySelectorAll('#edges path.bedge')].map(p => {
    try { const q = p.getPointAtLength(0); return {x: q.x, y: q.y}; } catch { return null; } }).filter(Boolean);
  for (const b of boxes) {
    const it = b.it;
    if (!it || it.depth !== 0 || !(it.node.routes || []).some(r => r.target === '__END__')) continue;
    const dot = firstRow.get(`${b.key}|__END__`);
    if (dot && !tieStarts.some(q => Math.abs(q.x - dot.x) <= 6 && Math.abs(q.y - dot.y) <= 6))
      add('ends', `${b.name} → END: no tie leaves its row's dot at ${r2(dot.x)},${r2(dot.y)}`, {key: b.key});
  }
  const allPts = [];
  for (const E of state.edgeEls) {
    const path = E.els[0];
    if (!path || !path.getAttribute('d')) continue;
    const a = state.rendered.get(E.a), bb = state.rendered.get(E.b);
    if (!a || !bb) continue;
    const Akey = a.bOut ? a.bOut.key : E.a, Bkey = bb.bIn ? bb.bIn.key : E.b;
    const A = byKey.get(Akey), B = byKey.get(Bkey);
    if (!A || !B) continue;
    const back = path.classList.contains('back');
    const pts = sample(path, 48);
    if (!pts.length) continue;
    allPts.push(...pts);
    const s = pts[0], t = pts[pts.length - 1];
    const label = `${a.node.name} → ${bb.node.name}`;
    // a route's wire leaves its condition row (render: condLabels +
    // condPorts) — a route that is the loop's return too, and a route
    // into END ties from its row (docs/ASSISTANT_NEXT_PLAN.md B4)
    const toEnd = bb.node.kind === '__boundary__' && /end/i.test(bb.node.boundary || bb.node.name || '');
    const rowKey = `${Akey}|${toEnd ? '__END__' : bb.node.name}`;
    const rowWire = !!firstRow.get(rowKey)
      && (a.node.routes || []).some(r => r.target === (toEnd ? '__END__' : bb.node.name));
    let want;
    const routeIx = /#(\d+)$/.exec(E.id || '');
    if (rowWire) want = (routeIx && firstRow.get(`${Akey}|#${routeIx[1]}`)) || firstRow.get(rowKey);
    else if (back) want = {x: A.x + A.w, y: A.y + A.h / 2};
    else want = {x: A.x + A.w / 2, y: A.y + A.h};
    if (!near(s, want, 6))
      add('ends', `${label} starts at ${r2(s.x)},${r2(s.y)}, its ${rowWire ? "row's dot" : 'port'} is ${r2(want.x)},${r2(want.y)}`, {key: E.a});
    const wantEnd = back ? {x: B.x + B.w, y: B.y + B.h / 2} : {x: B.x + B.w / 2, y: B.y};
    if (!near(t, wantEnd, 6))
      add('ends', `${label} ends at ${r2(t.x)},${r2(t.y)}, its port is ${r2(wantEnd.x)},${r2(wantEnd.y)}`, {key: E.b});
    // through other cards
    const skip = new Set([A.key, B.key, E.a, E.b]);
    const hits = new Map();
    for (const o of boxes) {
      if (!o.w || skip.has(o.key) || E.a.startsWith(o.key + '/') || o.knob) continue;
      const r = inset(o, 4);
      const n = pts.filter(p => inside(p, r)).length;
      if (n) hits.set(o.name, n);
    }
    if (hits.size) add('cross', `${label} runs through ${[...hits].map(([k, n]) => `${k} (${n})`).join(', ')}`, {key: E.a});
    // a wire between members stays inside their container
    const holder = byKey.get(parentKey(E.a));
    if (holder && holder.container) {
      const out = pts.filter(p => p.x < holder.x - 2 || p.x > holder.x + holder.w + 2
                                  || p.y < holder.y - 2 || p.y > holder.y + holder.h + 2);
      if (out.length) add('escape', `${label} leaves ${holder.name} (${out.length} points, e.g. ${r2(out[0].x)},${r2(out[0].y)})`, {key: E.a});
    }
    if (rowWire) {
      const r = inset(A, 4);
      const n = pts.filter(p => p.s > 14 && inside(p, r)).length;
      if (n > 1) add('owncross', `${label} runs back through its own card (${n} points)`, {key: E.a});
    }
  }
  // every other wire (the main START/END ties, loop labels) must stay in the world too
  for (const p of document.querySelectorAll('#edges path.bedge, #edges path.serve')) allPts.push(...sample(p, 16));

  // names cut short on a card that could still grow
  for (const b of boxes) {
    if (!b.w || b.container) continue;
    for (const t of b.el.querySelectorAll('.ntext, .brcond, .nname')) {
      if (t.scrollWidth > t.clientWidth + 1 && b.w < 309 && !('capped' in b.el.dataset))
        add('cut', `${b.name}: "${t.textContent.slice(0, 40)}" cut (${t.clientWidth}/${t.scrollWidth}) on a ${b.w} px card`, {key: b.key});
    }
  }

  // the scrollable world holds everything
  if (ex) {
    for (const b of boxes) {
      if (!b.w) continue;
      if (b.x < ex.minX - 1 || b.y < ex.minY - 1 || b.x + b.w > ex.maxX + 1 || b.y + b.h > ex.maxY + 1)
        add('extent', `${b.name} lies outside the world (${r2(b.x)},${r2(b.y)} ${b.w}×${b.h}; world ${ex.minX},${r2(ex.minY)} → ${r2(ex.maxX)},${r2(ex.maxY)})`, {key: b.key});
    }
    const out = allPts.filter(p => p.x < ex.minX - 2 || p.y < ex.minY - 2 || p.x > ex.maxX + 2 || p.y > ex.maxY + 2);
    if (out.length) add('extent', `${out.length} wire points outside the world (e.g. ${r2(out[0].x)},${r2(out[0].y)})`);
  }

  // door frames hold their gate only
  for (const z of document.querySelectorAll('#edges rect.zoneband')) {
    const zr = {l: +z.getAttribute('x'), t: +z.getAttribute('y')};
    zr.r = zr.l + +z.getAttribute('width'); zr.b = zr.t + +z.getAttribute('height');
    for (const b of boxes) {
      if (!b.w) continue;
      const own = Math.abs(b.x - 12 - zr.l) < 1 && Math.abs(b.y - 26 - zr.t) < 1;
      if (own) continue;
      const ox = Math.min(zr.r, b.x + b.w) - Math.max(zr.l, b.x), oy = Math.min(zr.b, b.y + b.h) - Math.max(zr.t, b.y);
      if (ox > 2 && oy > 2) add('zone', `${b.name} is inside a door frame`, {key: b.key});
    }
  }

  // wire labels hidden under cards
  for (const t of document.querySelectorAll('#edges text')) {
    let bb; try { bb = t.getBBox(); } catch { continue; }
    if (!bb.width) continue;
    const c = {x: bb.x + bb.width / 2, y: bb.y + bb.height / 2};
    const o = boxes.find(b => b.w && !b.container && inside(c, inset(b, 0)));
    if (o) add('glyph', `the label "${t.textContent}" is under ${o.name}`);
  }

  // something is on screen
  const sr = stage.getBoundingClientRect();
  const onScreen = boxes.filter(b => {
    const r = b.el.getBoundingClientRect();
    return r.width && r.right > sr.left && r.left < sr.right && r.bottom > sr.top && r.top < sr.bottom;
  }).length;
  if (!onScreen) add('view', 'no card on screen');

  return {findings: F, cards: boxes.length, wires: state.edgeEls.length, onScreen,
          scale: state.view.scale, zoom: document.querySelector('#world').dataset.zoom};
}
"""

SIG_JS = r"""
() => ({cards: [...document.querySelectorAll('#nodes > *')].map(n => [n.dataset.name || n.className, n.style.left, n.style.top, n.offsetWidth, n.offsetHeight]),
        paths: [...document.querySelectorAll('#edges path, #edgetop path')].map(p => p.getAttribute('d'))})
"""

FRAMES = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))"

REPORT = {"cases": [], "started": time.strftime("%Y-%m-%d %H:%M:%S")}


def slug(*parts):
    return "_".join(str(p).replace("/", "-").replace(" ", "-").replace("[", "").replace("]", "") for p in parts if p != "")


async def audit(pg, meta, shot=True, extra=None):
    """Run the in-page checks, screenshot, record one case."""
    await pg.evaluate(FRAMES)
    res = await pg.evaluate(AUDIT_JS)
    name = slug(meta["project"], meta.get("graph", ""), meta["step"], meta.get("width", ""))
    if shot:
        await pg.screenshot(path=f"{OUT}/{name}.png")
    case = dict(meta, shot=f"{name}.png" if shot else None, **{k: v for k, v in res.items() if k != "findings"})
    case["findings"] = res.get("findings", []) + (extra or [])
    REPORT["cases"].append(case)
    errs = [f for f in case["findings"] if f["check"] not in WARN_ONLY]
    warns = len(case["findings"]) - len(errs)
    flag = "FAIL" if errs else ("warn" if warns else "ok  ")
    print(f"{flag} {name:70s} {len(errs):3d} err {warns:3d} warn"
          + (f"  — {errs[0]['check']}: {errs[0]['msg'][:110]}" if errs else ""), flush=True)
    return case


async def login(pg):
    await studio_login.login(pg, BASE)


async def tab(pg, name):
    await pg.evaluate(f"switchTab({json.dumps(name)})")
    await pg.evaluate(FRAMES)


async def expand(pg):
    if await pg.locator("#btn-expand").is_visible():
        await pg.click("#btn-expand")
    else:
        await pg.evaluate("expandAll(!state.expanded.size)")
    await pg.evaluate(FRAMES)


async def centre_on_decision(pg):
    """Point the screenshot at the part most likely to go wrong: a decision card, else an open container."""
    await pg.evaluate("""() => {
      const all = [...state.rendered.values()];
      const it = all.find(x => x.node.routes && x.node.routes.length) || all.find(x => x.inner);
      if (it) centerOn(it);
    }""")


async def signature(pg):
    return await pg.evaluate(SIG_JS)


def diff_sig(a, b):
    out = []
    ca, cb = a["cards"], b["cards"]
    if len(ca) != len(cb):
        out.append(f"{len(ca)} cards became {len(cb)}")
    else:
        moved = [x[0] for x, y in zip(ca, cb) if x != y]
        if moved:
            out.append(f"{len(moved)} cards moved or resized: {', '.join(moved[:5])}")
    if len(a["paths"]) != len(b["paths"]):
        out.append(f"{len(a['paths'])} wires became {len(b['paths'])}")
    else:
        n = sum(1 for x, y in zip(a["paths"], b["paths"]) if x != y)
        if n:
            out.append(f"{n} wires re-routed")
    return out


async def themed(ctx):
    """--dark: every page of the context wears the dark theme from its first paint."""
    if "--dark" in FLAGS:
        await ctx.add_init_script("try { localStorage.setItem('ox:theme', 'dark') } catch (e) {}")
    return ctx


async def project_desktop(b, pid):
    ctx = await themed(await b.new_context(viewport={"width": 1440, "height": 900}))
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await login(pg)
    await pg.goto(f"{BASE}/p/{pid}")
    await pg.wait_for_selector("#nodes .node", timeout=60000)
    await pg.wait_for_timeout(600)
    info = await pg.evaluate("({name: state.ir.name, graphs: state.ir.graphs.map(g => g.name)})")
    project = info["name"]
    for gi, graph in enumerate(info["graphs"]):
        meta = {"pid": pid, "project": project, "graph": graph if len(info["graphs"]) > 1 else ""}
        if gi:
            # the picker is folded into the header's graph menu; drive its change event
            await pg.evaluate("""(g) => { const s = document.querySelector('#graph-pick'); s.value = g;
                                        s.dispatchEvent(new Event('change')); }""", graph)
            await pg.evaluate(FRAMES)
        named = await pg.evaluate("""(g) => { const h = document.querySelector('#inspector .phead h3');
                                           return !h || !h.offsetParent || h.textContent === g ? 'ok' : h.textContent; }""", graph)
        land = await audit(pg, dict(meta, step="01_landing"),
                           extra=[] if named == "ok" else [{"check": "view", "msg": f"the side panel describes {named}, not {graph}"}])
        land_sig = await signature(pg)
        # determinism: render again, nothing changed
        await pg.evaluate("render()")
        again = await signature(pg)
        d = diff_sig(land_sig, again)
        if d:
            REPORT["cases"].append(dict(meta, step="01b_rerender", shot=None,
                                        findings=[{"check": "stable", "msg": m} for m in d]))
            print(f"FAIL {slug(project, graph, 'rerender')}: {d}")
        nests = await pg.evaluate("state.graph.nodes.some(n => n.graph)")
        if nests:
            await expand(pg)
            await centre_on_decision(pg)
            await audit(pg, dict(meta, step="02_expanded"))
            if not QUICK:
                await expand(pg)
                back = await signature(pg)
                d = diff_sig(land_sig, back)
                await audit(pg, dict(meta, step="03_collapsed"), shot=bool(d),
                            extra=[{"check": "stable", "msg": "collapse did not restore: " + m} for m in d])
                await expand(pg)
        if QUICK:
            continue
        # zoom levels, everything open (each level change re-renders)
        for z, lvl in ((1.2, "hi"), (0.7, "mid"), (0.4, "lo")):
            await pg.evaluate(f"state.view.scale = {z}; applyView()")
            await pg.evaluate(FRAMES)
            await centre_on_decision(pg)
            await audit(pg, dict(meta, step=f"04_zoom_{lvl}"))
        # a render while the canvas is hidden, then back
        await pg.evaluate("fit()")
        await tab(pg, "traces")
        await pg.evaluate("render()")
        await tab(pg, "flow")
        await centre_on_decision(pg)
        await audit(pg, dict(meta, step="05_hidden_render"))
        # select the last card, find it, centre it
        target = await pg.evaluate("""() => { const all = [...state.rendered.values()].filter(x => !x.inner && x.node.kind !== '__boundary__');
                                              return all.length ? all[all.length - 1].node.name : null; }""")
        if target:
            await pg.evaluate("fit()")
            await pg.keyboard.press("/")
            await pg.fill("#find-input", target)
            await pg.keyboard.press("Enter")
            await pg.evaluate(FRAMES)
            vis = await pg.evaluate("""(name) => { const it = state.sel && state.rendered.get(state.sel);
              if (!it || it.node.name !== name) return `picked ${it ? it.node.name : 'nothing'}`;
              const c = state.cardEls.get(state.sel);
              if (!c) return 'missing'; const r = c.getBoundingClientRect(), s = document.querySelector('#stage').getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              return cx > s.left && cx < s.right && cy > s.top && cy < s.bottom ? 'ok' : `centre ${Math.round(cx)},${Math.round(cy)} outside the stage`; }""", target)
            await pg.keyboard.press("Escape")
            await audit(pg, dict(meta, step="11_find"),
                        extra=[] if vis == "ok" else [{"check": "view", "msg": f"find {target}: {vis}"}])
        # the side panel: closed, fit; open, fit
        await pg.evaluate("fit()")
        await pg.click("#btn-right")
        await pg.evaluate(FRAMES)
        await pg.evaluate("fit()")
        await audit(pg, dict(meta, step="10_panel_closed"))
        await pg.click("#btn-right")
        await pg.evaluate(FRAMES)
        await pg.evaluate("fit()")
        if nests:
            await expand(pg)   # leave the graph as the next one expects: all closed
    # a run: the workflow view, its lenses, a replay, then back to Flow
    has_runs = await pg.evaluate(f"fetch('/api/p/{pid}/runs').then(r => r.json()).then(j => (j.runs || []).length)")
    if has_runs and not QUICK:
        try:
            await tab(pg, "flow")
            # the Flow tab's view settles a frame or two after the switch: the
            # one to compare against is the settled one
            await pg.evaluate(FRAMES)
            VIEW = "(() => { const st = document.querySelector('#stage'); return [+state.view.scale.toFixed(3), Math.round(st.scrollLeft), Math.round(st.scrollTop)]; })()"
            flow_view = await pg.evaluate(VIEW)
            # a run whose graph the studio draws: one of a graph it does not
            # (a job's params) gets a note instead of a canvas (B5) — checked,
            # then the next run is tried
            runs = await pg.evaluate(f"""() => fetch('/api/p/{pid}/runs?limit=40').then(r => r.json()).then(j =>
                (j.runs || []).map(r => r.trace_id || r.run))""")
            shown = False
            for run in runs[:12]:
                await pg.evaluate("(r) => showRunWorkflow(r)", run)
                await pg.wait_for_selector(".replayctl, .wfmissing", timeout=15000)
                if await pg.locator(".wfmissing").count():
                    if await pg.evaluate("!!document.querySelector('#traces #stage')"):
                        REPORT["cases"].append({"pid": pid, "project": project, "step": "07_workflow_missing", "shot": None,
                                                "findings": [{"check": "b5", "msg": f"run {run}: an undrawn graph's note with a canvas beside it"}]})
                    continue
                shown = True
                break
            if not shown:
                print(f"skipped: {project} workflow: no recent run of a graph it draws")
                raise _Skip()
            await pg.evaluate(FRAMES)
            meta = {"pid": pid, "project": project, "graph": ""}
            await audit(pg, dict(meta, step="07_workflow_path"))
            for lens in ("time", "values", "errors", "cost"):
                await pg.locator(f".lensbar button:has-text('{lens.capitalize()}')").click()
                await pg.evaluate(FRAMES)
                await audit(pg, dict(meta, step=f"07_workflow_{lens}"), shot=lens in ("time", "values"))
            await pg.locator(".lensbar button:has-text('Path')").click()
            await pg.evaluate(FRAMES)
            before = await signature(pg)
            await pg.locator(".replayctl button").last.click()   # 4×
            await pg.wait_for_timeout(700)
            during = await signature(pg)
            moved = diff_sig(before, during)
            moved = [m for m in moved if "wires" not in m]   # particles are extra paths
            await audit(pg, dict(meta, step="08_replay"),
                        extra=[{"check": "moved", "msg": m} for m in moved])
            await pg.wait_for_timeout(1500)
            await tab(pg, "flow")
            pill = await pg.evaluate("!!document.querySelector('#livebar:not([hidden])')")
            back_view = await pg.evaluate(VIEW)
            extra = [{"check": "view", "msg": "the replay pill stayed on the Flow tab"}] if pill else []
            if back_view != flow_view:
                extra.append({"check": "view", "msg": f"the Flow view came back as {back_view}, it was {flow_view} (scale, scroll)"})
            await audit(pg, dict(meta, step="07b_workflow_then_flow"), extra=extra)
        except _Skip:
            pass
        except Exception as exc:  # noqa: BLE001
            REPORT["cases"].append({"pid": pid, "project": project, "step": "07_workflow", "shot": None,
                                    "findings": [{"check": "harness", "msg": f"{type(exc).__name__}: {str(exc)[:200]}"}]})
            print(f"harness: {project} workflow: {exc}")
    # a code change lands while another tab is open
    root = await pg.evaluate(f"fetch('/api/projects').then(r => r.json()).then(j => (j.projects || j).find(p => (p.id || p.pid) === '{pid}').root)")
    # only the throwaway projects get a probe file written into them
    if "--touch" in FLAGS and not QUICK and ("/scratchpad/" in root or "--touch-all" in FLAGS):
        await tab(pg, "flow")
        await tab(pg, "traces")
        stamp = await pg.evaluate("state.stamp")
        probe = os.path.join(root, "_layout_probe.py")
        with open(probe, "w") as fh:
            fh.write("# layout audit probe; safe to delete\n")
        try:
            for _ in range(40):
                await pg.wait_for_timeout(250)
                if await pg.evaluate("state.stamp") != stamp:
                    break
        finally:
            os.remove(probe)
        await pg.wait_for_timeout(300)
        await tab(pg, "flow")
        await centre_on_decision(pg)
        await audit(pg, {"pid": pid, "project": project, "graph": "", "step": "06_code_change_elsewhere"})
        await pg.wait_for_timeout(2500)   # the removal is a change too
    if not QUICK:
        sid = await pg.evaluate(f"""() => fetch('/api/assistant/sessions', {{method: 'POST', headers: {{'content-type': 'application/json'}},
                                     body: JSON.stringify({{scope: '{pid}'}})}}).then(r => r.json()).then(j => j.session.id)""")
        await pg.goto(f"{BASE}/p/{pid}#assistant={sid}")
        await pg.wait_for_selector(".ax.focus", timeout=20000)
        await pg.wait_for_timeout(800)
        await pg.evaluate("document.querySelector('.ax-b-focus').click()")   # leave focus
        await pg.wait_for_timeout(600)
        await centre_on_decision(pg)
        await audit(pg, {"pid": pid, "project": project, "graph": "", "step": "12_focus_then_canvas"})
        await pg.evaluate(f"fetch('/api/assistant/sessions/{sid}', {{method: 'DELETE'}})")
    if errors:
        REPORT["cases"].append({"pid": pid, "project": project, "step": "page", "shot": None,
                                "findings": [{"check": "pageerror", "msg": e[:200]} for e in errors[:5]]})
        print(f"FAIL {project}: page errors {errors[:2]}")
    await ctx.close()


async def project_width(b, pid, width):
    phone = width < 700
    ctx = await themed(await b.new_context(viewport={"width": width, "height": 844 if phone else 1000},
                                           is_mobile=phone, has_touch=phone, device_scale_factor=2 if phone else 1))
    pg = await ctx.new_page()
    await login(pg)
    await pg.goto(f"{BASE}/p/{pid}")
    await pg.wait_for_selector("#nodes .node", timeout=60000)
    await pg.wait_for_timeout(600)
    project = await pg.evaluate("state.ir.name")
    meta = {"pid": pid, "project": project, "graph": "", "width": width}
    # a flow wider than the view lands on its START (B6)
    landed = await pg.evaluate("""() => { const st = document.querySelector('#stage').getBoundingClientRect();
        const s = document.querySelector('#nodes .node.bnode.b-start:not(.knob)');
        if (!s) return 'ok';
        const r = s.getBoundingClientRect();
        return r.right > st.left && r.left < st.right && r.bottom > st.top && r.top < st.bottom ? 'ok'
          : `START at ${Math.round(r.left - st.left)},${Math.round(r.top - st.top)} is off the ${Math.round(st.width)}x${Math.round(st.height)} view`; }""")
    await audit(pg, dict(meta, step="09_landing"),
                extra=[] if landed == "ok" else [{"check": "landing", "msg": landed}])
    if await pg.evaluate("state.graph.nodes.some(n => n.graph)"):
        await expand(pg)
        await centre_on_decision(pg)
        await audit(pg, dict(meta, step="09_expanded"))
    await tab(pg, "traces")
    await pg.evaluate("render()")
    await tab(pg, "flow")
    await centre_on_decision(pg)
    await audit(pg, dict(meta, step="09_hidden_render"))
    await ctx.close()


def sheets():
    """Contact sheets: six screenshots a page, labelled, for reading by eye."""
    from PIL import Image, ImageDraw
    shots = [c for c in REPORT["cases"] if c.get("shot")]
    W, H, cols, rows = 720, 450, 2, 3
    for i in range(0, len(shots), cols * rows):
        sheet = Image.new("RGB", (W * cols, (H + 24) * rows), "white")
        d = ImageDraw.Draw(sheet)
        for j, c in enumerate(shots[i:i + cols * rows]):
            im = Image.open(os.path.join(OUT, c["shot"])).convert("RGB")
            im.thumbnail((W, H))
            x, y = (j % cols) * W, (j // cols) * (H + 24)
            sheet.paste(im, (x, y + 24))
            errs = [f for f in c["findings"] if f["check"] not in WARN_ONLY]
            d.text((x + 6, y + 5), f"{c['shot'][:-4]}  —  {len(errs)} err", fill=(200, 0, 0) if errs else (0, 0, 0))
        sheet.save(os.path.join(OUT, f"sheet_{i // (cols * rows):03d}.png"))


async def main():
    t0 = time.monotonic()
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for pid in PIDS:
            try:
                await project_desktop(b, pid)
            except Exception as exc:  # noqa: BLE001
                REPORT["cases"].append({"pid": pid, "step": "desktop", "shot": None,
                                        "findings": [{"check": "harness", "msg": f"{type(exc).__name__}: {str(exc)[:300]}"}]})
                print(f"harness: {pid}: {exc}")
            if "--widths" in FLAGS:
                for w in (390, 768, 1024):
                    try:
                        await project_width(b, pid, w)
                    except Exception as exc:  # noqa: BLE001
                        REPORT["cases"].append({"pid": pid, "step": f"width {w}", "shot": None,
                                                "findings": [{"check": "harness", "msg": f"{type(exc).__name__}: {str(exc)[:300]}"}]})
                        print(f"harness: {pid} @{w}: {exc}")
        await b.close()
    REPORT["seconds"] = round(time.monotonic() - t0, 1)
    by = {}
    for c in REPORT["cases"]:
        for f in c["findings"]:
            by.setdefault(f["check"], []).append(c.get("project", c["pid"]) + " " + c.get("graph", "") + " " + c["step"])
    REPORT["by_check"] = {k: len(v) for k, v in by.items()}
    json.dump(REPORT, open(os.path.join(OUT, "layout_audit.json"), "w"), indent=1)
    if "--sheets" in FLAGS:
        sheets()
    errs = sum(n for k, n in REPORT["by_check"].items() if k not in WARN_ONLY)
    print(f"\n{len(REPORT['cases'])} cases in {REPORT['seconds']} s")
    for k, v in sorted(by.items()):
        print(f"  {k:10s} {len(v):4d}  e.g. {v[0]}")
    print(f"{errs} error findings")
    sys.exit(1 if errs else 0)


asyncio.run(main())
