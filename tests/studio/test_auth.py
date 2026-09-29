"""The sign-in wall (docs/TEAM_PLAN.md §2.1, P1): accounts with revocable
sessions, throttled sign-in, the migration from the single login, and the
assistant's per-turn token.

The studio rides a public tunnel; the filesystem browser and the param
editor must sit behind SOMETHING. The suite at large runs with auth off
(conftest); these tests turn it back on deliberately (the ``team``
fixture: tests/studio/conftest.py).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import stat
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

ADMIN_PASS = "admin-pass-1"     # the team fixture's first admin (tests/studio/conftest.py)


def _app(state: Path):
    return build_studio_app(Recents(state_file=state / "studio.json"))


@pytest.fixture()
def fresh(tmp_path: Path, monkeypatch):
    """A first start with today's defaults: no accounts, root/123."""
    for var in ("OPERONX_STUDIO_AUTH", "OPERONX_STUDIO_USER", "OPERONX_STUDIO_PASS"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", "/nonexistent/claude")
    return tmp_path / "state"


# ── the wall ──────────────────────────────────────────────────────────────

def test_pages_redirect_and_apis_401_when_signed_out(team):
    team.use(None)
    page = team.client.get("/", follow_redirects=False)
    assert page.status_code == 302 and page.headers["location"] == "/login"
    assert team.client.get("/p/anything", follow_redirects=False).status_code == 302
    assert team.client.get("/api/projects").status_code == 401
    assert team.client.post("/api/open", json={"path": "/"}).status_code == 401


def test_login_page_and_static_stay_open(team):
    team.use(None)
    page = team.client.get("/login")
    assert page.status_code == 200 and "Choose your password" in page.text
    assert 'id="login-boot"' not in page.text                  # signed out: the form
    assert team.client.get("/static/studio.css").status_code == 200
    version = page.text.split('src="/static/bundle/login.js')[1].split('"')[0]
    assert team.client.get("/static/bundle/login.js" + version).status_code == 200
    schema = team.client.get("/openapi.json", follow_redirects=False)     # no schema for the public
    assert schema.status_code == 302 and schema.headers["location"] == "/login"
    team.use(team.admin_token)
    assert team.client.get("/openapi.json").status_code == 404           # nor for anyone


def test_sign_in_sticks_and_wrong_passwords_do_not(team):
    team.use(None)
    assert team.client.post("/api/login", json={"username": "root", "password": "wrong"}).status_code == 401
    assert team.client.post("/api/login", json={"username": "nobody", "password": "wrong"}).status_code == 401
    team.signin("ROOT ", ADMIN_PASS)                            # usernames are lowercase
    assert team.client.get("/api/projects").status_code == 200
    me = team.client.get("/api/me").json()
    assert me["auth"] is True and me["user"]["username"] == "root" and me["user"]["role"] == "admin"
    assert me["user"]["via"] == "web" and "pw" not in me["user"]


def test_the_cookie_is_random_hashed_at_rest_and_flagged(team):
    res = team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS},
                           headers={"x-forwarded-proto": "https"})
    token = res.cookies["oxsession"]
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie and "max-age=2592000" in cookie
    plain = team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS})
    assert "secure" not in plain.headers["set-cookie"].lower()      # plain http: a Secure cookie never comes back
    assert plain.cookies["oxsession"] != token                     # a new session, not a derived value
    for f in team.state.glob("users.sqlite*"):
        assert token.encode() not in f.read_bytes()                 # only its sha256 is kept
        assert stat.S_IMODE(f.stat().st_mode) == 0o600, f.name


def test_a_cookie_replayed_after_logout_gets_401(team):
    token = team.signin("root", ADMIN_PASS)
    other = team.signin("root", ADMIN_PASS)                     # a second device
    team.use(token)
    assert team.client.get("/api/projects").status_code == 200
    out = team.client.get("/logout", follow_redirects=False)
    assert out.status_code == 302 and out.headers["location"] == "/login"
    team.use(token)                                             # the copied cookie, replayed
    assert team.client.get("/api/projects").status_code == 401
    team.use(other)                                             # logout ends that one session only
    assert team.client.get("/api/projects").status_code == 200
    assert team.client.post("/api/logout").status_code == 200
    team.use(other)
    assert team.client.get("/api/projects").status_code == 401


def test_sessions_survive_a_restart(team):
    token = team.signin("root", ADMIN_PASS)
    with TestClient(_app(team.state)) as again:
        again.cookies.set("oxsession", token)
        assert again.get("/api/projects").status_code == 200


