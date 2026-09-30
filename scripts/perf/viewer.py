"""A viewer's studio, through the real page (docs/TEAM_PLAN.md P5).

The admin (OX_STUDIO_USER) adds a viewer; the viewer signs in and tours
every screen: no control that would change something is visible
(`.needs-edit`), the header says "View only", a forced edit shows the
toast, the playground stays closed, and runs still open. An editor on the
same screens does see the controls (the check can fail). Screenshots
desktop and phone, light and dark.

usage: viewer.py <base> <outdir> <pid>
"""
import asyncio
import sys
import time

from playwright.async_api import async_playwright

import studio_login

BASE, OUT, PID = sys.argv[1:4]
RESULTS = []
NAME = f"view{int(time.time()) % 100000}"
TABS = ["flow", "resources", "traces", "monitor", "review", "evals", "prompts", "services", "jobs", "alerts", "settings"]

VISIBLE = """() => [...document.querySelectorAll('.needs-edit')].filter(e => {
  const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; })
  .map(e => (e.textContent || e.getAttribute('aria-label') || e.title || e.className).trim().slice(0, 40))"""


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def as_person(b, username, password, first=None, **ctx):
    c = await b.new_context(**({"viewport": {"width": 1440, "height": 900}} | ctx))
    pg = await c.new_page()
    await pg.goto(f"{BASE}/login")
    await pg.fill("#login-user", username)
    await pg.fill("#login-pass", first or password)
    await pg.keyboard.press("Enter")
    if first:
        await pg.wait_for_selector("#step-password:not([hidden])")
        await pg.fill("#pw-new", password)
        await pg.fill("#pw-again", password)
        await pg.keyboard.press("Enter")
    await pg.wait_for_url(f"{BASE}/")
    return pg


