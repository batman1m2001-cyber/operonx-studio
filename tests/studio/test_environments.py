"""Environments (WORKSPACE_PLAN W3): this machine or a host over SSH, its key pinned, its secrets never served."""

from __future__ import annotations

import getpass
import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from operonx_studio import mcp, runhook, terminals
from operonx_studio.app import Recents, build_studio_app

SSHD = shutil.which("sshd") or "/usr/sbin/sshd"
AS_ASSISTANT = {"x-operonx-via": "assistant"}


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t"})  # fmt: skip


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def sshd(tmp_path: Path):
    """A private sshd on a free port: its own host key, one authorized client key, key auth only."""
    if not (os.access(SSHD, os.X_OK) and shutil.which("ssh") and shutil.which("ssh-keyscan")):
        pytest.skip("no OpenSSH server or client here")
    d = tmp_path / "sshd"
    d.mkdir()
    for name in ("host", "client"):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(d / name)], check=True)
    (d / "authorized_keys").write_text((d / "client.pub").read_text(), encoding="utf-8")
    port = _free_port()
    (d / "config").write_text(
        f"Port {port}\nListenAddress 127.0.0.1\nHostKey {d / 'host'}\nAuthorizedKeysFile {d / 'authorized_keys'}\n"
        f"PidFile {d / 'pid'}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\n"
        "StrictModes no\nPermitRootLogin prohibit-password\n", encoding="utf-8")
    proc = subprocess.Popen([SSHD, "-D", "-e", "-f", str(d / "config")], stderr=subprocess.DEVNULL)
    end = time.time() + 10
    while True:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            if proc.poll() is not None or time.time() > end:
                pytest.skip("the private sshd did not start")
            time.sleep(0.05)
    eid = "t-" + uuid.uuid4().hex[:8]
    yield {"port": port, "key": (d / "client").read_text(), "host_pub": d / "host.pub", "id": eid}
    proc.terminate()
    proc.wait(timeout=5)
    (Path.home() / ".config" / "operonx-env" / f"{eid}.env").unlink(missing_ok=True)  # the variables it pushed, as this user


@pytest.fixture()
def client(tmp_path: Path):
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "state" / "studio.json"))) as c:
        yield c


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(remote))
    root = tmp_path / "calc"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "calc"\n', encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "init")
    _git(root, "remote", "add", "origin", str(remote))
    _git(root, "push", "-q", "-u", "origin", "main")
    return root


