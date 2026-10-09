"""Build a project's graphs and serialise them to the Project IR.

The IR is **derived and disposable** — never committed. Git carries source;
this is a cache the UI reads so it never has to parse Python.

Two sources, deliberately:

* **The built graph supplies semantics.** Ops produced by an ``@op_factory``
  do not exist until something is injected, so nothing short of building can
  see them. This is why extraction executes project code, and why one
  process handles one project.
* **The AST supplies source anchors.** ``BaseOp`` records no construction
  site. For a ``FuncOp`` we can recover one from ``code_fn.__code__``, but a
  class-based op (``LLMOp``, ``EmitOp``) has none — its class lives in
  operonx, not in the project. C3 guarantees an op's name is its assignment
  variable, so the two views line up by name.

Reading values is done through ``object.__getattribute__`` against a type
whitelist. ``Ref.__getattr__`` *builds a new Ref* for any attribute asked of
it, so an ordinary ``hasattr`` probe fabricates objects instead of answering
a question (finding S9).
"""

from __future__ import annotations

import ast
import inspect
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:  # tomllib is stdlib from 3.11
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised on 3.10 only
    import tomli as tomllib  # type: ignore[no-redef]

from operonx_project.lint import SKIP_DIRS
from operonx_project.manifest import GraphSpec, Manifest

__all__ = [
    "IR_VERSION",
    "extract_project",
    "extract_graph",
    "extract_dependencies",
    "build_entry",
    "ExtractError",
]

IR_VERSION = 1

_ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}")

# Types we are willing to reach inside. Anything else is rendered by repr,
# never probed — see the S9 note above.
_REF = "Ref"
_SCRATCH_REF = "ScratchRef"


class ExtractError(Exception):
    """A declared graph could not be built."""


def _slot(obj: Any, name: str, default: Any = None) -> Any:
    """Read one attribute without triggering ``__getattr__``."""
    try:
        return object.__getattribute__(obj, name)
    except AttributeError:
        return default


# ── bindings ─────────────────────────────────────────────────────────────


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    return repr(value)


def _source_id(source: Any) -> Optional[str]:
    """Identify what a ``Ref`` points at.

    ``Ref._source`` holds the producing **op object**, not a name — its
    ``repr`` renders the full name, which is easy to mistake for the stored
    value. Ops are safe to read normally; only ``Ref`` fabricates attributes.
    """
    if source is None or isinstance(source, str):
        return source
    full = _slot(source, "full_name")
    return full if isinstance(full, str) else repr(source)[:200]


def _consume_of(ref: Any) -> Optional[Dict[str, Any]]:
    """How a streamed input is consumed — `.parallel()` / `.collect()`.

    Sequential is the default and stays implicit. The other two change the
    run's shape: parallel fans one generator's yields out concurrently,
    collect buffers every yield until EOF and delivers a list — an edge
    the canvas must not draw as a plain arrow.
    """
    if _slot(ref, "_stream_collect", False):
        return {"mode": "collect"}
    if _slot(ref, "_stream_parallel", False):
        out: Dict[str, Any] = {"mode": "parallel"}
        cap = _slot(ref, "_stream_parallel_max")
        if cap:
            out["max"] = cap
        return out
    return None


def _binding(value: Any) -> Dict[str, Any]:
    """Describe where an input comes from, without probing unknown objects."""
    kind = type(value).__name__
    if kind == _REF:
        out = {
            "kind": "ref",
            "from": _source_id(_slot(value, "_source")),
            "output": _slot(value, "var"),
            "transforms": len(_slot(value, "_transforms") or []),
        }
        consume = _consume_of(value)
        if consume is not None:
            out["consume"] = consume
        return out
    if kind == _SCRATCH_REF:
        return {"kind": "scratch", "key": _slot(value, "key")}
    if value is None:
        return {"kind": "unset"}
    if isinstance(value, (bool, int, float, str, list, tuple, dict)):
        return {"kind": "literal", "value": _json_safe(value)}
    return {"kind": "opaque", "repr": repr(value)[:200]}


# ── source anchors ───────────────────────────────────────────────────────


