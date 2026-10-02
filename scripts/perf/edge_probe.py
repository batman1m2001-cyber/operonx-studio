"""Which wires tangle? Opens a view, names every crossing pair and every shared
corridor (two wires on top of each other), and saves a whole-graph screenshot.

    python scripts/perf/edge_probe.py [--open brief] [--open news] [--tag now]

Needs Studio on :8766 (OPERONX_STUDIO_AUTH=off) on meeting-prep-operonx.
"""
from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / "edge_audit"

PROBE = r"""
() => {
  const name = k => k.split('/').map(s => s.replace(/^.*[.:]/, '')).filter(s => !s.startsWith('__') || s === '__start' || s === '__end').slice(-2).join('/');
  const wires = [];
  for (const {a, b, els} of state.edgeEls) {
    const p = els.find(x => x.classList && x.classList.contains('ecore')) || els.find(x => x.tagName === 'path');
    if (!p || !p.getAttribute('d')) continue;
    const n = p.getTotalLength(), k = Math.max(8, Math.round(n / 12)), pts = [];
    for (let i = 0; i <= k; i++) { const q = p.getPointAtLength(n * i / k); pts.push([q.x, q.y]); }
    wires.push({id: name(a) + ' -> ' + name(b), pts});
  }
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const seg = (a, b, c, d) => o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  const crossings = [], shared = [];
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    const A = wires[i].pts, B = wires[j].pts;
    let hit = false;
    for (let x = 1; x < A.length - 2 && !hit; x++) for (let y = 1; y < B.length - 2 && !hit; y++)
      if (seg(A[x], A[x + 1], B[y], B[y + 1])) hit = true;
    if (hit) crossings.push(wires[i].id + '  X  ' + wires[j].id);
    const a2 = A.slice(3, -3), b2 = B.slice(3, -3);
    let close = 0;
    for (const [x, y] of a2) if (b2.some(([u, v]) => Math.hypot(x - u, y - v) < 4)) close++;
    if (close * 12 >= 40) shared.push(wires[i].id + '  =  ' + wires[j].id + '  (' + close * 12 + 'px)');
  }
  return {wires: wires.length, crossings, shared};
}
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--open", action="append", default=[])
    ap.add_argument("--tag", default="now")
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    rows = json.load(urllib.request.urlopen(f"http://127.0.0.1:{args.port}/api/projects"))["projects"]
    pid = next(r["id"] for r in rows if r["root"].rstrip("\\/").endswith("meeting-prep-operonx"))
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge")
        pg = b.new_page(viewport={"width": 1800, "height": 2400})
        pg.goto(f"http://127.0.0.1:{args.port}/p/{pid}")
        pg.wait_for_timeout(4000)
        for nm in args.open:
            card = pg.locator(".node", has=pg.locator(".nname", has_text=nm)).filter(has=pg.locator(".badge.expand"))
            card.first.locator(".badge.expand").first.click()
            pg.wait_for_timeout(2000)
        res = pg.evaluate(PROBE)
        pg.evaluate("""() => { const ex = state.extent; const s = Math.min(1, 1700 / (ex.maxX - ex.minX), 2300 / (ex.maxY - ex.minY));
                       state.view.scale = Math.max(0.46, s); applyView(); }""")
        pg.wait_for_timeout(1500)
        pg.locator("#stage").screenshot(path=str(OUT / f"{args.tag}-probe.png"))
        b.close()
    print(f"wires={res['wires']} crossings={len(res['crossings'])} shared={len(res['shared'])}")
    for c in res["crossings"]:
        print("  X", c)
    for s in res["shared"]:
        print("  =", s)


if __name__ == "__main__":
    main()
