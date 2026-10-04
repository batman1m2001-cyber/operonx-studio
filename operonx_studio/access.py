"""Who may call what: one table, closed by default (docs/TEAM_PLAN.md §2.2).

Every route the studio serves has one entry, ``(method, route path) ->
level``; one global dependency (:func:`authorize`) checks it before any
handler runs. A route missing from the table answers 403 "no access
rule", and the studio logs every unclassified route at startup, so a new
route is closed until someone decides who it is for — and
``tests/studio/test_access.py`` fails until they do.

Levels, weakest first:

    open   anyone, signed in or not (the sign-in page and its assets)
    self   anyone signed in, acting on their own things (conversations,
           their Claude sign-in, their password)
    read   viewers and up: looking, never changing shared state
    edit   editors and up: changing projects, running code, spending money
    admin  admins: people

Why a table and not a dependency per route or "GET reads, the rest
edits": a per-route dependency can be forgotten silently, and the method
rule would hand the next sensitive GET (``/api/fs`` lists the machine's
directories) to viewers. The table is also the documentation, and the
activity log reads it to decide what to record.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

__all__ = ["ACCESS", "LEVELS", "READ_POSTS", "ROLE_LEVEL", "AccessDenied", "allows", "authorize",
           "is_open_path", "level_of", "unclassified", "stale"]

LEVELS = ("open", "self", "read", "edit", "admin")
_RANK = {level: i for i, level in enumerate(LEVELS)}

#: How far each role reaches.
ROLE_LEVEL = {"viewer": "read", "editor": "edit", "admin": "admin"}

P = "/api/p/{pid}"
A = "/api/assistant"

#: The non-GET routes a viewer may call, each with why it changes nothing shared.
READ_POSTS: Dict[Tuple[str, str], str] = {
    ("POST", f"{P}/settings/retention/preview"):
        "counts what a retention policy would delete; writes nothing",
    ("POST", f"{P}/play/warm"):
        "starts the project's playground bridge ahead of use, as GET play/doors already does; runs no op",
}

ACCESS: Dict[Tuple[str, str], str] = {
    # ── the way in ──
    ("GET", "/login"): "open",
    ("POST", "/api/login"): "open",
    ("GET", "/logout"): "open",
    ("GET", "/static/{name}.css"): "open",
    ("GET", "/static/bundle/{stem}.js"): "open",

    # ── yourself ──
    ("GET", "/api/me"): "self",
    ("POST", "/api/me/password"): "self",
    ("POST", "/api/logout"): "self",

    # ── people ──
    ("GET", "/team"): "admin",
    ("GET", "/api/admin/users"): "admin",
    ("GET", "/api/admin/activity"): "admin",
    ("POST", "/api/admin/users"): "admin",
    ("PATCH", "/api/admin/users/{uid}"): "admin",
    ("POST", "/api/admin/users/{uid}/password"): "admin",
    ("DELETE", "/api/admin/users/{uid}"): "admin",

    # ── home ──
    ("GET", "/"): "read",
    ("GET", "/api/projects"): "read",
    ("GET", "/api/projects/health"): "read",
    ("POST", "/api/open"): "edit",           # the shared recents
    ("POST", "/api/forget"): "edit",
    ("POST", "/api/new"): "edit",            # a directory, first-run jobs
    ("GET", "/api/templates"): "read",
    ("GET", "/api/fs"): "edit",              # lists any directory on the machine: only the Open/New dialogs use it

    # ── one project: looking ──
    ("GET", "/p/{pid}"): "read",
    ("GET", f"{P}/ir"): "read",
    ("GET", f"{P}/stamp"): "read",
    ("GET", f"{P}/env-health"): "read",
    ("GET", f"{P}/traces"): "read",
    ("GET", f"{P}/runs"): "read",
    ("GET", f"{P}/runs/groups"): "read",
    ("GET", f"{P}/runs/origins"): "read",
    ("GET", f"{P}/media/{{sha}}"): "read",
    ("GET", f"{P}/monitor"): "read",
    ("GET", f"{P}/trace/{{run}}"): "read",
    ("GET", f"{P}/trace/{{run}}/flow"): "read",
    ("GET", f"{P}/trace/{{run}}/tree"): "read",
    ("GET", f"{P}/compare"): "read",
    ("GET", f"{P}/trace/{{run}}/timeline"): "read",
    ("GET", f"{P}/trace/{{run}}/op/{{op_name}}"): "read",
    ("GET", f"{P}/settings"): "read",
    ("GET", f"{P}/jobs"): "read",
    ("GET", f"{P}/jobs/{{name}}/runs"): "read",
    ("GET", f"{P}/jobs/{{name}}/runs/{{run_id}}"): "read",
    ("GET", f"{P}/services"): "read",
    ("GET", f"{P}/services/log"): "read",
    ("GET", f"{P}/review/queue"): "read",
    ("GET", f"{P}/review/run/{{run}}"): "read",
    ("GET", f"{P}/prompts/{{op}}/samples"): "read",
    ("GET", f"{P}/alerts"): "read",
    ("GET", f"{P}/evals"): "read",
    ("GET", f"{P}/evals/{{name}}/runs/{{run_id}}"): "read",
    ("GET", f"{P}/datasets/{{name}}"): "read",
    ("GET", f"{P}/datasets"): "read",
    ("GET", f"{P}/datasets/{{name}}/cases/{{case}}/history"): "read",
    ("GET", f"{P}/experiments"): "read",
    ("GET", f"{P}/experiments/compare"): "read",
    ("GET", f"{P}/experiments/{{eid}}"): "read",
    ("GET", f"{P}/experiments/{{eid}}/cases/{{case}}"): "read",
    ("GET", f"{P}/pulse"): "read",
    ("GET", f"{P}/play/doors"): "read",
    ("GET", f"{P}/play/events"): "read",
    ("GET", f"{P}/play/rerun-plan"): "read",
    ("GET", f"{P}/assistant/suggest"): "read",
    ("GET", f"{P}/knowledge"): "read",
    ("GET", f"{P}/kb/{{service}}/{{path:path}}"): "read",      # a knowledge base's lists, pages, chunks

    # ── one project: changing it ──
    ("POST", f"{P}/edit"): "edit",
    ("POST", f"{P}/trace/{{run}}/delete"): "edit",
    ("POST", f"{P}/resources/price"): "edit",
    ("POST", f"{P}/settings/retention"): "edit",
    ("POST", f"{P}/jobs/{{name}}/run"): "edit",
    ("POST", f"{P}/services/start"): "edit",
    ("POST", f"{P}/services/stop"): "edit",
    ("POST", f"{P}/review/run/{{run}}"): "edit",
    ("POST", f"{P}/review/run/{{run}}/dataset"): "edit",
    ("POST", f"{P}/prompts/save"): "edit",
    ("POST", f"{P}/alerts"): "edit",
    ("DELETE", f"{P}/alerts/{{name}}"): "edit",
    ("POST", f"{P}/alerts/{{name}}/test"): "edit",      # calls a webhook
    ("POST", f"{P}/alerts/check"): "edit",
    ("POST", f"{P}/datasets/{{name}}/rows"): "edit",
    ("PATCH", f"{P}/datasets/{{name}}/rows/{{case}}"): "edit",       # operonx Dataset.update: one line of the JSONL
    ("POST", f"{P}/evals/{{name}}/run"): "edit",                     # operonx eval run: runs code, writes the score store
    ("POST", f"{P}/chat/undo"): "edit",                  # git checkout / unlink of project files
    ("POST", f"{P}/play/open"): "edit",
    ("POST", f"{P}/play/simulate"): "edit",              # spends LLM money
    ("POST", f"{P}/play/send"): "edit",
    ("POST", f"{P}/play/end"): "edit",
    ("POST", f"{P}/play/rerun"): "edit",
    ("POST", f"{P}/play/restart"): "edit",
    ("POST", f"{P}/kb/{{service}}/{{path:path}}"): "edit",     # a query runs the project's code and its answer model

    # ── the assistant's hands on your own screen ──
    ("POST", f"{P}/ui/action"): "self",
    ("GET", f"{P}/ui/actions"): "self",

    # ── the assistant: your own conversations and Claude sign-in ──
    ("GET", f"{A}/sessions"): "self",
    ("POST", f"{A}/sessions"): "self",
    ("GET", f"{A}/models"): "read",
    ("POST", f"{A}/login"): "self",
    ("POST", f"{A}/login/{{lid}}/code"): "self",
    ("DELETE", f"{A}/login/{{lid}}"): "self",
    ("POST", f"{A}/logout"): "self",
    ("GET", f"{A}/account"): "self",
    ("GET", f"{A}/usage"): "self",
    ("PUT", f"{A}/defaults"): "self",
    ("GET", f"{A}/sessions/{{sid}}"): "self",
    ("PATCH", f"{A}/sessions/{{sid}}"): "self",
    ("POST", f"{A}/sessions/{{sid}}/attachments"): "self",
    ("GET", f"{A}/sessions/{{sid}}/attachments/{{aid}}"): "self",
    ("DELETE", f"{A}/sessions/{{sid}}"): "self",
    ("POST", f"{A}/sessions/{{sid}}/turns"): "self",
    ("POST", f"{A}/sessions/{{sid}}/compact"): "self",
    ("POST", f"{A}/sessions/{{sid}}/items/{{seq}}"): "self",
    ("POST", f"{A}/import"): "self",
    ("GET", f"{A}/turns/{{tid}}"): "self",
    ("GET", f"{A}/turns/{{tid}}/stream"): "self",
    ("POST", f"{A}/turns/{{tid}}/stop"): "self",

    **{key: "read" for key in READ_POSTS},
}


#: Self-level routes the activity log records anyway (§2.6): your password,
#: and your Claude sign-in and sign-out.
AUDIT_SELF = {("POST", "/api/me/password"), ("POST", "/api/assistant/login"),
              ("POST", "/api/assistant/login/{lid}/code"), ("POST", "/api/assistant/logout")}


def recorded(method: str, route: Optional[str], level: Optional[str], status: int) -> bool:
    """Whether a request goes in the activity log: every change at edit or
    admin level, the self routes above, and every refusal. Reading (a GET)
    is not a change."""
    if status == 403:
        return True
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    return level in ("edit", "admin") or (method, route or "") in AUDIT_SELF


def level_of(method: str, path: Optional[str]) -> Optional[str]:
    """The table's level for a route (HEAD is GET's); None: no rule."""
    return ACCESS.get(("GET" if method == "HEAD" else method, path or ""))


def allows(role: Optional[str], level: str) -> bool:
    if level == "open":
        return True
    reach = ROLE_LEVEL.get(role or "")
    return reach is not None and _RANK[reach] >= _RANK[level]


def is_open_path(path: str) -> bool:
    """What the sign-in wall lets through before any route is chosen: the
    ``open`` routes, and the static files they load. Kept a plain path test
    because the middleware runs before routing; test_access.py checks it
    agrees with the table for every route."""
    return path in ("/login", "/api/login", "/logout") or path == "/static" or path.startswith("/static/")


class AccessDenied(Exception):
    """Raised by :func:`authorize`; the app turns it into ``{"error": …}``."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def authorize(request: Any) -> None:
    """The global dependency: the route FastAPI chose (``scope["route"]``,
    set by ``APIRoute.matches``) against the table, for the person the
    sign-in middleware resolved (``request.state.user``)."""
    route = request.scope.get("route")
    level = level_of(request.method, getattr(route, "path", None))
    if level is None:
        raise AccessDenied(403, "no access rule")
    if level == "open":
        return
    user = getattr(request.state, "user", None)
    if user is None:
        raise AccessDenied(401, "authentication required")
    if not allows(user.get("role"), level):
        raise AccessDenied(403, "View only — ask an admin for editor access" if level == "edit"
                           else "Admins only")


def _routes(routes: Iterable[Any]) -> List[Tuple[str, str]]:
    out = []
    for route in routes:
        methods = getattr(route, "methods", None)
        if not methods or not hasattr(route, "dependant"):   # an APIRoute; the /static mount is not one
            continue
        for method in sorted(methods):
            if method != "HEAD":
                out.append((method, route.path))
    return out


def unclassified(routes: Iterable[Any]) -> List[Tuple[str, str]]:
    """Routes the table has no rule for (they answer 403)."""
    return [key for key in _routes(routes) if key not in ACCESS]


def stale(routes: Iterable[Any]) -> List[Tuple[str, str]]:
    """Table entries no route answers to."""
    served = set(_routes(routes))
    return [key for key in ACCESS if key not in served]
