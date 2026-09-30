"""The activity log (docs/TEAM_PLAN.md §2.6, P6): one row for every change
and every refusal, saying who, how (web, assistant, cli), what and where —
and never a secret.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from operonx_studio.users import UserStore
from test_assistant import fake, project  # noqa: F401 — its fixtures: the fake claude, a project

pytestmark = pytest.mark.unit

WEBHOOK = "https://hooks.example.com/services/T000/B000/secret-webhook-token"


def _project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "p"\n', encoding="utf-8")
    return root


def _rows(c, **params):
    res = c.get("/api/admin/activity", params=params)
    assert res.status_code == 200, res.text
    return res.json()["rows"]


def test_every_change_is_one_row_with_who_and_how(team, tmp_path):
    c = team.client
    ed = team.person("ed", "editor")
    team.use(ed["token"])
    pid = c.post("/api/open", json={"path": str(_project(tmp_path))}).json()["id"]
    c.post(f"/api/p/{pid}/review/run/r1", json={"verdict": "good", "note": "fine"})
    c.get(f"/api/p/{pid}/runs")                                      # reading is not recorded
    team.use(team.admin_token)
    rows = [r for r in _rows(c, user=ed["id"]) if not r["route"].startswith(("/api/login", "/api/me"))]
    assert [(r["method"], r["route"]) for r in rows] == [
        ("POST", "/api/p/{pid}/review/run/{run}"), ("POST", "/api/open")]         # newest first
    review = rows[0]
    assert review["username"] == "ed" and review["via"] == "web" and review["pid"] == pid
    assert review["params"] == {"pid": pid, "run": "r1"} and review["status"] == 200
    assert "fine" not in json.dumps(review)                          # a note is not a recorded key
    assert rows[1]["detail"] == {"path": str(tmp_path / "proj")}


def test_refusals_are_recorded_too(team, tmp_path):
    c = team.client
    vi = team.person("vi", "viewer")
    team.use(team.admin_token)
    pid = c.post("/api/open", json={"path": str(_project(tmp_path))}).json()["id"]
    team.use(vi["token"])
    assert c.post(f"/api/p/{pid}/jobs/nightly/run", json={}).status_code == 403
    assert c.get("/api/admin/users").status_code == 403
    team.use(team.admin_token)
    rows = [r for r in _rows(c, user=vi["id"]) if r["status"] == 403]
    assert {r["route"] for r in rows} == {"/api/p/{pid}/jobs/{name}/run", "/api/admin/users"}


def test_nothing_secret_is_ever_written(team, tmp_path):
    c = team.client
    team.use(team.admin_token)
    pid = c.post("/api/open", json={"path": str(_project(tmp_path))}).json()["id"]
    c.post(f"/api/p/{pid}/alerts", json={"name": "slow", "origin": "service", "target": "*", "metric": "p95_ms",
                                         "op": ">", "threshold": 100, "webhook": WEBHOOK})
    c.post(f"/api/p/{pid}/datasets/cases/rows", json={"rows": [{"input": {"secret-input": 1}}]})
    c.post("/api/me/password", json={"current": "admin-pass-1", "new": "an-audit-pass-9"})
    c.post("/api/admin/users", json={"username": "zed", "role": "viewer"})
    team.use(None)
    c.post("/api/login", json={"username": "root", "password": "wrong-pass-7"})
    team.signin("root", "an-audit-pass-9")
    rows = _rows(c)
    assert any(r["route"] == "/api/p/{pid}/alerts" and r["detail"] == {"name": "slow", "op": ">"} for r in rows)
    blob = b"".join(f.read_bytes() for f in team.state.glob("users.sqlite*"))
    for secret in (WEBHOOK, "secret-webhook-token", "an-audit-pass-9", "wrong-pass-7", "admin-pass-1",
                   "secret-input"):
        assert secret.encode() not in blob, secret


def test_sign_ins_are_recorded_failed_ones_too(team):
    c = team.client
    team.use(None)
    c.post("/api/login", json={"username": "root", "password": "nope"})
    c.post("/api/login", json={"username": "nobody", "password": "nope"})
    team.signin("root", "admin-pass-1")
    rows = [r for r in _rows(c) if r["route"] == "/api/login"]
    assert [(r["username"], r["status"], r["detail"]) for r in rows[:3]] == [
        ("root", 200, {"username": "root"}), (None, 401, {"username": "nobody"}), ("root", 401, {"username": "root"})]


def test_the_assistants_changes_and_claude_sign_ins_are_recorded(team, project, fake):
    from test_assistant import _pid, _say, _session, _sign_in

    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], cwd=project, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b"], cwd=project, check=True)
    c = team.client
    ed = team.person("ed", "editor")
    team.use(team.admin_token)
    pid = _pid(c, project)
    team.use(ed["token"])
    _sign_in(c)
    sid = _session(c, pid)["id"]
    _say(c, sid, "EDIT please")
    c.post("/api/assistant/logout")
    team.use(team.admin_token)
    rows = _rows(c, user=ed["id"])
    edit = next(r for r in rows if r["route"] == "assistant:changes")
    assert edit["via"] == "assistant" and edit["pid"] == pid and edit["detail"] == {"files": ["added.py"]}
    routes = [r["route"] for r in rows]
    assert "/api/assistant/login" in routes and "/api/assistant/login/{lid}/code" in routes
    assert "/api/assistant/logout" in routes
    assert "good-code#fake" not in json.dumps(rows)                     # the code never


def test_the_log_filters_by_person_and_project_and_is_for_admins(team, tmp_path):
    c = team.client
    ed = team.person("ed", "editor")
    a, b = _project(tmp_path), tmp_path / "other"
    b.mkdir()
    (b / "operonx.toml").write_text('[project]\nname = "q"\n', encoding="utf-8")
    team.use(ed["token"])
    pa = c.post("/api/open", json={"path": str(a)}).json()["id"]
    pb = c.post("/api/open", json={"path": str(b)}).json()["id"]
    c.post(f"/api/p/{pa}/review/run/x", json={"verdict": "bad"})
    c.post(f"/api/p/{pb}/review/run/y", json={"verdict": "bad"})
    assert c.get("/api/admin/activity").status_code == 403
    team.use(team.admin_token)
    assert [r["params"].get("run") for r in _rows(c, pid=pa) if r["params"].get("run")] == ["x"]
    assert {r["username"] for r in _rows(c, user=ed["id"])} == {"ed"}
    first = _rows(c, limit=2)
    older = _rows(c, before=first[-1]["id"], limit=50)
    assert len(first) == 2 and older and older[0]["id"] < first[-1]["id"]


def test_old_rows_are_pruned(tmp_path):
    store = UserStore(tmp_path / "users.sqlite")
    now = time.time()
    store.audit(user="u", via="web", method="POST", route="/api/open", status=200, at=now - 200 * 86400)
    store.audit(user="u", via="web", method="POST", route="/api/open", status=200, at=now - 10 * 86400)
    assert store.prune_audit(days=180) == 1
    assert len(store.activity()) == 1


def test_a_cli_reset_is_recorded(team):
    import os

    ed = team.person("ed", "editor")
    env = {**os.environ, "OPERONX_STUDIO_STATE_DIR": str(team.state)}
    got = subprocess.run([sys.executable, "-m", "operonx_studio.cli", "--reset-password", "ed"], env=env,
                         capture_output=True, text=True, timeout=60)
    assert got.returncode == 0
    team.use(team.admin_token)
    row = next(r for r in _rows(team.client, user=ed["id"]) if r["via"] == "cli")
    assert row["route"] == "cli:reset-password" and row["detail"] == {"username": "ed"}


def test_whom_an_admin_acted_on_is_named_even_after_a_delete(team):
    c = team.client
    ed = team.person("ed", "editor")
    team.use(team.admin_token)
    c.patch(f"/api/admin/users/{ed['id']}", json={"role": "viewer"})
    c.delete(f"/api/admin/users/{ed['id']}")
    rows = [r for r in _rows(c) if "{uid}" in r["route"]]
    assert [(r["method"], r["detail"].get("username")) for r in rows] == [("DELETE", "ed"), ("PATCH", "ed")]


def test_a_disabled_persons_sign_in_is_one_row(team):
    c = team.client
    ed = team.person("ed", "editor")
    team.use(team.admin_token)
    c.patch(f"/api/admin/users/{ed['id']}", json={"disabled": True})
    team.use(None)
    assert c.post("/api/login", json={"username": "ed", "password": ed["password"]}).status_code == 403
    team.use(team.admin_token)
    rows = [r for r in _rows(c) if r["route"] == "/api/login" and r["status"] == 403]
    assert [(r["username"], r["detail"]) for r in rows] == [("ed", {"username": "ed"})]
