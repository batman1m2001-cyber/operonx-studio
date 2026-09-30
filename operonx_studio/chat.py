"""The assistant's plumbing: finding Claude Code, how far it may reach,
and what a turn changed.

Sessions, turns and their delivery live in operonx_studio.assistant;
this module keeps what that relay stands on — the binary, the knowledge
doc, the permission flags, the child's environment, and the git
snapshot / diff / undo behind every changes card.

What the agent may do is a deployment decision, not a code one:

    OPERONX_STUDIO_CHAT_MODE   read | edit | full   (default: full)
    OPERONX_STUDIO_CHAT_MODEL  model override       (default: CLI default)
    OPERONX_STUDIO_CLAUDE_BIN  explicit binary path

``full`` matches what the assistant promises — an agent that performs
tasks (edits files, runs tests). Note that on this deployment even
``edit`` is not a security boundary: the studio's watcher imports
project code, so anyone past the login who can write files can execute
code. The login wall is the boundary; the mode only sets how far the
agent reaches.
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = ["find_claude", "knowledge", "snapshot", "changes_since", "undo"]

KNOWLEDGE = Path(__file__).parent / "knowledge.md"

# stream-json lines carry whole tool results; the default 64KB readline
# limit would kill the relay mid-conversation on the first big file read.
_LINE_LIMIT = 16 * 1024 * 1024


def find_claude() -> Optional[str]:
    """The claude binary, wherever this machine keeps it.

    Order: explicit env, PATH, then the newest VS Code extension's
    bundled native binary (the common case on a box that runs Claude
    Code in the IDE but never installed the CLI).
    """
    explicit = os.environ.get("OPERONX_STUDIO_CLAUDE_BIN")
    if explicit:
        return explicit if Path(explicit).is_file() else None
    on_path = shutil.which("claude")
    if on_path:
        return on_path

    def version_key(path: str) -> List[int]:
        m = re.search(r"claude-code-(\d+)\.(\d+)\.(\d+)", path)
        return [int(g) for g in m.groups()] if m else [0, 0, 0]

    pattern = ("/.vscode-server/extensions/anthropic.claude-code-*/"
               "resources/native-binary/claude")
    hits = glob.glob(str(Path.home()) + pattern) + glob.glob("/root" + pattern)
    hits = [h for h in hits if os.access(h, os.X_OK)]
    return max(hits, key=version_key) if hits else None


def knowledge() -> str:
    try:
        return KNOWLEDGE.read_text(encoding="utf-8")
    except OSError:  # pragma: no cover — packaging fault, not runtime state
        return ""


#: The studio's own tools (operonx_studio.mcp) a read-only agent may use.
STUDIO_READ_TOOLS = ["mcp__studio__list_runs", "mcp__studio__open_run", "mcp__studio__op_values",
                     "mcp__studio__monitor", "mcp__studio__compare_runs", "mcp__studio__select_op"]


def _mode_args() -> List[str]:
    """Permission flags for the chosen reach.

    Headless sessions cannot prompt, so anything not pre-approved is
    simply denied — the flags below ARE the approval. The studio's own
    tools follow the same reach: reading runs is always allowed, starting
    a job or writing a price only where edits are.
    """
    mode = os.environ.get("OPERONX_STUDIO_CHAT_MODE", "full").strip().lower()
    read_tools = ["Read", "Grep", "Glob", "LS", "Task",
                  "WebFetch", "WebSearch"]
    if mode == "read":
        return ["--allowedTools", *read_tools, *STUDIO_READ_TOOLS]
    if mode == "edit":
        return ["--allowedTools", *read_tools, "Edit", "Write", "NotebookEdit", "mcp__studio"]
    return ["--permission-mode", "acceptEdits",
            "--allowedTools", "Bash", "WebFetch", "WebSearch", "mcp__studio"]


# ── what a turn changed ───────────────────────────────────────────────────
# Before a turn the working tree is snapshotted (`git stash create` makes a
# commit of it without touching anything; a clean tree snapshots as HEAD).
# After, the diff against that snapshot is exactly what the turn did — the
# user's own uncommitted work was in the snapshot, so it never shows as the
# agent's. Undo checks the snapshot's version of those files back out.


def _git(repo: Path, *args: str) -> Optional[str]:
    import subprocess

    try:
        out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def _ignored(path: str) -> bool:
    return path.startswith(".operonx/") or "/.operonx/" in path or path.startswith("out/")


def snapshot(repo: Optional[Path]) -> Optional[Dict[str, Any]]:
    """The working tree as it is now, or None when *repo* is not a git checkout."""
    if repo is None or _git(repo, "rev-parse", "--is-inside-work-tree") is None:
        return None
    sha = (_git(repo, "stash", "create") or "").strip() or (_git(repo, "rev-parse", "HEAD") or "").strip()
    if not sha:
        return None
    untracked = [p for p in (_git(repo, "ls-files", "--others", "--exclude-standard") or "").splitlines() if p]
    return {"sha": sha, "untracked": untracked}


def changes_since(repo: Path, snap: Dict[str, Any], limit: int = 200_000) -> Dict[str, Any]:
    """What changed in *repo* since *snap*: files, line counts, one diff."""
    files: List[Dict[str, Any]] = []
    for line in (_git(repo, "diff", "--numstat", snap["sha"]) or "").splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and not _ignored(parts[2]):
            added, removed = (int(x) if x.isdigit() else 0 for x in parts[:2])
            files.append({"path": parts[2], "added": added, "removed": removed, "new": False})
    paths = [f["path"] for f in files]
    diff = _git(repo, "diff", "--no-color", snap["sha"], "--", *paths) if paths else ""
    before = set(snap.get("untracked") or [])
    for path in (_git(repo, "ls-files", "--others", "--exclude-standard") or "").splitlines():
        if not path or path in before or _ignored(path):
            continue
        try:
            text = (repo / path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            text = ""
        n = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
        files.append({"path": path, "added": n, "removed": 0, "new": True})
        diff = (diff or "") + f"--- /dev/null\n+++ b/{path}\n" + "".join(f"+{ln}\n" for ln in text.splitlines())
    diff = diff or ""
    return {"sha": snap["sha"], "files": files,
            "diff": diff[:limit] + ("\n… (diff cut)" if len(diff) > limit else "")}


def undo(repo: Path, sha: str, files: List[str], new_files: List[str]) -> List[str]:
    """Put *files* back as they were in snapshot *sha*; remove *new_files*.
    Only paths inside the repo; returns what was restored or removed."""
    root = repo.resolve()
    done: List[str] = []
    for path in files:
        target = (root / path).resolve()
        if root not in target.parents:
            continue
        if _git(repo, "cat-file", "-e", f"{sha}:{path}") is not None:
            if _git(repo, "checkout", sha, "--", path) is not None:
                done.append(path)
        elif target.is_file():  # tracked since, absent in the snapshot
            target.unlink()
            done.append(path)
    for path in new_files:
        target = (root / path).resolve()
        if root in target.parents and target.is_file():
            target.unlink()
            done.append(path)
    return done


# ── the assistant's own sign-in (docs/ASSISTANT_NEXT_PLAN.md §3) ─────────
# The studio keeps its own Claude sign-in in its own config directory
# (CLAUDE_CONFIG_DIR), so signing in or out there never touches this
# machine's Claude Code. Until one exists, the machine's login is used.

def claude_home() -> Path:
    raw = os.environ.get("OPERONX_STUDIO_CLAUDE_HOME")
    return Path(raw).expanduser() if raw else Path.home() / ".operonx" / "claude"


_home = {"checked": False, "signed_in": False, "email": None}


def _status(home: Optional[Path]) -> Dict[str, Any]:
    """``claude auth status --json`` for *home* (None: the machine's)."""
    binary = find_claude()
    if binary is None:
        return {}
    env = _spawn_env(home=False)
    if home is not None:
        env["CLAUDE_CONFIG_DIR"] = str(home)
    try:
        out = subprocess.run([binary, "auth", "status", "--json"], env=env, stdin=subprocess.DEVNULL,
                             capture_output=True, text=True, timeout=20)
        return json.loads(out.stdout or "{}")
    except Exception:  # noqa: BLE001 — an unreadable status reads as signed out
        return {}


def home_signed_in(refresh: bool = False) -> bool:
    """Whether the studio's own sign-in exists (then every Claude process
    runs under it). Checked once, then on every sign-in and sign-out."""
    if refresh or not _home["checked"]:
        home = claude_home()
        got = _status(home) if home.is_dir() else {}
        _home.update(checked=True, signed_in=bool(got.get("loggedIn")), email=got.get("email"))
    return bool(_home["signed_in"])


def account_key() -> str:
    """Which sign-in a Claude session belongs to: a session can't be resumed
    under another one."""
    return f"studio:{_home['email'] or ''}" if home_signed_in() else "machine"


def _spawn_env(home: Optional[bool] = None) -> Dict[str, str]:
    # The studio itself is often launched from inside a Claude Code
    # session; the inherited CLAUDE_* vars would make the child believe
    # it is a nested/SDK session and misbehave. HOME must survive — the
    # OAuth credentials live under it.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("CLAUDE") and k not in ("CLAUDECODE", "AI_AGENT")}
    # the studio's own sign-in, once there is one (home=False: the machine's)
    if home_signed_in() if home is None else home:
        env["CLAUDE_CONFIG_DIR"] = str(claude_home())
    return env


def _tool_hint(block: Dict[str, Any]) -> str:
    inputs = block.get("input") or {}
    for key in ("file_path", "path", "command", "pattern", "query",
                "url", "description", "prompt"):
        value = inputs.get(key)
        if value:
            text = str(value).strip().replace("\n", " ")
            return text[:80] + ("…" if len(text) > 80 else "")
    return ""