def test_a_host_is_trusted_by_its_fingerprint_and_its_secrets_never_come_back(client, project, sshd, tmp_path):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    url, eid = f"/api/p/{pid}/environments", sshd["id"]
    assert [e["id"] for e in client.get(url).json()["environments"]] == ["local"]
    spec = {"op": "save", "id": eid, "name": "Staging", "host": "127.0.0.1", "port": sshd["port"],
            "user": getpass.getuser(), "workdir": str(tmp_path / "deploy")}
    # the owner sets an environment up; the assistant may not
    assert client.post(url, json=spec, headers=AS_ASSISTANT).status_code == 400
    assert client.post(url, json={**spec, "host": "a;b"}).status_code == 400
    assert client.post(url, json=spec).json()["ok"]
    # not trusted yet: nothing connects (no trust on first use)
    r = client.post(url, json={"op": "test", "env": eid})
    assert r.status_code == 400 and "not trusted" in r.json()["error"]
    seen = client.post(url, json={"op": "scan", "env": eid}).json()["fingerprints"]
    real = subprocess.run(["ssh-keygen", "-lf", str(sshd["host_pub"])], capture_output=True, text=True).stdout.split()[1]
    assert any(real in f for f in seen)
    assert client.post(url, json={"op": "trust", "env": eid}).json()["env"]["trusted"] == seen
    assert client.post(url, json={"op": "key", "env": eid, "key": "not a key"}).status_code == 400
    assert "key set" in client.post(url, json={"op": "key", "env": eid, "key": sshd["key"]}).json()["said"]
    client.post(url, json={"op": "vars", "env": eid, "vars": {"TOKEN": "s3cr3t-value"}})
    got = client.post(url, json={"op": "test", "env": eid}).json()
    assert got["ok"] and "connected" in got["said"]
    # what any route returns: the names, never a key or a value
    listed = client.get(url).text
    assert "s3cr3t" not in listed and "PRIVATE KEY" not in listed and "host_keys" not in listed
    assert client.get(url).json()["environments"][1]["vars"] == ["TOKEN"]
    said = client.post(url, json={"op": "run", "env": eid, "command": "echo token=$TOKEN"}).json()["said"]
    assert "token=•••" in said and "s3cr3t" not in said
    # the folder brought to a branch: cloned the first time from the project's remote
    got = client.post(url, json={"op": "checkout", "env": eid, "branch": "main"}).json()
    assert got["ok"] and "init" in got["said"] and (tmp_path / "deploy" / "operonx.toml").is_file()
    assert client.post(url, json={"op": "status", "env": eid}, headers=AS_ASSISTANT).json()["said"].startswith("main")
    # a terminal there: its output has the secrets taken out
    t = client.post(f"/api/p/{pid}/terminals", json={"env": eid, "command": "echo T=$TOKEN; pwd"}).json()
    assert t["env"] == eid and t["cwd"].endswith(":" + str(tmp_path / "deploy"))
    end, text = time.time() + 15, ""
    while time.time() < end and "deploy" not in text:
        text = client.get(f"/api/p/{pid}/terminals/{t['id']}/output").json()["text"]
        time.sleep(0.1)
    assert "T=•••" in text and "s3cr3t" not in text
    # the page's live socket too: a value split across what it reads is held back, not sent in halves
    t = client.post(f"/api/p/{pid}/terminals", json={"env": eid}).json()
    with client.websocket_connect(f"/api/p/{pid}/terminals/{t['id']}/ws") as ws:
        ws.send_json({"i": "printf 'A=%s' s3c''r; sleep 0.2; printf '%s\\n' 3t-''value; echo done-$TOKEN.\n"})
        seen = ""
        while "done-•••." not in seen:
            seen += ws.receive_bytes().decode()
    assert "A=•••" in seen and "A=s3" not in seen


def test_a_stream_holds_back_only_what_may_start_a_secret():
    assert terminals._maybe_secret("x=s3cr", ["s3cr3t-value"]) == 4
    assert terminals._maybe_secret("x=s3cr3t-valu", ["s3cr3t-value", "zz"]) == 11
    assert terminals._maybe_secret("prompt$ ", ["s3cr3t-value"]) == 0


def test_production_is_read_by_the_assistant_and_run_by_the_owner_on_confirm(client, project, sshd, tmp_path):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    url, eid = f"/api/p/{pid}/environments", sshd["id"]
    client.post(url, json={"op": "save", "id": eid, "host": "127.0.0.1", "port": sshd["port"],
                           "user": getpass.getuser(), "production": True})
    client.post(url, json={"op": "scan", "env": eid})
    client.post(url, json={"op": "trust", "env": eid})
    client.post(url, json={"op": "key", "env": eid, "key": sshd["key"]})
    assert client.post(url, json={"op": "resources", "env": eid}, headers=AS_ASSISTANT).json()["ok"]
    r = client.post(url, json={"op": "run", "env": eid, "command": "true"}, headers=AS_ASSISTANT)
    assert r.status_code == 400 and "production" in r.json()["error"]
    r = client.post(f"/api/p/{pid}/terminals", json={"env": eid}, headers=AS_ASSISTANT)
    assert r.status_code == 400 and "production" in r.json()["error"]
    assert "Production" in client.post(url, json={"op": "run", "env": eid, "command": "true"}).json()["needs_confirm"]
    assert client.post(url, json={"op": "run", "env": eid, "command": "true", "confirm": True}).json()["ok"]
    # read only: the assistant does not run there either; none: it does not even read
    client.post(url, json={"op": "save", "id": eid, "production": False, "assistant": "none"})
    assert client.post(url, json={"op": "status", "env": eid}, headers=AS_ASSISTANT).status_code == 400
    asked = client.post(url, json={"op": "delete", "env": eid}).json()
    assert "needs_confirm" in asked
    client.post(url, json={"op": "delete", "env": eid, "confirm": True})
    assert [e["id"] for e in client.get(url).json()["environments"]] == ["local"]
    assert not (tmp_path / "state" / "ox-secrets" / pid / eid).exists()


