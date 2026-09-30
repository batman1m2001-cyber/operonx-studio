"""Canvas cost: render() time (x3, then with every nested graph open) and
frame times across a burst of 40 wheel-zooms.

usage: render_cost.py <base> <pid> [<pid> ...]
"""
import asyncio
import json
import sys

import studio_login
from playwright.async_api import async_playwright

BASE = sys.argv[1]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await (await b.new_context(viewport={"width":1440,"height":900})).new_page()
        await studio_login.login(pg, BASE)
        for pid in sys.argv[2:]:
            await pg.goto(f"{BASE}/p/{pid}"); await pg.wait_for_selector(".node", timeout=90000); await pg.wait_for_timeout(500)
            r = await pg.evaluate("""() => {
              const t = (f) => { const a = performance.now(); f(); return +(performance.now() - a).toFixed(1); };
              const out = {nodes0: document.querySelectorAll('.node').length};
              out.render = [t(render), t(render), t(render)];
              expandAll(true);
              out.nodesAll = document.querySelectorAll('.node').length;
              out.renderAll = [t(render), t(render), t(render)];
              out.dom = document.querySelectorAll('*').length;
              out.paths = document.querySelectorAll('#edges path').length;
              return out; }""")
            # longtask during a pan/zoom burst
            lt = await pg.evaluate("""async () => {
              const long = []; const po = new PerformanceObserver(l => l.getEntries().forEach(e => long.push(Math.round(e.duration))));
              po.observe({type: 'longtask', buffered: false});
              const stage = document.querySelector('#stage'); const r = stage.getBoundingClientRect();
              const frames = []; let last = performance.now();
              for (let i = 0; i < 40; i++) {
                stage.dispatchEvent(new WheelEvent('wheel', {deltaY: i % 2 ? 60 : -60, ctrlKey: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, bubbles: true}));
                await new Promise(res => requestAnimationFrame(res));
                const now = performance.now(); frames.push(now - last); last = now;
              }
              po.disconnect(); frames.sort((a,b)=>a-b);
              return {longtasks: long, p50: +frames[20].toFixed(1), p95: +frames[38].toFixed(1), max: +frames[39].toFixed(1)}; }""")
            print(pid, json.dumps(r), "zoom-frames", json.dumps(lt))
        await b.close()
asyncio.run(main())