def test_a_session_lasts_thirty_days_from_its_last_use(team, monkeypatch):
    from operonx_studio import users as users_mod

    token = team.signin("root", ADMIN_PASS)
    now = [time.time()]
    monkeypatch.setattr(users_mod.time, "time", lambda: now[0])
    team.app_users = team.client.app.state.users
    now[0] += 20 * 86400
    team.client.app.state.users._changed()
    team.use(token)
    used = team.client.get("/api/projects")
    assert used.status_code == 200 and "oxsession" in used.headers.get("set-cookie", "")   # the browser's copy moves on
    now[0] += 20 * 86400                                        # 40 days after sign-in, 20 after last use
    team.client.app.state.users._changed()
    assert team.client.get("/api/projects").status_code == 200
    now[0] += 31 * 86400
    team.client.app.state.users._changed()
    assert team.client.get("/api/projects").status_code == 401


def test_a_password_change_ends_the_other_sessions(team):
    a = team.signin("root", ADMIN_PASS)
    b = team.signin("root", ADMIN_PASS)
    team.use(a)
    bad = team.client.post("/api/me/password", json={"current": "wrong", "new": "brand-new-pw"})
    assert bad.status_code == 400 and "current" in bad.json()["error"]
    for weak, why in (("short", "8 characters"), ("root", "8 characters"), (ADMIN_PASS, "different")):
        res = team.client.post("/api/me/password", json={"current": ADMIN_PASS, "new": weak})
        assert res.status_code == 400 and why in res.json()["error"], weak
    ok = team.client.post("/api/me/password", json={"current": ADMIN_PASS, "new": "brand-new-pw"})
    assert ok.status_code == 200 and ok.json()["ended_sessions"] == 2   # b, and the fixture's own
    assert team.client.get("/api/projects").status_code == 200    # this one stays
    team.use(b)
    assert team.client.get("/api/projects").status_code == 401    # the other ended
    team.use(None)
    assert team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS}).status_code == 401
    team.signin("root", "brand-new-pw")


def test_a_username_is_never_the_password(team):
    from operonx_studio.users import password_problem

    assert password_problem("Rootroot", "rootroot") and password_problem("rootroot", "rootroot")
    assert password_problem("rootroot", "root") is None          # only the name itself is refused


# ── throttling ────────────────────────────────────────────────────────────

def test_five_failures_lock_the_name_then_the_lock_doubles(team, monkeypatch):
    from operonx_studio import users as users_mod

    clock = [1000.0]
    monkeypatch.setattr(users_mod.time, "monotonic", lambda: clock[0])
    team.use(None)
    for _ in range(5):
        assert team.client.post("/api/login", json={"username": "root", "password": "x"}).status_code == 401
    locked = team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS})
    assert locked.status_code == 429 and locked.headers["retry-after"] == "31"   # even the right password waits
    assert "try again" in locked.json()["error"]
    clock[0] += 31
    for _ in range(5):
        team.client.post("/api/login", json={"username": "root", "password": "x"})
    again = team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS})
    assert again.status_code == 429 and again.json()["retry_after"] == 61      # 30 s, then 60 s
    clock[0] += 61
    assert team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS}).status_code == 200
    for _ in range(4):                                           # a success cleared the count
        team.client.post("/api/login", json={"username": "root", "password": "x"})
    assert team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS}).status_code == 200


def test_one_address_guessing_many_names_is_locked_too(team):
    team.use(None)
    for i in range(5):
        team.client.post("/api/login", json={"username": f"guess{i}", "password": "x"})
    assert team.client.post("/api/login", json={"username": "guess9", "password": "x"}).status_code == 429


def test_the_lock_doubles_up_to_fifteen_minutes(monkeypatch):
    from operonx_studio import users as users_mod

    clock = [0.0]
    monkeypatch.setattr(users_mod.time, "monotonic", lambda: clock[0])
    t = users_mod.Throttle()
    seen = []
    for _ in range(8):
        for _ in range(5):
            t.fail("user:a")
        seen.append(t.locked("user:a"))
        clock[0] += seen[-1]
    assert seen == [30, 60, 120, 240, 480, 900, 900, 900]


# ── cross-site requests ───────────────────────────────────────────────────

