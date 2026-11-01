"""Environments: where a project's commands run — this machine, or a host over SSH (docs/WORKSPACE_PLAN.md W3).

One interface, :class:`Provider`: the argv of a shell or a command there, and a command run to its end. The local
provider is the checkout; the SSH provider is the system's OpenSSH client with the host's key pinned (no
trust-on-first-use: the key is scanned, its fingerprint shown, and only a key the owner trusted is accepted),
key authentication only, and one shared connection per host while it is used.

What an environment is (host, port, user, the folder, production or not, what the assistant may do there) is
plain settings. Its secrets — the private key and the variables commands get — live apart, under
``<state>/ox-secrets/`` (0600), are written and never read back by any route, and every output a route returns
has their values replaced with ``•••`` (:func:`redact`). The assistant's file tools are refused that folder
(:mod:`operonx_studio.runhook`).

Production asks more: the assistant reads there (status, processes, logs) but does not run, and the owner's runs
there are confirmed first.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shlex
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from starlette.requests import Request
from starlette.responses import JSONResponse

from .safewrite import atomic_write

SECRETS = "ox-secrets"  # the folder's name: runhook refuses the assistant's tools any path through it
LEVELS = ("none", "read", "run")  # what the assistant may do in an environment
LOCAL_FIELDS = ("python", "build", "test", "preview")  # what this machine keeps: the rest is the checkout
_KEY_BLOCK = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")


class EnvError(Exception):
    """A refusal or a failure, said to whoever asked."""


@dataclass
class Env:
    id: str
    name: str = ""
    kind: str = "ssh"  # "local" | "ssh"
    host: str = ""
    port: int = 22
    user: str = ""
    workdir: str = ""
    production: bool = False
    assistant: str = "run"  # LEVELS
    host_keys: str = ""  # the known_hosts lines the owner trusted
    python: str = ""  # the interpreter there that serves the project (default: .venv/bin/python, else python3)
    build: str = ""  # a deploy's build and test commands, in the folder
    test: str = ""
    preview: str = ""  # where a service is opened: https://{port}.staging.example.com (default: the host and port)

    def public(self, secrets: "Secrets") -> Dict[str, Any]:
        out = {k: v for k, v in asdict(self).items() if k != "host_keys"}
        out["trusted"] = fingerprints(self.host_keys) if self.host_keys else []
        out["key_set"] = secrets.key(self.id).is_file()
        out["vars"] = sorted(secrets.vars(self.id))  # the names; never the values
        out["where"] = self.workdir if self.kind == "local" else f"{self.user}@{self.host}:{self.workdir or '~'}"
        return out


def redact(text: str, values: List[str]) -> str:
    """*text* with every secret value and any private key in it replaced."""
    text = _KEY_BLOCK.sub("[private key]", text)
    for v in sorted({v for v in values if len(v) >= 4}, key=len, reverse=True):
        text = text.replace(v, "•••")
    return text


def fingerprints(known_hosts: str) -> List[str]:
    """``SHA256:… (ED25519)`` for each key line."""
    got = subprocess.run(["ssh-keygen", "-lf", "-"], input=known_hosts, capture_output=True, text=True, timeout=10)
    return [" ".join(line.split()[1:2] + line.split()[-1:]) for line in got.stdout.splitlines() if line.strip()]


def scan(host: str, port: int) -> str:
    """The host's keys as known_hosts lines, as the host offers them (to be shown, then trusted or not)."""
    got = subprocess.run(["ssh-keyscan", "-T", "5", "-p", str(port), host], capture_output=True, text=True, timeout=20)
    lines = "\n".join(line for line in got.stdout.splitlines() if line and not line.startswith("#"))
    if not lines:
        raise EnvError(f"no host key from {host}:{port}: {got.stderr.strip()[-200:] or 'no answer'}")
    return lines + "\n"


