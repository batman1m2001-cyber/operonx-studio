"""Screenshot the studio's main surfaces, desktop and phone.

usage: tour.py <base> <outdir> <pid> [small_pid]
"""
import asyncio
import sys

from playwright.async_api import async_playwright

import studio_login

BASE, OUT, PID = sys.argv[1], sys.argv[2], sys.argv[3]


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, vp, mob in [("desk", {"width": 1440, "height": 900}, False),
                              ("mob", {"width": 390, "height": 844}, True)]:
            ctx = await b.new_context(viewport=vp, is_mobile=mob, has_touch=mob, device_scale_factor=2 if mob else 1)
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: print("PAGEERROR", e))
            await pg.goto(f"{BASE}/login")
            await pg.screenshot(path=f"{OUT}/{name}_login.png")
            await studio_login.submit(pg, BASE)
            await pg.wait_for_timeout(800)
            await pg.screenshot(path=f"{OUT}/{name}_home.png")
            await pg.goto(f"{BASE}/p/{PID}")
            await pg.wait_for_selector(".node", timeout=90000)
            await pg.wait_for_timeout(800)
            await pg.screenshot(path=f"{OUT}/{name}_flow.png")
            # the assistant
            if mob:
                await pg.click(".chat-fab")
            else:
                await pg.evaluate("window.oxSide && window.oxSide.show('assistant')")
            await pg.wait_for_timeout(500)
            await pg.screenshot(path=f"{OUT}/{name}_assistant.png")
            if mob:
                await pg.goto(f"{BASE}/p/{PID}")
                await pg.wait_for_selector(".node", timeout=90000)
            for tab in ["traces", "monitor", "playground", "evals"]:
                if mob:
                    await pg.click("#btn-screen")
                    await pg.wait_for_timeout(300)
                    await pg.click(f".rail .tabs button[data-tab={tab}]")
                else:
                    await pg.click(f".rail .tabs button[data-tab={tab}]")
                await pg.wait_for_timeout(1500)
                await pg.screenshot(path=f"{OUT}/{name}_{tab}.png")
            await ctx.close()
        await b.close()


asyncio.run(main())
