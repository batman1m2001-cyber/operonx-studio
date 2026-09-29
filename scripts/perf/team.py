"""The Team page and the account menu, through the real page (docs/TEAM_PLAN.md P2).

The admin (OX_STUDIO_USER / OX_STUDIO_PASS) adds a person and gets their
password once; a second browser signs in as them and chooses its own; the
admin disables them and that browser's next request goes to /login; the
guards (your own row, the last active admin) show before anyone hits them;
the person is deleted again. Then screenshots of the Team page, the add
sheet, the password card and the account menu — desktop 1440×900 and phone
390×844, light and dark — with a geometry check on each.

usage: team.py <base> <outdir>
"""
import asyncio
import json
import sys
import time

from playwright.async_api import async_playwright

import studio_login

BASE, OUT = sys.argv[1:3]
RESULTS = []
NAME = f"gate{int(time.time()) % 100000}"

GEOM = """() => {
  const out = [];
  const W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1) out.push('horizontal scroll ' + document.documentElement.scrollWidth + ' > ' + W);
  for (const e of document.querySelectorAll('.modal, .popover:not([hidden]), .teamrow, .roleguide > div')) {
    const r = e.getBoundingClientRect();
    if (r.width && (r.left < -0.5 || r.right > W + 0.5)) out.push('off screen: ' + e.className);
  }
  for (const e of document.querySelectorAll('.teamrow .name, .acctfull, .modal h2')) {
    if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis') out.push('cut: ' + e.textContent);
  }
  return out;
}"""


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def row(pg, username):
    return pg.locator(f".teamrow[data-user='{username}']")


async def flow(b):
    admin = await (await b.new_context(viewport={"width": 1440, "height": 900})).new_page()
    errors = []
    admin.on("pageerror", lambda e: errors.append(str(e)))
    await studio_login.login(admin, BASE)
    await admin.click("#btn-account")
    ok("the account menu names you and offers the Team page",
       studio_login.USER in await admin.locator(".acctmenu").inner_text()
       and await admin.locator(".acctmenu .menuitem:has-text('Team')").count() == 1)
    await admin.click(".acctmenu .menuitem:has-text('Team')")
    await admin.wait_for_url(f"{BASE}/team")
    await admin.wait_for_selector(".teamrow")

    # your own row can't lose its access
    me = await row(admin, studio_login.USER)
    ok("your own role can't be changed here", await me.locator(".rolepick").is_disabled())

    # add someone: a password shown once
    await admin.click("#btn-add")
    await admin.fill(".modal input >> nth=0", NAME)
    await admin.fill(".modal input >> nth=1", "Gate Person")
    await admin.select_option(".modal select", "editor")
    await admin.click(".modal button[type=submit]")
    await admin.wait_for_selector("#pw-once")
    temp = await admin.input_value("#pw-once")
    ok("adding someone shows their password once", len(temp) >= 12, f"{len(temp)} characters")
    await admin.click(".modal button:has-text('Done')")
    await admin.wait_for_selector(f".teamrow[data-user='{NAME}']")
    ok("…and they are listed, waiting to choose a password",
       "Password to choose" in await (await row(admin, NAME)).inner_text())

    # a second browser: they sign in and choose their own
    other = await (await b.new_context(viewport={"width": 390, "height": 844})).new_page()
    await other.goto(f"{BASE}/login")
    await other.fill("#login-user", NAME)
    await other.fill("#login-pass", temp)
    await other.keyboard.press("Enter")
    await other.wait_for_selector("#step-password:not([hidden])")
    ok("their first sign-in asks for their own password", True)
    await other.fill("#pw-new", "their-own-pass-1")
    await other.fill("#pw-again", "their-own-pass-1")
    await other.keyboard.press("Enter")
    await other.wait_for_url(f"{BASE}/")
    ok("…and then the studio opens", await other.locator("#btn-account").count() == 1)
    await other.click("#btn-account")
    menu = await other.locator(".acctmenu").inner_text()
    ok("an editor's menu has no Team entry", "Team" not in menu and "Editor" in menu, menu.replace("\n", " / "))
    await other.keyboard.press("Escape")

    # the admin disables them: their next request goes to /login
    await admin.reload()
    await admin.wait_for_selector(f".teamrow[data-user='{NAME}']")
    await (await row(admin, NAME)).locator(".more").click()
    await admin.click(".rowmenu .menuitem:has-text('Disable')")
    await admin.wait_for_selector(f".teamrow.off[data-user='{NAME}']")
    ok("disabling shows on their row", True)
    await other.goto(f"{BASE}/")
    ok("the disabled person's next request goes to /login", other.url.endswith("/login"), other.url)
    await other.fill("#login-user", NAME)
    await other.fill("#login-pass", "their-own-pass-1")
    await other.keyboard.press("Enter")
    await other.wait_for_selector("#login-err:not(:empty)")
    ok("…and they can't sign in again", "disabled" in await other.inner_text("#login-err"))

    # the last active admin's guard: shown on the admin's own row when alone
    admins = await admin.evaluate("async () => (await (await fetch('/api/admin/users')).json()).users"
                                  ".filter(u => u.role === 'admin' && !u.disabled).length")
    if admins == 1:
        ok("the last active admin's row says it keeps its access",
           "last active admin" in await me.inner_text() and await me.locator(".rolepick").is_disabled())
        await me.locator(".more").click()
        ok("…and its Disable and Delete are off",
           await admin.locator(".rowmenu .menuitem:has-text('Disable')").is_disabled()
           and await admin.locator(".rowmenu .menuitem:has-text('Delete')").is_disabled())
        await admin.keyboard.press("Escape")
    # a demotion the server refuses surfaces as a toast, not silence
    res = await admin.evaluate(f"""async () => {{
        const me = (await (await fetch('/api/me')).json()).user.id;
        const r = await fetch('/api/admin/users/' + me, {{method: 'PATCH', headers: {{'content-type': 'application/json'}},
                                                         body: JSON.stringify({{role: 'viewer'}})}});
        return [r.status, (await r.json()).error]; }}""")
    ok("the server refuses your own demotion too", res[0] == 400, res[1])

    # clean up: delete them
    await (await row(admin, NAME)).locator(".more").click()
    await admin.click(".rowmenu .menuitem:has-text('Delete')")
    await admin.click(".modal button:has-text('Delete')")
    await admin.wait_for_selector(f".teamrow[data-user='{NAME}']", state="detached")
    ok("deleting takes them off the list", True)
    ok("no page errors", not errors, "; ".join(errors[:3]))
    await admin.context.close()
    await other.context.close()


