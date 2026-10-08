"""`operonx studio` → a running studio: the probe, launch tickets, /open."""

from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from operonx_studio import cli
from operonx_studio.launch import make_ticket, take_ticket


@pytest.fixture()
def state(team, monkeypatch):
    # the tickets live where the studio keeps its state
    monkeypatch.setenv("OPERONX_STUDIO_STATE_DIR", str(team.state))
    return team.state


def _project(tmp_path: Path, name: str = "proj") -> Path:
    root = tmp_path / name
    root.mkdir()
    (root / "operonx.toml").write_text(f'[project]\nname = "{name}"\n', encoding="utf-8")
    return root


def test_the_probe_answers_without_a_sign_in(team, state):
    team.use(None)
    got = team.client.get("/.well-known/operonx-studio")
    assert got.status_code == 200
    assert got.json()["state_dir"] == str(state.resolve()) and got.json()["studio"]


def test_a_ticket_opens_its_project_once(team, state, tmp_path):
    root = _project(tmp_path)
    t = make_ticket(root)
    # signed out: sign in first, and come back to the same link
    team.use(None)
    page = team.client.get(f"/open?t={t}", follow_redirects=False)
    assert page.status_code == 302 and page.headers["location"] == f"/login?next=%2Fopen%3Ft%3D{t}"
    # signed in: the project joins the list and shows
    team.use(team.admin_token)
    page = team.client.get(f"/open?t={t}", follow_redirects=False)
    assert page.status_code == 302 and page.headers["location"].startswith("/p/")
    pid = page.headers["location"].rsplit("/", 1)[-1]
    assert pid in {p["id"] for p in team.client.get("/api/projects").json()["projects"]}
    # used: the same link opens nothing
    again = team.client.get(f"/open?t={t}", follow_redirects=False)
    assert again.headers["location"] == "/"


def test_a_link_cannot_name_a_folder(team, state, tmp_path):
    root = _project(tmp_path)
    team.use(team.admin_token)
    for bad in [f"/open?path={root}", "/open?t=" + "0" * 32, "/open?t=../../etc/passwd", "/open"]:
        page = team.client.get(bad, follow_redirects=False)
        assert page.headers["location"] == "/", bad
    assert team.client.get("/api/projects").json()["projects"] == []


def test_a_ticket_expires(state, tmp_path):
    root = _project(tmp_path)
    t = make_ticket(root)
    path = state / "launch" / f"{t}.json"
    path.write_text(json.dumps({"path": str(root), "at": time.time() - 3600}), encoding="utf-8")
    assert take_ticket(t) is None and not path.exists()


def test_a_second_launch_hands_the_project_over(state, tmp_path, monkeypatch, capsys):
    root = _project(tmp_path)
    # a studio from before the lock (none held) answering on the port, same state
    monkeypatch.setattr(cli, "_running", lambda host, port, wait=0.0: {"studio": "x", "state_dir": str(state.resolve())})
    opened = []
    monkeypatch.setattr(cli.webbrowser, "open", opened.append)
    assert cli.main([str(root), "--port", "8799"]) == 0
    url = opened[0]
    assert url.startswith("http://127.0.0.1:8799/open?t=")
    assert take_ticket(url.rsplit("=", 1)[-1]) == root.resolve()
    assert "already running" in capsys.readouterr().out


def test_a_studio_on_other_state_gets_no_ticket(state, tmp_path, capsys):
    root = _project(tmp_path)
    args = SimpleNamespace(host="127.0.0.1", port=8799, no_open=True)
    assert cli._hand_over(args, root, {"studio": "x", "state_dir": "/somewhere/else"}) == 0
    out = capsys.readouterr().out
    assert "/somewhere/else" in out and "open?t=" not in out
    assert not (state / "launch").exists() or not list((state / "launch").iterdir())


def test_one_studio_per_state(state):
    from operonx_studio.launch import claim, running_info

    first = claim()
    assert first is not None
    first.announce("127.0.0.1", 8799)
    assert claim() is None                         # a second launch sees it running
    assert running_info(wait=0)["port"] == 8799    # … and where
    first.release()
    again = claim()                                # gone: the next one may start
    assert again is not None and running_info(wait=0) is None
    again.release()


def test_a_launch_finds_the_running_studio_on_its_own_port(state, tmp_path, monkeypatch, capsys):
    from operonx_studio.launch import claim

    root = _project(tmp_path)
    held = claim()
    held.announce("127.0.0.1", 8766)               # running on another port than asked
    asked = []
    monkeypatch.setattr(cli, "_running", lambda host, port, wait=0.0: asked.append(port)
                        or {"studio": "x", "state_dir": str(state.resolve())})
    monkeypatch.setattr(cli.webbrowser, "open", lambda url: None)
    try:
        assert cli.main([str(root), "--port", "8765"]) == 0
    finally:
        held.release()
    assert asked == [8766]                          # it asked the running one, started nothing
    assert "already running on 127.0.0.1:8766" in capsys.readouterr().out


def test_a_dead_studios_run_file_is_not_trusted(state):
    from operonx_studio.launch import claim, running_info

    (state / "studio.run.json").write_text('{"host": "127.0.0.1", "port": 1, "pid": 1}', encoding="utf-8")
    held = claim()                                  # nobody holds the lock: the file is stale
    assert held is not None and running_info(wait=0) is None
    held.release()