def _anchors_for_module(path: Path) -> Dict[str, Dict[str, int]]:
    """``{lookup_name: {op_variable_name: line}}`` for one file.

    Each ``@graph`` body is filed under its own name *and* under the name of
    any plain function enclosing it. A manifest entry for the builder
    pattern names the **builder** (``build_ws_callbot_pipeline``), while the
    body belongs to the ``@graph`` inside it (``ws_callbot_pipeline``);
    without the second key, every builder-style project silently loses its
    ``wired_at`` anchors — and a class-based op such as ``LLMOp`` has no
    other source location at all.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, OSError):
        return {}

    enclosing: Dict[int, Optional[ast.AST]] = {}

    def walk(node: ast.AST, inside: Optional[ast.AST]) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                enclosing[id(child)] = inside
                walk(child, child)
            else:
                walk(child, inside)

    walk(tree, None)

    out: Dict[str, Dict[str, int]] = {}
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        decorated = {
            (d.func if isinstance(d, ast.Call) else d).id
            for d in fn.decorator_list
            if isinstance((d.func if isinstance(d, ast.Call) else d), ast.Name)
        }
        if "graph" not in decorated:
            continue
        names: Dict[str, int] = {}
        for stmt in ast.walk(fn):
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                tgt = stmt.targets[0]
                if isinstance(tgt, ast.Name):
                    names.setdefault(tgt.id, stmt.lineno)
        out[fn.name] = names
        outer = enclosing.get(id(fn))
        if isinstance(outer, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # A builder may wrap more than one graph; first one wins rather
            # than merging, so a reported line is never a blend of two bodies.
            out.setdefault(outer.name, names)
    return out


def collect_anchors(
    root: Path, src: Sequence[str] = (".",)
) -> Dict[str, Dict[str, Dict[str, int]]]:
    """``{module: {graph_fn: {op_var: line}}}`` across a project.

    Module names are computed relative to the declared **source roots**, not
    to the project root. With callbot's ``src/`` layout the two disagree —
    ``src/callbot/graph.py`` is imported as ``callbot.graph``, and keying it
    as ``src.callbot.graph`` means every anchor lookup misses silently.
    """
    roots = [(root / entry).resolve() for entry in (src or (".",))]
    out: Dict[str, Dict[str, Dict[str, int]]] = {}
    for py in sorted(root.rglob("*.py")):
        if any(part in SKIP_DIRS for part in py.parts):
            continue
        found = _anchors_for_module(py)
        if not found:
            continue
        resolved = py.resolve()
        for base in roots:
            try:
                relative = resolved.relative_to(base)
            except ValueError:
                continue
            # setdefault: the first (most specific) source root wins, matching
            # how the import system resolves the same name.
            out.setdefault(".".join(relative.with_suffix("").parts), found)
    return out


def _source_of(
    op: Any, root: Path, anchor_line: Optional[int], module: str
) -> Optional[Dict[str, Any]]:
    """Where this node came from — two different questions, both useful.

    ``defined_at`` is where the op's body lives, available only for a
    ``FuncOp`` via ``code_fn.__code__``. ``wired_at`` is where it was
    constructed inside the graph, recovered from the AST — the only anchor a
    class-based op such as ``InterruptOp`` or ``LLMOp`` has, since its class
    lives in operonx rather than the project.
    """
    out: Dict[str, Any] = {}
    code_fn = _slot(op, "code_fn")
    code = getattr(code_fn, "__code__", None) if code_fn is not None else None
    if code is not None:
        try:
            rel = str(Path(code.co_filename).resolve().relative_to(root))
        except ValueError:
            rel = code.co_filename
        out["defined_at"] = {"file": rel, "line": code.co_firstlineno}
    if anchor_line is not None:
        out["wired_at"] = {"file": module.replace(".", "/") + ".py", "line": anchor_line}
    return out or None


# ── nodes, edges, loops ──────────────────────────────────────────────────


def _edge_origin(edge: Any) -> str:
    """Which decision made this edge soft — the author's or the compiler's."""
    if getattr(edge, "pinned_hard", False):
        return "pinned_hard"
    if getattr(edge, "auto_soft", False):
        return "auto_soft"
    if getattr(edge, "soft", False):
        return "authored_soft"
    return "authored"


def _agent_of(op: Any) -> Optional[Dict[str, Any]]:
    """An agent op's agent (operonx-agents ``AgentOp``): its name, model resources
    and the tools it owns, each with what a reader needs to judge it — read-only,
    destructive, needs approval. Read by duck typing: the studio does not import
    operonx-agents, and an op without an ``agent`` is not one."""
    agent = _slot(op, "agent")
    tools = getattr(agent, "tools", None)
    if agent is None or tools is None or not hasattr(agent, "model"):
        return None
    listed = []
    for tool in getattr(tools, "tools", None) or list(tools):
        spec = getattr(tool, "spec", tool)
        approval = getattr(spec, "approval", "never")
        listed.append(
            {
                "name": getattr(tool, "name", None) or getattr(spec, "name", "?"),
                "description": (
                    getattr(spec, "description", None) or getattr(tool, "description", None) or ""
                ).strip().split("\n")[0][:200],
                "readonly": bool(getattr(spec, "readonly", False)),
                "destructive": bool(getattr(spec, "destructive", False)),
                "approval": approval if isinstance(approval, str) else "when",
            }
        )
    model = getattr(agent.model, "resources", None) or [getattr(agent.model, "resource", None)]
    out: Dict[str, Any] = {
        "name": getattr(agent, "name", None),
        "model": [m for m in model if m],
        "tools": listed,
    }
    # operonx-agents >= 0.2 says what the agent is itself: instructions,
    # limits, context, each tool's kind and what the policy decides for it
    describe = getattr(agent, "describe", None)
    if callable(describe):
        try:
            out.update(_json_safe(describe()))
        except Exception:  # noqa: BLE001 - an older or odd agent keeps the duck-typed view
            pass
    # how the op runs it: a session per session_id, a store for approvals
    out["session"] = _slot(op, "sessions") is not None
    out["store"] = _slot(op, "store") is not None
    out["stream"] = bool(_slot(op, "stream", False))
    return out


def _agent_loop(
    op: Any, agent: Dict[str, Any], root: Path, anchors: Dict[str, int], module: str
) -> Dict[str, Any]:
    """An agent op's inside, as a graph a viewer opens like a GraphOp: the
    model, one node per tool, and the answer. The model calls tools and
    each comes back to it (the next turn); when it calls none, it answers.

    A tool that is an operonx ``@graph`` carries its own graph, so it opens
    in place too; an ``@op`` tool carries its code. Built from the agent's
    own tools (``Tool.kind`` / ``Tool.target``, operonx-agents >= 0.2)."""
    base = op.full_name
    model = {
        "id": f"{base}.model", "name": "model", "kind": "AgentModel", "op_type": "llm",
        "agent_part": "model", "inputs": [], "outputs": ["content", "tool_calls"],
        "show_keys": [], "resource": agent.get("model") or [],
        "description": "The agent's model: reads the conversation, calls tools or answers.",
    }
    nodes: List[Dict[str, Any]] = [model]
    edges: List[Dict[str, Any]] = []
    by_name = {t.get("name"): t for t in agent.get("tools") or []}
    tools = _slot(_slot(op, "agent"), "tools")
    for t in (list(tools) if tools is not None else []):
        name = getattr(t, "name", None)
        if not name:
            continue
        info = dict(by_name.get(name) or {"name": name})
        node: Dict[str, Any] = {
            "id": f"{base}.{name}", "name": name, "kind": "AgentTool", "op_type": "tool",
            "agent_part": "tool", "tool": info, "inputs": [], "outputs": [],
            "show_keys": [], "description": info.get("description") or "",
        }
        target = getattr(t, "target", None)
        kind = getattr(t, "kind", None) or info.get("kind")
        fn = getattr(target, "__wrapped__", None)
        if kind == "graph" and fn is not None:
            sub = _tool_graph(target, fn, root, anchors)
            if sub is not None:
                node["graph"] = sub
        elif kind == "op" and fn is not None:
            try:
                source = inspect.getsource(fn)
                if len(source) <= 8000:
                    node["code"] = source
            except (OSError, TypeError):
                pass
        nodes.append(node)
        edges.append({"from": "model", "to": name, "type": "agent_call", "soft": False,
                      "origin": "agent"})
        edges.append({"from": name, "to": "model", "type": "agent_back", "soft": False,
                      "origin": "agent"})
    nodes.append({
        "id": f"{base}.answer", "name": "answer", "kind": "AgentAnswer", "op_type": "answer",
        "agent_part": "answer", "inputs": [], "outputs": ["output"], "show_keys": [],
        "end": True, "description": "The model called no tool: its reply is the answer.",
    })
    edges.append({"from": "model", "to": "answer", "type": "agent_done", "soft": False,
                  "origin": "agent"})
    return {"nodes": nodes, "edges": edges, "entries": ["model"], "exits": ["answer"],
            "agent_loop": True}


def _tool_graph(target: Any, fn: Any, root: Path, anchors: Dict[str, int]) -> Optional[Dict[str, Any]]:
    """A ``@graph`` tool's own graph, built the way an engine would build
    it (every parameter a runtime input). ``None`` when it cannot build."""
    try:
        params = list(inspect.signature(fn).parameters)
        g = target(**{p: None for p in params})
        try:
            g.build()
        except Exception:  # noqa: BLE001 - the unbuilt ops still describe it
            pass
        module = getattr(fn, "__module__", "") or ""
        return _subgraph(g, root, anchors, module)
    except Exception:  # noqa: BLE001 - a tool that cannot build is shown flat
        return None


def _node(op: Any, root: Path, anchors: Dict[str, int], module: str) -> Dict[str, Any]:
    inputs = []
    for name, param in (_slot(op, "inputs") or {}).items():
        inputs.append(
            {
                "name": name,
                "binding": _binding(_slot(param, "value")),
                "required": bool(_slot(param, "required", False)),
            }
        )
    node: Dict[str, Any] = {
        "id": op.full_name,
        "name": op.name,
        "kind": type(op).__name__,
        # operonx's OpType (`code`, `llm`, `graph`, `agent`, ...): what an
        # op IS, where `kind` is only its class
        "op_type": _slot(op, "type"),
        "bound": _slot(op, "bound"),
        # Semantics a normal workflow tool does not have, and the reason a
        # viewer must carry them: a generator op is invoked once and its
        # consumers dispatch PER YIELD, so one edge carries many items per
        # run — a diagram that draws it like a batch op lies about the
        # system's central mechanism. Transient marks the ports whose
        # values are evicted once consumed.
        "is_gen": bool(_slot(op, "is_gen", False)),
        "transient": bool(_slot(op, "transient", False)),
        "start": bool(_slot(op, "start", False)),
        "end": bool(_slot(op, "end", False)),
        "inputs": inputs,
        "outputs": sorted((_slot(op, "outputs") or {}).keys()),
        "source": _source_of(op, root, anchors.get(op.name), module),
    }
    for extra in ("resource", "channel"):
        value = _slot(op, extra)
        if value is not None:
            node[extra] = _json_safe(value)
    agent = _agent_of(op)
    if agent is not None:
        node["agent"] = agent
        node.setdefault("resource", agent["model"])
        node["graph"] = _agent_loop(op, agent, root, anchors, module)
    # The serve boundary is not compute: ingress hands the client's frames
    # to the run, egress hands the run's answers back. A viewer that draws
    # them as ordinary ops invites the reader to look for business logic
    # inside a door.
    code_fn = _slot(op, "code_fn")
    # An op that says it is a door (`@op(door="egress")`, operonx >= 1.8)
    # draws as one. A project's own door op keeps its code below; the
    # built-in ingress/egress are recognised by identity on older operonx.
    door = _slot(op, "door")
    builtin_door = (
        getattr(code_fn, "__module__", None) in ("operonx.app.serve.ops", "operonx.core.serve.ops")
        and getattr(code_fn, "__name__", "") in ("ingress", "egress")
    )
    if door in ("ingress", "egress"):
        node["serve_role"] = door
    elif builtin_door:
        node["serve_role"] = code_fn.__name__
    if code_fn is not None and not builtin_door:
        # A FuncOp's body IS its documentation — the inspector shows it as
        # a collapsed code block. Bounded so one giant function cannot
        # bloat the IR; the source location is always there for the rest.
        try:
            import inspect

            source = inspect.getsource(code_fn)
            if len(source) <= 8000:
                node["code"] = source
        except (OSError, TypeError):
            pass
    # The op's role in one paragraph: `description=` when the author set
    # one, else the first paragraph of the docstring — the function's for
    # a FuncOp, the graph function's for a GraphOp, the class's for an
    # op class. Rendered on the card and in the inspector, so a reader
    # learns what an op is for without opening its code.
    desc = _describe(op, code_fn)
    if desc:
        node["description"] = desc
    # The outputs that stand for the op — declared at the call site or
    # on the decorator, else the op class's default (operonx ≥ 1.6).
    # Empty here means "nobody said": _subgraph fills it from the
    # dataflow once every node of the graph is known. A door has
    # nothing to say.
    declared = _slot(op, "show_keys", ()) or ()
    node["show_keys"] = [] if node.get("serve_role") else [str(k) for k in declared]
    # A branch's whole meaning is WHICH condition routes WHERE, and the
    # op stores exactly that: `cases` as (ref, target) pairs with their
    # human descriptions ("score >= 90"), plus the else target. Without
    # this a canvas draws identical unlabeled arrows out of every router.
    cases = _slot(op, "cases")
    if cases is not None:
        descriptions = list(_slot(op, "_case_descriptions") or [])
        routes = []
        for i, case in enumerate(list(cases)):
            try:
                _ref, target = case
            except (TypeError, ValueError):
                continue
            routes.append({
                "condition": descriptions[i] if i < len(descriptions) else "?",
                "target": getattr(target, "name", None) or str(target),
            })
        default = _slot(op, "default")
        if default is not None:
            routes.append({"condition": "else",
                           "target": getattr(default, "name", None) or str(default)})
        if routes:
            node["routes"] = routes
    if _slot(op, "_ops"):
        node["graph"] = _subgraph(op, root, anchors, module)
    return node


def _auto_show_keys(node: Dict[str, Any], nodes: List[Dict[str, Any]]) -> List[str]:
    """One output that stands for an op nobody described — from the dataflow.

    Candidates are the op's outputs minus its own input names (a key
    that goes in and comes out is plumbing being passed along) and
    minus ``_``-prefixed keys (``__branch_target__``). Ranked by how
    many ops in the graph output that key (the rarer, the more it is
    THIS op's product), then by how many refs pull it from this op,
    then by name. One key: an auto pick is a guess, and two guesses
    read as a statement. Measured on a real flow the guess is right
    about half the time — declare ``show_keys`` where it is wrong.
    """
    outputs = list(node.get("outputs") or [])
    if not outputs:
        return []
    producers: Dict[str, int] = {}
    consumers: Dict[str, int] = {}
    for other in nodes:
        for key in other.get("outputs") or []:
            producers[key] = producers.get(key, 0) + 1
        for inp in other.get("inputs") or []:
            binding = inp.get("binding") or {}
            if binding.get("kind") == "ref" and binding.get("from") == node["id"]:
                key = binding.get("output")
                consumers[key] = consumers.get(key, 0) + 1
    own_inputs = {i["name"] for i in (node.get("inputs") or [])}
    candidates = [k for k in outputs if k not in own_inputs and not k.startswith("_")]
    pool = candidates or [k for k in outputs if not k.startswith("_")] or outputs
    ranked = sorted(pool, key=lambda k: (producers.get(k, 0), -consumers.get(k, 0), k))
    return [ranked[0]]


def _loop_of(op: Any) -> Optional[Dict[str, Any]]:
    """Loop metadata, if this node is one. Three kinds render differently."""
    mode = _slot(op, "_loop_mode")
    config = _slot(op, "_loop_config")
    if mode is None and config is None:
        return None
    return {
        "mode": mode or "classic",
        "synthetic": bool(_slot(op, "_synthetic", False)),
        # Cycle rewriting DELETES back-edges from _edges, so this is the only
        # record of what the author actually wrote.
        "back_edges": [list(e) for e in (_slot(op, "_back_edges") or [])],
        "until": _json_safe(_slot(config, "until")) if config is not None else None,
        "max_iterations": _slot(config, "max_iterations") if config is not None else None,
    }


def edge_id(src: str, dst: str, route: Optional[int] = None) -> str:
    """A stable edge id: the pair, plus the route index for a branch route."""
    return f"{src}->{dst}" if route is None else f"{src}->{dst}#{route}"


def _expand_branch_edges(
    edges: List[Dict[str, Any]], nodes: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Give every edge an ``id``; split a branch's edge into one per route.

    operonx keeps one edge per (source, target) pair, so a branch whose
    three conditions all route to the same op has ONE edge in ``_edges``
    and the canvas could draw only one wire. Each route is its own
    decision, so each becomes its own edge: same pair, its own ``id``,
    ``route`` index, ``label`` (the condition) and ``kind: "branch"``.
    Only pairs the engine actually wired are expanded — nothing is
    invented — and every non-branch edge passes through as it was.
    """
    routes_of = {n["name"]: n.get("routes") or [] for n in nodes if n.get("routes")}
    out: List[Dict[str, Any]] = []
    for e in edges:
        routes = routes_of.get(e["from"]) or []
        hits = [i for i, r in enumerate(routes) if r.get("target") == e["to"]]
        if not hits:
            out.append({**e, "id": edge_id(e["from"], e["to"])})
            continue
        for i in hits:
            out.append({
                **e,
                "id": edge_id(e["from"], e["to"], i),
                "kind": "branch",
                "route": i,
                "label": routes[i].get("condition"),
            })
    return out


def _subgraph(g: Any, root: Path, anchors: Dict[str, int], module: str) -> Dict[str, Any]:
    nodes, loops = [], {}
    for name, op in (_slot(g, "_ops") or {}).items():
        nodes.append(_node(op, root, anchors, module))
        loop = _loop_of(op)
        if loop is not None:
            loops[op.full_name] = loop
    edges = [
        {
            "from": edge.from_node,
            "to": edge.to_node,
            "type": edge.type,
            "soft": bool(edge.soft),
            "origin": _edge_origin(edge),
        }
        for edge in (_slot(g, "_edges") or {}).values()
    ]
    edges = _expand_branch_edges(edges, nodes)
    for node in nodes:
        if not node["show_keys"] and not node.get("serve_role"):
            node["show_keys"] = _auto_show_keys(node, nodes)
    out: Dict[str, Any] = {
        "nodes": nodes,
        "edges": edges,
        "entries": list(_slot(g, "entries") or []),
        "exits": list(_slot(g, "exits") or []),
    }
    # The author's `member["x"] >> PARENT["y"]` writes — the only edges
    # that genuinely OVERRIDE another op's variable. GraphOp keeps them
    # in _out_vars as {op_name: {src_var: dest_var}}; without this the
    # viewer cannot tell an export from an ordinary downstream pull.
    exports = []
    for op_name, mapping in (_slot(g, "_out_vars") or {}).items():
        for src_var, dest_var in (mapping or {}).items():
            exports.append({"from": op_name.split(".")[-1],
                            "output": src_var, "as": dest_var})
    if exports:
        out["exports"] = exports
    if loops:
        out["loops"] = loops
    rewritten = _slot(g, "_rewritten_from")
    if rewritten:
        out["rewritten_from"] = _json_safe(rewritten)
    return out


# ── building ─────────────────────────────────────────────────────────────


def build_entry(spec: GraphSpec, root: Path) -> Any:
    """Resolve and build one declared graph.

    An entry is a module-level ``@graph``: ``bind`` fixes some of its
    parameters (a variant), every other parameter is a runtime input port,
    wired here to ``PARENT``. A bound plain function (a graph factory) is
    refused, per operonx guide 05.

    The instance is renamed to the manifest label *before* building.
    ``auto_name`` reads the caller's frame, so without this the graph would
    be named after a local variable in this function.
    """
    from operonx.core import PARENT

    target = spec.resolve(root)
    bound: Dict[str, Any] = {}
    if spec.bind and spec.obj is not None:
        # Handed over by the application: the values are the objects.
        bound = dict(spec.bind)
    elif spec.bind:
        # Each bound reference is used **as-is**, never called. An earlier
        # draft called a zero-argument provider, which is ambiguous the
        # moment a dependency is itself a callable: callbot's
        # `build_mock_chat_pipeline(agent, sink_op)` takes an op *as a
        # value*, and calling it would inject the wrong thing entirely.
        # Projects that need construction expose a module-level instance,
        # which is what callbot already does (`agents.ahamove_hr:AGENT`).
        bound = spec.resolve_bind(root)
        # A @graph takes them as its own parameters: the decorator passes
        # a static value into the body as-is (operonx ≥ 1.7.2), and the
        # rest stay runtime inputs wired to PARENT below.

    if bound and not getattr(target, "_operonx_graph", False):
        raise ExtractError(
            f"graph '{spec.name}': {spec.entry} is a plain function; bound values go to a "
            "module-level @graph's own parameters, not to a function that builds a graph "
            "(operonx guide 05)"
        )
    try:
        params = list(inspect.signature(target).parameters)
    except (TypeError, ValueError) as exc:
        raise ExtractError(f"graph '{spec.name}': entry is not callable — {exc}") from exc
    unknown = set(bound) - set(params)
    if unknown:
        raise ExtractError(f"graph '{spec.name}': no parameter {sorted(unknown)}; it takes {params}")

    try:
        instance = target(**{p: PARENT[p] for p in params if p not in bound}, **bound)
    except Exception as exc:  # noqa: BLE001
        raise ExtractError(f"graph '{spec.name}': construction raised {exc!r}") from exc

    instance.name = spec.name
    instance.build()
    return instance


def extract_graph(
    spec: GraphSpec, root: Path, anchors: Dict[str, Dict[str, Dict[str, int]]]
) -> Dict[str, Any]:
    """Build one declared graph and serialise it."""
    instance = build_entry(spec, root)
    module, attr = spec.entry.split(":")
    by_graph = anchors.get(module, {})
    # The @graph function name, not the manifest label — the label is ours.
    fn_anchors = by_graph.get(attr, {})
    out = {"name": spec.name, "entry": spec.entry, "inputs": _json_safe(spec.inputs)}
    out.update(_subgraph(instance, root, fn_anchors, module))
    return out


# ── resources and env ────────────────────────────────────────────────────


def _scan_env(text: str) -> Tuple[List[str], Dict[str, str]]:
    required, optional = set(), {}
    for name, default in _ENV_PATTERN.findall(text):
        if default == "":
            # ``${VAR}`` has no colon; ``${VAR:}`` means empty default.
            required.add(name)
        else:
            optional[name] = default
    return sorted(required), dict(sorted(optional.items()))


def _parse_resources(text: str) -> Tuple[List[str], str]:
    """Top-level keys, and the live content to scan for env variables.

    Parsed as YAML rather than scanned line by line. A commented-out block
    looks exactly like a declaration to a scanner — ex16 has both a live
    ``doc_store:corpus`` and a commented one — and it would equally report
    the ``${PG_DSN}`` inside that dead block as a required variable. Telling
    someone to set a variable nothing reads is the same class of lie as the
    install hints in S12.

    Returns the keys and a re-serialised copy of the parsed document, so the
    env scan sees only what survives parsing. ``pyyaml`` is a base operonx
    dependency, so this costs nothing.
    """
    try:
        import yaml

        loaded = yaml.safe_load(text)
        if isinstance(loaded, dict):
            return [str(k) for k in loaded], yaml.safe_dump(loaded, default_flow_style=False)
    except Exception:  # noqa: BLE001 - malformed file, fall back below
        pass
    # Unparseable: report no keys rather than guessing, but still scan the
    # raw text so a broken file does not silently hide its env contract.
    return [], text


_SECRET_FIELD = re.compile(r"key|token|secret|password|credential", re.IGNORECASE)
# ``api_key_header: X-API-Key`` names a header, it does not hold one —
# fields ABOUT a secret are not the secret
_SECRET_EXEMPT = re.compile(r"header|name|path|file|url|id$", re.IGNORECASE)
_PLACEHOLDER_ONLY = re.compile(r"^\s*\$\{[A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?\}\s*$")


def _resource_fields(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Every scalar field of one declared resource, VERBATIM.

    The declaration is what the viewer shows — ``${VAR:default}`` and all,
    so the reader sees exactly which env knob each field hangs on. The
    one exception: a secret-named field whose value is NOT purely an env
    placeholder is a hardcoded credential, and it leaves as ``•••``.
    """
    fields: Dict[str, Any] = {}
    for key, value in entry.items():
        if isinstance(value, str):
            secretish = (_SECRET_FIELD.search(str(key))
                         and not _SECRET_EXEMPT.search(str(key)))
            if secretish and not _PLACEHOLDER_ONLY.match(value):
                fields[key] = "•••"
            else:
                fields[key] = value
        elif isinstance(value, (int, float, bool)):
            fields[key] = value
    return fields


def _describe(op: Any, code_fn: Any) -> str:
    """One paragraph for the op: an explicit ``description=`` wins, else
    the first paragraph of the function's docstring (a FuncOp) or of the
    op class's (TTSOp, a classifier). A FuncOp's own ``description`` is
    the docstring's first LINE, so when the docstring continues that
    line the paragraph is used instead. The generic container classes
    describe nothing about this graph, so they are skipped — a GraphOp
    is described by ``description=`` at the call site."""
    import inspect

    explicit = " ".join(str(_slot(op, "description") or "").split())
    doc = ""
    for target in (code_fn, type(op)):
        if target is None:
            continue
        if inspect.isclass(target) and target.__module__.startswith("operonx."):
            continue
        text = (inspect.getdoc(target) or "").strip()
        if text:
            doc = " ".join(text.split("\n\n", 1)[0].split())
            break
    if doc and (not explicit or doc.startswith(explicit)):
        return doc[:400]
    return explicit[:400]


def extract_resources(manifest: Manifest) -> Dict[str, Any]:
    """Declared resource keys, per-resource details, and the env contract.

    Details carry only what a viewer may show: scalar fields with env
    defaults resolved, secret-named fields dropped. An op's ``resource``
    attribute names a SECOND-level entry (``llm.inhouse`` → "inhouse"),
    so details are indexed by both levels — category and name.
    """
    keys: List[str] = []
    required: List[str] = []
    optional: Dict[str, str] = {}
    details: Dict[str, Any] = {}
    for path in manifest.resources.files(manifest.root):
        text = path.read_text(encoding="utf-8")
        found, live = _parse_resources(text)
        keys.extend(found)
        req, opt = _scan_env(live)
        required.extend(req)
        optional.update(opt)
        try:
            import yaml

            loaded = yaml.safe_load(text)
        except Exception:  # noqa: BLE001 - malformed file already handled above
            loaded = None
        if isinstance(loaded, dict):
            for category, group in loaded.items():
                if not isinstance(group, dict):
                    continue
                named = {k: v for k, v in group.items() if isinstance(v, dict)}
                for name, entry in named.items():
                    details[str(name)] = {"category": str(category),
                                          **_resource_fields(entry)}
                flat = {k: v for k, v in group.items() if not isinstance(v, dict)}
                if flat:
                    details.setdefault(str(category), {"category": str(category)})
                    details[str(category)].update(_resource_fields(flat))
    return {
        "keys": sorted(set(keys)),
        "details": details,
        "env": {"required": sorted(set(required)), "optional": dict(sorted(optional.items()))},
    }


def extract_dependencies(root: Path) -> Dict[str, Any]:
    """The project's declared dependencies, from its ``pyproject.toml``.

    Declarations only — never a resolved lockfile and never what happens to
    be installed. Those are machine state; the IR stays a function of the
    source so two extractions of the same commit agree byte for byte.
    """
    path = root / "pyproject.toml"
    if not path.exists():
        return {"declared": False}
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        return {"declared": False, "error": "pyproject.toml is not valid TOML"}

    project = raw.get("project") or {}
    extras = project.get("optional-dependencies") or {}
    return {
        "declared": True,
        "name": project.get("name"),
        "requires_python": project.get("requires-python"),
        "dependencies": sorted(project.get("dependencies") or []),
        "extras": {k: sorted(v) for k, v in sorted(extras.items())},
    }


def extract_application(manifest: Manifest) -> Dict[str, Any]:
    """Services and jobs, as the application layer describes them.

    ``operonx.app.Application.describe()`` is plain data and imports
    nothing from the project, so this is cheap and cannot fail on project
    code. A project on an operonx older than 1.7.1 has no application
    layer: its ``[[serve]]`` blocks are listed the old way and it has no
    jobs, which is true.
    """
    fallback = {"application": False, "services": [s.as_dict() for s in manifest.serves], "jobs": []}
    try:
        from operonx.app import Application
    except ImportError:
        return fallback
    try:
        app = Application.load(manifest.root / "operonx.toml")
        described = app.describe()
    except Exception as exc:                              # noqa: BLE001 — reported, never fatal
        return {**fallback, "error": f"{type(exc).__name__}: {exc}"}
    # Where each job keeps its records: the `Job` object says (operonx 1.17
    # places it under the project root; an older one only when it was set).
    try:
        specs = {
            j.name: str(j.records() if hasattr(j, "records") else (getattr(j, "record_dir", "") or ""))
            for j in app.jobs
        }
    except Exception:  # noqa: BLE001 — records unknown, jobs still listed
        specs = {}
    jobs = []
    for entry in described["jobs"]:
        rd = specs.get(entry["name"])
        # an eval records under evals/ unless it says otherwise
        record_dir = Path(rd) if rd else Path("evals" if entry.get("kind") == "eval" else "jobs")
        if not record_dir.is_absolute():
            record_dir = manifest.root / record_dir
        jobs.append({**entry, "record_dir": str(record_dir)})
    return {"application": True, "services": described["services"], "jobs": jobs}


def graph_specs(manifest: Manifest) -> List[GraphSpec]:
    """The graphs to draw. From the file when it declares them; from the
    application object when ``[project] app`` points at one — its
    ``graphs`` carry the objects and each variant's bound values, so
    nothing is re-parsed and nothing can drift from what production runs.
    """
    if not manifest.app:
        return list(manifest.graphs)
    from operonx.app import Application

    app = Application.load(manifest.root / "operonx.toml")
    app.bootstrap()
    own = {g.name for g in manifest.graphs}
    specs = list(manifest.graphs)
    for ref in app.graphs:
        if ref.name in own:
            continue
        specs.append(
            GraphSpec(
                name=ref.name, entry=ref.entry, bind=dict(ref.bind), inputs={},
                src=manifest.src, obj=ref.graph,
            )
        )
    return specs


def extract_project(manifest: Manifest) -> Dict[str, Any]:
    """The whole project as one IR document."""
    anchors = collect_anchors(manifest.root, manifest.src)
    application = extract_application(manifest)
    return {
        "ir_version": IR_VERSION,
        "project": manifest.name,
        "description": manifest.description,
        "graphs": [extract_graph(spec, manifest.root, anchors) for spec in graph_specs(manifest)],
        # What puts work into each graph. Declared rather than derived —
        # the hop from a socket handler to `engine.start()` is not an op
        # and cannot be discovered from the graph. Without it a served
        # pipeline renders as beginning from nowhere.
        "serves": [spec.as_dict() for spec in manifest.serves],
        # The application layer's own account of the same, plus the jobs:
        # the three lists the studio shows per project.
        "application": application["application"],
        "services": application["services"],
        "jobs": application["jobs"],
        "resources": extract_resources(manifest),
        "dependencies": extract_dependencies(manifest.root),
    }
