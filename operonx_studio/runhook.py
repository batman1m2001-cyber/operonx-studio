"""The PreToolUse hook that lets the studio watch every shell call as it runs (docs/EXECUTION_PROGRESS_PLAN.md D1, D3).

The CLI's stream says a running shell call is alive (tool_progress) but never what it printed, so the relay could
only read a call once it ended. This hook, given to the CLI by the relay (--settings), rewrites a Bash command so
its output also goes to <dir>/<tool_use_id>.out; the relay reads that file while the call runs (progress.py).

    python -I runhook.py <dir>      stdin: the hook's JSON; stdout: the rewritten input, or nothing

The command runs in the shell itself, not a pipeline's subshell, so a `cd` in it still holds for the next call;
its exit status is kept, and Python is told not to buffer (its output into a pipe otherwise comes at the end).
Lines that start with \\x1e go to the file only, never to the CLI: the shell's pid when it starts (D4, D7), the
exit status when it ends, and, for a plain chain like `ruff check . && pytest -q`, the start of each part (D3).

Bash only. Anything else, a command that starts a job of its own in the background (`server &`: it would keep the
copy open), or any doubt, and the call runs exactly as written.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import List, Optional, Tuple

WRAP = ("export PYTHONUNBUFFERED=1; __ox_o={out}; "
        "printf '\\036ox start %s %s\\n' $$ \"${{EPOCHREALTIME:-}}\" >> \"$__ox_o\"; {mark}"
        "exec 9> >(tee -a \"$__ox_o\" 2>/dev/null); __ox_tee=$!; {{ {cmd}\n}} "
        ">&9 2>&1 9>&-; __ox_rc=$?; exec 9>&-; wait $__ox_tee 2>/dev/null; "
        "printf '\\036ox end %s %s\\n' $__ox_rc \"${{EPOCHREALTIME:-}}\" >> \"$__ox_o\"; (exit $__ox_rc)")
# a part's marker keeps the status it was called with: `a && __ox_m 2 && b` runs b exactly when `a && b` would,
# and `a; __ox_m 2; echo $?` still prints a's status
MARK = ("__ox_m() {{ local r=$?; printf '\\036ox part %s %s %s\\n' \"$1\" $r \"${{EPOCHREALTIME:-}}\" "
        ">> \"$__ox_o\"; return $r; }}; ")

MAX_PARTS = 12
# a job of its own in the background would hold the copy open after the call ends: such a command is not wrapped
_BACKGROUND = re.compile(r"(?<![&>|<])&(?![&>])|\b(nohup|setsid|disown|daemonize)\b")
# a word that makes a command more than a plain list: not split (still wrapped, as one stage)
_COMPOUND = {"if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function",
             "select", "coproc", "{", "}", "trap", "eval", "exec"}
# set -e (or errexit) would end the shell on a part's marker after a failure the chain had excused
_ERREXIT = re.compile(r"\bset\s+(-\w*e|-o\s+errexit)|\berrexit\b")
# a part that only sets things up is not a stage of its own
_SETUP = {"cd", "pushd", "popd", "export", "set", "source", ".", "unset", "local", "alias", "true", ":", "echo",
          "printf", "sleep"}


def _unquoted(command: str) -> str:
    """The command with its single-quoted text blanked (so `&` in 'a&b' is not a background job)."""
    return re.sub(r"'[^']*'", "''", command)


def split(command: str) -> Optional[List[Tuple[int, str]]]:
    """A plain top-level list's parts: [(where its first word starts, the operator before it)], or None when the
    command is anything else — a heredoc, a substitution, a group, a loop or a branch, a function — or one part."""
    if _ERREXIT.search(command):
        return None
    parts: List[Tuple[int, str]] = []
    pending: Optional[str] = ";"         # the operator before the part being read; None once a word was read
    word, at, i, n = "", -1, 0, len(command)

    def end_word() -> bool:
        nonlocal word
        bad = word in _COMPOUND
        word = ""
        return bad

    while i < n:
        c = command[i]
        if c in " \t":
            if end_word():
                return None
            i += 1
            continue
        if c == "\\":
            if pending is not None:
                parts.append((i, pending))
                pending = None
            word += command[i:i + 2]
            i += 2
            continue
        if c in "'\"" or (c == "$" and command[i + 1:i + 2] in ("'", '"')):
            if pending is not None:
                parts.append((i, pending))
                pending = None
            if c == "$":
                i += 1
                c = command[i]
            j = i + 1
            while j < n and command[j] != c:
                if command[j] == "\\" and c != "'" or (command[j] == "\\" and command[i - 1] == "$"):
                    j += 1
                elif c == '"' and (command[j] == "`" or command[j:j + 2] == "$("):
                    return None
                j += 1
            if j >= n:
                return None
            word += "q"
            i = j + 1
            continue
        if command[i:i + 2] == "${":
            j = command.find("}", i)
            if j < 0 or "$(" in command[i:j] or "`" in command[i:j]:
                return None
            if pending is not None:
                parts.append((i, pending))
                pending = None
            word += "v"
            i = j + 1
            continue
        if c == "#" and not word:
            while i < n and command[i] != "\n":
                i += 1
            continue
        if c == "`" or command[i:i + 2] in ("$(", "<(", ">(", "<<") or c in "(){}":
            return None
        if command[i:i + 2] in ("&&", "||"):
            if end_word() or pending is not None:
                return None
            pending = command[i:i + 2]
            i += 2
            continue
        if c == ";" or c == "\n":
            if command[i:i + 2] == ";;" or end_word():
                return None
            if pending is None:
                pending = ";"
            elif c == ";":
                return None             # `a && ; b`, or a list that starts with ;
            i += 1
            continue
        if c == "|":
            if end_word() or pending is not None:
                return None
            word = ""
            i += 2 if command[i:i + 2] == "|&" else 1
            # a pipe continues the part: the next word is not a part of its own
            while i < n and command[i] in " \t\n":
                i += 1
            continue
        if c == "&":
            if command[i - 1:i] in (">", "<") or command[i + 1:i + 2] == ">":
                word += c
                i += 1
                continue
            return None
        if pending is not None:
            parts.append((i, pending))
            pending = None
        word += c
        i += 1
    if end_word() or pending not in (None, ";"):
        return None
    return parts if len(parts) >= 2 else None


def _first_word(command: str, at: int) -> str:
    m = re.match(r"[^\s;&|]+", command[at:])
    return m.group(0) if m else ""


def stages(command: str) -> Tuple[str, List[str]]:
    """The command with a marker before each part that is a stage, and those parts' text; ("", []) for one stage."""
    parts = split(command)
    if not parts:
        return "", []
    bounds = [at for at, _ in parts] + [len(command)]
    keep = []
    for k, (at, op) in enumerate(parts):
        first = _first_word(command, at)
        if first in _SETUP or re.fullmatch(r"\w+=\S*", first):
            continue
        text = command[at:bounds[k + 1]].strip().split("\n")[0]
        text = re.sub(r"\s+#[^'\"]*$", "", text).rstrip(" ;&|")
        keep.append((at, op, text))
    if not 2 <= len(keep) <= MAX_PARTS:
        return "", []
    out, last = [], 0
    for n, (at, op, _) in enumerate(keep, 1):
        out.append(command[last:at])
        out.append(f"__ox_m {n} {op} ")
        last = at
    out.append(command[last:])
    return "".join(out), [t for _, _, t in keep]


def rewrite(event: dict, live_dir: str) -> dict | None:
    if event.get("tool_name") != "Bash":
        return None
    inp = event.get("tool_input") or {}
    cmd, call = inp.get("command"), str(event.get("tool_use_id") or "")
    if not isinstance(cmd, str) or not cmd.strip() or _BACKGROUND.search(_unquoted(cmd)):
        return None
    if not re.fullmatch(r"[\w-]{1,128}", call) or os.path.basename(os.environ.get("SHELL", "")) != "bash":
        return None
    out = os.path.join(live_dir, call + ".out")
    marked, parts = stages(cmd)
    with open(os.path.join(live_dir, call + ".json"), "w", encoding="utf-8") as fh:
        json.dump({"command": cmd, "parts": parts, "background": bool(inp.get("run_in_background"))}, fh)
    quoted = "'" + out.replace("'", "'\\''") + "'"
    wrapped = WRAP.format(out=quoted, mark=MARK.format() if parts else "", cmd=marked or cmd)
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {**inp, "command": wrapped}}}


def main() -> None:
    try:
        out = rewrite(json.load(sys.stdin), sys.argv[1])
    except Exception:  # noqa: BLE001 — a hook that fails must leave the call alone
        return
    if out is not None:
        sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
