"""Own conversations, through the real page (docs/TEAM_PLAN.md P3).

Two people in two browsers, in one project: A (OX_STUDIO_USER) adds B,
B signs in; each talks to the assistant; each one's conversation list and
home page show only their own; B's turn is still running when A's makes an
edit, so A's changes card says someone else's assistant was working there
too. Screenshots of that card and of each person's list, desktop and phone,
light and dark. Needs a studio whose `claude` is the fake one (a turn with
SLOW runs 30 s; EDIT writes a file) and a project that is a git checkout.

usage: owners.py <base> <outdir> <pid, a git checkout>
"""
import asyncio
import json
import sys
import time

import studio_login
from playwright.async_api import async_playwright

BASE, OUT, PID = sys.argv[1:4]
RESULTS = []
B_NAME = f"bee{int(time.time()) % 100000}"


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def open_panel(pg):
    await pg.goto(f"{BASE}/p/{PID}")
    await pg.wait_for_selector(".node")
    await pg.evaluate("oxSide && oxSide.show('assistant')")
    await pg.wait_for_selector(".ax .ax-input")
    await pg.click(".ax-b-new")
    await pg.wait_for_timeout(300)


async def say(pg, text):
    await pg.locator(".ax-input textarea").fill(text)
    await pg.locator(".ax-input textarea").press("Enter")


async def titles(pg):
    """The conversation list as the panel shows it."""
    await pg.click(".ax-b-sessions")
    await pg.wait_for_timeout(800)
    got = await pg.locator(".ax-side .ax-row-title").all_inner_texts()
    return got


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errors = []
        a = await (await b.new_context(viewport={"width": 1440, "height": 900})).new_page()
        a.on("pageerror", lambda e: errors.append(str(e)))
        await studio_login.login(a, BASE)
        made = await a.evaluate("""async (name) => {
            const r = await fetch('/api/admin/users', {method: 'POST', headers: {'content-type': 'application/json'},
                                   body: JSON.stringify({username: name, name: 'Bee Example', role: 'editor'})});
            return r.json(); }""", B_NAME)
        bp = await (await b.new_context(viewport={"width": 1440, "height": 900})).new_page()
        bp.on("pageerror", lambda e: errors.append(str(e)))
        await bp.goto(f"{BASE}/login")
        await bp.fill("#login-user", B_NAME)
        await bp.fill("#login-pass", made["password"])
        await bp.keyboard.press("Enter")
        await bp.wait_for_selector("#step-password:not([hidden])")
        await bp.fill("#pw-new", "bee-own-pass-1")
        await bp.fill("#pw-again", "bee-own-pass-1")
        await bp.keyboard.press("Enter")
        await bp.wait_for_url(f"{BASE}/")

        # both in one project; B's turn runs on while A's edits
        await open_panel(a)
        await open_panel(bp)
        await say(bp, "SLOW — B works in this project")
        await bp.wait_for_timeout(1500)
        await say(a, "EDIT — A changes a file")
        await a.wait_for_selector(".ax-changes", timeout=30000)
        note = a.locator(".ax-changes .ax-overlap")
        ok("A's changes card says B's assistant worked there too",
           await note.count() == 1 and "Bee Example" in await note.inner_text(),
           (await note.inner_text()) if await note.count() else "no note")
        await a.locator(".ax-changes").scroll_into_view_if_needed()
        await a.screenshot(path=f"{OUT}/overlap_card_desktop_light.png")

        # each one's list: only their own
        ta, tb = await titles(a), await titles(bp)
        ok("A's list has only A's conversation", any("A changes" in t for t in ta) and not any("B works" in t for t in ta), json.dumps(ta))
        ok("B's list has only B's conversation", any("B works" in t for t in tb) and not any("A changes" in t for t in tb), json.dumps(tb))
        await bp.screenshot(path=f"{OUT}/list_b_desktop_light.png")
        await a.screenshot(path=f"{OUT}/list_a_desktop_light.png")
        # the home page's recent conversations too
        await bp.goto(f"{BASE}/")
        await bp.wait_for_timeout(800)
        recent_b = await bp.locator("#recent").inner_text()
        ok("B's home page lists only B's conversations", "A changes" not in recent_b and "B works" in recent_b,
           recent_b.replace("\n", " / ")[:120])
        # B cannot open A's conversation by its address
        sid_a = await a.evaluate("async () => (await (await fetch('/api/assistant/sessions')).json()).sessions[0].id")
        code = await bp.evaluate("async (sid) => (await fetch('/api/assistant/sessions/' + sid)).status", sid_a)
        ok("B asking for A's conversation gets 404", code == 404, str(code))

        # the overlap card, desktop and phone, light and dark (A's conversation)
        for size, (w, h) in {"desktop": (1440, 900), "phone": (390, 844)}.items():
            for theme in ("light", "dark"):
                ctx = await b.new_context(viewport={"width": w, "height": h}, color_scheme=theme,
                                          device_scale_factor=2 if size == "phone" else 1)
                pg = await ctx.new_page()
                await studio_login.login(pg, BASE)
                await pg.goto(f"{BASE}/p/{PID}#assistant={sid_a}")
                await pg.wait_for_selector(".ax-changes", timeout=30000)
                if size == "phone":
                    await pg.wait_for_timeout(600)
                card = pg.locator(".ax-changes").last
                await card.scroll_into_view_if_needed()
                await pg.wait_for_timeout(300)
                await pg.screenshot(path=f"{OUT}/overlap_{size}_{theme}.png")
                over = await pg.evaluate("""() => { const c = document.querySelector('.ax-changes .ax-overlap');
                    if (!c) return 'missing'; const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect();
                    return (r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && c.scrollWidth <= c.clientWidth + 1) ? '' : 'overflows'; }""")
                ok(f"the note fits its card ({size} {theme})", over == "", over)
                await ctx.close()

        # clean up: B's turn, then B
        await bp.evaluate("""async () => { const s = (await (await fetch('/api/assistant/sessions')).json()).sessions;
            for (const x of s) if (x.running_turn) await fetch('/api/assistant/turns/' + x.running_turn + '/stop', {method: 'POST'}); }""")
        await a.evaluate("async (id) => fetch('/api/admin/users/' + id, {method: 'DELETE'})", made["user"]["id"])
        ok("no page errors", not errors, "; ".join(errors[:3]))
        await b.close()
    print(f"\n{sum(1 for _, c in RESULTS if c)}/{len(RESULTS)} passed")
    sys.exit(0 if all(c for _, c in RESULTS) else 1)


asyncio.run(main())
