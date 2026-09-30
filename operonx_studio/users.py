"""The studio's people: accounts, passwords and sign-in sessions
(docs/TEAM_PLAN.md §2.1).

One SQLite file, ``<state>/users.sqlite`` (mode 0600), built the way the
assistant's :class:`~operonx_studio.assistant.ChatStore` is: one
connection behind a lock, WAL. Standard library only (decision D1):

* **Passwords** are ``hashlib.scrypt`` (n=2^14, r=8, p=1, 16-byte salt,
  32 bytes out), kept as ``scrypt$n$r$p$salt$hash`` so a later change of
  parameters still verifies the old hashes. An unknown username is checked
  against a dummy hash, so it takes as long as a wrong password.
* **Sessions** are random cookies (``secrets.token_urlsafe(32)``); only
  their sha256 is stored, so a copy of the file signs nobody in. A session
  lasts 30 days from its last use and ends on logout, on a password change
  (the others), and on a reset, disable or delete (all of them).
* **Agent tokens** (:class:`AgentTokens`) are the assistant's: one per
  turn, in memory only, for the turn's owner.

Reads go through a 5-second cache (decision D16: a role change applies
within 5 s even when another process — the CLI reset — made it); every
write through this store clears it at once.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

__all__ = ["ROLES", "AgentTokens", "PasswordError", "Throttle", "UserStore", "hash_password",
           "check_password", "valid_username"]

LOGGER = logging.getLogger(__name__)

ROLES = ("admin", "editor", "viewer")
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")

#: A session lasts this long from its last use.
SESSION_DAYS = 30
SESSION_TTL = SESSION_DAYS * 86400.0
#: ``last_seen`` is written at most this often (one UPDATE a minute, not one a request).
TOUCH_EVERY = 60.0
#: How long a read may be stale (decision D16).
CACHE_TTL = 5.0

_N, _R, _P, _DKLEN = 2 ** 14, 8, 1, 32


class PasswordError(ValueError):
    """A password (or a username) the rules refuse; the message says why."""


def valid_username(name: str) -> bool:
    return bool(USERNAME.match(name or ""))


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN,
                            maxmem=64 * 1024 * 1024)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        kind, n, r, p, salt, digest = stored.split("$")
        if kind != "scrypt":
            return False
        want = bytes.fromhex(digest)
        got = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                             dklen=len(want), maxmem=64 * 1024 * 1024)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, want)


_dummy: Dict[str, str] = {}


def _dummy_hash() -> str:
    """A hash nobody's password matches: an unknown username costs one
    scrypt, the same as a known one."""
    if "h" not in _dummy:
        _dummy["h"] = hash_password(secrets.token_urlsafe(16))
    return _dummy["h"]


def password_problem(password: str, username: str) -> Optional[str]:
    """Why *password* can't be chosen, or None."""
    if len(password) < 8:
        return "A password needs at least 8 characters."
    if password.strip().lower() == (username or "").lower():
        return "A password must differ from the username."
    return None


def temporary_password() -> str:
    return secrets.token_urlsafe(9)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL,
    pw            TEXT NOT NULL,
    must_change   INTEGER NOT NULL DEFAULT 0,
    disabled      INTEGER NOT NULL DEFAULT 0,
    machine_login INTEGER NOT NULL DEFAULT 0,
    claude_home   TEXT,
    claude_email  TEXT,
    created       REAL NOT NULL,
    last_seen     REAL
);
CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash  TEXT PRIMARY KEY,
    user        TEXT NOT NULL,
    created     REAL NOT NULL,
    last_seen   REAL NOT NULL,
    expires     REAL NOT NULL,
    label       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS web_sessions_by_user ON web_sessions (user);
CREATE TABLE IF NOT EXISTS audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        REAL NOT NULL,
    user      TEXT,
    username  TEXT,
    via       TEXT NOT NULL,
    method    TEXT NOT NULL,
    route     TEXT NOT NULL,
    pid       TEXT,
    params    TEXT NOT NULL DEFAULT '{}',
    status    INTEGER,
    detail    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_by_at ON audit (at);
