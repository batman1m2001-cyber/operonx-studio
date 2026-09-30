"""The assistant's composer, driven through the real page (plan A1).

Checks what a user would see: the box at rest, growth with a 30-line
prompt, the grip, the big editor, pasted cards (JSON, code, a log) and
their preview, drafts per conversation, Esc, a failed send that gives the
box back, and the user's message rendered with its blocks. `--live` adds
one real Haiku turn with a pasted JSON (about $0.01). Screenshots for
desktop and phone.

usage: composer.py <base> <outdir> <pid> [--live]
"""
import asyncio
import json
import sys

import studio_login
from playwright.async_api import async_playwright

BASE, OUT, PID = sys.argv[1:4]
LIVE = "--live" in sys.argv
RESULTS = []

PAYLOAD = {f"field_{i}": {"id": i, "ok": i % 3 != 0, "tags": ["a", "b"]} for i in range(18)}
CODE = "\n".join([
    "import asyncio", "from operonx import op", "", "@op", "async def scored(text: str) -> float:",
    "    if not text:", "        return 0.0", "    for word in text.split():", "        print(word)",
    "    total = sum(len(w) for w in text.split())", "    if total > 100:", "        return 1.0",
    "    return total / 100", "", "def main():", "    return asyncio.run(scored('hi'))"])
LOG = "\n".join(f"2026-09-27 10:00:{i:02d},120 INFO call.pipeline turn {i} ok" for i in range(20))
THIRTY = "\n".join(f"Step {i}: check the greeting, then the refund path, then the transfer." for i in range(1, 31))


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


async def login(pg):
    await studio_login.login(pg, BASE)


async def paste(pg, text):
    """A real paste: the clipboard, then Ctrl V into the box."""
    await pg.evaluate("t => navigator.clipboard.writeText(t)", text)
    await pg.locator(".ax-input textarea").first.focus()
    await pg.keyboard.press("Control+v")
    await pg.wait_for_timeout(150)


async def box(pg):
    return await pg.evaluate("""() => {
      const ax = document.querySelector('.ax'), t = ax.querySelector('.ax-input textarea');
      return {h: t.offsetHeight, sh: t.scrollHeight, panel: ax.clientHeight, value: t.value,
              cards: [...ax.querySelectorAll('.ax-paste')].map(n => n.dataset.label),
              logShown: getComputedStyle(ax.querySelector('.ax-log')).display !== 'none'};
    }""")


