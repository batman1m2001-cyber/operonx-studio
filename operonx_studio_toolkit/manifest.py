"""``operonx.toml`` — the studio's view of a project manifest.

The file is parsed by core (``operonx.app.manifest``), the same parser
``operonx serve`` boots from; this module keeps the shapes the studio's
extraction and edits work with (``GraphSpec.resolve`` imports an entry
inside the project's own interpreter, never the studio's).

Today a manifest mostly points at the application (``[project] app``),
whose services and jobs name the graphs; ``[[graph]]`` still lists graphs
nothing serves. A served door's ``[serve.variants]`` bind its graph's
build-time parameters, one drawn graph per variant. Input ports come from
each graph's signature, required env keys from ``${VAR}`` in
``resources.yaml``. (``[resources] base`` and ``[graph.bind]`` were the
studio's own and are gone: core never read them, and no project used them.)

Example::

    [project]
    name = "callbot"
    src  = ["src", "."]     # import roots; defaults to ["."]
    app  = "app.main:APP"
"""

from __future__ import annotations

import importlib
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Sequence, Tuple

try:  # tomllib is stdlib from 3.11
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - exercised on 3.10 only
    import tomli as tomllib  # type: ignore[no-redef]

__all__ = ["Manifest", "GraphSpec", "ResourceSpec", "ManifestError", "MANIFEST_NAME"]

MANIFEST_NAME = "operonx.toml"


class ManifestError(Exception):
    """The manifest is missing, malformed, or points at something unimportable."""


_ENTRY_RE = re.compile(r"^[\w.]+:[\w.]+$")


def _target(ref: str, where: str) -> Tuple[str, str]:
    """Split a ``"module:attr"`` reference, or raise with useful context."""
    if ref.count(":") != 1:
        raise ManifestError(f"{where}: expected 'module:attr', got {ref!r}")
    module, attr = ref.split(":")
    if not module or not attr:
        raise ManifestError(f"{where}: expected 'module:attr', got {ref!r}")
    return module, attr


def _check_not_foreign(module_name: str, where: str, root: Path) -> None:
    """Refuse a module already imported from *outside* this project.

    Projects routinely share top-level module names — every tutorial example
    defines ``main`` — so a second project resolved in the same interpreter
    would silently receive the first project's module and fail with a
    baffling ``AttributeError``. One process handles one project; this turns
    the violation into a message that says so.
    """
    existing = sys.modules.get(module_name)
    if existing is None:
        return
    origin = getattr(existing, "__file__", None)
    if not origin:
        return
    if Path(origin).resolve().is_relative_to(root):
        return
    raise ManifestError(
        f"{where}: module {module_name!r} is already imported from {origin}, "
        f"which is outside this project ({root}). Resolve one project per "
        f"process — module names collide across projects."
    )


def _import(ref: str, where: str, root: Path, src: Sequence[str] = (".",)) -> Any:
    """Import ``module:attr`` with the project's source roots on ``sys.path``.

    A project's packages do not have to sit at its root — callbot keeps them
    under ``src/`` and declares ``pythonpath = ["src", "."]`` for pytest.
    Without the same list here, ``callbot.graph`` simply does not import.
    """
    module_name, attr = _target(ref, where)
    _check_not_foreign(module_name.split(".")[0], where, root)
    added = []
    for entry in src or (".",):
        candidate = str((root / entry).resolve())
        if candidate not in sys.path:
            sys.path.insert(0, candidate)
            added.append(candidate)
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise ManifestError(
            f"{where}: cannot import module {module_name!r} — {exc}. "
            f"Source roots tried: {list(src or ('.',))}"
        ) from exc
    finally:
        for candidate in added:
            if candidate in sys.path:
                sys.path.remove(candidate)
    try:
        return getattr(module, attr)
    except AttributeError as exc:
        raise ManifestError(f"{where}: {module_name!r} has no attribute {attr!r}") from exc


@dataclass(frozen=True)
class ResourceSpec:
    """Where a project's resource definitions come from.

    ``overlay`` is merged over ``base`` by key, so a project can inherit a
    shared hub and override only what differs. Both are optional: a project
    that uses no resources declares neither.
    """

    base: str | None = None
    overlay: str | None = None

    def files(self, root: Path) -> list[Path]:
        """Existing resource files, base first, in merge order."""
        out = []
        for ref in (self.base, self.overlay):
            if not ref:
                continue
            path = Path(ref).expanduser()
            if not path.is_absolute():
                path = root / path
            if path.exists():
                out.append(path)
        return out


