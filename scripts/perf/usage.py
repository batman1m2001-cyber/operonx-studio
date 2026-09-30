"""Usage in the assistant, through the real page (plan A4).

Offline: the context ring always in the toolbar (grey, amber from 80%, red
from 95%), its card (this conversation, the plan's limits with reset times,
the account), /usage, the nudge above the box from 80% of a plan window,
and Send held at a limit — the numbers injected by intercepting the page's
own requests. `--live` adds one Haiku turn: the answer's footer carries its
tokens, and the card's numbers match what the studio stored.

usage: usage.py <base> <outdir> <pid> [--live]
"""
import asyncio
import json
import re
import sys
import time

import studio_login
from playwright.async_api import async_playwright

BASE, OUT, PID = sys.argv[1:4]
LIVE = "--live" in sys.argv
RESULTS = []
RESET = int(time.time()) + 3 * 3600          # three hours from now: a time today (or early tomorrow)


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def login(pg):
    await studio_login.login(pg, BASE)


def fake_rate(five, week=0.31, status="allowed"):
    return {"status": status, "limited_by": "five_hour", "overage": False, "at": time.time() - 240,
            "five_hour": {"used": five, "resets": RESET}, "seven_day": {"used": week, "resets": RESET + 4 * 86400}}


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 900})
        pg = await ctx.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        await login(pg)
        await pg.evaluate("localStorage.clear()")
        rate = {"value": fake_rate(0.26)}

        async def usage(route):
            await route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"rate": rate["value"], "as_of": rate["value"]["at"],
                 "account": {"logged_in": True, "method": "claude.ai", "email": "you@example.com", "plan": "max"}}))
        await pg.route("**/api/assistant/usage", usage)

        # the pulse carries the studio's real reading, newer than the injected
        # one (the newest wins): while numbers are injected, it carries none
        async def quiet_pulse(route):
            try:                     # a held pulse can outlive its page (a reload)
                res = await route.fetch()
                data = await res.json()
                data.pop("assistant_rate", None)
                await route.fulfill(response=res, body=json.dumps(data), headers={**res.headers, "content-type": "application/json"})
            except Exception:  # noqa: BLE001
                pass
        await pg.route("**/pulse?**", quiet_pulse)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.evaluate("oxSide && oxSide.show('assistant')")
        await pg.wait_for_selector(".ax.dock .ax-input")
        await pg.click(".ax-b-new")

        # 1. the ring at rest
        ring = await pg.evaluate("() => { const m = document.querySelector('.ax-tools .ax-meter'); return {shown: !!m && !m.hidden && m.offsetWidth > 0, cls: m.className, text: m.textContent}; }")
        ok("the context ring is always in the toolbar", ring["shown"] and "hot" not in ring["cls"] and "full" not in ring["cls"], str(ring))

        # 2. its card: the conversation, the plan's limits with reset times, the account
        await pg.click(".ax-tools .ax-meter")
        await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden])")
        await pg.wait_for_timeout(500)
        card = await pg.locator(".ax-pop.ax-usage").inner_text()
        ok("the card has the three sections", all(s in card.upper() for s in ("THIS CONVERSATION", "PLAN LIMITS", "ACCOUNT")), card[:80])
        ok("plan limits with their reset times", re.search(r"5-hour session\s+26% used · resets \S", card) is not None
           and re.search(r"Week\s+31% used · resets [A-Z][a-z]{2} ", card) is not None, card.replace("\n", " | ")[:260])
        ok("…as of when they were heard", "as of 4 min ago" in card)
        ok("the account and its plan", "you@example.com · Claude Max" in card)
        await pg.screenshot(path=f"{OUT}/a4_card.png")
        await pg.keyboard.press("Escape")

        # 3. /usage opens it too
        await pg.locator(".ax-input textarea").fill("/usage")
        await pg.locator(".ax-input textarea").press("Enter")
        await pg.wait_for_timeout(500)
        ok("/usage opens the card", await pg.locator(".ax-pop.ax-usage:not([hidden])").count() == 1)
        await pg.keyboard.press("Escape")

        # 4. from 80% of a plan window, a line above the box
        rate["value"] = fake_rate(0.85)
        await pg.reload()
        await pg.wait_for_selector(".ax .ax-input")
        await pg.evaluate("oxSide && oxSide.show('assistant')")
        await pg.wait_for_timeout(900)
        n = await pg.evaluate("() => { const n = document.querySelector('.ax-nudge'); return {shown: !n.hidden, text: n.textContent, limit: n.classList.contains('limit')}; }")
        ok("at 85% of the 5-hour window, the nudge says so", n["shown"] and not n["limit"]
           and n["text"].startswith("85% of this 5-hour session used · resets"), str(n))
        send_ok = await pg.evaluate("!document.querySelector('.ax-send').disabled")
        ok("…and Send still works", send_ok)
        await pg.screenshot(path=f"{OUT}/a4_nudge.png")

        # 5. at the limit: Send waits for the reset
        rate["value"] = fake_rate(1.0, status="rejected")
        await pg.reload()
        await pg.wait_for_selector(".ax .ax-input")
        await pg.evaluate("oxSide && oxSide.show('assistant')")
        await pg.wait_for_timeout(900)
        n = await pg.evaluate("() => { const n = document.querySelector('.ax-nudge'); const s = document.querySelector('.ax-send'); return {text: n.textContent, limit: n.classList.contains('limit'), disabled: s.disabled, title: s.title}; }")
        ok("at the limit, the nudge turns red and names the reset", n["limit"] and "limit is reached · it resets at" in n["text"], n["text"])
        ok("…and Send is held, saying when it comes back", n["disabled"] and "comes back at" in n["title"], n["title"])
        await pg.screenshot(path=f"{OUT}/a4_limit.png")

        # 6. the ring's colours, from a conversation's stored context
        rate["value"] = fake_rate(0.26)
        sid = await pg.evaluate(f"""fetch('/api/assistant/sessions', {{method: 'POST', headers: {{'content-type': 'application/json'}},
            body: JSON.stringify({{scope: '{PID}'}})}}).then(r => r.json()).then(j => j.session.id)""")
        def with_context(frac):
            # a route handler is called with (route, request): the fraction rides in a closure
            async def big(route):
                res = await route.fetch()
                data = await res.json()
                data["session"]["usage"] = {"context_tokens": int(frac * 1_000_000), "context_window": 1_000_000,
                                            "input_tokens": 1200, "output_tokens": 300, "cache_read_tokens": 90000,
                                            "cache_write_tokens": 5000, "turns": 4, "cost_usd": 0.1634}
                await route.fulfill(response=res, body=json.dumps(data), headers={**res.headers, "content-type": "application/json"})
            return big
        for frac, cls in ((0.85, "hot"), (0.96, "full")):
            await pg.route(f"**/api/assistant/sessions/{sid}", with_context(frac))
            await pg.evaluate("sid => oxAssistant.open(sid)", sid)
            await pg.wait_for_timeout(700)
            got = await pg.evaluate("document.querySelector('.ax-tools .ax-meter').className")
            ok(f"the ring turns {'amber' if cls == 'hot' else 'red'} at {int(frac * 100)}%", cls in got, got)
            await pg.unroute(f"**/api/assistant/sessions/{sid}")
        await pg.click(".ax-tools .ax-meter")
        await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden])")
        await pg.wait_for_timeout(400)
        card = await pg.locator(".ax-pop.ax-usage").inner_text()
        ok("the card shows the stored numbers", "960k of 1M · 96%" in card and "96k in · 300 out · 90k cached" in card
           and "Turns\n4" in card and "≈ $0.16 at API prices" in card, card.replace("\n", " | ")[:220])
        await pg.screenshot(path=f"{OUT}/a4_card_full.png")
        await pg.keyboard.press("Escape")
        await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", sid)
        await pg.unroute("**/api/assistant/usage")
        await pg.unroute_all(behavior="ignoreErrors")

        if LIVE:
            # 7. a real turn: its footer's tokens, and the card matches the store
            await pg.click(".ax-b-new")
            await pg.locator(".ax-input textarea").fill("/model haiku")
            await pg.locator(".ax-input textarea").press("Enter")
            await pg.wait_for_timeout(600)
            await pg.locator(".ax-input textarea").fill("Say only: fine")
            await pg.locator(".ax-input textarea").press("Enter")
            await pg.wait_for_timeout(1500)
            for _ in range(240):
                if not await pg.evaluate("document.querySelector('.ax').classList.contains('busy')"):
                    break
                await pg.wait_for_timeout(500)
            foot = await pg.locator(".ax-turn.last .ax-turnmeta").inner_text()
            ok("the answer's footer carries its tokens", re.search(r"\d[\d.]*k? in · \d+ out", foot) is not None, foot)
            sid = await pg.evaluate("JSON.parse(localStorage.getItem('ax:' + location.pathname.split('/')[2] + ':current'))")
            u = await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid).then(r => r.json()).then(j => j.session.usage)", sid)
            await pg.click(".ax-tools .ax-meter")
            await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden])")
            await pg.wait_for_timeout(1200)
            card = await pg.locator(".ax-pop.ax-usage").inner_text()
            ok("the card's plan limits are real and fresh", "as of just now" in card and "5-hour session" in card, card.replace("\n", " | ")[:200])
            ok("the card's turns match the store", f"Turns\n{u['turns']}" in card, str(u.get("turns")))
            await pg.screenshot(path=f"{OUT}/a4_live_card.png")
            await pg.keyboard.press("Escape")
            await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", sid)
        ok("no page errors", not errors, "; ".join(errors[:3]))
        await pg.unroute_all(behavior="ignoreErrors")
        await ctx.close()

        # 8. the phone: the card fits
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        pg = await ctx.new_page()
        await login(pg)
        await pg.goto(f"{BASE}/p/{PID}")
        await pg.wait_for_selector(".node")
        await pg.click(".ax-askbar")
        await pg.wait_for_selector(".ax.sheet")
        await pg.click(".ax-tools .ax-meter")
        await pg.wait_for_selector(".ax-pop.ax-usage:not([hidden])")
        await pg.wait_for_timeout(600)
        r = await pg.evaluate("() => { const b = document.querySelector('.ax-pop').getBoundingClientRect(); return {l: b.left, r: b.right, t: b.top, w: innerWidth}; }")
        ok("the card fits the phone", r["l"] >= 0 and r["r"] <= r["w"] and r["t"] >= 0, str(r))
        await pg.screenshot(path=f"{OUT}/a4_phone.png")
        await ctx.close()
        await b.close()
    passed = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n{passed}/{len(RESULTS)} passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


asyncio.run(main())
