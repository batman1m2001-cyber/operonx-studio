"""People (operonx_studio/users.py and the admin API, docs/TEAM_PLAN.md
§2.1): the store, passwords, the guards around roles, and the CLI reset.
"""

from __future__ import annotations

import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from operonx_studio.users import (PasswordError, UserStore, check_password, hash_password, password_problem,
                                  valid_username)

pytestmark = pytest.mark.unit


# ── the store ─────────────────────────────────────────────────────────────

def test_passwords_are_standard_library_scrypt():
    stored = hash_password("correct horse")
    kind, n, r, p, salt, digest = stored.split("$")
    assert (kind, n, r, p) == ("scrypt", "16384", "8", "1") and len(bytes.fromhex(salt)) == 16
    assert len(bytes.fromhex(digest)) == 32
    assert check_password("correct horse", stored) and not check_password("correct horsE", stored)
    assert hash_password("correct horse") != stored                 # salted
    assert not check_password("x", "bcrypt$garbage") and not check_password("x", "")


def test_the_rules():
    assert password_problem("1234567", "ann") and password_problem("annann12", "annann12")
    assert password_problem("12345678", "ann") is None
    assert valid_username("ann") and valid_username("a.b-c_9") and valid_username("9lives")
    for bad in ("", "Ann", "-ann", "a b", "x" * 33, "ann!"):
        assert not valid_username(bad), bad


def test_an_unknown_name_costs_one_scrypt_like_a_known_one(tmp_path, monkeypatch):
    from operonx_studio import users as users_mod

    store = UserStore(tmp_path / "users.sqlite")
    store.create("ann", role="editor", password="ann-pass-1")
    seen = []
    real = users_mod.check_password
    monkeypatch.setattr(users_mod, "check_password", lambda pw, h: seen.append(h) or real(pw, h))
    assert store.check("ann", "nope") is None and store.check("nobody", "nope") is None
    assert len(seen) == 2 and seen[1].startswith("scrypt$16384$")


def test_the_file_is_private_and_holds_no_secret_in_the_clear(tmp_path):
    store = UserStore(tmp_path / "state" / "users.sqlite")
    user, temp = store.create("ann", role="viewer")
    token = store.start_session(user["id"])
    assert stat.S_IMODE((tmp_path / "state" / "users.sqlite").stat().st_mode) == 0o600
    for f in (tmp_path / "state").glob("users.sqlite*"):
        blob = f.read_bytes()
        assert temp.encode() not in blob and token.encode() not in blob
    assert user["must_change"] and len(temp) == 12                   # token_urlsafe(9)


def test_create_refuses_bad_names_roles_duplicates_and_weak_passwords(tmp_path):
    store = UserStore(tmp_path / "users.sqlite")
    store.create("ann", role="editor")
    for kwargs in ({"username": "Bad Name", "role": "editor"}, {"username": "bob", "role": "owner"},
                   {"username": "ANN", "role": "viewer"}, {"username": "bob", "role": "viewer", "password": "short"}):
        with pytest.raises(PasswordError):
            store.create(**kwargs)


def test_sessions_end_as_the_plan_says(tmp_path):
    store = UserStore(tmp_path / "users.sqlite")
    ann, _ = store.create("ann", role="editor", password="ann-pass-1", must_change=False)
    a, b, c = (store.start_session(ann["id"]) for _ in range(3))
    assert store.resolve(a)[0]["username"] == "ann"
    store.end_session(a)                                             # logout: that one
    assert store.resolve(a)[0] is None and store.resolve(b)[0] is not None
    _, keep, _ = store.resolve(b)
    assert store.end_sessions(ann["id"], keep=keep) == 1             # a password change: the others
    assert store.resolve(b)[0] is not None and store.resolve(c)[0] is None
    store.reset_password(ann["id"])                                  # a reset: all
    assert store.resolve(b)[0] is None and store.user(ann["id"])["must_change"]


def test_a_disabled_person_signs_nobody_in(tmp_path):
    store = UserStore(tmp_path / "users.sqlite")
    ann, _ = store.create("ann", role="editor", password="ann-pass-1", must_change=False)
    token = store.start_session(ann["id"])
    store.update(ann["id"], disabled=True)
    assert store.resolve(token)[0] is None


