"""Screenshots of a running studio, to look at a colour theme: the home page, the newest project's
first screen, its Picture and its settings, at desktop width (and the home page at phone width).

    uv run --no-project --with playwright==1.44.0 python shots.py <base url> <out dir> <tag> [username password [project name]]

With no username the studio must run with OPERONX_STUDIO_AUTH=off.
"""
import sys
from playwright.sync_api import sync_playwright

base, out, tag = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
login = sys.argv[4:6]
wanted = sys.argv[6] if len(sys.argv) > 6 else ""     # a project by name; else the first listed
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, width in (("desktop", 1280), ("phone", 400)):
        ctx = browser.new_context(viewport={"width": width, "height": 800})
        if len(login) == 2:
            ctx.request.post(base + "/api/login", data={"username": login[0], "password": login[1]})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/")
        page.wait_for_timeout(2500)
        page.screenshot(path=f"{out}/{tag}-home-{name}.png")
        if name == "desktop":
            projects = ctx.request.get(base + "/api/projects").json().get("projects") or []
            projects = [p for p in projects if wanted in (p.get("name") or "")] or projects
            if projects:
                page.goto(f"{base}/p/{projects[0]['id']}")
                page.wait_for_timeout(3500)
                page.screenshot(path=f"{out}/{tag}-project.png")
                # the Picture is drawn on a canvas by the studio's own code: its colours are the ones most
                # easily missed by a theme, so it gets a shot of its own
                picture = page.locator('#hubtabs [data-view="factory"]')
                if picture.count() and picture.first.is_visible():
                    picture.first.click()
                    page.wait_for_timeout(3000)
                    page.screenshot(path=f"{out}/{tag}-picture.png")
                page.evaluate("switchTab('projectsettings')")
                page.wait_for_timeout(1500)
                page.screenshot(path=f"{out}/{tag}-settings.png")
        print(name, "page errors:", errors)
    browser.close()