async def desktop(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    await ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await login(pg)
    await pg.evaluate("localStorage.clear()")
    await pg.goto(f"{BASE}/p/{PID}")
    await pg.wait_for_selector(".node")
    await pg.evaluate("oxSide && oxSide.show('assistant')")
    await pg.wait_for_selector(".ax.dock .ax-input")
    await pg.click(".ax-b-new")

    # 1. at rest: one box, the toolbar inside, two lines, the wider panel
    side = await pg.evaluate("document.querySelector('#sidebar').offsetWidth")
    ok("the side panel is 420px at 1440px", side == 420, f"{side}px")
    b0 = await box(pg)
    ok("the box rests at two lines", 50 <= b0["h"] <= 64, f"{b0['h']}px")
    inside = await pg.evaluate("!!document.querySelector('.ax-input .ax-tools .ax-model') && !!document.querySelector('.ax-input .ax-tools .ax-send')")
    ok("the model pill and Send sit inside the box", inside)
    ok("no row under the box", await pg.locator(".ax-foot-row").count() == 0)
    await pg.screenshot(path=f"{OUT}/a1_rest.png")

    # 2. a 30-line prompt grows the box to half the panel, then scrolls
    await pg.locator(".ax-input textarea").fill(THIRTY)
    b1 = await box(pg)
    ok("a 30-line prompt grows the box to half the panel", abs(b1["h"] - round(b1["panel"] * 0.5)) <= 2,
       f"{b1['h']}px of {b1['panel']}px")
    ok("…and scrolls past it", b1["sh"] > b1["h"])
    await pg.screenshot(path=f"{OUT}/a1_thirty_lines.png")

    # 3. the big editor: the words take the column; Esc brings the conversation back
    await pg.click(".ax-b-expand")
    await pg.wait_for_timeout(150)
    b2 = await box(pg)
    ok("Expand gives the words the whole column", not b2["logShown"] and b2["h"] > b2["panel"] * 0.6, f"{b2['h']}px")
    await pg.screenshot(path=f"{OUT}/a1_expanded.png")
    await pg.locator(".ax-input textarea").press("Escape")
    await pg.wait_for_timeout(150)
    b3 = await box(pg)
    ok("Esc leaves the big editor and keeps the text", b3["logShown"] and b3["value"] == THIRTY)

    # 4. Esc clears (as an edit: Ctrl Z brings it back)
    await pg.locator(".ax-input textarea").press("Escape")
    ok("Esc clears the box", (await box(pg))["value"] == "")
    await pg.keyboard.press("Control+z")
    ok("Ctrl Z brings the words back", (await box(pg))["value"] == THIRTY)
    await pg.locator(".ax-input textarea").fill("")

    # 5. the grip: a height by hand, remembered; double-click fits the text again
    g = await pg.locator(".ax-grip").bounding_box()
    await pg.mouse.move(g["x"] + g["width"] / 2, g["y"] + g["height"] / 2)
    await pg.mouse.down()
    await pg.mouse.move(g["x"] + g["width"] / 2, g["y"] - 140, steps=6)
    await pg.mouse.up()
    b4 = await box(pg)
    ok("dragging the grip sets a taller box", b4["h"] >= 180, f"{b4['h']}px")
    await pg.reload()
    await pg.wait_for_selector(".ax .ax-input")
    await pg.evaluate("oxSide && oxSide.show('assistant')")
    await pg.wait_for_timeout(300)
    b5 = await box(pg)
    ok("the height is remembered", abs(b5["h"] - b4["h"]) <= 2, f"{b5['h']}px")
    await pg.dispatch_event(".ax-grip", "dblclick")
    ok("double-click fits the text again", (await box(pg))["h"] <= 64)
    await pg.click(".ax-b-new")

    # 6. pastes: long ones become cards, a short one stays in the words
    await paste(pg, json.dumps(PAYLOAD))
    await paste(pg, CODE)
    await paste(pg, LOG)
    await paste(pg, "a short line")
    b6 = await box(pg)
    ok("a pasted JSON becomes a card", any(c.startswith("Pasted · ") and c.endswith("JSON") for c in b6["cards"]), str(b6["cards"]))
    ok("pasted code is recognised as Python", any(c.endswith("Python") for c in b6["cards"]))
    ok("a pasted log is recognised as a log", any(c.endswith("Log") for c in b6["cards"]))
    ok("a short paste stays in the words", b6["value"] == "a short line" and len(b6["cards"]) == 3)
    await pg.screenshot(path=f"{OUT}/a1_cards.png")

    # 7. a card opens: preview, edit, change what it is, remove
    await pg.locator(".ax-paste-open").nth(1).click()
    await pg.wait_for_selector(".ax-peek:not([hidden])")
    await pg.wait_for_timeout(300)     # past its fade-in
    peek = await pg.locator(".ax-peek-text").input_value()
    ok("a card opens with its text", peek.startswith("import asyncio"))
    await pg.screenshot(path=f"{OUT}/a1_peek.png")
    await pg.select_option(".ax-peek-lang", "text")
    await pg.click(".ax-peek-acts button:has-text('Save')")
    labels = (await box(pg))["cards"]
    ok("its kind can be changed by hand", labels[1].endswith("Text"), labels[1])
    await pg.locator(".ax-paste").nth(2).locator(".ax-paste-x").click()
    ok("× removes a card", len((await box(pg))["cards"]) == 2)

    # 8. drafts: each conversation keeps its own
    await pg.evaluate("oxSide && oxSide.show('assistant')")
    sid = await pg.evaluate("""async () => (await (await fetch('/api/assistant/sessions', {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({scope: location.pathname.split('/')[2]})})).json()).session.id""")
    await pg.wait_for_timeout(400)          # the draft is written 300 ms after the last change
    await pg.evaluate("sid => oxAssistant.open(sid)", sid)
    await pg.wait_for_timeout(600)
    b8 = await box(pg)
    ok("another conversation opens with its own (empty) box", b8["value"] == "" and not b8["cards"])
    await pg.locator(".ax-input textarea").fill("a draft for the other conversation")
    await pg.wait_for_timeout(400)
    await pg.click(".ax-b-new")
    await pg.wait_for_timeout(300)
    b9 = await box(pg)
    ok("a new conversation gets back its own draft, cards and all", b9["value"] == "a short line" and len(b9["cards"]) == 2,
       f"{b9['value']!r} {b9['cards']}")
    await pg.evaluate("sid => oxAssistant.open(sid)", sid)
    await pg.wait_for_timeout(600)
    ok("…and the other one gets back its own", (await box(pg))["value"] == "a draft for the other conversation")
    await pg.reload()
    await pg.wait_for_selector(".ax .ax-input")
    await pg.wait_for_timeout(800)
    ok("a draft survives a reload", (await box(pg))["value"] == "a draft for the other conversation")
    await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", sid)
    await pg.click(".ax-b-new")
    await pg.wait_for_timeout(300)

    # 9. sending: blocks first as fences, then the words; a failed send gives the box back
    await pg.evaluate("oxSide && oxSide.show('assistant')")
    await pg.locator(".ax-input textarea").fill("How many keys does this have?")
    sent = {}

    async def fail(route):
        sent["body"] = json.loads(route.request.post_data or "{}")
        await route.fulfill(status=500, content_type="application/json", body='{"error": "a test failure"}')
    await pg.route("**/api/assistant/sessions/*/turns", fail)
    await pg.locator(".ax-input textarea").press("Enter")
    await pg.wait_for_timeout(800)
    msg = (sent.get("body") or {}).get("message", "")
    ok("the message carries the blocks as fences, then the words",
       msg.startswith('```json\n{\n  "field_0"') and "\n```\n\n```text\nimport asyncio" in msg
       and msg.endswith("\n```\n\nHow many keys does this have?"),
       msg[:40].replace("\n", "⏎") + " … " + msg[-50:].replace("\n", "⏎"))
    b10 = await box(pg)
    ok("a failed send gives the box back, cards and all", len(b10["cards"]) == 2 and "How many keys" in b10["value"],
       f"{b10['cards']} {b10['value'][:40]!r}")
    await pg.unroute("**/api/assistant/sessions/*/turns")

    # 10. live: one Haiku turn with the pasted JSON; the message renders as a folded tree
    if LIVE:
        await pg.locator(".ax-paste").nth(1).locator(".ax-paste-x").click()   # keep the JSON only
        await pg.locator(".ax-input textarea").fill("/model haiku")
        await pg.locator(".ax-input textarea").press("Enter")
        await pg.wait_for_timeout(1200)
        ok("a command runs with cards in the box, and leaves them", len((await box(pg))["cards"]) == 1)
        await pg.locator(".ax-input textarea").fill("How many top-level keys does the JSON have? Answer with the number only.")
        await pg.locator(".ax-input textarea").press("Enter")
        await pg.wait_for_selector(".ax-user .ax-json", timeout=15000)
        await pg.wait_for_timeout(1500)
        for _ in range(240):
            if not await pg.evaluate("document.querySelector('.ax').classList.contains('busy')"):
                break
            await pg.wait_for_timeout(500)
        answer = await pg.locator(".ax-text").last.inner_text()
        ok("a live turn reads the pasted JSON", "18" in answer, answer.strip()[:80])
        tree = await pg.evaluate("""() => {
          const j = document.querySelector('.ax-user .ax-json');
          return {folded: j.classList.contains('folded'), rows: j.querySelectorAll('.ax-tree .vwrap > .vfold > .vrows > .vrow').length,
                  label: j.querySelector('.ax-code-lang').textContent};
        }""")
        ok("the sent JSON renders as a tree, folded past 12 rows", tree["folded"] and tree["rows"] == 18, str(tree))
        title = await pg.locator(".ax-title span").inner_text()
        ok("the title is the words, not the paste", "```" not in title and title != "New conversation", title)
        await pg.screenshot(path=f"{OUT}/a1_live_json.png")
        await pg.click(".ax-user .ax-json .ax-code-flip")
        raw = await pg.evaluate("!document.querySelector('.ax-user .ax-json pre').hidden")
        ok("Raw shows the text as sent", raw)
        await pg.locator(".ax-input textarea").fill("")
        await pg.locator(".ax-input textarea").press("ArrowUp")
        b11 = await box(pg)
        ok("↑ edits the last message, its JSON a card again",
           b11["value"].startswith("How many top-level keys") and b11["cards"] == ["Pasted · 146 lines · JSON"], str(b11["cards"]))
        await pg.locator(".ax-input textarea").press("Escape")
        b12 = await box(pg)
        ok("Esc cancels the edit and empties the box again", b12["value"] == "" and not b12["cards"])
        live_sid = await pg.evaluate("JSON.parse(localStorage.getItem('ax:' + location.pathname.split('/')[2] + ':current'))")
        await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", live_sid)
    ok("no page errors (desktop)", not errors, "; ".join(errors[:3]))
    await ctx.close()


async def rendering(b):
    """The user's message with blocks, rendered without a turn: the pending
    copy a send shows at once is the same renderer."""
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await login(pg)
    await pg.goto(f"{BASE}/p/{PID}")
    await pg.wait_for_selector(".node")
    await pg.evaluate("oxSide && oxSide.show('assistant')")
    await pg.click(".ax-b-new")

    async def hold(route):
        await asyncio.sleep(30)
        await route.abort()
    await pg.route("**/api/assistant/sessions/*/turns", hold)
    old_wall = "Why is this payload rejected?\n" + json.dumps(PAYLOAD, indent=2)
    await pg.evaluate("t => document.querySelector('.ax-input textarea').value = t", old_wall)
    await pg.locator(".ax-input textarea").press("Enter")
    await pg.wait_for_selector(".ax-user .ax-json")
    got = await pg.evaluate("""() => {
      const u = document.querySelector('.ax-user .ax-bubble');
      return {words: u.querySelector('.ax-words').textContent, json: !!u.querySelector('.ax-json'), rich: u.classList.contains('rich')};
    }""")
    ok("a JSON wall under a question renders as words + a tree", got["words"] == "Why is this payload rejected?" and got["json"], str(got))
    await pg.screenshot(path=f"{OUT}/a1_render_wall.png")
    ok("no page errors (rendering)", not errors, "; ".join(errors[:3]))
    await ctx.close()


async def phone(b):
    ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    await ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await login(pg)
    await pg.evaluate("localStorage.clear()")
    await pg.goto(f"{BASE}/p/{PID}")
    await pg.wait_for_selector(".node")
    await pg.click(".ax-askbar")
    await pg.wait_for_selector(".ax.sheet")
    await pg.click(".ax-b-new")
    await pg.screenshot(path=f"{OUT}/a1_phone_rest.png")
    await pg.locator(".ax-input textarea").fill(THIRTY)
    b1 = await box(pg)
    ok("the phone sheet's box grows to 40% of the screen", abs(b1["h"] - round(b1["panel"] * 0.4)) <= 2, f"{b1['h']}px of {b1['panel']}px")
    await pg.screenshot(path=f"{OUT}/a1_phone_thirty.png")
    await pg.locator(".ax-input textarea").fill("What is wrong here?")
    await paste(pg, json.dumps(PAYLOAD))
    ok("a paste on the phone becomes a card", len((await box(pg))["cards"]) == 1)
    await pg.screenshot(path=f"{OUT}/a1_phone_card.png")
    overflow = await pg.evaluate("document.documentElement.scrollWidth - innerWidth")
    ok("no sideways scroll on the phone", overflow <= 0, f"{overflow}px")
    ok("no page errors (phone)", not errors, "; ".join(errors[:3]))
    await ctx.close()


async def home(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 900})
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await login(pg)
    await pg.wait_for_selector(".ax.hero .ax-input")
    hidden = await pg.evaluate("""() => ['.ax-grip', '.ax-b-expand', '.ax-meter', '.ax-model']
        .every(s => getComputedStyle(document.querySelector('.ax.hero ' + s)).display === 'none')""")
    ok("the home page's box has no grip, expander, ring or model pill", hidden)
    await pg.screenshot(path=f"{OUT}/a1_home.png")
    ok("no page errors (home)", not errors, "; ".join(errors[:3]))
    await ctx.close()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        await desktop(b)
        await rendering(b)
        await phone(b)
        await home(b)
        await b.close()
    passed = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n{passed}/{len(RESULTS)} passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


asyncio.run(main())