async def tour(pg, who, shots):
    seen = {}
    await pg.goto(f"{BASE}/")
    await pg.wait_for_timeout(1200)
    seen["home"] = await pg.evaluate(VISIBLE)
    if shots:
        await pg.screenshot(path=f"{OUT}/{who}_home.png")
    await pg.goto(f"{BASE}/p/{PID}")
    await pg.wait_for_selector(".node")
    for tab in TABS:
        await pg.evaluate("t => switchTab(t)", tab)
        await pg.wait_for_timeout(1500)
        if tab == "flow":
            await pg.locator(".node.cell").first.click()      # the inspector, with its editors
            await pg.wait_for_timeout(500)
        if tab == "traces" and await pg.locator(".runstable tbody tr").count():
            await pg.locator(".runstable tbody tr").first.hover()
        seen[tab] = await pg.evaluate(VISIBLE)
        if shots:
            await pg.screenshot(path=f"{OUT}/{who}_{tab}.png")
    return seen


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        admin = await (await b.new_context(viewport={"width": 1440, "height": 900})).new_page()
        await studio_login.login(admin, BASE)
        made = await admin.evaluate("""async (name) => (await fetch('/api/admin/users', {method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({username: name, name: 'Vic Viewer', role: 'viewer'})})).json()""", NAME)
        errors = []
        v = await as_person(b, NAME, "viewer-pass-1", first=made["password"])
        v.on("pageerror", lambda e: errors.append(str(e)))

        seen = await tour(v, "viewer", True)
        bad = {k: x for k, x in seen.items() if x}
        ok("a viewer's tour shows no edit control on any screen", not bad, str(bad)[:300])
        await v.goto(f"{BASE}/p/{PID}")
        await v.wait_for_selector(".node")
        ok("the header says View only", await v.locator(".viewpill").is_visible())
        # the playground stays closed, whatever opens it
        await v.evaluate("switchTab('playground')")
        await v.wait_for_timeout(500)
        tab = await v.evaluate("state.tab")
        toast = await v.locator("#toast.show").inner_text() if await v.locator("#toast.show").count() else ""
        ok("the playground stays closed, with the toast", tab != "playground" and "View only" in toast, f"{tab} / {toast}")
        await v.wait_for_timeout(3000)
        # a forced edit: the server refuses and the page says why
        await v.evaluate(f"api('/api/p/{PID}/jobs/anything/run', {{}}).catch(() => {{}})")
        await v.wait_for_timeout(300)
        toast = await v.locator("#toast.show").inner_text() if await v.locator("#toast.show").count() else ""
        ok("a forced edit shows the View only toast", "View only" in toast, toast)
        await v.screenshot(path=f"{OUT}/viewer_forced_toast.png")
        # reading still works: a run opens
        await v.evaluate("switchTab('traces')")
        await v.wait_for_timeout(1500)
        rows = v.locator(".runstable tbody tr")
        if await rows.count():
            await rows.first.click()
            await v.wait_for_timeout(1500)
            ok("a viewer opens a run", await v.locator(".runhead, .tracebar, .rvhead").count() > 0)

        # an editor on the same screens does see controls: the check is real
        ed_made = await admin.evaluate("""async (name) => (await fetch('/api/admin/users', {method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({username: name, name: 'Eddie Editor', role: 'editor'})})).json()""", NAME + "e")
        e = await as_person(b, NAME + "e", "editor-pass-1", first=ed_made["password"])
        seen_e = await tour(e, "editor", False)
        shown = sum(len(x) for x in seen_e.values())
        ok("an editor sees the same screens' controls", shown >= 8, f"{shown} controls on {sum(1 for x in seen_e.values() if x)} screens")
        await e.context.close()

        # a role changed while the page is open: the page redraws for it
        v2 = await as_person(b, NAME, "viewer-pass-1")
        await v2.goto(f"{BASE}/p/{PID}")
        await v2.wait_for_selector(".node")
        await admin.evaluate("""async (id) => fetch('/api/admin/users/' + id, {method: 'PATCH',
            headers: {'content-type': 'application/json'}, body: JSON.stringify({role: 'editor'})})""", made["user"]["id"])
        try:                                           # a promotion keeps the session: the pulse reloads the page
            await v2.wait_for_selector('body[data-role="editor"]', timeout=20000)
        except Exception:
            pass
        ok("a promotion redraws the open page for the new role",
           await v2.evaluate("document.body.dataset.role") == "editor" and not await v2.locator(".viewpill").count())
        await v2.wait_for_selector(".node")
        await admin.evaluate("""async (id) => fetch('/api/admin/users/' + id, {method: 'PATCH',
            headers: {'content-type': 'application/json'}, body: JSON.stringify({role: 'viewer'})})""", made["user"]["id"])
        try:                                           # the next pulse (held up to 8 s) hears it
            await v2.wait_for_url(f"{BASE}/login", timeout=20000)
        except Exception:
            pass
        ok("a demotion signs the open page out", v2.url.endswith("/login"), v2.url)
        await v2.context.close()

        # screenshots: desktop and phone, light and dark
        for size, (w, h) in {"desktop": (1440, 900), "phone": (390, 844)}.items():
            for theme in ("light", "dark"):
                pg = await as_person(b, NAME, "viewer-pass-1", viewport={"width": w, "height": h}, color_scheme=theme,
                                     device_scale_factor=2 if size == "phone" else 1)
                await pg.wait_for_timeout(800)
                await pg.screenshot(path=f"{OUT}/viewer_home_{size}_{theme}.png")
                await pg.goto(f"{BASE}/p/{PID}")
                await pg.wait_for_selector(".node")
                await pg.wait_for_timeout(800)
                await pg.screenshot(path=f"{OUT}/viewer_flow_{size}_{theme}.png")
                await pg.evaluate("switchTab('settings')")
                await pg.wait_for_timeout(1200)
                await pg.screenshot(path=f"{OUT}/viewer_settings_{size}_{theme}.png")
                over = await pg.evaluate("document.documentElement.scrollWidth <= innerWidth")
                ok(f"no sideways scroll ({size} {theme})", over)
                await pg.context.close()

        for uid in (made["user"]["id"], ed_made["user"]["id"]):
            await admin.evaluate("async (id) => fetch('/api/admin/users/' + id, {method: 'DELETE'})", uid)
        ok("no page errors", not errors, "; ".join(errors[:3]))
        await b.close()
    print(f"\n{sum(1 for _, c in RESULTS if c)}/{len(RESULTS)} passed")
    sys.exit(0 if all(c for _, c in RESULTS) else 1)


asyncio.run(main())
