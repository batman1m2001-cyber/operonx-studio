"""Set a few fields of one resource in a resources YAML file — as text.

A resources file is hand-written: comments explain each block, and the
order is the author's. Loading and re-dumping the YAML would throw all of
that away, so this edits the lines themselves: it finds the resource's
block (``category:`` then ``  name:``), replaces a field's line when the
field is already there (keeping any trailing comment), and otherwise adds
it after the block's last field. Every other line is untouched.

Only the block layout resources files use is understood — a category at
column 0, entries indented under it, fields indented under those. Anything
else is refused with a reason rather than guessed at.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

__all__ = ["YamlEditError", "set_fields", "yaml_scalar"]


class YamlEditError(ValueError):
    """The file does not have the block this edit needs."""


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _is_blank(line: str) -> bool:
    s = line.strip()
    return not s or s.startswith("#")


def yaml_scalar(value: Any) -> str:
    """A plain YAML scalar for a number, bool, None or short string."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        text = repr(value)
        return text if "e" not in text else f"{value:.12f}".rstrip("0").rstrip(".") or "0"
    text = str(value)
    if re.fullmatch(r"[A-Za-z0-9_./:@-]+", text) and text.lower() not in ("true", "false", "null", "yes", "no"):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _find_block(lines: List[str], category: str, name: str) -> Tuple[int, int, int]:
    """(entry line index, end index exclusive, field indent) of the entry."""
    cat = next((i for i, ln in enumerate(lines)
                if _indent(ln) == 0 and ln.split("#", 1)[0].rstrip() == f"{category}:"), None)
    if cat is None:
        raise YamlEditError(f"no `{category}:` block at the top level")
    entry, entry_indent = None, None
    for i in range(cat + 1, len(lines)):
        ln = lines[i]
        if _is_blank(ln):
            continue
        ind = _indent(ln)
        if ind == 0:
            break
        if entry_indent is None:
            entry_indent = ind
        if ind == entry_indent and ln.split("#", 1)[0].strip() == f"{name}:":
            entry = i
            break
    if entry is None:
        raise YamlEditError(f"no `{name}:` entry under `{category}:`")
    field_indent: Optional[int] = None
    end = entry + 1
    for i in range(entry + 1, len(lines)):
        ln = lines[i]
        if _is_blank(ln):
            continue
        ind = _indent(ln)
        if ind <= entry_indent:
            break
        if field_indent is None:
            field_indent = ind
        end = i + 1
    return entry, end, field_indent if field_indent is not None else entry_indent + 2


def set_fields(text: str, category: str, name: str, fields: Dict[str, Any]) -> str:
    """*text* with ``category.name.<field> = value`` for every field."""
    lines = text.splitlines(keepends=True)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    for key, value in fields.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise YamlEditError(f"not a field name: {key!r}")
        entry, end, ind = _find_block(lines, category, name)
        rendered = yaml_scalar(value)
        for i in range(entry + 1, end):
            ln = lines[i]
            if _indent(ln) == ind and re.match(rf"\s*{re.escape(key)}\s*:", ln):
                comment = ""
                body = ln.rstrip("\n")
                if " #" in body:
                    comment = "  #" + body.split(" #", 1)[1]
                lines[i] = f"{' ' * ind}{key}: {rendered}{comment}\n"
                break
        else:
            lines.insert(end, f"{' ' * ind}{key}: {rendered}\n")
    return "".join(lines)
