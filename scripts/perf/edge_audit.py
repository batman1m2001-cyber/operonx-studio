"""Edge audit: how tangled is the canvas? Counts, per view, the pairs of wires that
cross, the wires that run through a card they don't belong to, and the straight runs
inside wires; saves a screenshot of each view.

    python scripts/perf/edge_audit.py [--root D:\\meeting-prep-operonx] [--port 8766] [--tag before]

Needs Studio running on that project (OPERONX_STUDIO_AUTH=off) and Playwright.
The views: the project's first graph with every top-level container opened in turn,
then each container's own containers — enough to show a workflow and an agent inside it.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / "edge_audit"

MEASURE = r"""
() => {
  const svgEl = document.querySelector('#edges') || document.querySelector('svg');
  const paths = [...document.querySelectorAll('path.ecore')].filter(p => p.getAttribute('d'));
  const sample = (p) => {
    const n = p.getTotalLength(), k = Math.max(8, Math.round(n / 12)), pts = [];
    for (let i = 0; i <= k; i++) { const q = p.getPointAtLength(n * i / k); pts.push([q.x, q.y]); }
    return pts;
  };
  const lines = paths.map(sample);
  const seg = (a, b, c, d) => {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  let crossings = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    // wires sharing an end (fan-in/out) meet there by design: trim 14 px off both ends
    let hit = false;
    for (let a = 1; a < A.length - 2 && !hit; a++) for (let b = 1; b < B.length - 2 && !hit; b++)
      if (seg(A[a], A[a + 1], B[b], B[b + 1])) hit = true;
    if (hit) crossings++;
  }
  // wires through cards: sample points strictly inside a leaf card's box
  const toCanvas = svgEl.getScreenCTM ? svgEl.getScreenCTM().inverse() : null;
  const cards = [...document.querySelectorAll('.node:not(.container)')].map(c => c.getBoundingClientRect());
  const pt = svgEl.createSVGPoint ? svgEl.createSVGPoint() : null;
  let through = 0;
  paths.forEach((p, i) => {
    const m = p.getScreenCTM();
    const inside = lines[i].slice(2, -2).some(([x, y]) => {
      pt.x = x; pt.y = y; const s = pt.matrixTransform(m);
      return cards.some(r => s.x > r.left + 4 && s.x < r.right - 4 && s.y > r.top + 4 && s.y < r.bottom - 4);
    });
    if (inside) through++;
  });
  const straight = paths.filter(p => / L /.test(' ' + p.getAttribute('d') + ' ')).length;
  // shared corridors: two wires within 4 px of each other for 40 px or more, away from their ends
  let shared = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i].slice(3, -3), B = lines[j].slice(3, -3);
    let close = 0;
    for (const [x, y] of A) if (B.some(([u, v]) => Math.hypot(x - u, y - v) < 4)) close++;
    if (close * 12 >= 40) shared++;
  }
  return {edges: paths.length, crossings, through, straight, shared};
}
"""


def project_id(port: int, root: str) -> str:
    rows = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/projects"))["projects"]
    want = Path(root).resolve()
    return next(r["id"] for r in rows if Path(r["root"]).resolve() == want)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=r"D:\meeting-prep-operonx")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--tag", default="now")
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    pid = project_id(args.port, args.root)
    t0 = time.time()
    with sync_playwright() as p:
        b = p.chromium.launch(channel="msedge")
        pg = b.new_page(viewport={"width": 1900, "height": 1300})
        pg.goto(f"http://127.0.0.1:{args.port}/p/{pid}")
        pg.wait_for_timeout(5000)
        views = [("closed", None)]
        firsts = pg.locator(".node .badge.expand")
        if firsts.count():
            views.append(("open1", 0))
        rows = []
        for name, idx in views:
            if idx is not None:
                pg.locator(".node .badge.expand").nth(idx).click()
                pg.wait_for_timeout(2500)
            m = pg.evaluate(MEASURE)
            pg.screenshot(path=str(OUT / f"{args.tag}-{name}.png"))
            rows.append((name, m))
        # the deepest view: open the first container inside the opened one
        inner = pg.locator(".node:not(.container) .badge.expand")
        if inner.count():
            inner.nth(0).click()
            pg.wait_for_timeout(2500)
            m = pg.evaluate(MEASURE)
            pg.locator(".node.container").last.screenshot(path=str(OUT / f"{args.tag}-open2.png"))
            rows.append(("open2", m))
        b.close()
    for name, m in rows:
        print(f"{args.tag:<8} {name:<7} edges={m['edges']:3d} crossings={m['crossings']:3d} "
              f"through-cards={m['through']:3d} shared-corridors={m['shared']:3d} with-straight-runs={m['straight']:3d}")
    print(f"{time.time() - t0:.1f}s · screenshots in {OUT}")


if __name__ == "__main__":
    main()
