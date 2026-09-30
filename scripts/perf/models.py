"""Model and effort in the assistant, and a project's own tool servers
(plan A3, B3), through the real page.

Offline: the menu (Default, four models with what each is good for and its
window, the effort levels, "Use for new conversations"), the pill, the
/model and /effort commands, and the warning when a conversation is bigger
than a model's window. `--live` adds real turns (a few cents): a Haiku turn
at low effort, then a switch to Sonnet — the next answer is Sonnet's, and a
divider says so — and a call to the project's own `notes` server (its
.mcp.json), which the studio's `--strict-mcp-config` lets in alone.

usage: models.py <base> <outdir> <pid, with a notes server in .mcp.json> [--live]
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

import studio_login

BASE, OUT, PID = sys.argv[1:4]
LIVE = "--live" in sys.argv
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def login(pg):
    await studio_login.login(pg, BASE)


async def pill(pg):
    return (await pg.locator(".ax-model").inner_text()).strip()


async def wait_idle(pg, timeout=180):
    for _ in range(timeout * 2):
        if not await pg.evaluate("document.querySelector('.ax').classList.contains('busy')"):
            return
        await pg.wait_for_timeout(500)
    raise TimeoutError("the turn did not finish")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await login(pg)
        await pg.evaluate("localStorage.clear()")
        saved = await pg.evaluate("fetch('/api/assistant/models').then(r => r.json()).then(j => j.studio_defaults)")
        await pg.evaluate("fetch('/api/assistant/defaults', {method: 'PUT', headers: {'content-type': 'application/json'}, body: '{}'})")
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.evaluate("oxSide && oxSide.show('assistant')")
        await pg.wait_for_selector(".ax.dock .ax-input")
        await pg.click(".ax-b-new")
        box = pg.locator(".ax-input textarea")
        sid = await pg.evaluate(f"""fetch('/api/assistant/sessions', {{method: 'POST', headers: {{'content-type': 'application/json'}},
            body: JSON.stringify({{scope: '{PID}'}})}}).then(r => r.json()).then(j => j.session.id)""")
        await pg.evaluate("sid => oxAssistant.open(sid)", sid)
        await pg.wait_for_timeout(700)

        # 1. the menu
        await pg.click(".ax-model")
        await pg.wait_for_selector(".ax-pop.ax-models:not([hidden])")
        rows = await pg.locator(".ax-model-opt .ax-opt-label").all_inner_texts()
        ok("the menu lists Default and four models", len(rows) == 5 and rows[0].startswith("Default"), str(rows))
        ok("…each named with its version and window", any(r.startswith("Fable 5.1") and "1M context" in r for r in rows)
           and any(r.startswith("Haiku 4.5") and "200k context" in r for r in rows), str(rows))
        subs = await pg.locator(".ax-model-opt .ax-opt-sub").all_inner_texts()
        ok("…with what each is good for", all(s.strip() for s in subs), str(subs[:2]))
        efforts = await pg.locator(".ax-effort-opt").all_inner_texts()
        ok("effort levels, Default to Max", efforts == ["Default", "Low", "Medium", "High", "Extra high", "Max"], str(efforts))
        await pg.wait_for_timeout(300)     # past its fade-in
        await pg.screenshot(path=f"{OUT}/a3_menu.png")

        # 2. choosing: the pill follows
        await pg.locator(".ax-model-opt", has_text="Sonnet").click()
        await pg.wait_for_timeout(500)
        ok("choosing Sonnet puts it on the pill", (await pill(pg)) == "Sonnet 5", await pill(pg))
        await pg.click(".ax-model")
        await pg.locator(".ax-effort-opt", has_text="High").first.click()
        await pg.wait_for_timeout(500)
        ok("choosing an effort adds it to the pill", (await pill(pg)) == "Sonnet 5 · High", await pill(pg))
        await pg.keyboard.press("Escape")

        # 3. the commands
        await box.fill("/effort xhigh")
        await box.press("Enter")
        await pg.wait_for_timeout(500)
        await box.fill("/model haiku")
        await box.press("Enter")
        await pg.wait_for_timeout(500)
        ok("/model and /effort set them", (await pill(pg)) == "Haiku 4.5 · Extra high", await pill(pg))
        s = await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid).then(r => r.json()).then(j => j.session)", sid)
        ok("…on the conversation, server-side", (s["model"], s["effort"]) == ("haiku", "xhigh"), f"{s['model']} {s['effort']}")

        # 4. use for new conversations
        await pg.click(".ax-model")
        await pg.wait_for_selector(".ax-pop.ax-models:not([hidden])")
        await pg.locator(".ax-usenew input").check()
        await pg.wait_for_timeout(500)
        d = await pg.evaluate("fetch('/api/assistant/models').then(r => r.json()).then(j => j.studio_defaults)")
        ok("'Use for new conversations' sets the studio default", d == {"model": "haiku", "effort": "xhigh"}, str(d))
        await pg.keyboard.press("Escape")
        new = await pg.evaluate(f"""fetch('/api/assistant/sessions', {{method: 'POST', headers: {{'content-type': 'application/json'}},
            body: JSON.stringify({{scope: '{PID}'}})}}).then(r => r.json()).then(j => j.session)""")
        ok("…and a new conversation starts with it", (new["model"], new["effort"]) == ("haiku", "xhigh"))
        await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", new["id"])

        # 5. a conversation bigger than a model's window is warned
        async def big(route):
            res = await route.fetch()
            data = await res.json()
            data["session"]["usage"] = dict(data["session"].get("usage") or {}, context_tokens=300_000)
            await route.fulfill(response=res, body=json.dumps(data), headers={**res.headers, "content-type": "application/json"})
        await pg.route(f"**/api/assistant/sessions/{sid}", big)
        await pg.evaluate("sid => oxAssistant.open(sid)", sid)
        await pg.wait_for_timeout(700)
        await pg.click(".ax-model")
        await pg.wait_for_selector(".ax-pop.ax-models:not([hidden])")
        warn = await pg.locator(".ax-model-opt.warn").all_inner_texts()
        ok("a model whose window is too small is warned, with Compact first",
           len(warn) == 1 and "Haiku" in warn[0] and "compact first" in warn[0], str(warn))
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f"{OUT}/a3_window_warning.png")
        await pg.keyboard.press("Escape")
        await pg.unroute(f"**/api/assistant/sessions/{sid}")

        if LIVE:
            # 6. Haiku at low effort, then Sonnet: the answers say which
            await pg.evaluate("sid => oxAssistant.open(sid)", sid)
            await pg.wait_for_timeout(600)
            await box.fill("/effort low")
            await box.press("Enter")
            await pg.wait_for_timeout(400)
            await box.fill("Say only: one")
            await box.press("Enter")
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            foot1 = await pg.locator(".ax-turn.last .ax-turnmeta").inner_text()
            ok("the answer names its model and effort", "Haiku 4.5 · Low" in foot1, foot1)
            await box.fill("/model sonnet")
            await box.press("Enter")
            await pg.wait_for_timeout(500)
            await box.fill("Say only: two")
            await box.press("Enter")
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            foot2 = await pg.locator(".ax-turn.last .ax-turnmeta").inner_text()
            ok("the next turn is Sonnet's (its init named it)", "Sonnet 5 · Low" in foot2, foot2)
            div = await pg.locator(".ax-switch").all_inner_texts()
            ok("a divider records the switch", div == ["Switched to Sonnet 5 · Low"], str(div))
            await pg.screenshot(path=f"{OUT}/a3_live_switch.png")

            # 7. the project's own server answers; the studio let it in
            await box.fill("/model haiku")
            await box.press("Enter")
            await pg.wait_for_timeout(400)
            await box.fill("Call the ping tool of the notes server, then tell me exactly the text it returned.")
            await box.press("Enter")
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            said = await pg.locator(".ax-turn.last .ax-text").last.inner_text()
            steps = await pg.evaluate("() => [...document.querySelectorAll('.ax-turn.last .ax-step-label')].map(n => n.textContent)")
            ok("a project's own tool server is called", "pong from the project's notes server" in said, said[:90])
            await pg.screenshot(path=f"{OUT}/a3_live_notes.png")
        await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", sid)
        await pg.evaluate("d => fetch('/api/assistant/defaults', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify(d || {})})", saved)
        ok("no page errors", not errors, "; ".join(errors[:3]))
        await ctx.close()

        # 8. the phone: the pill and its menu fit
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        pg = await ctx.new_page()
        await login(pg)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.click(".ax-askbar")
        await pg.wait_for_selector(".ax.sheet")
        await pg.click(".ax-model")
        await pg.wait_for_selector(".ax-pop.ax-models:not([hidden])")
        r = await pg.evaluate("() => { const b = document.querySelector('.ax-pop').getBoundingClientRect(); return {l: b.left, r: b.right, t: b.top, w: innerWidth}; }")
        ok("the menu fits the phone", r["l"] >= 0 and r["r"] <= r["w"] and r["t"] >= 0, str(r))
        await pg.screenshot(path=f"{OUT}/a3_phone_menu.png")
        await ctx.close()
        await b.close()
    passed = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n{passed}/{len(RESULTS)} passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


asyncio.run(main())