def test_this_machine_runs_in_the_checkout_with_its_variables_hidden(client, project):
    pid = client.post("/api/open", json={"path": str(project)}).json()["id"]
    url = f"/api/p/{pid}/environments"
    client.post(url, json={"op": "vars", "env": "local", "vars": {"API_KEY": "abcd-1234"}})
    got = client.post(url, json={"op": "run", "env": "local", "command": "pwd; echo $API_KEY"}).json()
    assert str(project) in got["said"] and "•••" in got["said"] and "abcd-1234" not in got["said"]
    assert client.post(url, json={"op": "key", "env": "local", "key": "x"}).status_code == 400


@pytest.mark.parametrize("event", [
    {"tool_name": "Read", "tool_input": {"file_path": "/root/.operonx-studio/ox-secrets/p/staging/key"}},
    {"tool_name": "Bash", "tool_input": {"command": "cat ~/.operonx-studio/ox-secrets/*/*/vars.json"}},
    {"tool_name": "Grep", "tool_input": {"pattern": "TOKEN", "path": "/root/.operonx-studio/ox-secrets"}},
])
def test_the_assistant_tools_are_refused_the_secrets_folder(event, tmp_path):
    out = runhook.rewrite(event, str(tmp_path))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert runhook.rewrite({"tool_name": "Read", "tool_input": {"file_path": "/x/a.py"}}, str(tmp_path)) is None


SERVE_MAIN = '''
import os

if os.environ.get("BREAK"):  # set on the host only (the environment's variables)
    raise SystemExit("boom: BREAK is set")

from operonx.core import END, START, graph, op
from operonx.app.serve import egress, ingress


@op(bound="sync")
def times(item=None) -> dict:
    return {"out": {"n": int(item["n"]) * FACTOR}}


@graph
def flow():
    src = ingress()
    d = times(item=src["item"])
    out = egress(item=d["out"])
    START >> src >> d >> out >> END
'''