@dataclass(frozen=True)
class GraphSpec:
    """One runnable graph.

    ``entry`` points at either a ``@graph`` function — in which case every
    parameter is a runtime input port — or a plain builder function, whose
    parameters are build-time injections and must appear in ``bind``.

    ``inputs`` holds sample values so the UI has something to run with; they
    are documentation, never required for extraction.
    """

    name: str
    entry: str
    bind: Dict[str, Any] = field(default_factory=dict)
    inputs: Dict[str, Any] = field(default_factory=dict)
    src: Tuple[str, ...] = (".",)
    #: The graph object itself, when the application was declared in
    #: Python and handed it over (`Application.graphs`); `entry` is then
    #: only its name.
    obj: Any = field(default=None, compare=False, repr=False)

    def resolve(self, root: Path) -> Any:
        """Import and return the entry object."""
        if self.obj is not None:
            return self.obj
        return _import(self.entry, f"graph '{self.name}' entry", root, self.src)

    def resolve_bind(self, root: Path) -> Dict[str, Any]:
        """Import every declared injection, keyed by parameter name.

        A ``module:attr`` reference is used exactly as it is found — never
        called. A dependency may itself be a callable that the builder
        expects to receive rather than invoke, so "call it if it is
        callable" would silently inject the wrong value. Projects needing
        construction expose a module-level instance. Any other value (a
        variant's literal) is passed as it is.
        """
        return {
            param: (
                _import(ref, f"graph '{self.name}' bind.{param}", root, self.src)
                if isinstance(ref, str) and _ENTRY_RE.match(ref)
                else ref
            )
            for param, ref in self.bind.items()
        }



#: What a `[[serve]]` block may declare as its kind. Descriptive only —
#: nothing here changes how anything runs.
#: What operonx ships a transport for. A project's own transport is named
#: by `module:Class` instead and needs no entry here — see the check in
#: `Manifest.load`. `cron` and `queue` were listed here for years with
#: nothing implementing either, so a manifest naming one linted clean and
#: then failed at boot. `webhook` and `schedule` ship with operonx (its
#: triggers); without them here a project using one did not extract.
SERVE_KINDS = ("websocket", "http", "asgi", "webhook", "schedule")


@dataclass(frozen=True)
class ServeSpec:
    """What puts work into a graph.

    The IR records nodes, edges and entries, all derived from the graph
    itself. Nothing derived can say what *calls* it, so a served pipeline
    renders as if it begins from nowhere — a socket handler and a cron job
    look identical, and the environment contract cannot mention the port
    the thing actually listens on.

    This is the missing half, and it is a declaration rather than a
    discovery because the answer is not in the code: uvicorn calls an ASGI
    route, which starts a run. That hop is not an op and cannot be made
    one, so it is written down instead.

    It is no longer only descriptive. `operonx.core.manifest` reads the
    same block and boots from it, so this is now the one place a
    deployment is defined — which is why `graph` may name an entry point
    directly rather than pointing at a `[[graph]]` that exists only to
    give it a name::

        [[serve]]
        kind  = "websocket"
        path  = "/ws/call"
        graph = "pipeline.graph:ws_callbot_pipeline"

    `[[graph]]` remains for graphs nothing serves — an example, an
    experiment, a subgraph worth linting on its own.

    Attributes:
        kind: One of :data:`SERVE_KINDS`.
        graph: The name of a ``[[graph]]`` in the same manifest. Checked at
            load time, so a typo is a manifest error rather than a blank
            spot in the studio.
        path: Route or queue name. Absent for a cron.
        schedule: Cron expression. Absent for everything else.
        description: One line, for the UI.
    """

    kind: str
    graph: str
    path: str | None = None
    schedule: str | None = None
    description: str = ""
    #: `[serve.variants]` — one compiled graph per name, each binding the
    #: graph's build-time parameters. The graphs are listed as
    #: ``<graph>[<variant>]``.
    variants: Tuple[str, ...] = ()

    def as_dict(self) -> Dict[str, Any]:
        """The IR form. Optional fields are omitted rather than null."""
        out: Dict[str, Any] = {"kind": self.kind, "graph": self.graph}
        if self.path:
            out["path"] = self.path
        if self.schedule:
            out["schedule"] = self.schedule
        if self.description:
            out["description"] = self.description
        if self.variants:
            out["variants"] = list(self.variants)
        return out