def test_a_state_change_from_another_origin_is_refused(team):
    team.use(team.admin_token)
    evil = team.client.post("/api/open", json={"path": "/"}, headers={"origin": "https://evil.example"})
    assert evil.status_code == 403 and "cross-site" in evil.json()["error"]
    login = team.client.post("/api/login", json={"username": "root", "password": ADMIN_PASS},
                             headers={"origin": "https://evil.example"})
    assert login.status_code == 403
    same = team.client.post("/api/open", json={"path": "/"}, headers={"origin": "http://testserver"})
    assert same.status_code == 400                               # through the wall; the path is just wrong
    tunnel = team.client.post("/api/open", json={"path": "/"},
                              headers={"origin": "https://x.serveo.net", "x-forwarded-host": "x.serveo.net"})
    assert tunnel.status_code == 400
    assert team.client.get("/api/projects", headers={"origin": "https://evil.example"}).status_code == 200


# ── migrating today's single login ────────────────────────────────────────

def test_root_123_signs_in_to_the_choose_your_password_step(fresh):
    with TestClient(_app(fresh)) as c:
        res = c.post("/api/login", json={"username": "root", "password": "123"})
        assert res.status_code == 200 and res.json()["must_change"] is True
        # until then, only the password step
        blocked = c.get("/api/projects")
        assert blocked.status_code == 403 and blocked.json() == {"error": "choose a new password first",
                                                                  "must_change": True}
        home = c.get("/", follow_redirects=False)
        assert home.status_code == 302 and home.headers["location"] == "/login"
        page = c.get("/login")
        boot = json.loads(page.text.split('<script id="login-boot" type="application/json">')[1].split("</script>")[0])
        assert boot == {"step": "password", "username": "root"}
        assert c.get("/api/me").json()["user"]["must_change"] is True
        assert c.post("/api/me/password", json={"new": "123"}).status_code == 400
        assert c.post("/api/me/password", json={"new": "a-real-password"}).status_code == 200
        assert c.get("/api/projects").status_code == 200
        assert 'id="login-boot"' not in c.get("/login").text
    with TestClient(_app(fresh)) as c:
        assert c.post("/api/login", json={"username": "root", "password": "123"}).status_code == 401


def test_the_first_admin_keeps_the_sign_in_directory_and_the_machine_login(fresh, monkeypatch, caplog):
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_HOME", str(fresh / "claude-today"))
    with caplog.at_level("WARNING"):
        _app(fresh)
    from operonx_studio.users import UserStore

    [admin] = UserStore(fresh / "users.sqlite").users()
    assert admin["username"] == "root" and admin["role"] == "admin" and admin["must_change"]
    assert admin["machine_login"] and admin["claude_home"] == str(fresh / "claude-today")
    assert "first admin" in caplog.text and "not read again" in caplog.text