def _call(port: int, n: int) -> int:
    import json
    import urllib.request

    req = urllib.request.Request(f"http://127.0.0.1:{port}/times", data=json.dumps({"n": n}).encode(),
                                 headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.loads(res.read())["n"]


def _wait(client, url: str, did: str) -> dict:
    end = time.time() + 180
    while time.time() < end:
        run = next(r for r in client.get(url).json()["deploys"] if r["id"] == did)
        if run["state"] not in ("queued", "running"):
            return run
        time.sleep(0.3)
    raise AssertionError(f"deploy {did} did not end")


def test_a_deploy_runs_its_stages_on_the_host_waits_on_production_and_rolls_back(client, sshd, tmp_path):
    import sys

    remote, root, port = tmp_path / "remote.git", tmp_path / "svc", _free_port()
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(remote))
    root.mkdir()
    (root / "main.py").write_text("FACTOR = 2\n" + SERVE_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(f'[project]\nname = "svc"\n\n[[serve]]\nname = "times"\nkind = "http"\n'
                                       f'path = "/times"\nhost = "127.0.0.1"\nport = {port}\ngraph = "main:flow"\n',
                                       encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "double")
    _git(root, "remote", "add", "origin", str(remote))
    _git(root, "push", "-q", "-u", "origin", "main")
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]
    url, eid = f"/api/p/{pid}/environments", sshd["id"]
    client.post(url, json={"op": "save", "id": eid, "host": "127.0.0.1", "port": sshd["port"], "user": getpass.getuser(),
                           "workdir": str(tmp_path / "deploy"), "python": sys.executable,
                           "test": "grep -q FACTOR main.py"})
    client.post(url, json={"op": "scan", "env": eid})
    client.post(url, json={"op": "trust", "env": eid})
    client.post(url, json={"op": "key", "env": eid, "key": sshd["key"]})
    dep, svc = f"/api/p/{pid}/deploys", f"/api/p/{pid}/env-services"
    try:
        # git → build → test → run → validate → deploy, each with its time and what it said
        did = client.post(dep, json={"env": eid, "ref": "main", "card": "m1/C1"}).json()["deploy"]["id"]
        run = _wait(client, dep, did)
        states = {s["name"]: s["state"] for s in run["stages"]}
        assert run["state"] == "ok", run["stages"]
        assert states == {"git": "ok", "build": "skipped", "test": "ok", "run": "ok", "validate": "ok", "deploy": "ok"}
        assert _call(port, 21) == 42
        first = run["sha"]
        listed = client.post(svc, json={"env": eid}).json()
        (lst,) = listed["listeners"]
        assert lst["running"] and lst["health"] == 200 and listed["release"] == first and lst["url"] == ""
        assert "times" in client.post(svc, json={"env": eid, "op": "log", "key": lst["key"]}).json()["said"]
        # a second release, then production: the assistant asks, the owner approves
        (root / "main.py").write_text("FACTOR = 3\n" + SERVE_MAIN, encoding="utf-8")
        _git(root, "commit", "-qam", "triple")
        _git(root, "push", "-q")
        client.post(url, json={"op": "save", "id": eid, "production": True})
        asked = client.post(dep, json={"env": eid, "ref": "main"}, headers=AS_ASSISTANT).json()
        assert asked["waiting"] and asked["deploy"]["state"] == "waiting"
        assert client.post(dep, json={"op": "approve", "id": asked["deploy"]["id"]}, headers=AS_ASSISTANT).status_code == 400
        assert client.post(svc, json={"env": eid, "op": "stop", "key": lst["key"]}, headers=AS_ASSISTANT).status_code == 400
        client.post(dep, json={"op": "approve", "id": asked["deploy"]["id"]})
        run = _wait(client, dep, asked["deploy"]["id"])
        assert run["state"] == "ok" and run["approved_by"] == "owner" and run["sha"] != first
        assert _call(port, 21) == 63
        # rollback: the last good release before this one, its tests not run again
        assert "needs_confirm" in client.post(dep, json={"env": eid, "op": "rollback"}).json()
        did = client.post(dep, json={"env": eid, "op": "rollback", "confirm": True}).json()["deploy"]["id"]
        run = _wait(client, dep, did)
        assert run["state"] == "ok" and run["sha"] == first and run["stages"][2]["state"] == "skipped"
        assert _call(port, 21) == 42
        # history, newest first; a broken release fails at validate and says why
        client.post(url, json={"op": "save", "id": eid, "production": False})
        client.post(url, json={"op": "vars", "env": eid, "vars": {"BREAK": "1"}})
        run = _wait(client, dep, client.post(dep, json={"env": eid, "ref": "main"}).json()["deploy"]["id"])
        assert run["state"] == "failed"
        failed = next(s for s in run["stages"] if s["state"] == "failed")
        assert failed["name"] == "validate" and "boom" in failed["said"] and run["stages"][-1]["state"] == "not run"
        kinds = [r["kind"] for r in client.get(dep, params={"env": eid}).json()["deploys"]]
        assert kinds == ["deploy", "rollback", "deploy", "deploy"]
        # it left the host on the broken code: a rollback goes back to the release that was good
        client.post(url, json={"op": "vars", "env": eid, "vars": {"BREAK": None}})
        run = _wait(client, dep, client.post(dep, json={"env": eid, "op": "rollback"}).json()["deploy"]["id"])
        assert run["state"] == "ok" and run["sha"] == first and _call(port, 21) == 42
    finally:
        for t in list(client.app.state.deploys.active.values()):  # a deploy still running would start it again
            t.join(timeout=120)
        client.post(url, json={"op": "save", "id": eid, "production": False})
        client.post(svc, json={"env": eid, "op": "stop", "key": f"127.0.0.1:{port}"})
        shutil.rmtree(Path.home() / ".local" / "state" / "operonx-svc" / eid, ignore_errors=True)


