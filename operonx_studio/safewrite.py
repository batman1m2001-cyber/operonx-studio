"""Every write the studio makes to a project's files (docs/STUDIO_EXPERIENCE_PLAN.md §5).

The project's files are the source of truth; the studio only proposes a
change and, once seen, makes it — never more than it showed, never over
someone else's edit, never leaving the project broken:

1. **Preview.** The change as a diff, and the file's sha256 as it was read.
2. **Apply with that sha.** A file that changed since (an editor, the
   assistant, a teammate) is refused — ``stale`` — with the diff against
   what is there now, to see again.
3. **Prove the scope.** A YAML edit must change only the paths it names; a
   Python edit only the lines of the statement it targets; an ``.env`` edit
   only its variables; a prompt only its own text. Otherwise ``scope``.
4. **Write atomically**: a temporary file beside it, then a rename.
5. **Still builds.** The project is extracted again in a fresh interpreter
   (the watcher's own extraction). A project that built before and does
   not now gets its old bytes back — ``build`` — with the error.
6. **Journal.** Each write is kept (before and after) for one-click undo,
   which goes through the same steps.
"""

from __future__ import annotations

import difflib
import hashlib
import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

__all__ = [
    "WriteRefused", "Write", "sha", "diff", "preview", "commit", "undo", "journal",
    "lines_scope", "yaml_scope", "toml_scope", "env_scope", "span_scope", "pyedit_scope",
]

#: Writes kept per project for undo.
JOURNAL_SIZE = 50

# A scope check: (before, after) -> None when the change stays inside what
# it claimed, else why not.
Scope = Callable[[str, str], Optional[str]]


class WriteRefused(Exception):
    """A write that was not made. ``code``: ``stale``, ``scope``, ``build``."""

    def __init__(self, code: str, message: str, diff: str = "", base: str = ""):
        super().__init__(message)
        self.code = code
        self.diff = diff
        self.base = base

    def to_dict(self) -> Dict[str, Any]:
        return {"error": str(self), "code": self.code, "diff": self.diff, "base": self.base}


@dataclass
class Write:
    id: str
    file: str            # relative to the project root
    before: str
    after: str
    at: float
    what: str = ""
    who: Optional[str] = None
    undone: bool = False

    def summary(self) -> Dict[str, Any]:
        return {"id": self.id, "file": self.file, "at": self.at, "what": self.what,
                "who": self.who, "undone": self.undone}


_journals: Dict[str, List[Write]] = {}
_lock = threading.Lock()


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def diff(before: str, after: str, name: str) -> str:
    return "".join(difflib.unified_diff(
        before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=name, tofile=name, n=2,
    ))


def preview(root: Path, path: Path, before: str, after: str) -> Dict[str, Any]:
    """What a change would do: the diff, and the sha the apply must name."""
    name = _rel(root, path)
    return {"file": name, "diff": diff(before, after, name), "changed": before != after, "base": sha(before)}


def _rel(root: Path, path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(Path(root).resolve()))
    except ValueError:
        return str(path)


def _atomic_write(path: Path, text: str) -> None:
    path = Path(path)
    mode = path.stat().st_mode if path.exists() else None
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".studio", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        if mode is not None:
            os.chmod(tmp, mode & 0o7777)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def commit(
    root: Path,
    path: Path,
    after: str,
    base: str,
    *,
    scope: Optional[Scope] = None,
    watcher: Any = None,
    what: str = "",
    who: Optional[str] = None,
    before: Optional[str] = None,
) -> Write:
    """Write *after* to *path* if the file is still the one previewed (*base*),
    the change stays in *scope*, and the project still builds. ``before`` is
    the text the change was made from, when the caller planned it from the
    file it read (the default: the file now)."""
    root, path = Path(root), Path(path)
    name = _rel(root, path)
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    if sha(current) != base:
        raise WriteRefused(
            "stale",
            f"{name} changed since this was previewed; here is the change against the file as it is now",
            diff=diff(current, after, name), base=sha(current),
        )
    before = current if before is None else before
    if scope is not None:
        why = scope(before, after)
        if why:
            raise WriteRefused("scope", f"{name}: the change reaches beyond what it was for — {why}")
    was_ok = bool(watcher is not None and getattr(watcher.last, "ok", False))
    _atomic_write(path, after)
    if watcher is not None:
        got = watcher.extract()
        if was_ok and not got.ok:
            _atomic_write(path, current)
            watcher.extract()
            raise WriteRefused("build", f"{name}: the project no longer builds with this change, so it was not kept:\n"
                               + (got.error or "extraction failed"))
    w = Write(id=uuid.uuid4().hex[:12], file=name, before=current, after=after, at=time.time(), what=what, who=who)
    with _lock:
        j = _journals.setdefault(str(root.resolve()), [])
        j.append(w)
        del j[:-JOURNAL_SIZE]
    return w


def journal(root: Path) -> List[Write]:
    with _lock:
        return list(_journals.get(str(Path(root).resolve()), []))


def undo(root: Path, write_id: str, *, watcher: Any = None, who: Optional[str] = None) -> Write:
    """Put a write's *before* back — if the file is still what it wrote."""
    root = Path(root)
    found = next((w for w in journal(root) if w.id == write_id), None)
    if found is None:
        raise WriteRefused("stale", f"no write {write_id!r} to undo (the studio restarted, or it is too old)")
    path = root / found.file
    back = commit(root, path, found.before, sha(found.after), watcher=watcher,
                  what=f"undo: {found.what}", who=who)
    found.undone = True
    return back


