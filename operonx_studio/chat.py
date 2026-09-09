"""The assistant, wired: headless Claude Code behind the ✦ panel.

Each message spawns ``claude -p`` in stream-json mode with the project
root as its working directory, an appended system prompt (the packaged
operonx knowledge doc plus a live briefing the caller composes), and
``--resume`` for continuity — Claude Code itself persists the
conversation on disk, so the studio keeps no chat state at all. The
browser holds the session id and the transcript.

Events are relayed to the browser as SSE, translated to a small shape:

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
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

__all__ = ["find_claude", "knowledge", "chat_sse"]

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


def _sse(payload: Dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _relay(message: str, *, cwd: Optional[Path], context: str,
                 session: Optional[str]) -> AsyncIterator[bytes]:
    binary = find_claude()
    if binary is None:
        yield _sse({"t": "error", "text":
                    "No claude binary found on this machine — set "
                    "OPERONX_STUDIO_CLAUDE_BIN or install Claude Code."})
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

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd) if cwd else None,
        env=_spawn_env(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=_LINE_LIMIT,
    )
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
                yield _sse({"t": "start", "session": event.get("session_id")})
            elif kind == "stream_event":
                # Answer text arrives here token by token; the complete
                # assistant messages that follow would duplicate it, so
                # text renders ONLY from deltas.
                delta = (event.get("event") or {}).get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    yield _sse({"t": "delta", "text": delta["text"]})
            elif kind == "assistant":
                for block in (event.get("message") or {}).get("content") or []:
                    if block.get("type") == "tool_use":
                        yield _sse({"t": "tool", "name": block.get("name"),
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
                yield _sse(done)
        await proc.wait()
        if not got_result:
            stderr = b""
            if proc.stderr is not None:
                stderr = await proc.stderr.read()
            tail = stderr.decode(errors="replace").strip()[-500:]
            yield _sse({"t": "error",
                        "text": tail or f"claude exited with {proc.returncode}"})
    finally:
        if proc.returncode is None:
            proc.kill()  # browser went away mid-task; don't orphan the agent


def chat_sse(message: str, *, cwd: Optional[Path] = None, context: str = "",
             session: Optional[str] = None):
    """A StreamingResponse relaying one chat turn."""
    from fastapi.responses import StreamingResponse

    return StreamingResponse(
        _relay(message, cwd=cwd, context=context, session=session),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
