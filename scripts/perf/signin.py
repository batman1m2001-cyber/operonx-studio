"""The assistant's own Claude sign-in, through the real page (plan A5).

Automated up to the sign-in link, then cancelled: finishing a sign-in needs
a person's account (the page it opens is Claude's). Checks the account as
the usage card and Settings show it ("Using this machine's login (…)"),
the sign-in card taking the box's place, the link opened in a new tab
(intercepted: nothing is loaded from claude.com), Cancel ending the CLI's
login, a failed turn's "Sign in" button, and the phone. Leaves the studio
on the login it had.

usage: signin.py <base> <outdir> <pid>
"""
import asyncio
import json
import re
import sys

from playwright.async_api import async_playwright

import studio_login

BASE, OUT, PID = sys.argv[1:4]
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def login(pg):
    await studio_login.login(pg, BASE)


async def account(pg):
    return await pg.evaluate("fetch('/api/assistant/account?fresh=1').then(r => r.json()).then(j => j.account)")


FAKE_CODE = "good-code#fake"      # what the suite's fake `claude` accepts; a real CLI never does


async def two_people(b):
    import time as _time

    a_ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    await a_ctx.route("https://**claude.com/**", lambda r: r.abort())
    a = await a_ctx.new_page()
    await login(a)
    name = f"signin{int(_time.time()) % 100000}"
    made = await a.evaluate("""async (name) => (await fetch('/api/admin/users', {method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({username: name, name: 'Bea Signin', role: 'editor'})})).json()""", name)
    for size, (w, h) in {"desktop": (1440, 900), "phone": (390, 844)}.items():
        for theme in ("light", "dark"):
            ctx = await b.new_context(viewport={"width": w, "height": h}, color_scheme=theme,
                                      device_scale_factor=2 if size == "phone" else 1)
            await ctx.route("https://**claude.com/**", lambda r: r.abort())
            pg = await ctx.new_page()
            await pg.goto(f"{BASE}/login")
            await pg.fill("#login-user", name)
            if size == "desktop" and theme == "light":
                await pg.fill("#login-pass", made["password"])
                await pg.keyboard.press("Enter")
                await pg.wait_for_selector("#step-password:not([hidden])")
                await pg.fill("#pw-new", "bea-own-pass-1")
                await pg.fill("#pw-again", "bea-own-pass-1")
            else:
                await pg.fill("#login-pass", "bea-own-pass-1")
            await pg.keyboard.press("Enter")
            await pg.wait_for_url(f"{BASE}/")
            acc = await account(pg)
            if size == "desktop" and theme == "light":
                ok("B is not signed in, and never runs on the machine's login", acc["source"] == "none" and not acc["logged_in"],
                   f"{acc['source']} {acc['logged_in']}")
            await pg.goto(f"{BASE}/p/{PID}")
            await pg.wait_for_selector(".node")
            if size == "phone":
                await pg.wait_for_selector(".ax-askbar:visible, .ax-signin:not([hidden])")
                if await pg.locator(".ax-askbar:visible").count():
                    await pg.click(".ax-askbar")
            else:
                await pg.evaluate("oxSide && oxSide.show('assistant')")
            # with nobody signed in, the panel opens on the sign-in card itself
            await pg.wait_for_selector(".ax-signin:not([hidden])", timeout=15000)
            await pg.wait_for_timeout(600)
            card = await pg.locator(".ax-signin").inner_text()
            ok(f"B's assistant asks B to sign in with B's own account ({size} {theme})",
               "your own Claude account" in card and "machine's login" not in card, card.replace("\n", " ")[:90])
            await pg.screenshot(path=f"{OUT}/p4_b_account_{size}_{theme}.png")
            sw = await pg.evaluate("""() => { const c = document.querySelector('.ax-signin').getBoundingClientRect();
                return document.documentElement.scrollWidth <= innerWidth && c.left >= 0 && c.right <= innerWidth; }""")
            ok(f"…and it fits ({size} {theme})", sw)
            if size == "desktop" and theme == "light":
                # A starts a sign-in; B's own does not cancel it
                la = await a.evaluate("""async () => (await (await fetch('/api/assistant/login', {method: 'POST',
                    headers: {'content-type': 'application/json'}, body: '{"method": "claudeai"}'})).json()).login_id""")
                async with ctx.expect_page() as tab_info:
                    await pg.locator(".ax-signin button", has_text="Sign in with Claude").click()
                await (await tab_info.value).close()
                await pg.wait_for_selector(".ax-signin-code", timeout=30000)
                still = await account(a)
                ok("B's sign-in leaves A's running", (still.get("login") or {}).get("id") == la, str(still.get("login")))
                steal = await pg.evaluate("async (lid) => (await fetch('/api/assistant/login/' + lid, {method: 'DELETE'})).status", la)
                ok("B can't cancel A's sign-in", steal == 404, str(steal))
                await pg.fill(".ax-signin-code", FAKE_CODE)
                await pg.keyboard.press("Enter")
                await pg.wait_for_timeout(2500)
                acc = await account(pg)
                if acc.get("source") == "studio":
                    ok("B signed in to B's own directory", "/users/" in acc["home"], acc["home"][-60:])
                    ok("…and A is still on the machine's login", (await account(a))["source"] == "machine")
                    await pg.screenshot(path=f"{OUT}/p4_b_signed_in_{size}_{theme}.png")
                    # back to not signed in, so the other screenshots show the ask
                    await pg.evaluate("fetch('/api/assistant/logout', {method: 'POST'})")
                    await pg.wait_for_timeout(800)
                else:
                    print("SKIP finishing B's sign-in: this studio's claude is not the fake one", flush=True)
                await a.evaluate("async (lid) => fetch('/api/assistant/login/' + lid, {method: 'DELETE'})", la)
            await ctx.close()
    await a.evaluate("async (id) => fetch('/api/admin/users/' + id, {method: 'DELETE'})", made["user"]["id"])
    await a_ctx.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        opened = []
        # the sign-in page is Claude's: note what was asked for, load nothing
        async def note_and_stop(route):
            opened.append(route.request.url)
            await route.abort()
        await ctx.route("https://claude.com/**", note_and_stop)
        await ctx.route("https://*.claude.com/**", note_and_stop)
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await login(pg)
        before = await account(pg)
        ok("the studio starts on this machine's login", before["source"] == "machine" and before["logged_in"], before["source"])
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.evaluate("oxSide && oxSide.show('assistant')")
        await pg.wait_for_selector(".ax.dock .ax-input")

        # 1. the usage card says whose login it is
        await pg.click(".ax-tools .ax-meter")
        await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden]) .ax-account")
        await pg.wait_for_timeout(600)
        acc = await pg.locator(".ax-pop.ax-usage .ax-account").inner_text()
        ok("the card says the machine's login is in use", acc.startswith("Using this machine's login (") and "Claude Max" in acc, acc.split("\n")[0][:40] + "…")
        ok("…and offers the studio's own sign-in", "Sign in with Claude" in acc)
        await pg.keyboard.press("Escape")

        # 2. Settings shows the same
        await pg.evaluate("switchTab('settings')")
        await pg.wait_for_selector(".setaccount .ax-account", timeout=10000)
        s = await pg.locator(".setaccount").inner_text()
        ok("Settings → Assistant shows the account", "Using this machine's login" in s)
        await pg.screenshot(path=f"{OUT}/a5_settings.png")
        await pg.evaluate("switchTab('flow')")
        await pg.wait_for_timeout(400)

        # 3. the sign-in card takes the box's place; the link opens in a new tab
        await pg.click(".ax-tools .ax-meter")
        await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden]) .ax-account")
        await pg.wait_for_timeout(500)
        await pg.locator(".ax-pop.ax-usage .ax-account button", has_text="Sign in with Claude").click()
        await pg.wait_for_selector(".ax-signin:not([hidden])")
        card = await pg.evaluate("() => ({box: !document.querySelector('.ax-input').hidden, text: document.querySelector('.ax-signin').textContent})")
        ok("the sign-in card replaces the box", not card["box"] and "Sign in with Claude" in card["text"]
           and "Console account (API billing)" in card["text"] and "SSO" in card["text"], card["text"][:60])
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f"{OUT}/a5_card_step1.png")
        async with ctx.expect_page() as tab_info:
            await pg.locator(".ax-signin button", has_text="Sign in with Claude").click()
        tab = await tab_info.value
        await pg.wait_for_selector(".ax-signin-code", timeout=30000)
        await pg.wait_for_timeout(800)
        started = await account(pg)
        url = (started.get("login") or {}).get("url", "")
        ok("the studio's CLI started a sign-in and gave its link", url.startswith("https://claude.com/cai/oauth/authorize?")
           and "redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" in url, re.sub(r"\?.*", "?…", url))
        ok("the new tab went to that link", any(u.split("?")[0] == url.split("?")[0] for u in opened) or tab.url.split("?")[0] == url.split("?")[0],
           (tab.url or "")[:50])
        step2 = await pg.locator(".ax-signin").inner_text()
        ok("step 2 asks for the code the page shows", "paste the code it shows" in step2 and "Open the sign-in page again" in step2)
        await pg.screenshot(path=f"{OUT}/a5_card_step2.png")
        await tab.close()

        # 4. Cancel ends the CLI's login; the studio keeps the login it had
        await pg.locator(".ax-signin button", has_text="Cancel").click()
        await pg.wait_for_timeout(1200)
        after = await account(pg)
        ok("Cancel ends the sign-in", after.get("login") is None, str(after.get("login")))
        ok("…and the studio is still on this machine's login", after["source"] == "machine" and after["logged_in"])
        gone = await pg.evaluate("() => document.querySelector('.ax-signin').hidden && !document.querySelector('.ax-input').hidden")
        ok("…and the box comes back", gone)

        # 5. a turn that failed for want of a sign-in offers one
        sid = await pg.evaluate(f"""fetch('/api/assistant/sessions', {{method: 'POST', headers: {{'content-type': 'application/json'}},
            body: JSON.stringify({{scope: '{PID}'}})}}).then(r => r.json()).then(j => j.session.id)""")

        async def with_auth_error(route):
            res = await route.fetch()
            data = await res.json()
            data["items"] = [{"seq": 1, "turn": "t-auth", "kind": "user", "text": "hello"},
                             {"seq": 2, "turn": "t-auth", "kind": "error", "text": "Invalid API key · Please run /login",
                              "retry": True, "auth": True},
                             {"seq": 3, "turn": "t-auth", "kind": "turn_end", "state": "failed"}]
            await route.fulfill(response=res, body=json.dumps(data), headers={**res.headers, "content-type": "application/json"})
        await pg.route(f"**/api/assistant/sessions/{sid}", with_auth_error)
        await pg.evaluate("sid => oxAssistant.open(sid)", sid)
        await pg.wait_for_selector(".ax-error")
        await pg.locator(".ax-error button", has_text="Sign in").click()
        await pg.wait_for_selector(".ax-signin:not([hidden])")
        why = await pg.locator(".ax-signin").inner_text()
        ok("a failed turn's Sign in opens the card", "needs a Claude sign-in" in why, why[:80])
        await pg.locator(".ax-signin button", has_text="Not now").click()
        await pg.unroute(f"**/api/assistant/sessions/{sid}")
        await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", sid)
        ok("no page errors", not errors, "; ".join(errors[:3]))
        await ctx.close()

        # 6. the phone: the card in the sheet
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        pg = await ctx.new_page()
        await login(pg)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.click(".ax-askbar")
        await pg.wait_for_selector(".ax.sheet")
        await pg.click(".ax-tools .ax-meter")
        await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden]) .ax-account")
        await pg.wait_for_timeout(600)
        await pg.locator(".ax-pop.ax-usage .ax-account button", has_text="Sign in with Claude").click()
        await pg.wait_for_selector(".ax-signin:not([hidden])")
        await pg.wait_for_timeout(300)
        r = await pg.evaluate("() => { const b = document.querySelector('.ax-signin').getBoundingClientRect(); return {l: b.left, r: b.right, w: innerWidth, sw: document.documentElement.scrollWidth}; }")
        ok("the card fits the phone", r["l"] >= 0 and r["r"] <= r["w"] and r["sw"] <= r["w"], str(r))
        await pg.screenshot(path=f"{OUT}/a5_phone.png")
        await pg.locator(".ax-signin button", has_text="Not now").click()
        await ctx.close()

        # 7. two people (docs/TEAM_PLAN.md P4): B is not the machine login's
        # owner, so B's assistant is not signed in until B signs in — in B's
        # own directory; B's sign-in does not cancel A's; each account is its
        # own. Finishing needs the fake CLI's code (FAKE_CODE); with a real
        # CLI the section stops at the link, like the steps above.
        await two_people(b)
        await b.close()
    passed = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n{passed}/{len(RESULTS)} passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


asyncio.run(main())