@dataclass(frozen=True)
class Manifest:
    """A parsed ``operonx.toml``."""

    name: str
    root: Path
    description: str = ""
    resources: ResourceSpec = field(default_factory=ResourceSpec)
    graphs: Tuple[GraphSpec, ...] = ()
    serves: Tuple[ServeSpec, ...] = ()
    src: Tuple[str, ...] = (".",)
    #: `[project] app = "module:APP"`: the application is declared in
    #: Python; graphs and services come from that object, not this file.
    app: str | None = None

    @classmethod
    def load(cls, root: str | Path) -> "Manifest":
        """Read ``operonx.toml`` from *root*, parsed by core.

        The file is parsed by ``operonx.app.manifest`` (what ``operonx
        serve`` boots from), so the studio and production can never read
        one file two ways; this is the studio's view of the result. Nothing
        is imported: the studio process never imports a project.

        Raises:
            ManifestError: file missing, unparseable, or structurally invalid.
        """
        from operonx.app.declare import graph_refs, ref_name
        from operonx.app.manifest import Manifest as CoreManifest
        from operonx.app.manifest import ManifestError as CoreManifestError

        root = Path(root).resolve()
        path = root / MANIFEST_NAME
        if not path.exists():
            raise ManifestError(f"no {MANIFEST_NAME} in {root}")
        try:
            core = CoreManifest.from_file(path)
        except (CoreManifestError, ValueError, OSError) as exc:
            msg = str(exc)
            raise ManifestError(msg if str(path) in msg else f"{path}: {msg}") from exc
        if not core.project.get("name"):
            raise ManifestError(f"{path}: [project] name is required")
        app_ref = core.app_entry
        if not core.graphs and not core.serves and not app_ref:
            # a manifest nothing can be loaded from is still worth refusing
            raise ManifestError(
                f"{path}: nothing to load — [project] app (the Application), a [[graph]], "
                f"or a [[serve]] naming a `module:function` entry point"
            )
        src = tuple(core.src)
        graphs = []
        seen: set = set()
        for name, entry, _used_by, bind, _obj in graph_refs(core):
            if name in seen:
                raise ManifestError(f"{path}: duplicate graph name {name!r}")
            seen.add(name)
            inputs = next((dict(g.inputs) for g in core.graphs if g.name == name), {})
            graphs.append(GraphSpec(name=name, entry=entry, bind=dict(bind), inputs=inputs, src=src))
        serves = []
        for i, s in enumerate(core.serves):
            # core refuses an unknown kind only when it serves; the studio
            # says so when the file is read, so it does not draw a door
            # nothing can open
            if ":" not in s.kind and s.kind not in SERVE_KINDS:
                raise ManifestError(
                    f"{path}: [[serve]] #{i + 1}: unknown kind {s.kind!r}. known: "
                    f"{', '.join(SERVE_KINDS)}, or a `module:Class` path to a transport of your own"
                )
            if s.kind == "asgi":
                serves.append(ServeSpec(kind=s.kind, graph="", path=s.path, description=s.description))
                continue
            entry = ref_name(s.graph)
            serves.append(
                ServeSpec(
                    kind=s.kind,
                    graph=entry.rpartition(":")[2],
                    path=s.path,
                    schedule=(s.options or {}).get("schedule"),
                    description=s.description,
                    variants=tuple(str(v) for v in s.variants),
                )
            )
        return cls(
            name=core.name,
            root=root,
            description=str(core.project.get("description", "")),
            resources=ResourceSpec(overlay=core.resources_overlay),
            graphs=tuple(graphs),
            serves=tuple(serves),
            src=src,
            app=str(app_ref) if app_ref else None,
        )

    def graph(self, name: str) -> GraphSpec:
        """The :class:`GraphSpec` called *name*."""
        for g in self.graphs:
            if g.name == name:
                return g
        known = ", ".join(g.name for g in self.graphs)
        raise ManifestError(f"{self.name}: no graph {name!r} (have: {known})")
