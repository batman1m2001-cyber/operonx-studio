"""Run, test, deploy: an environment's services and a light pipeline to it (docs/WORKSPACE_PLAN.md W4).

Services are the project's listeners (:func:`operonx_studio.services.listeners_of` over the IR). On this machine
the Services page starts them (:class:`~operonx_studio.services.ServiceProcs`); on a host over SSH they are started
here the same way — the interpreter there, ``-m operonx.cli.serve --only …``, detached in a session of its own, the
environment's variables loaded — with its pid, log and the current release under ``~/.local/state/operonx-svc/<env>/``
on the host. What is up is asked of the port itself (``/healthz``, which every operonx listener has).

A deploy runs its stages in order, each with its time and the tail of its output: git (the folder to a branch or a
commit), build, test, run (the listeners restarted), validate (each up and healthy), deploy (the release recorded as
the environment's current). On production it waits for the owner's approval first. Every deploy is kept, and a
rollback is a deploy of the last good release before the current one, or of the current one when a deploy
after it failed and left the host on its code (its tests are not run again).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from starlette.requests import Request
from starlette.responses import JSONResponse

from .environments import Env, EnvError, Environments, Provider, checkout, may, who
from .services import Listener

STAGES = ("git", "build", "test", "run", "validate", "deploy")


# ── a host's listeners, over any provider ─────────────────────────────


def _dir(env: Env) -> str:
    return f"~/.local/state/operonx-svc/{env.id}"


def _local(host: str) -> str:
    return "127.0.0.1" if host in ("", "0.0.0.0", "::") else host


def start_cmd(env: Env, lst: Listener) -> str:
    py = shlex.quote(env.python) if env.python else '"$([ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)"'
    only = " ".join(f"--only {shlex.quote(str(s.get('name')))}" for s in lst.services)
    p = lst.port
    return (f"D={_dir(env)}; mkdir -p $D; if [ -f $D/{p}.pid ] && kill -0 $(cat $D/{p}.pid) 2>/dev/null; then "
            f"echo '{lst.key} is already running'; exit 3; fi; PYTHONUNBUFFERED=1 nohup setsid {py} -m operonx.cli.serve "
            f"{only} > $D/{p}.log 2>&1 < /dev/null & echo $! > $D/{p}.pid; echo started {lst.key} pid $!")


def stop_cmd(env: Env, port: int) -> str:
    """Its whole process group (workers too): TERM, then KILL after 8 s."""
    return (f"D={_dir(env)}; if [ -f $D/{port}.pid ]; then P=$(cat $D/{port}.pid); kill -TERM -$P 2>/dev/null || "
            f"kill -TERM $P 2>/dev/null; for i in $(seq 1 40); do kill -0 $P 2>/dev/null || break; sleep 0.2; done; "
            f"kill -0 $P 2>/dev/null && kill -KILL -$P 2>/dev/null; rm -f $D/{port}.pid; echo stopped {port}; "
            f"else echo 'nothing started on {port}'; fi")


def status_cmd(env: Env, listeners: List[Listener]) -> str:
    """One line per listener: ``port|alive|http code of /healthz|pid``, then ``release|<sha>``."""
    parts = [f"D={_dir(env)}"]
    for lst in listeners:
        p = lst.port
        parts.append(f"a=0; [ -f $D/{p}.pid ] && kill -0 $(cat $D/{p}.pid) 2>/dev/null && a=1; "
                     f"h=$(curl -s -o /dev/null -m 2 -w '%{{http_code}}' http://{_local(lst.host)}:{p}/healthz 2>/dev/null"
                     f" || true); command -v curl >/dev/null || h=nocurl; echo \"{p}|$a|${{h:-000}}|$(cat $D/{p}.pid "
                     f"2>/dev/null)\"")
    parts.append("echo \"release|$(cat $D/release 2>/dev/null)\"")
    return "; ".join(parts)


def read_status(env: Env, listeners: List[Listener], out: str) -> Dict[str, Any]:
    rows: Dict[int, List[str]] = {}
    release = ""
    for line in out.splitlines():
        bits = line.strip().split("|")
        if bits[0] == "release" and len(bits) == 2:
            release = bits[1]
        elif len(bits) == 4 and bits[0].isdigit():
            rows[int(bits[0])] = bits
    got = []
    for lst in listeners:
        _, alive, code, pid = rows.get(lst.port) or ["", "0", "000", ""]
        up = code not in ("000", "nocurl")
        got.append({"key": lst.key, "host": lst.host, "port": lst.port,
                    "services": [s.get("name") for s in lst.services], "running": alive == "1", "up": up,
                    "health": None if code == "nocurl" else (int(code) if code.isdigit() and up else None),
                    "pid": int(pid) if pid.isdigit() else None, "url": preview(env, lst)})
    return {"listeners": got, "release": release}


def preview(env: Env, lst: Listener) -> str:
    """Where to open it: the environment's preview template (``https://{port}.staging.example.com``), else the host
    and port when the listener is on every address; one on 127.0.0.1 only is not reachable from outside."""
    if env.preview:
        return env.preview.replace("{port}", str(lst.port))
    if lst.host in ("", "0.0.0.0", "::"):
        return f"http://{env.host}:{lst.port}"
    return ""


# ── deploys: kept per project, run one stage at a time ────────────────


class Deploys:
    """``<state>/deploys/<pid>.json``: every deploy, newest last."""

    KEEP = 200

    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.lock = threading.Lock()
        self.active: Dict[str, threading.Thread] = {}  # deploy id → its runner

    def _file(self, pid: str) -> Path:
        return self.state_dir / "deploys" / f"{pid}.json"

    def all(self, pid: str) -> List[Dict[str, Any]]:
        try:
            runs = json.loads(self._file(pid).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        for r in runs:  # a runner the studio lost when it stopped
            if r["state"] == "running" and r["id"] not in self.active:
                r["state"] = "interrupted"
        return runs

    def get(self, pid: str, did: str) -> Dict[str, Any]:
        for r in self.all(pid):
            if r["id"] == did:
                return r
        raise EnvError(f"no deploy {did!r}")

    def put(self, pid: str, run: Dict[str, Any]) -> None:
        with self.lock:
            runs = [r for r in self.all(pid) if r["id"] != run["id"]] + [run]
            runs.sort(key=lambda r: r["created"])
            p = self._file(pid)
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp")  # replaced whole: a reader never sees half a file
            tmp.write_text(json.dumps(runs[-self.KEEP:], indent=1), encoding="utf-8")
            os.replace(tmp, p)

    def current(self, pid: str, eid: str) -> List[Dict[str, Any]]:
        """The environment's good releases, newest first."""
        return [r for r in reversed(self.all(pid)) if r["env"] == eid and r["state"] == "ok"]