async def shots(b):
    problems = {}
    for size, (w, h) in {"desktop": (1440, 900), "phone": (390, 844)}.items():
        for theme in ("light", "dark"):
            ctx = await b.new_context(viewport={"width": w, "height": h}, color_scheme=theme,
                                      device_scale_factor=2 if size == "phone" else 1)
            pg = await ctx.new_page()
            await studio_login.login(pg, BASE)
            tag = f"{size}_{theme}"
            await pg.click("#btn-account")
            await pg.wait_for_timeout(150)
            await pg.screenshot(path=f"{OUT}/account_menu_home_{tag}.png")
            problems[f"account_menu_home_{tag}"] = await pg.evaluate(GEOM)
            pid = await pg.evaluate("async () => ((await (await fetch('/api/projects')).json()).projects[0] || {}).id")
            if pid:
                await pg.goto(f"{BASE}/p/{pid}")
                await pg.wait_for_selector("#btn-account")
                await pg.wait_for_timeout(600)
                await pg.click("#btn-account")
                await pg.wait_for_timeout(150)
                await pg.screenshot(path=f"{OUT}/account_menu_project_{tag}.png")
                problems[f"account_menu_project_{tag}"] = await pg.evaluate(GEOM)
            await pg.goto(f"{BASE}/team")
            await pg.wait_for_selector(".teamrow")
            await pg.wait_for_timeout(200)
            await pg.screenshot(path=f"{OUT}/team_{tag}.png", full_page=True)
            problems[f"team_{tag}"] = await pg.evaluate(GEOM)
            await pg.click("#btn-add")
            await pg.fill(".modal input >> nth=0", f"{NAME}{size[0]}{theme[0]}")
            await pg.fill(".modal input >> nth=1", "Ann Example-Longname")
            await pg.wait_for_timeout(150)
            await pg.screenshot(path=f"{OUT}/team_add_{tag}.png")
            problems[f"team_add_{tag}"] = await pg.evaluate(GEOM)
            await pg.click(".modal button[type=submit]")
            await pg.wait_for_selector("#pw-once")
            await pg.wait_for_timeout(150)
            await pg.screenshot(path=f"{OUT}/team_password_{tag}.png")
            problems[f"team_password_{tag}"] = await pg.evaluate(GEOM)
            await pg.click(".modal button:has-text('Done')")
            await pg.wait_for_timeout(300)
            r = pg.locator(f".teamrow[data-user='{NAME}{size[0]}{theme[0]}']")
            await r.locator(".more").click()
            await pg.wait_for_timeout(150)
            await pg.screenshot(path=f"{OUT}/team_rowmenu_{tag}.png")
            problems[f"team_rowmenu_{tag}"] = await pg.evaluate(GEOM)
            await pg.click(".rowmenu .menuitem:has-text('Delete')")
            await pg.click(".modal button:has-text('Delete')")
            await pg.wait_for_timeout(300)
            await ctx.close()
    bad = {k: v for k, v in problems.items() if v}
    ok("screenshots: no layout problems", not bad, json.dumps(bad)[:400])


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await flow(b)
        await shots(b)
        await b.close()
    print(f"\n{sum(1 for _, c in RESULTS if c)}/{len(RESULTS)} passed")
    sys.exit(0 if all(c for _, c in RESULTS) else 1)


asyncio.run(main())
