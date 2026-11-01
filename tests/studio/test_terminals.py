"""Terminals (WORKSPACE_PLAN W2): a real shell on a PTY in the checkout or a worktree, read and typed into."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_studio.app import Recents, build_studio_app


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t"})  # fmt: skip


@pytest.fixture()
def client(tmp_path: Path):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "calc"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init")
    return root


def _until(client, url: str, ok, timeout: float = 10.0):
    end = time.time() + timeout
    while True:
        got = client.get(url).json()
        if ok(got) or time.time() > end:
            return got
        time.sleep(0.05)


def test_a_terminal_is_a_shell_typed_into_and_read(client, project, tmp_path):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    _git(project, "worktree", "add", "-q", "-b", "feat", str(tmp_path / "wt"))
    listed = client.get(f"/api/p/{pid}/terminals").json()
    assert listed["terminals"] == [] and listed["places"] == [str(project), str(tmp_path / "wt")]
    # outside the checkout and its worktrees: refused
    assert client.post(f"/api/p/{pid}/terminals", json={"cwd": str(tmp_path)}).status_code == 400
    t = client.post(f"/api/p/{pid}/terminals", json={"cwd": str(tmp_path / "wt"), "card": "m1/C2"}).json()
    assert (t["by"], t["card"], t["cwd"], t["state"]) == ("owner", "m1/C2", str(tmp_path / "wt"), "idle")
    url = f"/api/p/{pid}/terminals/{t['id']}"
    client.post(url, json={"input": "git branch --show-current; echo $VIRTUAL_ENV.; tty\n"})
    got = _until(client, f"{url}/output", lambda g: "/dev/pts/" in g["text"])
    assert "feat" in got["text"] and "\n.\n" in got["text"] and "\x1b[" not in got["text"]
    # a command in the foreground is the terminal's own answer: working, and what runs
    client.post(url, json={"input": "sleep 30\n"})
    got = _until(client, url + "/output", lambda g: g["state"] == "working")
    assert got["running"] == "sleep"
    client.post(url, json={"input": "\x03"})
    assert _until(client, url + "/output", lambda g: g["state"] == "idle")["state"] == "idle"
    # the socket: what was printed so far, then what is typed into it
    with client.websocket_connect(f"{url}/ws") as ws:
        assert b"/dev/pts/" in ws.receive_bytes()
        ws.send_json({"i": "echo from-the-socket\n"})
        seen = b""
        while b"from-the-socket\r\n" not in seen:
            seen += ws.receive_bytes()
    # since: only what came after
    end = client.get(url + "/output").json()["bytes"]
    client.post(url, json={"input": "echo after\n"})
    got = _until(client, f"{url}/output?since={end}", lambda g: "after\n" in g["text"])
    assert "from-the-socket" not in got["text"]
    assert client.delete(url).json() == {"ok": True}
    assert client.get(f"/api/p/{pid}/terminals").json()["terminals"] == []


def test_a_command_terminal_ends_with_its_exit_code(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    t = client.post(f"/api/p/{pid}/terminals", json={"command": "echo hi; exit 3"}).json()
    url = f"/api/p/{pid}/terminals/{t['id']}/output"
    got = _until(client, url, lambda g: g["state"] == "ended")
    assert got["exit_code"] == 3 and "hi" in got["text"] and t["title"] == "echo hi; exit 3"
    assert client.post(f"/api/p/{pid}/terminals/{t['id']}", json={"input": "x"}).status_code == 409


def test_a_viewer_gets_no_terminal_and_no_socket(team, tmp_path, project):
    pid = team.client.post("/api/open", json={"path": str(project)}).json()["id"]
    t = team.client.post(f"/api/p/{pid}/terminals", json={}).json()
    viewer = team.person("vic", "viewer")
    team.use(viewer["token"])
    assert team.client.get(f"/api/p/{pid}/terminals").status_code == 403
    assert team.client.post(f"/api/p/{pid}/terminals", json={}).status_code == 403
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with team.client.websocket_connect(f"/api/p/{pid}/terminals/{t['id']}/ws") as ws:
            ws.receive_bytes()
    # an editor's socket from another site's page is refused too
    team.use(team.admin_token)
    with pytest.raises(WebSocketDisconnect):
        with team.client.websocket_connect(f"/api/p/{pid}/terminals/{t['id']}/ws",
                                           headers={"origin": "https://evil.example"}) as ws:
            ws.receive_bytes()
    with team.client.websocket_connect(f"/api/p/{pid}/terminals/{t['id']}/ws") as ws:
        ws.send_json({"i": "echo ok\n"})
        assert ws.receive_bytes()
    team.client.delete(f"/api/p/{pid}/terminals/{t['id']}")


def test_the_assistant_opens_types_into_and_closes_a_terminal(client, project):
    """The MCP terminal tools, through the studio's own routes: the terminal is the assistant's, on its card."""
    from operonx_studio import mcp

    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]

    class Through(mcp.Studio):
        def root(self, path, body=None, **params):
            headers = {"x-operonx-via": "assistant"}
            clean = {k: v for k, v in params.items() if v not in (None, "")}
            r = client.post(f"/api{path}", json=body, params=clean, headers=headers) if body is not None else \
                client.get(f"/api{path}", params=clean, headers=headers)
            if r.status_code >= 400:
                raise RuntimeError(r.json().get("error"))
            return r.json()

    s = Through("http://x", pid)
    opened = mcp.t_terminal_open(s, {"card": "docs/X_PLAN.md#W2", "title": "dev"})
    tid = opened.split()[1]
    t = client.get(f"/api/p/{pid}/terminals").json()["terminals"][0]
    assert (t["id"], t["by"], t["card"], t["title"]) == (tid, "assistant", "docs/X_PLAN.md#W2", "dev")
    got = mcp.t_terminal_send(s, {"id": tid, "text": "sleep 0.5; echo done-$((1+2))"})
    assert "done-3" in got and "idle" in got.splitlines()[0]
    assert tid in mcp.t_terminal_list(s, {})
    assert mcp.t_terminal_close(s, {"id": tid}) == "Closed."
    assert client.get(f"/api/p/{pid}/terminals").json()["terminals"] == []