def _new(env: Env, ref: str, by: str, card: str, kind: str) -> Dict[str, Any]:
    return {"id": "d-" + uuid.uuid4().hex[:10], "env": env.id, "ref": ref, "sha": "", "by": by, "card": card,
            "kind": kind, "production": env.production, "state": "waiting" if env.production else "queued",
            "created": time.time(), "started": None, "ended": None, "approved_by": "",
            "stages": [{"name": s, "state": "pending", "ms": None, "said": ""} for s in STAGES]}


def register(app: Any, *, envs: Environments, watcher_of: Callable[[str], Any],
             listeners: Callable[[str], List[Listener]], base_env: Callable[[], Dict[str, str]],
             remote_url: Callable[[Path], str], state_dir: Callable[[], Path]) -> Deploys:
    """``/api/p/{pid}/env-services`` (a host's listeners) and ``/api/p/{pid}/deploys`` (the pipeline)."""
    deploys = Deploys(state_dir())

    def root_of(pid: str) -> Path:
        w = watcher_of(pid)
        if w is None:
            raise EnvError("unknown project")
        return Path(w.root)

    def host(pid: str, eid: str) -> tuple:
        root = root_of(pid)
        env = envs.get(pid, root, eid)
        if env.kind == "local":
            raise EnvError("this machine runs the checkout as it is: its services are on the Services page")
        return root, env, envs.provider(pid, root, eid, base_env())

    async def answer(fn: Callable[[], Any]) -> JSONResponse:
        import asyncio

        try:
            return JSONResponse(await asyncio.to_thread(fn))
        except EnvError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    # ── services on a host ──

    def status(pid: str, env: Env, p: Provider) -> Dict[str, Any]:
        lst = listeners(pid)
        code, out = p.run(status_cmd(env, lst), timeout=30)
        if code != 0 and "|" not in out:
            raise EnvError(out.strip()[-300:] or "the host did not answer")
        return read_status(env, lst, out)

    @app.post("/api/p/{pid}/env-services")
    async def env_services(pid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        by = who(request)
        return await answer(lambda: services_act(pid, body, by))

    def services_act(pid: str, body: Dict[str, Any], by: str) -> Dict[str, Any]:
        op, key = str(body.get("op") or "list"), str(body.get("key") or "")
        root, env, p = host(pid, str(body.get("env") or ""))
        need = "read" if op in ("list", "log") else "run"
        why = may(env, by, need)
        if why:
            raise EnvError(why)
        if op == "list":
            return {"ok": True, **status(pid, env, p)}
        lst = next((x for x in listeners(pid) if x.key == key), None)
        if lst is None:
            raise EnvError(f"no listener {key!r}")
        if op == "log":
            n = max(1, min(int(body.get("n") or 200), 2000))
            _, out = p.run(f"tail -n {n} {_dir(env)}/{lst.port}.log 2>/dev/null || echo 'no log yet'", timeout=30)
            return {"ok": True, "said": out[-20000:]}
        if op not in ("start", "stop", "restart"):
            raise EnvError(f"unknown op {op!r}")
        if env.production and not body.get("confirm"):
            return {"needs_confirm": f"Production: {op} {lst.key} on {env.name or env.id}?"}
        cmd = {"start": start_cmd(env, lst), "stop": stop_cmd(env, lst.port),
               "restart": stop_cmd(env, lst.port) + "; " + start_cmd(env, lst)}[op]
        code, out = p.run(cmd, timeout=60)
        if code != 0:
            raise EnvError(out.strip()[-500:] or f"{op} failed ({code})")
        return {"ok": True, "said": out.strip()[-2000:], **status(pid, env, p)}

    # ── the pipeline ──

    @app.get("/api/p/{pid}/deploys")
    async def deploys_list(pid: str, env: str = "") -> JSONResponse:
        def read() -> Dict[str, Any]:
            root_of(pid)
            runs = [r for r in deploys.all(pid) if not env or r["env"] == env]
            return {"deploys": list(reversed(runs))[:50]}
        return await answer(read)

    @app.post("/api/p/{pid}/deploys")
    async def deploys_act(pid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        by = who(request)
        return await answer(lambda: deploy_act(pid, body, by))

    def deploy_act(pid: str, body: Dict[str, Any], by: str) -> Dict[str, Any]:
        op = str(body.get("op") or "deploy")
        if op in ("approve", "reject"):
            if by == "assistant":
                raise EnvError("the owner approves a deploy")
            run = deploys.get(pid, str(body.get("id") or ""))
            if run["state"] != "waiting":
                raise EnvError(f"that deploy is {run['state']}, not waiting")
            if op == "reject":
                run.update(state="rejected", ended=time.time())
                deploys.put(pid, run)
                return {"ok": True, "said": "rejected", "deploy": run}
            run["approved_by"] = "owner"
            return go(pid, run)
        root, env, _ = host(pid, str(body.get("env") or ""))
        if op == "rollback":
            good = deploys.current(pid, env.id)
            moved = [r for r in reversed(deploys.all(pid)) if r["env"] == env.id and r["sha"]]  # the checkout moved
            if moved and moved[0]["state"] != "ok":  # the last one broke it: back to the release that was good
                back = good[0] if good else None
            else:
                back = next((r for r in good[1:] if r["sha"] and r["sha"] != (good[0]["sha"] if good else "")), None)
            if back is None:
                raise EnvError("no earlier good release to go back to")
            ref, kind = back["sha"], "rollback"
        elif op == "deploy":
            ref, kind = str(body.get("ref") or "").strip(), "deploy"
            if not ref:
                raise EnvError("which branch or commit?")
        else:
            raise EnvError(f"unknown op {op!r}")
        # the assistant asks for production (the owner approves); elsewhere it runs as its level allows
        why = may(env, by, "read" if env.production else "run")
        if why:
            raise EnvError(why)
        if any(r["env"] == env.id and r["state"] in ("queued", "running") for r in deploys.all(pid)):
            raise EnvError(f"a deploy to {env.name or env.id} is running")
        run = _new(env, ref, by, str(body.get("card") or ""), kind)
        if env.production:
            if by == "assistant":
                deploys.put(pid, run)
                return {"ok": True, "waiting": True, "deploy": run,
                        "said": f"waiting for the owner's approval ({env.name or env.id} is production)"}
            if not body.get("confirm"):
                return {"needs_confirm": f"Production: {kind} {ref[:12]} to {env.name or env.id}?"}
            run["approved_by"] = "owner"
        return go(pid, run)

    def go(pid: str, run: Dict[str, Any]) -> Dict[str, Any]:
        run.update(state="running", started=time.time())
        deploys.put(pid, run)
        t = threading.Thread(target=execute, args=(pid, run["id"]), daemon=True, name=f"deploy-{run['id']}")
        deploys.active[run["id"]] = t
        t.start()
        return {"ok": True, "said": f"{run['kind']} {run['ref'][:12]} started", "deploy": run}

    def execute(pid: str, did: str) -> None:
        run = deploys.get(pid, did)
        try:
            root, env, p = host(pid, run["env"])
            failed = False
            for st in run["stages"]:
                if failed:
                    st["state"] = "not run"
                    continue
                st["state"] = "running"
                deploys.put(pid, run)
                t0 = time.monotonic()
                try:
                    ok, said = stage(pid, root, env, p, run, st["name"])
                except EnvError as exc:
                    ok, said = False, str(exc)
                st.update(ms=int((time.monotonic() - t0) * 1000), said=said.strip()[-4000:],
                          state="skipped" if ok is None else ("ok" if ok else "failed"))
                failed = ok is False
                deploys.put(pid, run)
            run["state"] = "failed" if failed else "ok"
        except Exception as exc:  # noqa: BLE001 — a runner never dies silently: the deploy says why
            run["state"] = "failed"
            run["stages"][-1]["said"] = f"{type(exc).__name__}: {exc}"
        finally:
            run["ended"] = time.time()
            deploys.put(pid, run)
            deploys.active.pop(did, None)

    def stage(pid: str, root: Path, env: Env, p: Provider, run: Dict[str, Any], name: str) -> tuple:
        """(True | False | None for skipped, what it said)."""
        lst = listeners(pid)
        if name == "git":
            code, out = p.run(checkout(env, run["ref"], remote_url(root)) + " && git rev-parse HEAD", timeout=300)
            sha = out.strip().splitlines()[-1] if out.strip() else ""
            if code == 0 and re.fullmatch(r"[0-9a-f]{40}", sha):
                run["sha"] = sha
            return code == 0, out
        if name in ("build", "test"):
            cmd = getattr(env, name)
            if name == "test" and run["kind"] == "rollback":
                return None, "a rollback goes back to a release that passed"
            if not cmd:
                return None, f"no {name} command (the environment's settings)"
            code, out = p.run(cmd, timeout=1800)
            return code == 0, out + f"\nexit {code}"
        if name == "run":
            if not lst:
                return None, "no services in the project"
            cmd = "; ".join(stop_cmd(env, x.port) for x in lst) + "; " + " && ".join(start_cmd(env, x) for x in lst)
            code, out = p.run(cmd, timeout=120)
            return code == 0, out
        if name == "validate":
            if not lst:
                return None, "no services to check"
            end, got = time.monotonic() + 60, {}
            while True:
                got = status(pid, env, p)
                bad = [x for x in got["listeners"] if not (x["running"] and x["health"] == 200)]
                if not bad or time.monotonic() > end:
                    break
                if any(not x["running"] for x in bad):  # it exited: no waiting it out
                    break
                time.sleep(1)
            lines = [f"{x['key']}: {'up' if x['running'] else 'not running'}, /healthz {x['health'] or 'no answer'}"
                     for x in got["listeners"]]
            for x in bad:
                _, tail = p.run(f"tail -n 30 {_dir(env)}/{x['port']}.log 2>/dev/null", timeout=30)
                lines += [f"── {x['key']} log ──", tail.rstrip()]
            return not bad, "\n".join(lines)
        if name == "deploy":
            if not run["sha"]:
                return False, "no commit to record"
            code, out = p.run(f"D={_dir(env)}; mkdir -p $D && echo {run['sha']} > $D/release && "
                              f"echo \"$(date -u +%FT%TZ) {run['sha']} {run['kind']}\" >> $D/releases && "
                              f"echo released {run['sha'][:12]}", timeout=30)
            return code == 0, out
        raise EnvError(f"unknown stage {name!r}")

    app.state.deploys = deploys
    return deploys
