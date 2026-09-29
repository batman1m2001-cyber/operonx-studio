"""Signing the perf scripts in: one place, one account.

    OX_STUDIO_USER   the studio account (default root)
    OX_STUDIO_PASS   its password       (default 123, the first start's default)

Since accounts (docs/TEAM_PLAN.md P1) root/123 only reaches the "choose
your password" step, so point these at a real account; the defaults stay
so a studio still on its first-start login works as before.
"""
import os

USER = os.environ.get("OX_STUDIO_USER", "root")
PASSWORD = os.environ.get("OX_STUDIO_PASS", "123")


async def submit(pg, base):
    """Fill the sign-in form already on screen and wait for the home page."""
    await pg.fill("#login-user", USER)
    await pg.fill("#login-pass", PASSWORD)
    await pg.keyboard.press("Enter")
    try:
        await pg.wait_for_url(f"{base}/", timeout=15000)
    except Exception:
        if await pg.locator("#step-password:not([hidden])").count():
            raise SystemExit(f"{USER} must choose a password first: sign in once by hand, then set "
                             "OX_STUDIO_USER / OX_STUDIO_PASS") from None
        err = (await pg.locator("#login-err").inner_text()).strip()
        raise SystemExit(f"could not sign in as {USER}: {err or 'no answer'}") from None


async def login(pg, base):
    """The sign-in page, then the home page."""
    await pg.goto(f"{base}/login")
    await submit(pg, base)