def test_the_environment_is_read_on_the_first_start_only(fresh, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_USER", "Thang")
    monkeypatch.setenv("OPERONX_STUDIO_PASS", "s3cret-enough")
    with TestClient(_app(fresh)) as c:
        res = c.post("/api/login", json={"username": "thang", "password": "s3cret-enough"})
        assert res.status_code == 200 and res.json()["must_change"] is False     # a fine password stays
    monkeypatch.setenv("OPERONX_STUDIO_USER", "root")
    monkeypatch.setenv("OPERONX_STUDIO_PASS", "123")
    with TestClient(_app(fresh)) as c:
        assert c.post("/api/login", json={"username": "root", "password": "123"}).status_code == 401
        assert c.post("/api/login", json={"username": "thang", "password": "s3cret-enough"}).status_code == 200


def test_a_weak_environment_password_must_be_changed_too(fresh, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_PASS", "s3cret")
    with TestClient(_app(fresh)) as c:
        assert c.post("/api/login", json={"username": "root", "password": "s3cret"}).json()["must_change"] is True


def test_the_old_shared_cookie_is_refused(fresh):
    key = hashlib.sha256(b"oxstudio:root:123").digest()
    old = hmac.new(key, b"session-v1", hashlib.sha256).hexdigest()
    with TestClient(_app(fresh)) as c:
        c.cookies.set("oxsession", old)
        assert c.get("/api/projects").status_code == 401
        assert c.get("/", follow_redirects=False).headers["location"] == "/login"


def test_auth_off_acts_as_the_first_admin(tmp_path):
    state = tmp_path / "state"
    with TestClient(_app(state)) as c:                            # conftest: auth off, no accounts
        me = c.get("/api/me").json()
        assert me["auth"] is False and me["user"]["username"] == "local" and me["user"]["role"] == "admin"
        assert c.get("/api/admin/users").status_code == 200
    from operonx_studio.users import UserStore

    UserStore(state / "users.sqlite").create("boss", role="admin", password="boss-pass-1", must_change=False)
    with TestClient(_app(state)) as c:
        assert c.get("/api/me").json()["user"]["username"] == "boss"


# ── the assistant's token ─────────────────────────────────────────────────

FAKE_AGENT = r'''#!/usr/bin/env python3
import json, os, sys, time
argv = sys.argv[1:]
if argv[:1] == ["auth"]:
    print(json.dumps({"loggedIn": False})); sys.exit(1)
cfg = argv[argv.index("--mcp-config") + 1]
line = sys.stdin.readline() if "--input-format" in argv else ""
msg = "".join(b.get("text", "") for b in (json.loads(line)["message"]["content"] if line.strip() else []))
with open(os.environ["OX_FAKE_LOG"], "a") as f:
    f.write(json.dumps({"argv": argv, "config_path": cfg, "mode": oct(os.stat(cfg).st_mode & 0o777),
                        "config": json.load(open(cfg))}) + "\n")
def emit(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
emit({"type": "system", "subtype": "init", "session_id": "s1", "model": "m"})
if "SLOW" in msg:
    time.sleep(30)
emit({"type": "result", "subtype": "success", "session_id": "s1", "is_error": False, "result": "ok", "usage": {}})
'''


def _drain(c, turn):
    for _ in range(200):
        got = c.get(f"/api/assistant/turns/{turn}", params={"cursor": 0}).json()
        if not got["alive"]:
            return got
        time.sleep(0.05)
    raise AssertionError("the turn never ended")


def test_the_assistant_tools_sign_in_with_a_token_for_that_turn_only(team, tmp_path, monkeypatch):
    binary = tmp_path / "fake-claude"
    binary.write_text(FAKE_AGENT, encoding="utf-8")
    binary.chmod(0o755)
    log = tmp_path / "calls.jsonl"
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("OX_FAKE_LOG", str(log))
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_TITLES", "off")
    c = team.client
    team.use(team.admin_token)
    sid = c.post("/api/assistant/sessions", json={"scope": "home"}).json()["session"]["id"]

    turn = c.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "SLOW please"}).json()["turn"]
    for _ in range(200):
        if log.is_file() and log.read_text().strip():
            break
        time.sleep(0.05)
    call = json.loads(log.read_text().splitlines()[-1])
    cfg = Path(call["config_path"])
    # a 0600 file under <state>/run/, not JSON on the command line
    assert cfg.parent == team.state / "run" and call["mode"] == "0o600"
    assert stat.S_IMODE(cfg.parent.stat().st_mode) == 0o700
    token = call["config"]["mcpServers"]["studio"]["env"]["OPERONX_STUDIO_TOKEN"]
    assert token and not any(token in a for a in call["argv"]) and "mcpServers" not in " ".join(call["argv"])
    assert token != team.admin_token

    # while the turn runs, the token is its owner, marked as the assistant
    team.use(token)
    me = c.get("/api/me").json()["user"]
    assert me["username"] == "root" and me["via"] == "assistant" and me["role"] == "admin"
    assert c.get("/api/projects").status_code == 200
    assert c.post("/api/logout").status_code == 200              # the agent can't end its person's session
    team.use(token)
    assert c.get("/api/projects").status_code == 200

    team.use(team.admin_token)
    assert c.get("/api/projects").status_code == 200
    assert c.post(f"/api/assistant/turns/{turn}/stop").status_code == 200
    _drain(c, turn)
    assert not cfg.exists()                                       # deleted when the turn ended
    team.use(token)
    assert c.get("/api/projects").status_code == 401             # and its token with it

    # a turn that ends on its own does the same
    team.use(team.admin_token)
    turn = c.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "hi"}).json()["turn"]
    _drain(c, turn)
    call = json.loads(log.read_text().splitlines()[-1])
    assert not Path(call["config_path"]).exists()
    team.use(call["config"]["mcpServers"]["studio"]["env"]["OPERONX_STUDIO_TOKEN"])
    assert c.get("/api/projects").status_code == 401
    assert not list((team.state / "run").glob("mcp-*.json"))


def test_agent_tokens_expire_on_their_own():
    from operonx_studio.users import AgentTokens

    tokens = AgentTokens()
    live = tokens.issue("u1", ttl=60)
    dead = tokens.issue("u1", ttl=-1)
    assert tokens.resolve(live) == "u1" and tokens.resolve(dead) is None
    assert tokens.revoke_user("u1") == 1 and tokens.resolve(live) is None


def test_a_stale_mcp_config_is_swept_at_start(tmp_path):
    from operonx_studio.assistant import ChatStore, Relay

    run = tmp_path / "run"
    run.mkdir()
    (run / "mcp-old.json").write_text("{}")
    Relay(ChatStore(tmp_path / "assistant.sqlite"))
    assert not (run / "mcp-old.json").exists()
