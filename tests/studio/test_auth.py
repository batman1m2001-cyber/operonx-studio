"""The login wall: on by default, configurable, honest failures.

The studio rides a public tunnel; the filesystem browser and the param
editor must sit behind SOMETHING. The suite at large runs with auth off
(conftest); these tests turn it back on deliberately.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import build_studio_app
from operonx_studio.registry import Recents

pytestmark = pytest.mark.unit


@pytest.fixture()
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.delenv("OPERONX_STUDIO_AUTH", raising=False)
    recents = Recents(state_file=tmp_path / "studio.json")
    return TestClient(build_studio_app(recents))


def test_pages_redirect_and_apis_401_when_signed_out(client):
    page = client.get("/", follow_redirects=False)
    assert page.status_code == 302 and page.headers["location"] == "/login"
    api = client.get("/api/projects")
    assert api.status_code == 401


def test_login_page_and_static_stay_open(client):
    assert client.get("/login").status_code == 200
    assert client.get("/static/studio.css").status_code == 200


def test_default_credentials_sign_in_and_stick(client):
    bad = client.post("/api/login", json={"username": "root", "password": "wrong"})
    assert bad.status_code == 401
    good = client.post("/api/login", json={"username": "root", "password": "123"})
    assert good.status_code == 200 and "oxsession" in good.cookies
    assert client.get("/api/projects").status_code == 200  # cookie persists


def test_credentials_come_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.delenv("OPERONX_STUDIO_AUTH", raising=False)
    monkeypatch.setenv("OPERONX_STUDIO_USER", "thang")
    monkeypatch.setenv("OPERONX_STUDIO_PASS", "s3cret")
    client = TestClient(build_studio_app(Recents(state_file=tmp_path / "s.json")))
    assert client.post("/api/login",
                       json={"username": "root", "password": "123"}).status_code == 401
    assert client.post("/api/login",
                       json={"username": "thang", "password": "s3cret"}).status_code == 200
    assert client.get("/api/projects").status_code == 200


def test_logout_slams_the_door(client):
    client.post("/api/login", json={"username": "root", "password": "123"})
    assert client.get("/api/projects").status_code == 200
    client.get("/logout", follow_redirects=False)
    assert client.get("/api/projects").status_code == 401


def test_sessions_survive_a_restart_with_same_credentials(tmp_path, monkeypatch):
    """The cookie is derived from the credentials, not from boot-time
    randomness — a redeploy must not log everyone out."""
    monkeypatch.delenv("OPERONX_STUDIO_AUTH", raising=False)
    first = TestClient(build_studio_app(Recents(state_file=tmp_path / "a.json")))
    login = first.post("/api/login", json={"username": "root", "password": "123"})
    token = login.cookies["oxsession"]

    second = TestClient(build_studio_app(Recents(state_file=tmp_path / "b.json")))
    second.cookies.set("oxsession", token)
    assert second.get("/api/projects").status_code == 200