def test_another_process_is_heard_within_five_seconds(tmp_path, monkeypatch):
    from operonx_studio import users as users_mod

    clock = [100.0]
    monkeypatch.setattr(users_mod.time, "monotonic", lambda: clock[0])
    here = UserStore(tmp_path / "users.sqlite")
    ann, _ = here.create("ann", role="editor", password="ann-pass-1", must_change=False)
    token = here.start_session(ann["id"])
    assert here.resolve(token)[0]["role"] == "editor"
    UserStore(tmp_path / "users.sqlite").update(ann["id"], role="viewer")   # e.g. the CLI
    assert here.resolve(token)[0]["role"] == "editor"                 # cached...
    clock[0] += 5.1
    assert here.resolve(token)[0]["role"] == "viewer"                 # ...for 5 s at most (D16)


# ── the admin API ─────────────────────────────────────────────────────────

def test_an_admin_adds_someone_who_chooses_a_password(team):
    c = team.client
    team.use(team.admin_token)
    res = c.post("/api/admin/users", json={"username": "ann", "name": "Ann", "role": "editor"})
    assert res.status_code == 200
    temp, uid = res.json()["password"], res.json()["user"]["id"]
    assert res.json()["user"]["must_change"] and "pw" not in res.json()["user"]
    assert c.post("/api/admin/users", json={"username": "ann", "role": "editor"}).status_code == 400
    assert c.post("/api/admin/users", json={"username": "Bo B", "role": "editor"}).status_code == 400
    assert c.post("/api/admin/users", json={"username": "bo", "role": "owner"}).status_code == 400
    team.signin("ann", temp)
    assert c.get("/api/projects").status_code == 403                 # the password step first
    assert c.post("/api/me/password", json={"new": "ann-pass-1"}).status_code == 200
    assert c.get("/api/projects").status_code == 200
    team.use(team.admin_token)
    listed = {u["username"]: u for u in c.get("/api/admin/users").json()["users"]}
    assert listed["ann"]["role"] == "editor" and listed["ann"]["sessions"] == 1 and not listed["ann"]["must_change"]
    assert listed["root"]["machine_login"] and not listed["ann"]["machine_login"]


def test_nobody_changes_their_own_role_or_removes_themselves(team):
    c = team.client
    root = next(u for u in c.get("/api/admin/users").json()["users"] if u["username"] == "root")["id"]
    assert "own role" in c.patch(f"/api/admin/users/{root}", json={"role": "viewer"}).json()["error"]
    assert c.patch(f"/api/admin/users/{root}", json={"disabled": True}).status_code == 400
    assert c.delete(f"/api/admin/users/{root}").status_code == 400
    assert c.post(f"/api/admin/users/{root}/password").status_code == 400
    assert c.patch(f"/api/admin/users/{root}", json={"name": "The Root"}).json()["user"]["name"] == "The Root"
    assert c.patch("/api/admin/users/nope", json={"name": "x"}).status_code == 404


def test_the_last_active_admin_stays(team):
    """An acting admin is an active one, so the guard bites only in the 5 s
    an acting admin's own demotion takes to reach the cache — exactly then:
    root, just demoted by another process, still passes as an admin and
    tries to remove boss, by now the only active admin."""
    c = team.client
    boss = team.person("boss", "admin")
    store = c.app.state.users
    team.use(team.admin_token)
    assert c.get("/api/admin/users").status_code == 200           # root is cached as an admin
    store._q("UPDATE users SET role = 'editor' WHERE username = 'root'")   # e.g. the CLI: no cache clear
    for body in ({"disabled": True}, {"role": "editor"}):
        res = c.patch(f"/api/admin/users/{boss['id']}", json=body)
        assert res.status_code == 400 and "last active admin" in res.json()["error"]
    assert c.delete(f"/api/admin/users/{boss['id']}").json()["error"] == "They are the last active admin"
    assert store.user(boss["id"])["role"] == "admin" and not store.user(boss["id"])["disabled"]
    # with two admins, demoting one is fine — and holds from their next request
    store._q("UPDATE users SET role = 'admin' WHERE username = 'root'")
    store._changed()
    team.use(boss["token"])
    root = next(u for u in c.get("/api/admin/users").json()["users"] if u["username"] == "root")["id"]
    assert c.patch(f"/api/admin/users/{root}", json={"role": "editor"}).status_code == 200
    team.signin("root", "admin-pass-1")
    assert c.get("/api/admin/users").status_code == 403


