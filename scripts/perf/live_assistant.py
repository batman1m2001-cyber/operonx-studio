"""Drive the real assistant through the real page, with the real CLI.

Each step asserts what a user would see and saves a screenshot. It
spends real Claude usage (the host's login), on haiku: about $0.5.

usage: live_assistant.py <base> <outdir> <pid> <project root>
"""
import asyncio
import subprocess
import sys
import time

from playwright.async_api import async_playwright

import studio_login

BASE, OUT, PID, ROOT = sys.argv[1:5]
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def wait_idle(pg, timeout=180):
    """Until the turn on screen is done."""
    t0 = time.monotonic()
    await pg.wait_for_timeout(600)
    while time.monotonic() - t0 < timeout:
        busy = await pg.evaluate("document.querySelector('.ax').classList.contains('busy')")
        if not busy:
            return time.monotonic() - t0
        await pg.wait_for_timeout(300)
    raise TimeoutError("the turn did not finish")


async def step(pg, name, fn):
    """One scenario; a failure is recorded with a screenshot, not fatal."""
    try:
        await fn()
    except Exception as exc:  # noqa: BLE001
        ok(f"{name} (raised)", False, f"{type(exc).__name__}: {str(exc).splitlines()[0][:160]}")
        await pg.screenshot(path=f"{OUT}/fail_{name.replace(' ', '_')}.png")