# ── scope checks ──────────────────────────────────────────────────────────


def _changed_lines(before: str, after: str) -> List[Tuple[int, int]]:
    """The 1-based line ranges of *before* a change touches (an insertion is
    the line it lands after)."""
    a, b = before.splitlines(), after.splitlines()
    out = []
    for tag, i1, i2, _j1, _j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        out.append((i1 + 1, max(i1 + 1, i2)))
    return out


def lines_scope(start: int, end: int, *, parse: Optional[Callable[[str], Any]] = None) -> Scope:
    """Only lines *start*..*end* (1-based, inclusive) of the file may change,
    and *parse* (``ast.parse``, say) must accept the result."""
    def check(before: str, after: str) -> Optional[str]:
        for a, b in _changed_lines(before, after):
            if a < start or b > end:
                line = a if a < start else max(a, end + 1)
                return f"it changes line {line}, outside lines {start}-{end} it was for"
        if parse is not None:
            try:
                parse(after)
            except Exception as exc:  # noqa: BLE001 — any parse failure refuses
                return f"the result does not parse: {exc}"
        return None
    return check


def span_scope(start: int, end: int) -> Scope:
    """Only the characters *start*..*end* of *before* may change (a prompt's
    own text): what precedes and follows it stays byte for byte."""
    def check(before: str, after: str) -> Optional[str]:
        tail = len(before) - end
        if after[:start] != before[:start] or (tail and after[-tail:] != before[-tail:]) or len(after) < start + tail:
            return "it changes text outside the span it was for"
        return None
    return check


def _yaml_paths(a: Any, b: Any, path: Tuple = ()) -> List[Tuple]:
    # an empty value and an empty mapping are the same thing here: a block
    # whose last key was deleted reads back as `llm:` (null)
    if isinstance(a, dict) and b is None:
        b = {}
    if isinstance(b, dict) and a is None:
        a = {}
    if isinstance(a, dict) and isinstance(b, dict):
        out: List[Tuple] = []
        for k in set(a) | set(b):
            # an added or removed table is compared inside: its new keys are
            # the paths that changed (a new [studio] holding only retention)
            x, y = a.get(k, _MISSING), b.get(k, _MISSING)
            if x is _MISSING and isinstance(y, dict):
                x = {}
            if y is _MISSING and isinstance(x, dict):
                y = {}
            if x is _MISSING or y is _MISSING:
                out.append(path + (k,))
            else:
                out.extend(_yaml_paths(x, y, path + (k,)))
        return out
    return [] if a == b else [path]


_MISSING = object()


def yaml_scope(allowed: Iterable[Sequence[Any]]) -> Scope:
    """The YAML's data may change only under the *allowed* paths (each a key
    sequence: ``("llm", "inhouse", "model")``, or ``("llm", "new")`` for a
    whole block); everything else — comments aside — stays equal."""
    allowed_t = [tuple(p) for p in allowed]

    def check(before: str, after: str) -> Optional[str]:
        import yaml

        try:
            a = yaml.safe_load(before) or {}
            b = yaml.safe_load(after) or {}
        except yaml.YAMLError as exc:
            return f"the result is not valid YAML: {exc}"
        for p in _yaml_paths(a, b):
            if not any(p[: len(x)] == x for x in allowed_t):
                return f"it changes {'.'.join(map(str, p)) or 'the document'}"
        return None
    return check


def _env_pairs(text: str) -> Dict[str, str]:
    out = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        out[k.strip().removeprefix("export ").strip()] = v.strip()
    return out


def env_scope(keys: Iterable[str]) -> Scope:
    """Only the variables *keys* may change in an ``.env`` file."""
    keys = set(keys)

    def check(before: str, after: str) -> Optional[str]:
        a, b = _env_pairs(before), _env_pairs(after)
        for k in set(a) | set(b):
            if a.get(k) != b.get(k) and k not in keys:
                return f"it changes {k}"
        return None
    return check


def toml_scope(allowed: Iterable[Sequence[Any]]) -> Scope:
    """``yaml_scope`` for a TOML file (``operonx.toml``)."""
    allowed_t = [tuple(p) for p in allowed]

    def check(before: str, after: str) -> Optional[str]:
        try:
            import tomllib as toml
        except ImportError:  # Python 3.10
            import tomli as toml  # type: ignore[no-redef]
        try:
            a, b = toml.loads(before), toml.loads(after)
        except Exception as exc:  # noqa: BLE001
            return f"the result is not valid TOML: {exc}"
        for p in _yaml_paths(a, b):
            if not any(p[: len(x)] == x for x in allowed_t):
                return f"it changes {'.'.join(map(str, p)) or 'the document'}"
        return None
    return check


def pyedit_scope(before: str, manifest: Any, graph_label: str, action: str, args: Dict[str, Any]) -> Scope:
    """The lines a typed Python edit (``operonx_studio_toolkit.apply``) may change:
    the op's own statement for a parameter or a resource; the graph's body
    for a structural edit (rename, delete, insert)."""
    import ast

    from operonx_studio_toolkit.pyedit import _assignment_for, find_graph

    attr = manifest.graph(graph_label).entry.split(":")[1]
    node = body = find_graph(ast.parse(before), attr)
    op = args.get("op_name") or args.get("op")
    if action in ("set_param", "set_resource") and op:
        node = _assignment_for(body, str(op))
    return lines_scope(node.lineno, node.end_lineno or node.lineno, parse=ast.parse)
