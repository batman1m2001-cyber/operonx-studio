"""A YAML file edited value by value, without rewriting the file
(docs/STUDIO_EXPERIENCE_PLAN.md §4, §6).

A round-trip YAML library re-emits the whole document and changes lines
nobody touched; this edits text at the exact span PyYAML's composer reports
for one node (``start_mark`` / ``end_mark``), so a comment, a quote style or a
key order elsewhere stays byte for byte:

* ``set``     one scalar's value, in its own style where it can (plain,
              quoted, a literal block for text with line breaks);
* ``append``  one item at the end of a list (block ``- x`` or flow ``[x]``);
* ``remove``  one item of a block list;
* ``add``     one ``key: value`` at the end of a block mapping;
* ``delete``  one key of a block mapping.

Every edit is proved by :func:`operonx_studio.safewrite.yaml_scope` on the
path it names before it is written.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

__all__ = ["YamlDocError", "tree", "edit"]


class YamlDocError(ValueError):
    pass


def _compose(text: str) -> yaml.Node:
    try:
        node = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.YAMLError as exc:
        raise YamlDocError(f"not valid YAML: {exc}") from exc
    if node is None:
        raise YamlDocError("the file is empty")
    return node


def _scalar_value(node: yaml.ScalarNode) -> Any:
    return yaml.SafeLoader("").construct_object(node, deep=True)


def tree(text: str, max_items: int = 2000) -> Dict[str, Any]:
    """The document as the editor draws it: each node with its kind, its
    value (a scalar's), its children and its first line."""
    count = [0]

    def walk(node: yaml.Node) -> Dict[str, Any]:
        count[0] += 1
        out: Dict[str, Any] = {"line": node.start_mark.line + 1}
        if count[0] > max_items:
            out.update(kind="more")
            return out
        if isinstance(node, yaml.MappingNode):
            out["kind"] = "map"
            out["flow"] = bool(node.flow_style)
            out["items"] = []
            for k, v in node.value:
                child = walk(v)
                child["key_line"] = k.start_mark.line + 1   # where `key:` is written
                out["items"].append([_scalar_value(k) if isinstance(k, yaml.ScalarNode) else str(k.value), child])
        elif isinstance(node, yaml.SequenceNode):
            out["kind"] = "list"
            out["flow"] = bool(node.flow_style)
            out["items"] = [walk(v) for v in node.value]
        else:
            out["kind"] = "scalar"
            out["value"] = _scalar_value(node)
            out["style"] = node.style or ""
        return out

    return walk(_compose(text))


def _find(root: yaml.Node, path: Sequence[Any]) -> yaml.Node:
    node = root
    for step in path:
        if isinstance(node, yaml.MappingNode):
            for k, v in node.value:
                if isinstance(k, yaml.ScalarNode) and (_scalar_value(k) == step or k.value == str(step)):
                    node = v
                    break
            else:
                raise YamlDocError(f"no key {step!r} at {_show(path)}")
        elif isinstance(node, yaml.SequenceNode):
            try:
                node = node.value[int(step)]
            except (ValueError, IndexError):
                raise YamlDocError(f"no item {step!r} at {_show(path)}") from None
        else:
            raise YamlDocError(f"{_show(path)} goes past a value")
    return node


def _show(path: Sequence[Any]) -> str:
    return ".".join(str(p) for p in path) or "the document"


def _line_start(text: str, index: int) -> int:
    return text.rfind("\n", 0, index) + 1


def _line_end(text: str, index: int) -> int:
    """Index just past the newline ending the line *index* is on."""
    j = text.find("\n", index)
    return len(text) if j < 0 else j + 1


def _render_inline(value: Any, quote: str = "") -> str:
    """A value on one line, as YAML: a quote style kept when it was quoted."""
    if isinstance(value, str) and quote in ("'", '"') and "\n" not in value:
        if quote == '"':
            return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
        return "'" + value.replace("'", "''") + "'"
    text = yaml.safe_dump(value, default_flow_style=True, allow_unicode=True, width=10**9, sort_keys=False)
    text = text.strip()
    if text.endswith("\n..."):
        text = text[: -4].strip()
    if text.endswith("..."):
        text = text[:-3].strip()
    return text


def _render_block_text(value: str, indent: int) -> str:
    """A string with line breaks as a literal block (``|-``)."""
    pad = " " * indent
    return "|-\n" + "\n".join((pad + ln) if ln else "" for ln in value.split("\n"))


def _set(text: str, root: yaml.Node, path: Sequence[Any], value: Any) -> str:
    node = _find(root, path)
    if not isinstance(node, yaml.ScalarNode):
        raise YamlDocError(f"{_show(path)} is a {'list' if isinstance(node, yaml.SequenceNode) else 'mapping'}, not a value")
    if isinstance(value, (dict, list)):
        raise YamlDocError("set takes a single value; add or append items instead")
    start, end = node.start_mark.index, node.end_mark.index
    was_block = node.style in ("|", ">")
    # a block scalar's span runs to the start of the line after it; a plain or
    # quoted one ends on its own line, before any comment
    line_start = _line_start(text, start)
    lead = text[line_start:start]
    indent = len(lead) - len(lead.lstrip(" ")) + 2
    if isinstance(value, str) and "\n" in value:
        if not was_block:
            rest = text[end:_line_end(text, end)].strip()
            if rest.startswith("#"):
                raise YamlDocError(f"{_show(path)} has a comment on its line; a value with line breaks would swallow it — edit it in the file")
        body = _render_block_text(value, indent)
        return text[:start] + body + ("\n" if was_block else "") + text[end:]
    inline = _render_inline(value, "" if was_block else (node.style or ""))
    return text[:start] + inline + ("\n" if was_block else "") + text[end:]


def _append(text: str, root: yaml.Node, path: Sequence[Any], value: Any) -> str:
    node = _find(root, path)
    if not isinstance(node, yaml.SequenceNode):
        raise YamlDocError(f"{_show(path)} is not a list")
    if node.flow_style or not node.value:
        # [a, b] -> [a, b, value]; an empty flow list [] -> [value]
        close = node.end_mark.index - 1
        inner = text[node.start_mark.index + 1:close].strip()
        return text[:close] + (", " if inner else "") + _render_inline(value) + text[close:]
    last = node.value[-1]
    first = node.value[0]
    dash = text.rfind("-", 0, first.start_mark.index)
    col = dash - _line_start(text, dash)
    at = _line_end(text, last.end_mark.index - 1 if last.end_mark.index > last.start_mark.index else last.end_mark.index)
    line = " " * col + "- " + _render_inline(value) + "\n"
    if at > 0 and not text[:at].endswith("\n"):
        line = "\n" + line
    return text[:at] + line + text[at:]


def _remove(text: str, root: yaml.Node, path: Sequence[Any]) -> str:
    *where, index = path
    node = _find(root, where)
    if not isinstance(node, yaml.SequenceNode) or node.flow_style:
        raise YamlDocError(f"{_show(where)} is not a block list")
    i = int(index)
    if not 0 <= i < len(node.value):
        raise YamlDocError(f"no item {i} in {_show(where)}")
    item = node.value[i]
    dash = text.rfind("-", 0, item.start_mark.index)
    start = _line_start(text, dash)
    if i + 1 < len(node.value):
        nxt = node.value[i + 1]
        end = _line_start(text, text.rfind("-", 0, nxt.start_mark.index))
    else:
        end = _line_end(text, max(item.start_mark.index, item.end_mark.index - 1))
    return text[:start] + text[end:]


def _add(text: str, root: yaml.Node, path: Sequence[Any], key: str, value: Any) -> str:
    node = _find(root, path)
    if not isinstance(node, yaml.MappingNode) or node.flow_style:
        raise YamlDocError(f"{_show(path)} is not a block mapping")
    if any(isinstance(k, yaml.ScalarNode) and k.value == key for k, _ in node.value):
        raise YamlDocError(f"{_show(path)} already has {key!r}")
    if not node.value:
        raise YamlDocError(f"{_show(path)} is empty: add the first key in the file")
    first_key = node.value[0][0]
    col = first_key.start_mark.column
    last_val = node.value[-1][1]
    at = _line_end(text, max(last_val.start_mark.index, last_val.end_mark.index - 1))
    pad = " " * col
    if isinstance(value, dict):
        body = yaml.safe_dump(value, allow_unicode=True, sort_keys=False, width=10**9, default_flow_style=False)
        block = f"{pad}{_render_inline(key)}:\n" + "".join(f"{pad}  {ln}\n" for ln in body.rstrip("\n").split("\n"))
    else:
        block = f"{pad}{_render_inline(key)}: {_render_inline(value)}\n"
    if not text[:at].endswith("\n"):
        block = "\n" + block
    return text[:at] + block + text[at:]


def _delete(text: str, root: yaml.Node, path: Sequence[Any]) -> str:
    *where, key = path
    node = _find(root, where)
    if not isinstance(node, yaml.MappingNode) or node.flow_style:
        raise YamlDocError(f"{_show(where)} is not a block mapping")
    pairs = node.value
    for i, (k, v) in enumerate(pairs):
        if isinstance(k, yaml.ScalarNode) and (k.value == str(key)):
            start = _line_start(text, k.start_mark.index)
            if i + 1 < len(pairs):
                end = _line_start(text, pairs[i + 1][0].start_mark.index)
            else:
                end = _line_end(text, max(v.start_mark.index, v.end_mark.index - 1))
            return text[:start] + text[end:]
    raise YamlDocError(f"no key {key!r} at {_show(where)}")


def edit(text: str, op: str, path: Sequence[Any], value: Any = None, key: Optional[str] = None) -> Tuple[str, List[Tuple]]:
    """One edit, and the paths :func:`safewrite.yaml_scope` must allow."""
    root = _compose(text)
    path = list(path or [])
    if op == "set":
        return _set(text, root, path, value), [tuple(path)]
    if op == "append":
        return _append(text, root, path, value), [tuple(path)]
    if op == "remove":
        return _remove(text, root, path), [tuple(path[:-1])]
    if op == "add":
        if not key:
            raise YamlDocError("add needs a key")
        return _add(text, root, path, key, value), [tuple(path) + (key,)]
    if op == "delete":
        return _delete(text, root, path), [tuple(path)]
    raise YamlDocError(f"unknown edit {op!r}; known: set, append, remove, add, delete")