def test_demoting_or_disabling_ends_their_sessions_and_turns(team):
    c = team.client
    ann = team.person("ann", "editor")
    team.use(ann["token"])
    assert c.post("/api/open", json={"path": "/nope"}).status_code == 400      # an editor may
    team.use(team.admin_token)
    res = c.patch(f"/api/admin/users/{ann['id']}", json={"role": "viewer"})
    assert res.status_code == 200 and res.json()["user"]["role"] == "viewer"
    team.use(ann["token"])
    assert c.get("/api/projects").status_code == 401                 # signed out at once
    fresh = team.signin("ann", ann["password"])
    assert c.post("/api/open", json={"path": "/nope"}).status_code == 403      # a viewer may not
    assert c.get("/api/projects").status_code == 200
    team.use(team.admin_token)
    assert c.patch(f"/api/admin/users/{ann['id']}", json={"disabled": True}).status_code == 200
    team.use(fresh)
    assert c.get("/api/projects").status_code == 401
    team.use(None)
    denied = c.post("/api/login", json={"username": "ann", "password": ann["password"]})
    assert denied.status_code == 403 and "disabled" in denied.json()["error"]
    wrong = c.post("/api/login", json={"username": "ann", "password": "not-hers-1"})
    assert wrong.status_code == 401                                  # no hint without the password
    team.use(team.admin_token)
    c.patch(f"/api/admin/users/{ann['id']}", json={"disabled": False})
    team.signin("ann", ann["password"])


def test_a_demotion_stops_their_running_turn(team, tmp_path, monkeypatch):
    from test_auth import FAKE_AGENT      # the same fake (tests/studio is on sys.path)

    binary = tmp_path / "fake-claude"
    binary.write_text(FAKE_AGENT, encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(binary))
    monkeypatch.setenv("OX_FAKE_LOG", str(tmp_path / "calls.jsonl"))
    monkeypatch.setenv("OPERONX_STUDIO_CHAT_TITLES", "off")
    c = team.client
    ann = team.person("ann", "editor")
    team.use(ann["token"])
    sid = c.post("/api/assistant/sessions", json={"scope": "home"}).json()["session"]["id"]
    turn = c.post(f"/api/assistant/sessions/{sid}/turns", json={"message": "SLOW"}).json()["turn"]
    team.use(team.admin_token)
    res = c.patch(f"/api/admin/users/{ann['id']}", json={"role": "viewer"})
    assert res.json()["stopped_turns"] == 1
    for _ in range(200):
        got = c.get(f"/api/assistant/turns/{turn}").json()
        if not got["alive"]:
            break
        time.sleep(0.05)
    assert not got["alive"]
    said = [e["item"]["text"] for e in got["events"] if e["t"] == "item" and e["item"]["kind"] == "error"]
    assert any("changed this person's access" in s for s in said)


def test_a_reset_prints_once_and_ends_every_session(team):
    c = team.client
    ann = team.person("ann", "editor")
    team.use(team.admin_token)
    res = c.post(f"/api/admin/users/{ann['id']}/password")
    temp = res.json()["password"]
    assert res.status_code == 200 and res.json()["user"]["must_change"]
    team.use(ann["token"])
    assert c.get("/api/projects").status_code == 401
    team.use(None)
    assert c.post("/api/login", json={"username": "ann", "password": ann["password"]}).status_code == 401
    team.signin("ann", temp)
    assert c.get("/api/projects").status_code == 403                 # choose a password first


def test_deleting_someone_signs_out_and_removes_their_own_claude_directory(team, tmp_path, monkeypatch):
    fake = tmp_path / "fake-claude"
    log = tmp_path / "auth.log"
    fake.write_text(f"#!/bin/sh\necho \"$@ $CLAUDE_CONFIG_DIR\" >> {log}\n", encoding="utf-8")
    fake.chmod(0o755)
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", str(fake))
    c = team.client
    ann = team.person("ann", "editor")
    bo = team.person("bo", "viewer")
    own = team.state / "users" / ann["id"] / "claude"
    own.mkdir(parents=True)
    outside = tmp_path / "somebody-elses-claude"
    outside.mkdir()
    store = c.app.state.users
    store.update(ann["id"], claude_home=str(own))
    store.update(bo["id"], claude_home=str(outside))
    team.use(team.admin_token)
    assert c.delete(f"/api/admin/users/{ann['id']}").json()["deleted"] == ann["id"]
    assert not own.exists() and log.read_text().split() == ["auth", "logout", str(own)]
    team.use(ann["token"])
    assert c.get("/api/projects").status_code == 401
    team.use(team.admin_token)
    assert c.delete(f"/api/admin/users/{bo['id']}").status_code == 200
    assert outside.is_dir() and len(log.read_text().splitlines()) == 1   # never touched outside the state
    assert {u["username"] for u in c.get("/api/admin/users").json()["users"]} == {"root"}