class Secrets:
    """``<state>/ox-secrets/<pid>/<env>/``: the private key and the variables, 0600, written, never served."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _dir(self, eid: str) -> Path:
        d = self.root / eid
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root.parent, 0o700)
        return d

    def key(self, eid: str) -> Path:
        return self.root / eid / "key"

    def set_key(self, eid: str, text: str) -> str:
        text = text.strip() + "\n"
        if not _KEY_BLOCK.search(text):
            raise EnvError("not a private key (paste the whole -----BEGIN … PRIVATE KEY----- block)")
        p = self._dir(eid) / "key"
        atomic_write(p, text)  # 0600 from the start
        got = subprocess.run(["ssh-keygen", "-y", "-P", "", "-f", str(p)], capture_output=True, text=True, timeout=10)
        if got.returncode != 0:
            p.unlink()
            raise EnvError("the key needs a passphrase or is not readable: use a key without one for this host")
        return " ".join(got.stdout.split()[:1]) + " key set"

    def vars(self, eid: str) -> Dict[str, str]:
        p = self.root / eid / "vars.json"
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def set_vars(self, eid: str, given: Dict[str, Optional[str]]) -> None:
        cur = self.vars(eid)
        for k, v in given.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", k):
                raise EnvError(f"{k!r} is not a variable name")
            if v is None:
                cur.pop(k, None)
            elif v != "":  # an empty value keeps the one stored (the page never has it)
                cur[k] = str(v)
        atomic_write(self._dir(eid) / "vars.json", json.dumps(cur))  # 0600; a run reading them sees all or none

    def drop(self, eid: str) -> None:
        d = self.root / eid
        for f in ("key", "vars.json", "known_hosts"):
            (d / f).unlink(missing_ok=True)
        if d.is_dir():
            d.rmdir()


class Provider:
    """Where commands run: the argv of a shell or of one command there, and a command run to its end."""

    def __init__(self, env: Env, secrets: Secrets, base_env: Dict[str, str]) -> None:
        self.env, self.secrets, self.base_env = env, secrets, base_env

    def argv(self, command: str = "", *, tty: bool = False) -> List[str]:
        raise NotImplementedError

    def environ(self) -> Dict[str, str]:
        return dict(self.base_env)

    def run(self, command: str, *, timeout: float = 120) -> Tuple[int, str]:
        try:
            got = subprocess.run(self.argv(command), cwd=self.cwd(), env=self.environ(), capture_output=True,
                                 text=True, timeout=timeout, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired as exc:
            out = (exc.stdout or b"").decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            return 124, self.clean(out + f"\n[stopped after {timeout:.0f}s]")
        return got.returncode, self.clean(got.stdout + got.stderr)

    def cwd(self) -> str:
        return self.env.workdir

    def clean(self, text: str) -> str:
        return redact(text, list(self.secrets.vars(self.env.id).values()))


class Local(Provider):
    """This machine, in the checkout (or the folder the environment names)."""

    def argv(self, command: str = "", *, tty: bool = False) -> List[str]:
        shell = self.base_env.get("SHELL") or "/bin/bash"
        return [shell, "-lc", command] if command else [shell, "-l"]

    def environ(self) -> Dict[str, str]:
        return {**self.base_env, **self.secrets.vars(self.env.id)}


class SSH(Provider):
    """A host over OpenSSH: its pinned key, the stored private key, one shared connection."""

    def known_hosts(self) -> Path:
        p = self.secrets._dir(self.env.id) / "known_hosts"
        try:
            same = p.read_text(encoding="utf-8") == self.env.host_keys
        except OSError:
            same = False
        if not same:  # rewritten under an ssh reading it, a check could fail: only when it changed, whole
            atomic_write(p, self.env.host_keys)
        return p

    def options(self) -> List[str]:
        if not self.env.host_keys:
            raise EnvError("the host's key is not trusted yet: Scan it, check the fingerprint, then Trust")
        key = self.secrets.key(self.env.id)
        if not key.is_file():
            raise EnvError("no private key: paste one in the environment's settings")
        # a short control path (sockets are limited to ~100 bytes); one per host and user
        tag = hashlib.sha1(f"{self.env.user}@{self.env.host}:{self.env.port}:{key}".encode()).hexdigest()[:12]
        return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={self.known_hosts()}",
                "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                "-o", "PasswordAuthentication=no", "-o", "ConnectTimeout=10", "-o", "ControlMaster=auto",
                "-o", f"ControlPath={tempfile.gettempdir()}/oxs-{tag}", "-o", "ControlPersist=120",
                "-o", "LogLevel=ERROR", "-i", str(key), "-p", str(self.env.port), "-l", self.env.user, self.env.host]

    def remote(self, command: str) -> str:
        """The command on the host: in the folder, with the variables from ~/.config/operonx-env/<env>.env."""
        where = f"cd {shlex.quote(self.env.workdir)} 2>/dev/null; " if self.env.workdir else ""  # not there yet: home
        load = f"f=~/.config/operonx-env/{self.env.id}.env; [ -f $f ] && set -a && . $f && set +a; "
        return where + load + (command or 'exec "${SHELL:-/bin/bash}" -l')

    def argv(self, command: str = "", *, tty: bool = False) -> List[str]:
        return ["ssh", *(["-tt"] if tty else ["-T"]), *self.options(), self.remote(command)]

    def cwd(self) -> str:
        return tempfile.gettempdir()

    def push_vars(self) -> None:
        """The variables to ~/.config/operonx-env/<env>.env on the host (0600), over stdin: never on a command line."""
        values = self.secrets.vars(self.env.id)
        body = "".join(f"{k}={shlex.quote(v)}\n" for k, v in sorted(values.items()))
        cmd = f"umask 077; mkdir -p ~/.config/operonx-env && cat > ~/.config/operonx-env/{self.env.id}.env"
        got = subprocess.run(["ssh", "-T", *self.options(), cmd], input=body, capture_output=True, text=True,
                             timeout=30, cwd=self.cwd(), env=self.environ())
        if got.returncode != 0:
            raise EnvError(self.clean(got.stderr.strip()[-300:]) or "could not write the variables on the host")


class Environments:
    """A project's environments: ``local`` (always, the checkout) and the ones the owner added."""

    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir

    def _file(self, pid: str) -> Path:
        return self.state_dir / "environments" / f"{pid}.json"

    def secrets(self, pid: str) -> Secrets:
        return Secrets(self.state_dir / SECRETS / pid)

    def all(self, pid: str, root: Path) -> List[Env]:
        try:
            raw = json.loads(self._file(pid).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = []
        names = {f.name for f in fields(Env)}
        envs = [Env(**{k: v for k, v in r.items() if k in names}) for r in raw if r.get("id") != "local"]
        mine = next((r for r in raw if r.get("id") == "local"), {})  # this machine: only its commands are kept
        here = Env("local", "This machine", "local", workdir=str(root), assistant="run",
                   **{k: str(mine.get(k) or "") for k in LOCAL_FIELDS})
        return [here, *envs]

    def get(self, pid: str, root: Path, eid: str) -> Env:
        for e in self.all(pid, root):
            if e.id == eid:
                return e
        raise EnvError(f"no environment {eid!r}")

    def save(self, pid: str, root: Path, env: Env) -> None:
        here, *rest = self.all(pid, root)
        here = env if env.id == "local" else here
        envs = [{"id": "local", **{k: getattr(here, k) for k in LOCAL_FIELDS}}] + \
            [asdict(e) for e in rest if e.id != env.id] + ([asdict(env)] if env.id != "local" else [])
        self._write(pid, envs)

    def _write(self, pid: str, rows: List[Dict[str, Any]]) -> None:
        p = self._file(pid)
        p.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(p, json.dumps(rows, indent=1))

    def delete(self, pid: str, root: Path, eid: str) -> None:
        if eid == "local":
            raise EnvError("this machine stays")
        here, *rest = self.all(pid, root)
        self._write(pid, [{"id": "local", **{k: getattr(here, k) for k in LOCAL_FIELDS}}]
                    + [asdict(e) for e in rest if e.id != eid])
        self.secrets(pid).drop(eid)

    def provider(self, pid: str, root: Path, eid: str, base_env: Dict[str, str]) -> Provider:
        env = self.get(pid, root, eid)
        return (Local if env.kind == "local" else SSH)(env, self.secrets(pid), base_env)


def who(request: Request) -> str:
    """``assistant`` when the assistant's tools call, else ``owner``."""
    user = getattr(request.state, "user", None) or {}
    return "assistant" if user.get("via") == "assistant" or request.headers.get("x-operonx-via") == "assistant" \
        else "owner"


def may(env: Env, by: str, need: str) -> Optional[str]:
    """Why *by* may not do what needs *need* ("read" or "run") in *env*, or None."""
    if by != "assistant":
        return None
    level = "read" if env.production and env.assistant == "run" else env.assistant
    if LEVELS.index(level) >= LEVELS.index(need):
        return None
    if env.production:
        return f"{env.name or env.id} is production: the assistant reads there; the owner runs from the Environments page"
    return f"the assistant may {'not touch' if level == 'none' else 'only read'} {env.name or env.id} (its settings)"


# what each read op runs, on any provider
READS = {
    "processes": "ps -eo pid,etime,pcpu,pmem,args --sort=-pcpu | head -40",
    "resources": "uptime; echo; free -m 2>/dev/null || vm_stat; echo; df -h . 2>/dev/null | tail -n +1",
    "status": "git rev-parse --abbrev-ref HEAD 2>/dev/null && git log -1 --format='%h %s (%cr)' 2>/dev/null "
              "&& git status --short 2>/dev/null | head -20 || echo 'no checkout here'",
}


def register(app: Any, *, watcher_of: Callable[[str], Any], state_dir: Callable[[], Path],
             base_env: Callable[[], Dict[str, str]], remote_url: Callable[[Path], str]) -> "Environments":
    """``/api/p/{pid}/environments``: list (GET), add or change and act on one (POST)."""
    envs = Environments(state_dir())
    scanned: Dict[Tuple[str, str], str] = {}  # (pid, env) → the keys last scanned, until trusted

    def root_of(pid: str) -> Path:
        w = watcher_of(pid)
        if w is None:
            raise EnvError("unknown project")
        return Path(w.root)

    async def answer(fn: Callable[[], Any]) -> JSONResponse:
        try:
            return JSONResponse(await asyncio.to_thread(fn))
        except EnvError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    @app.get("/api/p/{pid}/environments")
    async def environments_list(pid: str) -> JSONResponse:
        def read() -> Dict[str, Any]:
            root = root_of(pid)
            return {"environments": [e.public(envs.secrets(pid)) for e in envs.all(pid, root)]}
        return await answer(read)

    @app.post("/api/p/{pid}/environments")
    async def environments_act(pid: str, body: Dict[str, Any], request: Request) -> JSONResponse:
        by = who(request)
        return await answer(lambda: act(pid, body, by))

    def act(pid: str, body: Dict[str, Any], by: str) -> Dict[str, Any]:
        root = root_of(pid)
        op, eid = str(body.get("op") or ""), str(body.get("env") or "")
        sec = envs.secrets(pid)
        if op in ("save", "key", "vars", "scan", "trust", "delete") and by == "assistant":
            raise EnvError("the owner sets environments up (hosts, keys, variables, trusted host keys)")
        if op == "save":
            return save(pid, root, body)
        env = envs.get(pid, root, eid)
        if op == "key":
            if env.kind == "local":
                raise EnvError("this machine needs no key")
            return {"ok": True, "said": sec.set_key(env.id, str(body.get("key") or "")), "env": env.public(sec)}
        if op == "vars":
            sec.set_vars(env.id, {str(k): v for k, v in (body.get("vars") or {}).items()})
            if env.kind == "ssh" and env.host_keys and sec.key(env.id).is_file():
                envs.provider(pid, root, env.id, base_env()).push_vars()  # type: ignore[attr-defined]
            return {"ok": True, "said": "variables saved", "env": env.public(sec)}
        if op == "scan":
            if env.kind == "local":
                raise EnvError("this machine has no host key to check")
            scanned[(pid, env.id)] = scan(env.host, env.port)
            got = fingerprints(scanned[(pid, env.id)])
            same = env.host_keys and set(got) == set(fingerprints(env.host_keys))
            return {"ok": True, "fingerprints": got, "changed": bool(env.host_keys) and not same,
                    "said": "the host's keys: check them against the host's own (ssh-keygen -lf /etc/ssh/ssh_host_*.pub)"}
        if op == "trust":
            keys = scanned.pop((pid, env.id), "")
            if not keys:
                raise EnvError("scan the host first")
            env.host_keys = keys
            envs.save(pid, root, env)
            return {"ok": True, "said": "host key trusted", "env": env.public(sec)}
        if op == "delete":
            if not body.get("confirm"):
                return {"needs_confirm": f"Delete {env.name or env.id}, its key and its variables?"}
            envs.delete(pid, root, env.id)
            return {"ok": True, "said": f"{env.id} deleted"}
        p = envs.provider(pid, root, env.id, base_env())
        if op == "test":
            why = may(env, by, "read")
            if why:
                raise EnvError(why)
            t0 = time.monotonic()
            code, out = p.run("echo connected; whoami; uname -sr; pwd", timeout=30)
            return {"ok": code == 0, "ms": int((time.monotonic() - t0) * 1000), "said": out.strip()[-1500:],
                    "exit_code": code}
        if op in READS or op in ("logs", "files"):
            why = may(env, by, "read")
            if why:
                raise EnvError(why)
            if op == "logs":
                path = str(body.get("path") or "")
                if not path:
                    raise EnvError("which log file?")
                cmd = f"tail -n {max(1, min(int(body.get('n') or 200), 2000))} -- {shlex.quote(path)}"
            elif op == "files":
                cmd = f"ls -la -- {shlex.quote(str(body.get('path') or '.'))} | head -200"
            else:
                cmd = READS[op]
            code, out = p.run(cmd, timeout=30)
            return {"ok": code == 0, "exit_code": code, "said": out[-20000:]}
        if op in ("run", "checkout", "kill"):
            why = may(env, by, "run")
            if why:
                raise EnvError(why)
            if op == "checkout":
                cmd = checkout(env, str(body.get("branch") or ""), remote_url(root))
            elif op == "kill":
                cmd = f"kill -TERM {int(body.get('pid') or 0)}"
            else:
                cmd = str(body.get("command") or "")
                if not cmd.strip():
                    raise EnvError("which command?")
            if (env.production or op == "kill") and not body.get("confirm"):
                return {"needs_confirm": f"{'Production: ' if env.production else ''}run `{cmd}` on {env.name or env.id}?"}
            code, out = p.run(cmd, timeout=min(float(body.get("timeout") or 300), 1800))
            return {"ok": code == 0, "exit_code": code, "said": out[-20000:]}
        raise EnvError(f"unknown op {op!r}")

    def save(pid: str, root: Path, body: Dict[str, Any]) -> Dict[str, Any]:
        eid = str(body.get("id") or "").strip().lower()
        if eid == "local":  # this machine: the checkout as it is; its interpreter and commands can be set
            env = envs.get(pid, root, eid)
            for k in LOCAL_FIELDS:
                if k in body:
                    setattr(env, k, str(body[k]).strip())
            envs.save(pid, root, env)
            return {"ok": True, "said": "this machine saved", "env": env.public(envs.secrets(pid))}
        if not _SLUG.fullmatch(eid):
            raise EnvError("an id: lowercase letters, digits and dashes (staging, prod-eu), not 'local'")
        try:
            env = envs.get(pid, root, eid)
        except EnvError:
            env = Env(eid)
        for k in ("name", "host", "user", "workdir", "python", "build", "test", "preview"):
            if k in body:
                setattr(env, k, str(body[k]).strip())
        if "port" in body:
            env.port = int(body["port"] or 22)
        if "production" in body:
            env.production = bool(body["production"])
        if body.get("assistant") in LEVELS:
            env.assistant = body["assistant"]
        if not env.host or not env.user:
            raise EnvError("a host and a user")
        if any(c in env.host + env.user for c in " @:/;'\"`$") or env.host.startswith("-") or env.user.startswith("-"):
            raise EnvError("the host and user are a name or an address, nothing else")
        envs.save(pid, root, env)
        return {"ok": True, "said": f"{eid} saved", "env": env.public(envs.secrets(pid))}

    app.state.environments = envs
    return envs


def checkout(env: Env, branch: str, url: str) -> str:
    """Bring the environment's folder to *branch* (or a commit): clone it there the first time, then fetch and
    fast-forward (a commit is checked out detached)."""
    if not branch or not re.fullmatch(r"[\w./-]{1,200}", branch) or branch.startswith("-"):
        raise EnvError("which branch?")
    if not env.workdir:
        raise EnvError("the environment has no folder: set one")
    b, wd = shlex.quote(branch), shlex.quote(env.workdir)
    clone = f"git clone --quiet {shlex.quote(url)} {wd} && cd {wd}" if url else f"echo 'no remote to clone from'; exit 1"
    to = (f"git switch --quiet --detach {b}" if re.fullmatch(r"[0-9a-f]{7,40}", branch)
          else f"git switch --quiet {b} && git pull --ff-only --quiet")
    return (f"cd / && if [ -d {wd}/.git ]; then cd {wd}; else {clone}; fi && git fetch --all --prune --quiet "
            f"&& {to} && git log -1 --format='%h %s'")
