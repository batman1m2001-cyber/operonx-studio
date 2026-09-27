"""Measure the studio as a user meets it: requests, bytes and wall time
for home, project open and every screen. Prints one JSON line per step.

usage: audit.py <base> <pid> [<pid> ...] <tag>    (writes audit_<tag>.json)
       audit.py ... | python fmt.py                (a readable table)

A screen is "ready" when no request other than the long polls has been
in flight for 500 ms. Needs playwright (pip install playwright;
playwright install chromium). Log-in is root/123, the studio default.
"""
import asyncio
import json
import sys
import time

from playwright.async_api import async_playwright

BASE = sys.argv[1]
PIDS = sys.argv[2:-1]
TAG = sys.argv[-1]
TABS = ["flow", "playground", "resources", "traces", "monitor", "review", "evals", "prompts",
        "services", "jobs", "alerts", "settings"]


async def main():
    out = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        pg = await ctx.new_page()
        reqs = []
        pg.on("requestfinished", lambda r: reqs.append(r))
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        inflight = set()
        LONG = ("/stamp", "/ui/actions", "/chat/turn/", "/play/events", "/pulse", "/assistant/turns/")
        def _on(r):
            if not any(k in r.url for k in LONG):
                inflight.add(r)
        pg.on("request", _on)
        pg.on("requestfinished", lambda r: inflight.discard(r))
        pg.on("requestfailed", lambda r: inflight.discard(r))

        async def settle(ms=500, cap=15000):
            # quiet: no (non-poll) request in flight for `ms`
            t0 = time.monotonic(); quiet = None
            await asyncio.sleep(0.05)
            while time.monotonic() - t0 < cap / 1000:
                if inflight:
                    quiet = None
                elif quiet is None:
                    quiet = time.monotonic()
                elif time.monotonic() - quiet >= ms / 1000:
                    return quiet - t0
                await asyncio.sleep(0.02)
            print("  (still waiting on:", [r.url.replace(BASE, "")[:80] for r in inflight], ")")
            return time.monotonic() - t0

        async def tally(label, t0, ready=None):
            sizes = []
            for r in list(reqs):
                try:
                    s = await r.sizes()
                    sizes.append((r.url.replace(BASE, ""), s["responseBodySize"], r.timing.get("responseEnd", 0)))
                except Exception:
                    sizes.append((r.url.replace(BASE, ""), 0, 0))
            api = [s for s in sizes if "/api/" in s[0]]
            row = {"step": label, "ms": round(((ready if ready is not None else time.monotonic() - t0)) * 1000), "requests": len(sizes),
                   "api": len(api), "kb": round(sum(s[1] for s in sizes) / 1024),
                   "api_kb": round(sum(s[1] for s in api) / 1024),
                   "slowest": sorted(((round(s[2]), s[0][:70]) for s in sizes), reverse=True)[:4],
                   "urls": sorted({s[0].split("?")[0] for s in api})}
            out.append(row)
            print(json.dumps(row))
            reqs.clear()

        await pg.goto(f"{BASE}/login")
        await pg.fill("#login-user", "root")
        await pg.fill("#login-pass", "123")
        await pg.keyboard.press("Enter")
        await pg.wait_for_url(f"{BASE}/")
        reqs.clear()
        t0 = time.monotonic()
        await pg.goto(f"{BASE}/")
        await pg.wait_for_selector(".projrow", timeout=30000)
        await tally("home:first-paint", t0)
        await settle()
        await tally("home:idle-extra", time.monotonic())

        for pid in PIDS:
            inflight.clear()  # a navigation aborts requests without a finished event
            reqs.clear()
            t0 = time.monotonic()
            await pg.goto(f"{BASE}/p/{pid}")
            await pg.wait_for_selector(".node", timeout=90000)
            await tally(f"{pid}:flow-first-node", t0)
            inflight.clear()
            t1 = time.monotonic()
            try:
                await settle(cap=8000)
            except Exception:
                pass
            await tally(f"{pid}:flow-idle-extra", t1)
            # count polling over 10s of doing nothing
            t2 = time.monotonic()
            await pg.wait_for_timeout(10000)
            await tally(f"{pid}:10s-idle", t2)
            for tab in TABS[1:]:
                t3 = time.monotonic()
                btn = pg.locator(f"[data-tab={tab}], [data-tabbtn={tab}]").first
                await btn.click()
                took = await settle(cap=20000)
                await tally(f"{pid}:{tab}", t3, took + 0.05)
            nodes = await pg.evaluate("document.querySelectorAll('*').length")
            out.append({"step": f"{pid}:dom-nodes", "n": nodes})
        out.append({"errors": errors})
        print("ERRORS", errors)
        await b.close()
    json.dump(out, open(f"audit_{TAG}.json", "w"), indent=1)  # in the working directory


asyncio.run(main())
