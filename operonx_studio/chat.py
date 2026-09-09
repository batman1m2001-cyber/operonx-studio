"""The assistant, wired: headless Claude Code behind the ✦ panel.

Each message spawns ``claude -p`` in stream-json mode with the project
root as its working directory, an appended system prompt (the packaged
operonx knowledge doc plus a live briefing the caller composes), and
``--resume`` for continuity — Claude Code itself persists the
conversation on disk, so the only chat state the studio keeps is the
in-flight turn. The browser holds the session id and the transcript.

Delivery is turn-based polling, not a long-lived stream: the free
tunnel in front of this studio hard-kills any response after ~10
seconds regardless of activity (measured — data flowing every 2s,
connection cut at 11s on both h2 and HTTP/1.1). So POST starts the
turn and returns at once; the agent runs in a background task
appending translated events to a buffer; GET polls drain it by cursor,
each held at most a few seconds. A dropped poll or a page reload
leaves the agent running — the browser just polls again.

Event shapes:

    {"t": "start", "session": "..."}          the session to resume with
    {"t": "delta", "text": "..."}             streamed answer text
    {"t": "tool",  "name": "Edit", "hint": "app.py"}
    {"t": "done",  "session": "...", "cost": 0.12}
    {"t": "error", "text": "..."}

What the agent may do is a deployment decision, not a code one:

    OPERONX_STUDIO_CHAT_MODE   read | edit | full   (default: full)
    OPERONX_STUDIO_CHAT_MODEL  model override       (default: CLI default)
    OPERONX_STUDIO_CLAUDE_BIN  explicit binary path

``full`` matches what the panel promises — an agent that performs tasks
(edits files, runs tests). Note that on this deployment even ``edit`` is
not a security boundary: the studio's watcher imports project code, so
anyone past the login who can write files can execute code. The login
wall is the boundary; the mode only sets how far the agent reaches.
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = ["find_claude", "knowledge", "start_turn", "poll_turn", "stop_turn"]

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


def _mode_args() -> List[str]:
    """Permission flags for the chosen reach.

    Headless sessions cannot prompt, so anything not pre-approved is
    simply denied — the flags below ARE the approval.
    """
    mode = os.environ.get("OPERONX_STUDIO_CHAT_MODE", "full").strip().lower()
    read_tools = ["Read", "Grep", "Glob", "LS", "Task",
                  "WebFetch", "WebSearch"]
    if mode == "read":
        return ["--allowedTools", *read_tools]
    if mode == "edit":
        return ["--allowedTools", *read_tools, "Edit", "Write", "NotebookEdit"]
    return ["--permission-mode", "acceptEdits",
            "--allowedTools", "Bash", "WebFetch", "WebSearch"]


def _spawn_env() -> Dict[str, str]:
    # The studio itself is often launched from inside a Claude Code
    # session; the inherited CLAUDE_* vars would make the child believe
    # it is a nested/SDK session and misbehave. HOME must survive — the
    # OAuth credentials live under it.
    return {k: v for k, v in os.environ.items()
            if not k.startswith("CLAUDE") and k not in ("CLAUDECODE", "AI_AGENT")}


def _tool_hint(block: Dict[str, Any]) -> str:
    inputs = block.get("input") or {}
    for key in ("file_path", "path", "command", "pattern", "query",
                "url", "description", "prompt"):
        value = inputs.get(key)
        if value:
            text = str(value).strip().replace("\n", " ")
            return text[:80] + ("…" if len(text) > 80 else "")
    return ""


@dataclass
class Turn:
    """One in-flight (or recently finished) agent turn."""

    id: str
    events: List[Dict[str, Any]] = field(default_factory=list)
    done: bool = False
    proc: Optional[asyncio.subprocess.Process] = None
    fresh: asyncio.Event = field(default_factory=asyncio.Event)
    last_poll: float = field(default_factory=time.monotonic)


_turns: Dict[str, Turn] = {}

# A finished turn lingers so a reloading browser can replay it; a turn
# nobody polls is presumed abandoned and its agent is put down.
_DONE_TTL = 600.0
_ORPHAN_TTL = 900.0
_POLL_HOLD = 4.0   # well under the tunnel's ~10s response cap


def _push(turn: Turn, event: Dict[str, Any]) -> None:
    turn.events.append(event)
    turn.fresh.set()


def _sweep() -> None:
    now = time.monotonic()
    for tid, turn in list(_turns.items()):
        idle = now - turn.last_poll
        if (turn.done and idle > _DONE_TTL) or idle > _ORPHAN_TTL:
            if turn.proc is not None and turn.proc.returncode is None:
                turn.proc.kill()
            _turns.pop(tid, None)


async def _run(turn: Turn, message: str, *, cwd: Optional[Path],
               context: str, session: Optional[str]) -> None:
    binary = find_claude()
    if binary is None:
        _push(turn, {"t": "error", "text":
                     "No claude binary found on this machine — set "
                     "OPERONX_STUDIO_CLAUDE_BIN or install Claude Code."})
        turn.done = True
        return

    prompt = knowledge()
    if context:
        prompt = f"{prompt}\n\n{context}" if prompt else context
    cmd = [binary, "-p", message,
           "--output-format", "stream-json", "--verbose",
           "--include-partial-messages",
           "--append-system-prompt", prompt]
    if session:
        cmd += ["--resume", session]
    model = os.environ.get("OPERONX_STUDIO_CHAT_MODEL")
    if model:
        cmd += ["--model", model]
    cmd += _mode_args()

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(cwd) if cwd else None,
            env=_spawn_env(),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_LINE_LIMIT,
        )
    except OSError as exc:
        _push(turn, {"t": "error", "text": f"could not start claude: {exc}"})
        turn.done = True
        return
    turn.proc = proc
    got_result = False
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            kind = event.get("type")
            if kind == "system" and event.get("subtype") == "init":
                _push(turn, {"t": "start", "session": event.get("session_id")})
            elif kind == "stream_event":
                # Answer text arrives here token by token; the complete
                # assistant messages that follow would duplicate it, so
                # text renders ONLY from deltas.
                delta = (event.get("event") or {}).get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    _push(turn, {"t": "delta", "text": delta["text"]})
            elif kind == "assistant":
                for block in (event.get("message") or {}).get("content") or []:
                    if block.get("type") == "tool_use":
                        _push(turn, {"t": "tool", "name": block.get("name"),
                                     "hint": _tool_hint(block)})
            elif kind == "result":
                got_result = True
                done: Dict[str, Any] = {"t": "done",
                                        "session": event.get("session_id")}
                if event.get("total_cost_usd") is not None:
                    done["cost"] = event["total_cost_usd"]
                if event.get("is_error"):
                    done["error"] = str(event.get("result") or
                                        event.get("subtype") or "error")
                _push(turn, done)
        await proc.wait()
        if not got_result:
            stderr = b""
            if proc.stderr is not None:
                stderr = await proc.stderr.read()
            tail = stderr.decode(errors="replace").strip()[-500:]
            _push(turn, {"t": "error",
                         "text": tail or ("stopped" if proc.returncode == -9
                                          else f"claude exited with {proc.returncode}")})
    except Exception as exc:  # noqa: BLE001 — the turn must always resolve
        _push(turn, {"t": "error", "text": f"relay failed: {exc}"})
    finally:
        turn.done = True
        turn.fresh.set()
        if proc.returncode is None:
            proc.kill()


def start_turn(message: str, *, cwd: Optional[Path] = None, context: str = "",
               session: Optional[str] = None) -> str:
    """Begin a turn; returns its id immediately. Call from a running loop."""
    _sweep()
    turn = Turn(id=uuid.uuid4().hex[:16])
    _turns[turn.id] = turn
    asyncio.get_running_loop().create_task(
        _run(turn, message, cwd=cwd, context=context, session=session))
    return turn.id


async def poll_turn(turn_id: str, cursor: int = 0) -> Optional[Dict[str, Any]]:
    """Events past ``cursor``, holding briefly when there are none yet."""
    turn = _turns.get(turn_id)
    if turn is None:
        return None
    turn.last_poll = time.monotonic()
    if len(turn.events) <= cursor and not turn.done:
        turn.fresh.clear()
        try:
            await asyncio.wait_for(turn.fresh.wait(), timeout=_POLL_HOLD)
        except asyncio.TimeoutError:
            pass
        turn.last_poll = time.monotonic()
    return {"events": turn.events[cursor:],
            "cursor": len(turn.events),
            "alive": not turn.done}


def stop_turn(turn_id: str) -> bool:
    turn = _turns.get(turn_id)
    if turn is None:
        return False
    if turn.proc is not None and turn.proc.returncode is None:
        turn.proc.kill()
    return True