def test_this_machine_is_the_default_and_deploys_its_checkout_as_it_is(client, tmp_path):
    import hashlib
    import sys

    from operonx_studio.services import probe_port

    root, port = tmp_path / "here", _free_port()
    root.mkdir()
    (root / "main.py").write_text("FACTOR = 2\n" + SERVE_MAIN, encoding="utf-8")
    (root / "operonx.toml").write_text(f'[project]\nname = "here"\n\n[[serve]]\nname = "times"\nkind = "http"\n'
                                       f'path = "/times"\nhost = "127.0.0.1"\nport = {port}\ngraph = "main:flow"\n',
                                       encoding="utf-8")
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "double")
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]
    url, dep, svc = f"/api/p/{pid}/environments", f"/api/p/{pid}/deploys", f"/api/p/{pid}/env-services"
    # this machine keeps its interpreter and commands; its folder stays the checkout
    client.post(url, json={"op": "save", "id": "local", "python": sys.executable, "test": "grep -q FACTOR main.py",
                           "workdir": "/elsewhere"})
    here = client.get(url).json()["environments"][0]
    assert here["id"] == "local" and here["python"] == sys.executable and here["workdir"] == str(root)
    key = f"127.0.0.1:{port}"
    try:
        # the Services page started it: a deploy here takes the port over
        assert client.post(f"/api/p/{pid}/services/start", json={"key": key}).status_code == 200
        end = time.time() + 60
        while time.time() < end and not probe_port("127.0.0.1", port):
            time.sleep(0.3)
        page = client.get(f"/api/p/{pid}/services").json()["listeners"][0]
        assert page["running"] and page["managed"]
        # no environment, no ref: this machine, its checkout as it is
        run = _wait(client, dep, client.post(dep, json={}).json()["deploy"]["id"])
        states = {s["name"]: s["state"] for s in run["stages"]}
        assert run["env"] == "local" and run["state"] == "ok", run["stages"]
        assert states == {"git": "ok", "build": "skipped", "test": "ok", "run": "ok", "validate": "ok", "deploy": "ok"}
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
        assert run["sha"] == head and run["ref"] == "main" and "main at" in run["stages"][0]["said"]
        assert _call(port, 21) == 42
        assert not client.app.state.deploys.active  # the run ended
        listed = client.post(svc, json={}).json()
        assert listed["listeners"][0]["running"] and listed["release"] == head
        assert listed["listeners"][0]["url"] == f"http://{key}"  # opened from here, not "http://:port"
        # another branch is the owner's to switch to: the git stage says so and nothing moves
        run = _wait(client, dep, client.post(dep, json={"ref": "other"}).json()["deploy"]["id"])
        assert run["state"] == "failed" and "this machine is on main" in run["stages"][0]["said"]
        assert run["stages"][1]["state"] == "not run" and _call(port, 21) == 42
    finally:
        for t in list(client.app.state.deploys.active.values()):
            t.join(timeout=120)
        client.post(svc, json={"op": "stop", "key": key})
        client.post(f"/api/p/{pid}/services/stop", json={"key": key})
        tag = hashlib.sha1(str(root).encode()).hexdigest()[:10]
        shutil.rmtree(Path.home() / ".local" / "state" / "operonx-svc" / f"local-{tag}", ignore_errors=True)



def test_the_env_tools_name_this_machine_when_no_env_is_given():
    seen = []

    class Studio:
        def call(self, path, body=None, **params):
            seen.append(body)
            return {"exit_code": 0, "said": "fine"}

    assert mcp.t_env_check(Studio(), {}) == "status on local (exit 0):\nfine"
    mcp.t_env_run(Studio(), {"command": "pwd"})
    mcp.t_env_services(Studio(), {})
    assert [b["env"] for b in seen] == ["local"] * 3
