"""Images and files in the assistant's composer, through the real page (plan A2).

Offline: the + button, a big image resized to a 1568 px long edge, paste
and drop, at most 8 images, a text file as a card, the image preview, and
a send (intercepted) that uploads the images and names them in the turn —
and gives them back when it fails. `--live` adds real Haiku turns (a few
cents): an image described, regenerate sending it again, and a 200 KB
paste that the old command-line path could not start.

usage: attachments.py <base> <outdir> <pid> [--live]
"""
import asyncio
import io
import json
import sys

import studio_login
from PIL import Image, ImageDraw
from playwright.async_api import async_playwright

BASE, OUT, PID = sys.argv[1:4]
LIVE = "--live" in sys.argv
RESULTS = []


def ok(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def png(w, h, shapes=True):
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    if shapes:
        d.ellipse((w * .08, h * .12, w * .58, h * .88), fill=(220, 30, 30))
        d.rectangle((w * .66, h * .25, w * .94, h * .75), fill=(30, 90, 220))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


SHAPES = png(480, 320)
BIG = png(3000, 2000)
CODE = "\n".join(["import asyncio", "from operonx import op", "", "@op", "async def scored(text: str) -> float:",
                  "    return len(text) / 100", "", "def main():", "    return asyncio.run(scored('hi'))"]) + "\n"


async def login(pg):
    await studio_login.login(pg, BASE)


async def tray(pg):
    return await pg.evaluate("""() => ({thumbs: document.querySelectorAll('.ax-input .ax-thumb').length,
        cards: [...document.querySelectorAll('.ax-input .ax-paste')].map(n => n.dataset.label),
        value: document.querySelector('.ax-input textarea').value})""")


# a file handed to the page as if pasted or dropped
FAKE_EVENT = """async ([kind, b64, name, type]) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, {type}));
  if (kind === 'paste') {
    const t = document.querySelector('.ax-input textarea');
    t.focus();
    t.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  } else {
    const ax = document.querySelector('.ax');
    ax.dispatchEvent(new DragEvent('dragenter', {dataTransfer: dt, bubbles: true, cancelable: true}));
    ax.dispatchEvent(new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true}));
    const shown = ax.classList.contains('dropping');
    ax.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));
    return shown;
  }
}"""


async def wait_idle(pg, timeout=180):
    for _ in range(timeout * 2):
        if not await pg.evaluate("document.querySelector('.ax').classList.contains('busy')"):
            return
        await pg.wait_for_timeout(500)
    raise TimeoutError("the turn did not finish")


async def main():
    import base64
    b64 = lambda b: base64.b64encode(b).decode()
    async with async_playwright() as p:
        b = await p.chromium.launch()
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
        box = pg.locator(".ax-input textarea")

        # 1. the + button: two images and a code file
        await pg.set_input_files(".ax-tools input[type=file]", files=[
            {"name": "shapes.png", "mimeType": "image/png", "buffer": SHAPES},
            {"name": "photo.png", "mimeType": "image/png", "buffer": BIG},
            {"name": "main.py", "mimeType": "text/x-python", "buffer": CODE.encode()}])
        await pg.wait_for_timeout(800)
        t1 = await tray(pg)
        ok("+ adds images as thumbnails", t1["thumbs"] == 2, str(t1))
        ok("…and a text file as a named card", t1["cards"] == ["main.py · 9 lines · Python"], str(t1["cards"]))
        await pg.screenshot(path=f"{OUT}/a2_tray.png")

        # 2. paste an image; drop one (the drop zone shows while dragging)
        await pg.evaluate(FAKE_EVENT, ["paste", b64(SHAPES), "image.png", "image/png"])
        await pg.wait_for_timeout(400)
        shown = await pg.evaluate(FAKE_EVENT, ["drop", b64(png(200, 200)), "dropped.png", "image/png"])
        await pg.wait_for_timeout(400)
        t2 = await tray(pg)
        ok("a pasted image joins the tray", t2["thumbs"] >= 3, str(t2["thumbs"]))
        ok("a dropped image joins the tray, and the drop zone showed", t2["thumbs"] == 4 and shown, f"{t2['thumbs']} shown={shown}")

        # 3. at most 8
        await pg.set_input_files(".ax-tools input[type=file]", files=[
            {"name": f"extra{i}.png", "mimeType": "image/png", "buffer": png(60 + i, 60)} for i in range(6)])
        await pg.wait_for_timeout(900)
        t3 = await tray(pg)
        ok("at most 8 images a message", t3["thumbs"] == 8, str(t3["thumbs"]))

        # 4. a thumbnail opens large; Remove takes it out
        await pg.locator(".ax-thumb-open").nth(7).click()
        await pg.wait_for_selector(".ax-peek:not([hidden]) .ax-peek-img img")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f"{OUT}/a2_preview.png")
        await pg.click(".ax-peek-acts button:has-text('Remove')")
        ok("the preview's Remove takes it out", (await tray(pg))["thumbs"] == 7)
        for _ in range(5):
            await pg.locator(".ax-thumb").last.hover()
            await pg.locator(".ax-thumb-x").last.click()
        ok("× removes thumbnails", (await tray(pg))["thumbs"] == 2)

        # 5. a send (intercepted): images up first, then the turn names them; a failure gives it all back
        await box.fill("What shapes are in these?")
        uploads, turns = [], []

        async def up(route):
            uploads.append(json.loads(route.request.post_data or "{}"))
            await route.continue_()

        async def fail(route):
            turns.append(json.loads(route.request.post_data or "{}"))
            await route.fulfill(status=500, content_type="application/json", body='{"error": "a test failure"}')
        await pg.route("**/api/assistant/sessions/*/attachments", up)
        await pg.route("**/api/assistant/sessions/*/turns", fail)
        await box.press("Enter")
        await pg.wait_for_timeout(1500)
        sizes = [(u.get("name"), u.get("w"), u.get("h")) for u in uploads]
        ok("images upload before the turn", len(uploads) == 2 and len(turns) == 1, str(sizes))
        ok("a big image is resized to a 1568 px long edge", ("photo.png", 1568, 1045) in sizes, str(sizes))
        ok("the turn names the uploaded images", len((turns[0] if turns else {}).get("attachments", [])) == 2)
        ok("…and carries the code file as a fenced block", "```python main.py\n" in (turns[0] if turns else {}).get("message", ""))
        t5 = await tray(pg)
        ok("a failed send gives the images and card back", t5["thumbs"] == 2 and len(t5["cards"]) == 1 and "shapes" in t5["value"], str(t5))
        await pg.unroute("**/api/assistant/sessions/*/attachments")
        await pg.unroute("**/api/assistant/sessions/*/turns")

        if LIVE:
            # 6. a real image turn: described, and regenerate sends it again
            for _ in range(2):
                await pg.locator(".ax-thumb").last.hover()
                await pg.locator(".ax-thumb-x").last.click()
            await pg.locator(".ax-paste-x").click()
            await box.fill("/model haiku")
            await box.press("Enter")
            await pg.wait_for_timeout(1000)
            await pg.set_input_files(".ax-tools input[type=file]", files=[{"name": "shapes.png", "mimeType": "image/png", "buffer": SHAPES}])
            await pg.wait_for_timeout(500)
            await box.fill("In one short sentence: which shapes and colours are in this image?")
            await box.press("Enter")
            await pg.wait_for_selector(".ax-user .ax-uimg img", timeout=15000)
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            answer = (await pg.locator(".ax-text").last.inner_text()).lower()
            ok("an image turn gets a description", "red" in answer and "circle" in answer, answer[:100])
            loaded = await pg.evaluate("() => { const i = document.querySelector('.ax-user .ax-uimg img'); return i && i.complete && i.naturalWidth; }")
            ok("the sent image shows in the transcript", bool(loaded), str(loaded))
            await pg.screenshot(path=f"{OUT}/a2_live_image.png")
            await pg.locator(".ax-turn.last").hover()
            await pg.locator(".ax-turn.last .ax-regen").click()
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            again = (await pg.locator(".ax-text").last.inner_text()).lower()
            imgs = await pg.locator(".ax-user .ax-uimg").count()
            ok("regenerate sends the image again", "red" in again and imgs == 1, f"{again[:80]} · {imgs} image")

            # 7. a 200 KB paste goes through (as one argument it could not start)
            big = "".join(f"Line {i:05d}: the quick brown fox jumps over the lazy dog.\n" for i in range(3600))
            await pg.evaluate("t => navigator.clipboard.writeText(t)", big)
            await box.focus()
            await pg.keyboard.press("Control+v")
            await pg.wait_for_timeout(400)
            await box.fill("How many lines does the pasted text have? Answer with the number only.")
            await box.press("Enter")
            await pg.wait_for_timeout(1500)
            await wait_idle(pg)
            answer = await pg.locator(".ax-text").last.inner_text()
            ok("a 200 KB paste goes through", "3600" in answer.replace(",", ""), answer.strip()[:60])
            sid = await pg.evaluate("JSON.parse(localStorage.getItem('ax:' + location.pathname.split('/')[2] + ':current'))")
            await pg.evaluate("sid => fetch('/api/assistant/sessions/' + sid, {method: 'DELETE'})", sid)
        ok("no page errors (desktop)", not errors, "; ".join(errors[:3]))
        await ctx.close()

        # 8. the phone: + and a thumbnail in the sheet
        ctx = await b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
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
        await pg.set_input_files(".ax-tools input[type=file]", files=[{"name": "shapes.png", "mimeType": "image/png", "buffer": SHAPES}])
        await pg.wait_for_timeout(600)
        await pg.locator(".ax-input textarea").fill("What is this?")
        ok("the phone sheet takes an image", (await tray(pg))["thumbs"] == 1)
        overflow = await pg.evaluate("document.documentElement.scrollWidth - innerWidth")
        ok("no sideways scroll on the phone", overflow <= 0, f"{overflow}px")
        await pg.screenshot(path=f"{OUT}/a2_phone.png")
        ok("no page errors (phone)", not errors, "; ".join(errors[:3]))
        await ctx.close()
        await b.close()
    passed = sum(1 for _, c, _ in RESULTS if c)
    print(f"\n{passed}/{len(RESULTS)} passed")
    sys.exit(0 if passed == len(RESULTS) else 1)


asyncio.run(main())
