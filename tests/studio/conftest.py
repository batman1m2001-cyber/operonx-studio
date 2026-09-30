"""Helpers for the team tests (test_auth, test_users, test_access).

The suite runs with auth off (tests/conftest.py); these turn it on. Several
people share ONE ``TestClient`` and switch ``client.cookies`` — a turn is an
asyncio task on that client's loop, so a second client would break it
(docs/TEAM_PLAN.md §5).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import pytest

ADMIN_PASS = "admin-pass-1"


class Team:
    """One studio with auth on; the first admin is ``root`` / ``ADMIN_PASS``."""

    def __init__(self, client: Any, state: Path):
        self.client = client
        self.state = state
        self.admin_token = self.signin("root", ADMIN_PASS)

    def signin(self, username: str, password: str) -> str:
        """Signs in and returns the cookie; the client keeps it."""
        self.client.cookies.clear()
        res = self.client.post("/api/login", json={"username": username, "password": password})
        assert res.status_code == 200, res.text
        return res.cookies["oxsession"]

    def use(self, token: str | None) -> None:
        self.client.cookies.clear()
        if token:
            self.client.cookies.set("oxsession", token)

    def person(self, username: str, role: str, password: str | None = None) -> Dict[str, Any]:
        """Someone added through the admin API, who has chosen *password*
        (default ``<username>-pass-1``); returns {id, token, password}."""
        self.use(self.admin_token)
        res = self.client.post("/api/admin/users", json={"username": username, "name": username.title(),
                                                         "role": role})
        assert res.status_code == 200, res.text
        uid, temp = res.json()["user"]["id"], res.json()["password"]
        token = self.signin(username, temp)
        password = password or f"{username}-pass-1"
        res = self.client.post("/api/me/password", json={"new": password})
        assert res.status_code == 200, res.text
        self.use(self.admin_token)
        return {"id": uid, "token": token, "password": password}


@pytest.fixture()
def auth_on(monkeypatch):
    monkeypatch.delenv("OPERONX_STUDIO_AUTH", raising=False)
    monkeypatch.setenv("OPERONX_STUDIO_USER", "root")
    monkeypatch.setenv("OPERONX_STUDIO_PASS", ADMIN_PASS)
    # never the host's real claude: no binary at all unless a test brings a fake
    monkeypatch.setenv("OPERONX_STUDIO_CLAUDE_BIN", "/nonexistent/claude")


@pytest.fixture()
def team(tmp_path: Path, auth_on):
    from fastapi.testclient import TestClient

    from operonx_studio.app import build_studio_app
    from operonx_studio.registry import Recents

    state = tmp_path / "state"
    with TestClient(build_studio_app(Recents(state_file=state / "studio.json"))) as client:
        yield Team(client, state)