async def send(pg, text):
    box = pg.locator(".ax textarea")
    await box.fill(text)
    await box.press("Enter")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await studio_login.login(pg, BASE)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.keyboard.press("Control+j")
        await pg.wait_for_timeout(500)
        ok("focus mode opens on Ctrl J", await pg.locator(".ax.focus").count() == 1)
        await pg.click(".ax-b-new")

        nonlocal_state = {}

        # 1. a question, streamed
        async def s1():
            await send(pg, "/model haiku")
            await pg.wait_for_timeout(1500)
            t0 = time.monotonic()
            await send(pg, "In two sentences: what does the op `scored` do? Read the code first.")
            await pg.wait_for_selector(".ax-status:not([hidden])", timeout=15000)
            await pg.wait_for_selector(".ax-text", timeout=90000)
            first = time.monotonic() - t0
            await pg.screenshot(path=f"{OUT}/live_1_streaming.png")
            took = await wait_idle(pg)
            text = await pg.locator(".ax-text").last.inner_text()
            ok("a question gets a streamed answer", len(text) > 40, f"first text {first:.1f}s, done {first + took:.1f}s")
            ok("the model pin shows Haiku", "Haiku" in await pg.locator(".ax-model").inner_text())
            steps = await pg.locator(".ax-act").count()
            ok("its reading shows as activity", steps >= 1)
            title = await pg.locator(".ax-title span").inner_text()
            ok("the conversation gets a title", title and title != "New conversation", title)
            await pg.screenshot(path=f"{OUT}/live_1_done.png")
        await step(pg, "1 a question, streamed", s1)

        # 2. an edit, then undo
        async def s2():
            before = open(f"{ROOT}/main.py").read()
            await send(pg, "Add exactly one line `# reviewed by the assistant` at the very top of main.py. Change nothing else.")
            await wait_idle(pg)
            cards = pg.locator(".ax-changes")
            ok("an edit arrives as a changes card", await cards.count() >= 1)
            changed = open(f"{ROOT}/main.py").read()
            ok("the file really changed", changed != before and "reviewed by the assistant" in changed)
            await pg.screenshot(path=f"{OUT}/live_2_changes.png")
            await cards.last.locator("button:has-text('Undo')").click()
            await pg.wait_for_timeout(1500)
            ok("Undo puts the file back", open(f"{ROOT}/main.py").read() == before)
            ok("the card says undone", "Undone" in await cards.last.inner_text())
        await step(pg, "2 an edit, then undo", s2)

        # 3. stop
        async def s3():
            texts = await pg.locator(".ax-text").count()
            await send(pg, "Count from 1 to 400, one number per line, no other text.")
            for _ in range(200):          # until THIS turn has written something
                if await pg.locator(".ax-text").count() > texts:
                    break
                await pg.wait_for_timeout(200)
            await pg.wait_for_timeout(1200)
            await pg.click(".ax-stop")
            await wait_idle(pg, 30)
            foot = await pg.locator(".ax-turn.last .ax-turnfoot").inner_text()
            ok("Stop ends the turn and keeps what was written", "Stopped" in foot and
               len(await pg.locator(".ax-turn.last .ax-text").last.inner_text()) > 0, foot.strip())
            await pg.screenshot(path=f"{OUT}/live_3_stopped.png")
        await step(pg, "3 stop", s3)

        # 4. regenerate the last answer
        async def s4():
            n_turns = await pg.locator(".ax-turn").count()
            await pg.locator(".ax-turn.last").hover()
            await pg.locator(".ax-turn.last .ax-regen").click()
            await pg.wait_for_timeout(800)
            await pg.click(".ax-stop") if await pg.locator(".ax-status:not([hidden])").count() else None
            await wait_idle(pg, 60)
            ok("Regenerate replaces the last turn, not adds one", await pg.locator(".ax-turn").count() == n_turns)
        await step(pg, "4 regenerate the last answer", s4)

        # 5. edit an earlier message
        async def s5():
            first_user = pg.locator(".ax-user").first
            await first_user.hover()
            await first_user.locator("button").click()
            ok("editing fills the composer", "scored" in await pg.locator(".ax textarea").input_value())
            await pg.locator(".ax textarea").fill("In one sentence: what does this project do?")
            await pg.locator(".ax textarea").press("Enter")
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            ok("an edit forks: one turn left", await pg.locator(".ax-turn").count() == 1)
            await pg.screenshot(path=f"{OUT}/live_5_edited.png")
        await step(pg, "5 edit an earlier message", s5)

        # 6. compact
        async def s6():
            await send(pg, "/compact")
            await wait_idle(pg, 120)
            ok("compact leaves a divider", await pg.locator(".ax-divider").count() == 1,
               await pg.locator(".ax-divider").inner_text() if await pg.locator(".ax-divider").count() else "")
        await step(pg, "6 compact", s6)

        # 7. reload mid-turn
        async def s7():
            await send(pg, "Read operonx.toml and list the jobs it declares, one per line.")
            await pg.wait_for_selector(".ax-status:not([hidden])", timeout=15000)
            await pg.wait_for_timeout(1200)
            await pg.reload()
            await pg.wait_for_selector(".node")
            await pg.keyboard.press("Control+j")
            await pg.wait_for_timeout(1500)
            reattached = await pg.evaluate("document.querySelector('.ax').classList.contains('busy')")
            await wait_idle(pg)
            ok("a reload mid-turn reattaches and finishes", await pg.locator(".ax-turn.last .ax-text").count() >= 1,
               f"busy after reload: {reattached}")
            await pg.screenshot(path=f"{OUT}/live_7_after_reload.png")
        await step(pg, "7 reload mid-turn", s7)

        # 8. sessions: new, search, archive, delete
        async def s8():
            nonlocal_state['sid_title'] = await pg.locator(".ax-title span").inner_text()
            await pg.click(".ax-b-new")
            await send(pg, "Say only the word: pong")
            await wait_idle(pg)
            await pg.wait_for_timeout(500)
            rows = await pg.locator(".ax-row").count()
            ok("two conversations in the list", rows >= 2, str(rows))
            await pg.fill(".ax-search", "pong")
            await pg.wait_for_timeout(900)
            ok("search finds by what was said", await pg.locator(".ax-row").count() >= 1)
            await pg.fill(".ax-search", "")
            await pg.wait_for_timeout(700)
            row = pg.locator(".ax-row.on")
            await row.hover()
            await row.locator(".ax-row-more").click()
            await pg.locator(".ax-opt:has-text('Archive')").click()
            await pg.wait_for_timeout(900)
            titles = await pg.locator(".ax-row-title").all_inner_texts()
            ok("archive hides it", all("pong" not in t.lower() for t in titles), str(titles[:4]))
            await pg.click(".ax-side-foot button")
            await pg.wait_for_timeout(700)
            arch = pg.locator(".ax-row").first
            await arch.hover()
            await arch.locator(".ax-row-more").click()
            pg.once("dialog", lambda d: asyncio.ensure_future(d.accept()))
            await pg.locator(".ax-opt:has-text('Delete')").click()
            await pg.wait_for_timeout(900)
            ok("delete removes it", await pg.locator(".ax-row").count() == 0)
            await pg.click(".ax-side-foot button")
            await pg.screenshot(path=f"{OUT}/live_8_sessions.png")
            ok("the first conversation is still there", nonlocal_state.get('sid_title', '') in " ".join(await pg.locator(".ax-row-title").all_inner_texts()))
            await ctx.close()
        await step(pg, "8 sessions: new, search, archive, delete", s8)

        # 9. phone: the sheet
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                  device_scale_factor=2)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await studio_login.login(pg, BASE)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.click(".ax-askbar")
        await pg.wait_for_timeout(800)
        await pg.click(".ax-b-new")
        await send(pg, "Say only: hello from the phone")
        await wait_idle(pg)
        ok("the phone sheet answers", "phone" in (await pg.locator(".ax-text").last.inner_text()).lower())
        await pg.screenshot(path=f"{OUT}/live_9_phone.png")
        await pg.click(".ax-b-close")
        await pg.wait_for_timeout(500)
        ok("closing the sheet returns to the canvas", await pg.locator(".ax.sheet").count() == 0
           and await pg.locator(".ax-askbar").is_visible())
        await ctx.close()
        await b.close()
    ok("no page errors", not errors, "; ".join(errors[:3]))
    passed = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n{passed}/{len(RESULTS)} passed")


asyncio.run(main())