CREATE INDEX IF NOT EXISTS audit_by_user ON audit (user, id);
CREATE INDEX IF NOT EXISTS audit_by_pid ON audit (pid, id);
"""

#: The request-body keys the activity log keeps (docs/TEAM_PLAN.md §2.6): what
#: was acted on, never what was said or any secret — a password, a sign-in
#: code, a webhook, dataset rows, inputs and messages are never among them.
#: username/role/disabled name who an admin acted on (P6: the Team page's rows).
AUDIT_KEYS = ("name", "key", "action", "graph", "resource", "apply", "dry_run", "dataset", "service", "op",
              "template", "path", "username", "role", "disabled")
AUDIT_DAYS = 180


def audit_detail(body: Any) -> Dict[str, Any]:
    """The recordable part of a request body: the keys above, scalars only
    (strings cut at 200), lists of scalars cut at 20."""
    if not isinstance(body, dict):
        return {}
    out: Dict[str, Any] = {}
    for key in AUDIT_KEYS:
        if key not in body:
            continue
        v = body[key]
        if isinstance(v, str):
            out[key] = v[:200]
        elif v is None or isinstance(v, (bool, int, float)):
            out[key] = v
        elif isinstance(v, list) and all(isinstance(x, (str, int, float, bool)) for x in v):
            out[key] = [x[:200] if isinstance(x, str) else x for x in v[:20]]
    return out

_USER_FIELDS = ("name", "role", "must_change", "disabled", "machine_login", "claude_home", "claude_email")


class UserStore:
    """Accounts and web sessions in one SQLite file. Thread-safe: one
    connection behind a lock — every statement here is sub-millisecond
    (the scrypt work happens outside the lock)."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.path.exists():
            # 0600 before SQLite opens it: SQLite gives its -wal and -shm
            # files the database's own mode, so they are private too
            os.close(os.open(str(self.path), os.O_WRONLY | os.O_CREAT, 0o600))
        try:
            os.chmod(self.path, 0o600)
        except OSError:  # pragma: no cover — a file we can open but not chmod
            pass
        self._db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.executescript(_SCHEMA)
        self._cache: Dict[str, Tuple[float, Any]] = {}
        # the studio prunes at start (app.py); after that, once a day as rows arrive
        self._pruned = time.time()

    def _q(self, sql: str, args: Iterable[Any] = ()) -> List[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, tuple(args)).fetchall()

    def _changed(self) -> None:
        self._cache.clear()

    def _cached(self, key: str, make):
        now = time.monotonic()
        got = self._cache.get(key)
        if got is not None and now - got[0] < CACHE_TTL:
            return got[1]
        value = make()
        self._cache[key] = (now, value)
        return value

    # ── people ──

    @staticmethod
    def _user(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        out = dict(row)
        for key in ("must_change", "disabled", "machine_login"):
            out[key] = bool(out[key])
        return out

    def count(self) -> int:
        return int(self._q("SELECT COUNT(*) AS n FROM users")[0]["n"])

    def users(self) -> List[Dict[str, Any]]:
        return [self._user(r) for r in self._q("SELECT * FROM users ORDER BY created")]  # type: ignore[misc]

    def user(self, uid: str) -> Optional[Dict[str, Any]]:
        rows = self._q("SELECT * FROM users WHERE id = ?", (uid,))
        return self._user(rows[0]) if rows else None

    def cached_user(self, uid: str) -> Optional[Dict[str, Any]]:
        return self._cached("u:" + uid, lambda: self.user(uid))

    def by_name(self, username: str) -> Optional[Dict[str, Any]]:
        rows = self._q("SELECT * FROM users WHERE username = ?", ((username or "").strip().lower(),))
        return self._user(rows[0]) if rows else None

    def first_admin(self) -> Optional[Dict[str, Any]]:
        """The oldest active admin: who everyone is when auth is off."""
        def look():
            rows = self._q("SELECT * FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY created LIMIT 1")
            return self._user(rows[0]) if rows else None
        return self._cached("first_admin", look)

    def active_admins(self) -> int:
        return int(self._q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")[0]["n"])

    def create(self, username: str, *, role: str, name: str = "", password: Optional[str] = None,
               must_change: bool = True, machine_login: bool = False,
               claude_home: Optional[str] = None, check_rules: bool = True) -> Tuple[Dict[str, Any], str]:
        """A new person; returns them and their password (a temporary one
        when none is given — shown once, never stored in the clear)."""
        username = (username or "").strip().lower()
        if not valid_username(username):
            raise PasswordError("A username is 1-32 lowercase letters, digits, '.', '_' or '-', "
                                "starting with a letter or digit.")
        if role not in ROLES:
            raise PasswordError(f"A role is one of {', '.join(ROLES)}.")
        if self.by_name(username) is not None:
            raise PasswordError(f"There is already someone called {username}.")
        password = password if password is not None else temporary_password()
        if check_rules:
            problem = password_problem(password, username)
            if problem:
                raise PasswordError(problem)
        uid = secrets.token_hex(8)
        self._q("INSERT INTO users (id, username, name, role, pw, must_change, machine_login, claude_home, created)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (uid, username, (name or "").strip()[:80], role, hash_password(password), int(must_change),
                 int(machine_login), claude_home, time.time()))
        self._changed()
        return self.user(uid), password  # type: ignore[return-value]

    def update(self, uid: str, **fields: Any) -> Optional[Dict[str, Any]]:
        sets = {k: v for k, v in fields.items() if k in _USER_FIELDS}
        if "role" in sets and sets["role"] not in ROLES:
            raise PasswordError(f"A role is one of {', '.join(ROLES)}.")
        for key in ("must_change", "disabled", "machine_login"):
            if key in sets:
                sets[key] = int(bool(sets[key]))
        if sets:
            self._q(f"UPDATE users SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), uid))
            self._changed()
        return self.user(uid)

    def set_password(self, uid: str, password: str, *, must_change: bool = False) -> None:
        self._q("UPDATE users SET pw = ?, must_change = ? WHERE id = ?",
                (hash_password(password), int(must_change), uid))
        self._changed()

    def reset_password(self, uid: str) -> str:
        """A temporary password, to be changed at the next sign-in; every
        session of theirs ends."""
        password = temporary_password()
        self.set_password(uid, password, must_change=True)
        self.end_sessions(uid)
        return password

    def delete(self, uid: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM web_sessions WHERE user = ?", (uid,))
            self._db.execute("DELETE FROM users WHERE id = ?", (uid,))
        self._changed()

    def check(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        """The person *username* names when *password* is theirs, else None.
        Always one scrypt, known name or not."""
        user = self.by_name(username)
        ok = check_password(password, user["pw"] if user else _dummy_hash())
        return user if (ok and user is not None) else None

    # ── sessions ──

    def start_session(self, uid: str, label: str = "") -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        self._q("INSERT INTO web_sessions (token_hash, user, created, last_seen, expires, label)"
                " VALUES (?, ?, ?, ?, ?, ?)", (_token_hash(token), uid, now, now, now + SESSION_TTL, label[:120]))
        self._q("UPDATE users SET last_seen = ? WHERE id = ?", (now, uid))
        return token

    def resolve(self, token: str) -> Tuple[Optional[Dict[str, Any]], Optional[str], bool]:
        """(the person, the session's hash, whether its 30 days just moved
        on) for a session cookie; (None, None, False) when it signs nobody in."""
        if not token or len(token) > 200:
            return None, None, False
        th = _token_hash(token)

        def look():
            rows = self._q("SELECT * FROM web_sessions WHERE token_hash = ?", (th,))
            return dict(rows[0]) if rows else None

        sess = self._cached("s:" + th, look)
        if sess is None:
            return None, None, False
        now = time.time()
        if sess["expires"] < now:
            self.end_session(token)
            return None, None, False
        user = self.cached_user(sess["user"])
        if user is None or user["disabled"]:
            return None, None, False
        touched = False
        if now - sess["last_seen"] >= TOUCH_EVERY:
            self._q("UPDATE web_sessions SET last_seen = ?, expires = ? WHERE token_hash = ?",
                    (now, now + SESSION_TTL, th))
            self._q("UPDATE users SET last_seen = ? WHERE id = ?", (now, sess["user"]))
            sess.update(last_seen=now, expires=now + SESSION_TTL)
            touched = True
        return user, th, touched

    def end_session(self, token: str) -> None:
        self.end_session_hash(_token_hash(token))

    def end_session_hash(self, th: str) -> None:
        self._q("DELETE FROM web_sessions WHERE token_hash = ?", (th,))
        self._changed()

    def end_sessions(self, uid: str, *, keep: Optional[str] = None) -> int:
        """End *uid*'s sessions, except the one hashed *keep*; how many ended."""
        rows = self._q("SELECT token_hash FROM web_sessions WHERE user = ?", (uid,))
        gone = [r["token_hash"] for r in rows if r["token_hash"] != keep]
        with self._lock:
            for th in gone:
                self._db.execute("DELETE FROM web_sessions WHERE token_hash = ?", (th,))
        self._changed()
        return len(gone)

    def session_counts(self) -> Dict[str, int]:
        rows = self._q("SELECT user, COUNT(*) AS n FROM web_sessions WHERE expires >= ? GROUP BY user", (time.time(),))
        return {r["user"]: int(r["n"]) for r in rows}

    # ── the activity log (§2.6) ──

    def audit(self, *, user: Optional[str], via: str, method: str, route: str, status: Optional[int],
              username: Optional[str] = None, pid: Optional[str] = None, params: Optional[Dict[str, Any]] = None,
              detail: Optional[Dict[str, Any]] = None, at: Optional[float] = None) -> None:
        """One row: who (and how: web, assistant, cli) did what, where, and
        how it ended. *detail* must already be filtered (audit_detail)."""
        now = time.time()
        if username is None and user:
            row = self.cached_user(user)
            username = row["username"] if row else None
        self._q("INSERT INTO audit (at, user, username, via, method, route, pid, params, status, detail)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (at if at is not None else now, user, username, via, method, route, pid,
                 json.dumps(params or {}), status, json.dumps(detail or {})))
        if now - self._pruned > 86400:           # at most once a day, as rows are written
            self.prune_audit()

    def activity(self, *, user: Optional[str] = None, pid: Optional[str] = None, before: Optional[int] = None,
                 limit: int = 200) -> List[Dict[str, Any]]:
        """Newest first; *before* an id pages further back."""
        where, args = [], []
        for col, val in (("user", user), ("pid", pid)):
            if val:
                where.append(f"{col} = ?")
                args.append(val)
        if before:
            where.append("id < ?")
            args.append(int(before))
        sql = "SELECT * FROM audit" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?"
        args.append(max(1, min(int(limit), 1000)))
        out = []
        for r in self._q(sql, args):
            row = dict(r)
            row["params"] = json.loads(row["params"] or "{}")
            row["detail"] = json.loads(row["detail"] or "{}")
            out.append(row)
        return out

    def prune_audit(self, days: int = AUDIT_DAYS) -> int:
        """Rows older than *days* go; how many."""
        self._pruned = time.time()
        with self._lock:
            return int(self._db.execute("DELETE FROM audit WHERE at < ?", (time.time() - days * 86400,)).rowcount)

    # ── the first start ──

    def ensure_first_admin(self, username: str, password: str, *, claude_home: Optional[str]) -> Optional[Dict[str, Any]]:
        """Today's single login becomes the first admin (decision D3), once:
        on a start that finds no one. They keep the studio's Claude sign-in
        directory and the machine's login; a default or too-weak password
        must be changed at the first sign-in. Returns them when created."""
        if self.count():
            return None
        name = re.sub(r"[^a-z0-9._-]", "-", (username or "").strip().lower()).lstrip("._-")[:32] or "root"
        must = password == "123" or password_problem(password, name) is not None
        user, _ = self.create(name, role="admin", name=name, password=password, must_change=must,
                              machine_login=True, claude_home=claude_home, check_rules=False)
        LOGGER.warning("operonx studio: no accounts yet, so %r is now the first admin, from OPERONX_STUDIO_USER/"
                       "OPERONX_STUDIO_PASS (default root/123)%s. Those variables are not read again; "
                       "use `operonx-studio --reset-password NAME` if you are locked out.",
                       name, " — the password must be changed at the first sign-in" if must else "")
        return user


class AgentTokens:
    """The assistant's way in (decision D12): a token per turn, for the
    person whose turn it is, in memory only. It is revoked when the turn
    ends, and dies on its own after *ttl* in case an end is ever missed. A
    studio restart forgets every one — the turns died with it."""

    def __init__(self) -> None:
        self._tokens: Dict[str, Tuple[str, float]] = {}   # token -> (user id, expires, monotonic)
        self._lock = threading.Lock()

    def issue(self, uid: str, ttl: float) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            now = time.monotonic()
            for t, (_, until) in list(self._tokens.items()):
                if until < now:
                    self._tokens.pop(t, None)
            self._tokens[token] = (uid, now + ttl)
        return token

    def resolve(self, token: str) -> Optional[str]:
        got = self._tokens.get(token or "")
        if got is None:
            return None
        if got[1] < time.monotonic():
            self.revoke(token)
            return None
        return got[0]

    def revoke(self, token: str) -> None:
        with self._lock:
            self._tokens.pop(token, None)

    def revoke_user(self, uid: str) -> int:
        with self._lock:
            gone = [t for t, (u, _) in self._tokens.items() if u == uid]
            for t in gone:
                self._tokens.pop(t, None)
        return len(gone)

    def __len__(self) -> int:
        return len(self._tokens)


class Throttle:
    """Failed sign-ins, per username and per client address, in memory
    (decision D15): after 5 failures a key is locked for 30 s, then 60, …
    up to 15 minutes. A success clears both keys; a key idle for an hour
    is forgotten."""

    LIMIT = 5
    FIRST = 30.0
    MOST = 900.0
    FORGET = 3600.0

    def __init__(self) -> None:
        self._keys: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def locked(self, *keys: str) -> float:
        """Seconds until every key may try again (0: go ahead)."""
        now = time.monotonic()
        wait = 0.0
        with self._lock:
            for key in keys:
                st = self._keys.get(key)
                if st is None:
                    continue
                if now - st["last"] > self.FORGET and st["until"] < now:
                    self._keys.pop(key, None)
                    continue
                wait = max(wait, st["until"] - now)
        return max(0.0, wait)

    def fail(self, *keys: str, pw: Optional[str] = None) -> None:
        """*pw* is the stored hash the attempt was checked against, so a
        later reset of that password can lift the lock (see
        :meth:`password_changed`)."""
        now = time.monotonic()
        with self._lock:
            for key in keys:
                st = self._keys.setdefault(key, {"fails": 0, "level": 0, "until": 0.0, "last": now})
                st["fails"] += 1
                st["last"] = now
                if pw is not None:
                    st["pw"] = pw
                if st["fails"] >= self.LIMIT:
                    st["until"] = now + min(self.MOST, self.FIRST * (2 ** st["level"]))
                    st["level"] += 1
                    st["fails"] = 0

    def password_changed(self, key: str, pw: str) -> bool:
        """Whether *key* is locked under a password other than *pw*."""
        with self._lock:
            st = self._keys.get(key)
            return bool(st and st["until"] > time.monotonic() and st.get("pw") not in (None, pw))

    def clear(self, *keys: str) -> None:
        with self._lock:
            for key in keys:
                self._keys.pop(key, None)
