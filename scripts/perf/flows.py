"""The major user flows, end to end, through the real page (no LLM spend).

Each step asserts what a user would see; failures are screenshotted.

usage: flows.py <base> <outdir> <pid with jobs+evals+playground> <pid with a nested graph>
"""
import asyncio
import sys
import time

from playwright.async_api import async_playwright

BASE, OUT, PID, BIG = sys.argv[1:5]
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await (await b.new_context(viewport={"width": 1440, "height": 900})).new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        async def step(name, fn):
            try:
                await fn()
            except Exception as exc:  # noqa: BLE001
                ok(f"{name} (raised)", False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:160]}")
                await pg.screenshot(path=f"{OUT}/fail_{name.replace(' ', '_')}.png")

        async def tab(name):
            await pg.click(f".rail .tabs button[data-tab={name}]")
            await pg.wait_for_timeout(1200)

        # home → project
        async def home():
            await pg.goto(f"{BASE}/login")
            await pg.fill("#login-user", "root")
            await pg.fill("#login-pass", "123")
            await pg.keyboard.press("Enter")
            await pg.wait_for_url(f"{BASE}/")
            await pg.wait_for_selector(".projrow")
            ok("home lists projects with health", await pg.locator(".projrow .hdot.ok").count() > 0)
            ok("home has the assistant first", await pg.locator(".ax.hero textarea").is_visible())
            await pg.locator(f".projrow[data-pid='{PID}']").click()
            await pg.wait_for_selector(".node")
            ok("a project opens on its flow", await pg.locator(".node").count() > 2)
        await step("home", home)

        # flow → select → inspect → ask
        async def flow():
            await pg.locator(".node.cell").first.click()
            await pg.wait_for_timeout(400)
            ok("selecting an op shows the inspector", await pg.locator("#inspector h3").count() > 0)
            await pg.locator("#inspector .askbtn").click()
            await pg.wait_for_timeout(400)
            chip = await pg.locator(".ax-ctx-node").inner_text()
            ok("Ask about this puts the op on the composer", len(chip.strip()) > 0, chip.strip())
            await pg.keyboard.press("Escape")
        await step("flow", flow)

        # runs → run → workflow → replay
        async def runs():
            await tab("traces")
            rows = pg.locator(".runstable tbody tr")
            ok("runs are listed", await rows.count() > 0, str(await rows.count()))
            await rows.first.click()
            await pg.wait_for_timeout(1500)
            ok("a run opens", await pg.locator(".runhead, .tracebar, .rvhead").count() > 0 or "Tree" in await pg.content())
            await pg.locator("button:has-text('Workflow')").first.click()
            await pg.wait_for_selector(".replayctl", timeout=10000)
            await pg.locator(".replayctl button").first.click()
            await pg.wait_for_timeout(1200)
            ok("a run replays on the canvas", await pg.locator("#livebar:not([hidden])").count() == 1)
        await step("runs", runs)

        async def monitor():
            await tab("monitor")
            ok("the monitor shows tiles", await pg.locator(".stattiles, .panenote").count() > 0)
        await step("monitor", monitor)

        async def evals():
            await tab("evals")
            ok("evals list", await pg.locator(".evcard").count() > 0)
            before = await pg.locator(".evcard").first.inner_text()
            await pg.locator("button:has-text('Run eval')").click()
            t0 = time.monotonic()
            for _ in range(120):
                await pg.wait_for_timeout(500)
                txt = await pg.locator(".evcard").first.inner_text()
                if "running" not in txt and txt != before:
                    break
            ok("an eval runs and reports", "%" in await pg.locator(".evbignum").inner_text(), f"{time.monotonic() - t0:.1f}s")
        await step("evals", evals)

        async def jobs():
            await tab("jobs")
            ok("jobs list", await pg.locator(".jrow").count() > 0)
            ok("a job's runs and items show in one screen", await pg.locator(".jruns tbody tr").count() > 0)
        await step("jobs", jobs)

        async def playground():
            await tab("playground")
            await pg.wait_for_selector("#playground .playhead", timeout=30000)
            await pg.wait_for_timeout(1500)
            form = pg.locator("#playground textarea")
            if await form.count():
                await form.first.fill('{"call_id": "flows", "transcript": "please call me back tomorrow morning"}')
                await pg.locator("#playground button:has-text('Send')").click()
                await pg.wait_for_timeout(3000)
            ok("the playground answers a form", await pg.locator("#playground .playrun, #playground .chat-msg").count() > 0)
        await step("playground", playground)

        async def review():
            await tab("review")
            ok("the review queue shows a conversation", await pg.locator(".revrow").count() > 0)
        await step("review", review)

        async def settings():
            await pg.click("#btn-settings")
            await pg.wait_for_timeout(1200)
            note = await pg.locator("#retention-preview").inner_text()
            ok("settings show what the policy would delete", "deletes" in note, note)
        await step("settings", settings)

        async def alerts():
            await tab("alerts")
            ok("alerts render", await pg.locator(".alcard, .panenote").count() > 0)
        await step("alerts", alerts)

        async def services():
            await tab("services")
            ok("services render", await pg.locator(".svcrow, .panenote, #services button:has-text('Start')").count() > 0)
        await step("services", services)

        # a nested graph opens in place
        async def nested():
            await pg.goto(f"{BASE}/p/{BIG}")
            await pg.wait_for_selector(".node")
            n0 = await pg.locator(".node").count()
            await pg.click("#btn-expand")
            await pg.wait_for_timeout(800)
            ok("nested graphs open in place", await pg.locator(".node").count() > n0,
               f"{n0} → {await pg.locator('.node').count()}")
            await pg.keyboard.press("/")
            await pg.wait_for_timeout(200)
            ok("find opens with /", await pg.locator("#find:not([hidden])").count() == 1)
        await step("nested", nested)

        ok("no page errors", not errors, "; ".join(errors[:3]))
        await b.close()
    print(f"\n{sum(1 for _, c in RESULTS if c)}/{len(RESULTS)} passed")


asyncio.run(main())
