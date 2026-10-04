"""The access table (operonx_studio/access.py, docs/TEAM_PLAN.md §2.2):
every route classified, nothing stale, and each level enforced — for
every route the studio serves, not a sample of them.

Path parameters are filled from samples (``pid`` the opened project or
``x``, ``seq`` 1, the rest ``x``) and every request sends ``json={}``.
Where a handler is allowed to run, the ``x`` ids make it answer 404/400
without doing anything; no route here reaches a real Claude (the binary is
``/nonexistent``).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.routing import APIRoute

from operonx_studio.access import ACCESS, READ_POSTS, is_open_path, level_of, stale, unclassified
from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit

SAMPLES = {"seq": "1", "name": "x", "stem": "login"}


def _routes(app):
    out = []
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods - {"HEAD"}):
                out.append((method, route.path))
    return out


def _url(path: str, pid: str) -> str:
    def fill(m):
        key = m.group(1)
        if key == "pid":
            return pid
        return SAMPLES.get(key, "x")
    url = re.sub(r"\{(\w+)\}", fill, path)
    return url.replace("/static/x.css", "/static/studio.css")


def _call(client, method: str, url: str, tmp_path: Path):
    params = {"path": str(tmp_path)} if url == "/api/fs" else None
    kw = {"params": params, "follow_redirects": False}
    if method in ("POST", "PUT", "PATCH"):
        return client.request(method, url, json={}, **kw)
    return client.request(method, url, **kw)


@pytest.fixture()
def app(tmp_path, auth_on):
    return build_studio_app(Recents(state_file=tmp_path / "state" / "studio.json"))


# ── the table itself ─────────────────────────────────────────────────────

def test_every_route_is_classified_and_nothing_is_stale(app):
    assert unclassified(app.routes) == []
    assert stale(app.routes) == []
    assert sorted(ACCESS) == sorted(_routes(app))
    # the only other route is the static mount, which the wall lets through
    others = [r for r in app.routes if not isinstance(r, APIRoute)]
    assert [getattr(r, "path", None) for r in others] == ["/static"]


def test_only_read_level_non_gets_are_in_read_posts(app):
    read_non_get = {(m, p) for (m, p) in _routes(app) if m != "GET" and ACCESS[(m, p)] == "read"}
    assert read_non_get == set(READ_POSTS)
    assert all(len(why) > 20 for why in READ_POSTS.values())
    assert all(level in ("open", "self", "read", "edit", "admin") for level in ACCESS.values())


def test_the_wall_lets_through_exactly_the_open_routes(app):
    for method, path in _routes(app):
        assert is_open_path(_url(path, "x")) == (ACCESS[(method, path)] == "open"), (method, path)


def test_the_sensitive_gets_are_not_read():
    assert level_of("GET", "/api/fs") == "edit"
    assert level_of("HEAD", "/api/projects") == "read"             # HEAD is GET's
    assert level_of("GET", "/api/nope") is None


def test_an_unclassified_route_answers_403_and_is_logged(tmp_path, auth_on, monkeypatch, caplog):
    from operonx_studio import access

    monkeypatch.delitem(access.ACCESS, ("GET", "/api/templates"))
    with caplog.at_level("WARNING"):
        app = build_studio_app(Recents(state_file=tmp_path / "s" / "studio.json"))
    assert "GET /api/templates has no access rule" in caplog.text
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        c.post("/api/login", json={"username": "root", "password": "admin-pass-1"})
        res = c.get("/api/templates")
        assert res.status_code == 403 and res.json() == {"error": "no access rule"}


# ── enforcement, route by route ──────────────────────────────────────────

@pytest.fixture()
def people(team, tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "operonx.toml").write_text('[project]\nname = "p"\n', encoding="utf-8")
    team.use(team.admin_token)
    pid = team.client.post("/api/open", json={"path": str(proj)}).json()["id"]
    return {"team": team, "pid": pid, "editor": team.person("ed", "editor"),
            "viewer": team.person("vi", "viewer"), "tmp": tmp_path}


def _by_level(team, *levels):
    return [(m, p) for (m, p) in _routes(team.client.app) if ACCESS[(m, p)] in levels
            and (m, p) != ("POST", "/api/logout")]                  # it would end the session mid-sweep


def test_anonymous_gets_401_or_the_login_page_everywhere_but_open(people):
    team = people["team"]
    team.use(None)
    for method, path in _routes(team.client.app):
        res = _call(team.client, method, _url(path, people["pid"]), people["tmp"])
        if ACCESS[(method, path)] == "open":
            # the handler answered (sign-in with {} is a wrong password), not the wall
            assert res.status_code != 403 and "authentication required" not in res.text, (method, path)
        elif path.startswith("/api/"):
            assert res.status_code == 401, (method, path, res.status_code)
        else:
            assert res.status_code == 302 and res.headers["location"] == "/login", (method, path)


def test_admin_routes_refuse_editors_and_viewers(people):
    team = people["team"]
    admin_routes = _by_level(team, "admin")
    assert len(admin_routes) == 7                       # /team, the five /api/admin/users routes, the activity log
    for who in ("editor", "viewer"):
        team.use(people[who]["token"])
        for method, path in admin_routes:
            res = _call(team.client, method, _url(path, people["pid"]), people["tmp"])
            if path.startswith("/api/"):
                assert res.status_code == 403 and res.json() == {"error": "Admins only"}, (who, method, path)
            else:                                                    # a page sends them home instead
                assert res.status_code == 302 and res.headers["location"] == "/", (who, method, path)
    team.use(team.admin_token)
    for method, path in admin_routes:
        res = _call(team.client, method, _url(path, "x"), people["tmp"])
        assert res.status_code not in (401, 403), (method, path, res.status_code)


def test_edit_routes_refuse_viewers_before_the_handler_runs(people):
    team = people["team"]
    edit_routes = _by_level(team, "edit")
    assert len(edit_routes) == 28   # + PATCH a dataset case, POST run an eval (E6)
    team.use(people["viewer"]["token"])
    # the real project id: a handler that ran would act on it
    for method, path in edit_routes:
        res = _call(team.client, method, _url(path, people["pid"]), people["tmp"])
        assert res.status_code == 403 and "View only" in res.json()["error"], (method, path, res.status_code)
    team.use(team.admin_token)
    assert [p["id"] for p in team.client.get("/api/projects").json()["projects"]] == [people["pid"]]   # not forgotten


def test_editors_pass_edit_routes_and_everyone_passes_read_and_self(people):
    team = people["team"]
    team.use(people["editor"]["token"])
    for method, path in _by_level(team, "edit", "read", "self"):
        if (method, path) == ("POST", "/api/forget"):
            continue                                                 # {} forgets nothing, but keep the sweep pure
        res = _call(team.client, method, _url(path, "x"), people["tmp"])
        assert res.status_code not in (401, 403), (method, path, res.status_code)
    team.use(people["viewer"]["token"])
    for method, path in _by_level(team, "read", "self"):
        res = _call(team.client, method, _url(path, "x"), people["tmp"])
        assert res.status_code not in (401, 403), (method, path, res.status_code)


# ── P5: a viewer is refused before anything happens ──────────────────────

def test_a_viewer_is_refused_before_the_handler_runs_and_an_editor_is_not(people):
    from operonx.telemetry.runs.files import FilesRunStore
    from test_runs import _trace

    team, pid, tmp = people["team"], people["pid"], people["tmp"]
    c = team.client
    proj = tmp / "proj"
    FilesRunStore(root=proj / ".operonx" / "runs", refresh_every=0).consume(_trace("r-keep", origin="service", service="s"))
    toml = (proj / "operonx.toml").read_text()
    parent = tmp / "newhome"
    parent.mkdir()
    runs = lambda: [r["run"] for r in c.get(f"/api/p/{pid}/runs").json()["runs"]]
    team.use(people["viewer"]["token"])
    assert runs() == ["r-keep"]                                        # a viewer reads
    for method, url, body in (
        ("POST", "/api/new", {"path": str(parent), "name": "made-by-viewer"}),
        ("POST", f"/api/p/{pid}/trace/r-keep/delete", {}),
        ("POST", f"/api/p/{pid}/settings/retention", {"retention": {"service": 1}}),
    ):
        res = c.request(method, url, json=body)
        assert res.status_code == 403 and "View only" in res.json()["error"], url
    assert not (parent / "made-by-viewer").exists()                     # no directory
    assert runs() == ["r-keep"]                                         # the run survives
    assert (proj / "operonx.toml").read_text() == toml                  # retention unchanged
    team.use(people["editor"]["token"])
    assert c.post("/api/new", json={"path": str(parent), "name": "made-by-editor"}).status_code == 200
    assert (parent / "made-by-editor" / "operonx.toml").is_file()
    assert c.post(f"/api/p/{pid}/settings/retention", json={"retention": {"service": 1}}).status_code == 200
    assert c.post(f"/api/p/{pid}/trace/r-keep/delete", json={}).status_code == 200
    assert runs() == []


def test_the_page_and_the_pulse_carry_the_role(people):
    team, pid = people["team"], people["pid"]
    c = team.client
    team.use(people["viewer"]["token"])
    assert '<body data-tab="flow" data-role="viewer"' in c.get(f"/p/{pid}").text
    assert '<body class="page" data-role="viewer"' in c.get("/").text
    assert c.get(f"/api/p/{pid}/pulse", params={"hold": 0}).json()["role"] == "viewer"
    team.use(people["editor"]["token"])
    assert c.get(f"/api/p/{pid}/pulse", params={"hold": 0}).json()["role"] == "editor"