def test_reviews_are_signed_with_the_username(team, tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "p"\n', encoding="utf-8")
    c = team.client
    team.person("ann", "editor")
    team.signin("ann", "ann-pass-1")
    pid = c.post("/api/open", json={"path": str(root)}).json()["id"]
    got = c.post(f"/api/p/{pid}/review/run/r1", json={"verdict": "good"})
    assert got.status_code == 200 and got.json()["user"] == "ann"


# ── the CLI ───────────────────────────────────────────────────────────────

def _cli(state: Path, *args: str) -> subprocess.CompletedProcess:
    import os

    env = {**os.environ, "OPERONX_STUDIO_STATE_DIR": str(state)}
    return subprocess.run([sys.executable, "-m", "operonx_studio.cli", *args], env=env,
                          capture_output=True, text=True, timeout=60)


def test_reset_password_from_the_command_line(team):
    ann = team.person("ann", "editor")
    got = _cli(team.state, "--reset-password", "ann")
    assert got.returncode == 0, got.stdout + got.stderr
    temp = got.stdout.split("temporary password for ann: ")[1].split()[0]
    time.sleep(5.1)                                                  # the studio's 5 s cache
    c = team.client
    team.use(ann["token"])
    assert c.get("/api/projects").status_code == 401
    team.use(None)
    res = c.post("/api/login", json={"username": "ann", "password": temp})
    assert res.status_code == 200 and res.json()["must_change"]
    missing = _cli(team.state, "--reset-password", "nobody")
    assert missing.returncode == 2 and "known: root, ann" in missing.stdout


def test_reset_password_with_no_accounts_says_so(tmp_path):
    got = _cli(tmp_path / "empty", "--reset-password", "root")
    assert got.returncode == 2 and "no accounts" in got.stdout


# ── the Team page and the account menu (P2) ───────────────────────────────

def _boot(html: str, node: str) -> dict:
    import json

    return json.loads(html.split(f'<script id="{node}" type="application/json">')[1].split("</script>")[0])


def test_the_team_page_is_for_admins(team):
    c = team.client
    ann = team.person("ann", "editor")
    team.use(team.admin_token)
    page = c.get("/team")
    assert page.status_code == 200 and 'id="team"' in page.text
    assert _boot(page.text, "me-boot")["user"]["username"] == "root"
    team.use(ann["token"])
    away = c.get("/team", follow_redirects=False)
    assert away.status_code == 302 and away.headers["location"] == "/"     # a page, not a JSON 403
    assert c.get("/api/admin/users").status_code == 403                    # the API still says why
    team.use(None)
    assert c.get("/team", follow_redirects=False).headers["location"] == "/login"


def test_every_page_knows_who_is_signed_in(team, tmp_path):
    c = team.client
    ann = team.person("ann", "viewer")
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "operonx.toml").write_text('[project]\nname = "p"\n', encoding="utf-8")
    pid = c.post("/api/open", json={"path": str(proj)}).json()["id"]
    team.use(ann["token"])
    for path in ("/", f"/p/{pid}"):
        me = _boot(c.get(path).text, "me-boot")
        assert me == {"user": {"id": ann["id"], "username": "ann", "name": "Ann", "role": "viewer"}, "auth": True}, path
    # the account menu's script rides in every page's bundle
    for page in ("home", "project", "team"):
        assert "Change password" in c.get(f"/static/bundle/{page}.js").text, page


def test_auth_off_pages_say_so(tmp_path):
    from fastapi.testclient import TestClient

    from operonx_studio.app import build_studio_app
    from operonx_studio.registry import Recents

    with TestClient(build_studio_app(Recents(state_file=tmp_path / "s" / "studio.json"))) as c:
        me = _boot(c.get("/").text, "me-boot")
        assert me["auth"] is False and me["user"]["role"] == "admin"
        assert c.get("/team").status_code == 200
