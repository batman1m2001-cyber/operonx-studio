"""Make an op's inline prompt a named one (operonx.prompts).

Two pure steps, so each can be shown before anything is written:

* :func:`to_named` — the ``str.format`` template the code holds, as the text of
  a ``prompts/<name>.md``: ``{var}`` becomes ``{{var}}``, a doubled brace
  becomes the brace it stood for. Refused when the round trip would not give
  the op the same template back.
* :func:`rewrite_call` — the source with the op's ``prompt=`` (or one part of a
  ``prompt={...}``) replaced by ``prompt("name")``, and the import added.

The expression replaced need not be the literal itself: ``prompt=PROMPTS["X"]``
is replaced the same way (the text comes from the extracted graph), and the
constant is left where it is for whoever else reads it.
"""

from __future__ import annotations

import ast
import os
import re
import string
from pathlib import Path
from typing import List, Optional, Tuple

__all__ = ["Refused", "to_named", "rewrite_call", "find_source"]

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_LOOKS_NAMED = re.compile(r"\{\{\s*>?\s*[A-Za-z0-9_./-]+\s*\}\}")


class Refused(ValueError):
    """The change cannot be made mechanically; the message says why."""


def to_named(template: str) -> str:
    """*template* (what ``LLMOp`` formats) as a named prompt's text."""
    from operonx import prompts as P

    out: List[str] = []
    try:
        pieces = list(string.Formatter().parse(template))
    except ValueError as exc:
        raise Refused(f"the text is not a valid template ({exc})") from None
    for literal, field, spec, conv in pieces:
        if _LOOKS_NAMED.search(literal):
            raise Refused("the text has a literal {{…}} that a prompt file would read as a variable")
        out.append(literal)
        if field is None:
            continue
        if not _IDENT.match(field) or spec or conv:
            shown = "{" + field + ("!" + conv if conv else "") + (":" + spec if spec else "") + "}"
            raise Refused(f"{shown} is more than a name; a prompt file's variables are plain {{{{name}}}}")
        out.append("{{" + field + "}}")
    text = "".join(out).rstrip()
    # the op must get the same template back; only blank space at the very end is not kept by a prompt file
    if P._as_template(text) != template.rstrip():
        raise Refused("the text would not come back the same from a prompt file (braces it cannot keep)")
    return text + "\n"


def _offset(lines: List[str], lineno: int, col: int) -> int:
    """A character offset from ast's (1-based line, UTF-8 byte column)."""
    line = lines[lineno - 1]
    return sum(len(x) for x in lines[: lineno - 1]) + len(line.encode("utf-8")[:col].decode("utf-8"))


def _bound_elsewhere(tree: ast.Module, line: int) -> Tuple[bool, Optional[str]]:
    """(is ``prompt`` already something else here?, the name operonx.prompts.prompt is imported as)."""
    imported, taken = None, False
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "operonx.prompts":
            for a in node.names:
                if a.name == "prompt":
                    imported = a.asname or "prompt"
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            taken = taken or any((a.asname or a.name.split(".")[0]) == "prompt" for a in node.names)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            taken = taken or node.name == "prompt"
            # a parameter named prompt hides the import only inside its own function
            if not isinstance(node, ast.ClassDef) and node.lineno <= line <= (node.end_lineno or node.lineno):
                args = node.args
                taken = taken or any(a.arg == "prompt" for a in args.args + args.kwonlyargs + args.posonlyargs)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            taken = taken or node.id == "prompt"
    return taken, imported


def rewrite_call(source: str, line: int, name: str, part: Optional[str] = None) -> str:
    """*source* with the call built at *line* asking for the prompt *name*.

    *part* names one key of a ``prompt={...}`` literal; without it the whole
    ``prompt=`` value is replaced."""
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise Refused(f"the file does not parse ({exc.msg}, line {exc.lineno})") from None
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
             and n.lineno <= line <= (n.end_lineno or n.lineno) and any(k.arg == "prompt" for k in n.keywords)]
    if not calls:
        raise Refused(f"no call with prompt= is built at line {line}")
    call = max(calls, key=lambda n: n.lineno)   # the innermost one around the line
    target = next(k.value for k in call.keywords if k.arg == "prompt")
    if part is not None:
        if not isinstance(target, ast.Dict):
            raise Refused("prompt= is not written as a {…} here, so one part of it cannot be replaced")
        hit = [v for k, v in zip(target.keys, target.values) if isinstance(k, ast.Constant) and k.value == part]
        if len(hit) != 1:
            raise Refused(f"prompt= has no single {part!r} key written here")
        target = hit[0]
    taken, imported = _bound_elsewhere(tree, line)
    fn = imported or ("named_prompt" if taken else "prompt")
    if isinstance(target, ast.Call) and isinstance(target.func, ast.Name) and target.func.id == imported:
        raise Refused("this prompt is already asked for by name")
    lines = source.splitlines(keepends=True)
    a = _offset(lines, target.lineno, target.col_offset)
    b = _offset(lines, target.end_lineno, target.end_col_offset)
    out = source[:a] + f'{fn}("{name}")' + source[b:]
    if imported is None:
        stmt = "from operonx.prompts import prompt" + (" as named_prompt" if taken else "") + "\n"
        top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
        if top:
            at = sum(len(x) for x in lines[: top[-1].end_lineno])
        else:   # after the module docstring, if there is one
            first = tree.body[0] if tree.body else None
            doc = first is not None and isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant) and isinstance(first.value.value, str)
            at = sum(len(x) for x in lines[: first.end_lineno]) if doc else 0
            stmt = ("\n" if doc else "") + stmt + ("\n" if not doc else "")
        out = out[:at] + stmt + out[at:]
    try:
        ast.parse(out)
    except SyntaxError as exc:   # never hand back a file that does not parse
        raise Refused(f"the rewritten file would not parse ({exc.msg})") from None
    return out


_SKIP = {"node_modules", "site-packages", "venv", "__pycache__", "build", "dist"}


def find_source(root: Path, file: str) -> Optional[Path]:
    """The file an op's ``wired_at`` names. The engine writes it relative to the
    import root the module came from (``chat.py`` for ``src/chat.py``), so when
    it is not there under *root*, it is the one file in the project that ends
    with that path — or nothing, when two do."""
    if not file:
        return None
    direct = root / file
    if direct.is_file():
        return direct
    found = []
    for base, dirs, _names in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in _SKIP]
        cand = Path(base) / file
        if cand.is_file():
            found.append(cand)
    return found[0] if len(found) == 1 else None
