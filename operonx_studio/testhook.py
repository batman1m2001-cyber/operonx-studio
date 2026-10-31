"""The PreToolUse hook that lets the studio watch a test run as it runs (D6, live).

The CLI's stream says a running shell call is alive (tool_progress) but never what it printed, so the relay
could only read a test run once it ended. This hook, given to the CLI by the relay (--settings), rewrites a test
command so its output also goes to <dir>/<tool_use_id>.out; the relay reads that file while the call runs.

    python -I testhook.py <dir>      stdin: the hook's JSON; stdout: the rewritten input, or nothing

The command runs in the shell itself, not a pipeline's subshell, so a `cd` in it still holds for the next call;
its exit status is kept, and Python is told not to buffer (its output into a pipe otherwise comes at the end).
Bash only: anything else, a background run, or any doubt, and the call runs exactly as written.
"""

from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testreport import is_test  # noqa: E402 — runs by path, outside the package

WRAP = ("export PYTHONUNBUFFERED=1; exec 9> >(tee {out} 2>/dev/null); __ox_tee=$!; {{ {cmd}\n}} "
        ">&9 2>&1; __ox_rc=$?; exec 9>&-; wait $__ox_tee 2>/dev/null; (exit $__ox_rc)")


def rewrite(event: dict, live_dir: str) -> dict | None:
    if event.get("tool_name") != "Bash":
        return None
    inp = event.get("tool_input") or {}
    cmd, call = inp.get("command"), str(event.get("tool_use_id") or "")
    if not isinstance(cmd, str) or not is_test(cmd) or inp.get("run_in_background"):
        return None
    if not re.fullmatch(r"[\w-]{1,128}", call) or os.path.basename(os.environ.get("SHELL", "")) != "bash":
        return None
    out = os.path.join(live_dir, call + ".out")
    quoted = "'" + out.replace("'", "'\\''") + "'"
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                   "updatedInput": {**inp, "command": WRAP.format(out=quoted, cmd=cmd)}}}


def main() -> None:
    try:
        out = rewrite(json.load(sys.stdin), sys.argv[1])
    except Exception:  # noqa: BLE001 — a hook that fails must leave the call alone
        return
    if out is not None:
        sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
