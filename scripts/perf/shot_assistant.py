"""Screenshots of the assistant in its placements, desktop and phone.

usage: shot_assistant.py <base> <outdir> <pid> [<session id in that project>]
"""
import asyncio
import sys

from playwright.async_api import async_playwright

BASE, OUT, PID = sys.argv[1], sys.argv[2], sys.argv[3]
SID = sys.argv[4] if len(sys.argv) > 4 else ""


async def login(pg):
    await pg.goto(f"{BASE}/login")
    await pg.fill("#login-user", "root")
    await pg.fill("#login-pass", "123")
    await pg.keyboard.press("Enter")
    await pg.wait_for_url(f"{BASE}/")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # desktop
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: print("PAGEERROR", e))
        await login(pg)
        await pg.wait_for_timeout(700)
        await pg.screenshot(path=f"{OUT}/desk_home.png")
        await pg.screenshot(path=f"{OUT}/desk_home_full.png", full_page=True)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path=f"{OUT}/desk_dock_empty.png")
        await pg.click(".ax-b-sessions")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f"{OUT}/desk_dock_sessions.png")
        await pg.click(".ax-b-sessions")
        if SID:
            await pg.goto(f"{BASE}/p/{PID}#assistant={SID}")
            await pg.wait_for_selector(".ax.focus .ax-turn", timeout=15000)
            await pg.wait_for_timeout(800)
            await pg.screenshot(path=f"{OUT}/desk_focus_session.png")
            await pg.click(".ax-act-head")
            await pg.wait_for_timeout(300)
            steps = pg.locator(".ax-step-head.more")
            if await steps.count():
                await steps.first.click()
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f"{OUT}/desk_focus_activity.png")
            await pg.click(".ax-b-info")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f"{OUT}/desk_focus_details.png")
            await pg.keyboard.press("Escape")
            await pg.click(".ax-title")
            await pg.mouse.click(10, 10)
            await pg.locator(".ax textarea").fill("/")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f"{OUT}/desk_focus_slash.png")
            await pg.locator(".ax textarea").fill("")
            await pg.click(".ax-b-focus")
            await pg.wait_for_timeout(600)
            await pg.screenshot(path=f"{OUT}/desk_dock_session.png")
        await ctx.close()
        # phone
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                  device_scale_factor=2)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: print("PAGEERROR", e))
        await login(pg)
        await pg.wait_for_timeout(700)
        await pg.screenshot(path=f"{OUT}/mob_home.png")
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.wait_for_timeout(1000)
        await pg.screenshot(path=f"{OUT}/mob_flow_askbar.png")
        await pg.click(".ax-askbar")
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path=f"{OUT}/mob_sheet.png")
        if SID:
            await pg.goto(f"{BASE}/p/{PID}#assistant={SID}")
            await pg.wait_for_selector(".ax.sheet .ax-turn", timeout=15000)
            await pg.wait_for_timeout(800)
            await pg.screenshot(path=f"{OUT}/mob_sheet_session.png")
            await pg.click(".ax-b-sessions")
            await pg.wait_for_timeout(600)
            await pg.screenshot(path=f"{OUT}/mob_sheet_sessions.png")
        await ctx.close()
        await b.close()


asyncio.run(main())
