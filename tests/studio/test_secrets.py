"""PROJECT_SOURCE_PLAN S1: a project's secrets are kept outside the project."""

import os
import stat

import pytest

from operonx_studio import secrets
from operonx_studio.registry import project_id


@pytest.fixture
def proj(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_STATE_DIR", str(tmp_path / "state"))
    root = tmp_path / "proj"
    root.mkdir()
    (root / "operonx.toml").write_text("[project]\nname = 'p'\n")
    return root


def _kept(root, name):
    return root.parent / "state" / "secrets" / project_id(root) / f"{name}.env"


def test_the_env_is_copied_out_and_comes_back_when_the_project_loses_it(proj):
    (proj / ".env").write_text("LLM_API_KEY=abc\n")
    secrets.sync(proj)
    kept = _kept(proj, "dev")
    assert kept.read_text() == "LLM_API_KEY=abc\n"
    assert stat.S_IMODE(os.stat(kept).st_mode) == 0o600
    (proj / ".env").unlink()                      # the clone was deleted and made again
    secrets.sync(proj)
    assert (proj / ".env").read_text() == "LLM_API_KEY=abc\n"
    assert stat.S_IMODE(os.stat(proj / ".env").st_mode) == 0o600


def test_a_hand_edit_of_the_env_wins_over_the_copy(proj):
    (proj / ".env").write_text("A=1\n")
    secrets.sync(proj)
    (proj / ".env").write_text("A=2\n")
    secrets.sync(proj)
    assert _kept(proj, "dev").read_text() == "A=2\n"


def test_switching_environment_saves_the_old_one_and_loads_the_new(proj):
    (proj / ".env").write_text("A=dev\n")
    secrets.add(proj, "staging")
    secrets.use(proj, "staging")
    assert (proj / ".env").read_text() == "" and secrets.current(project_id(proj)) == "staging"
    (proj / ".env").write_text("A=staging\n")
    secrets.use(proj, "dev")
    assert (proj / ".env").read_text() == "A=dev\n"
    assert _kept(proj, "staging").read_text() == "A=staging\n"
    assert secrets.environments(project_id(proj)) == ["dev", "staging"]


def test_bad_and_unknown_names_are_refused(proj):
    for bad in ("", "../x", "Prod", "a b"):
        with pytest.raises(ValueError):
            secrets.add(proj, bad)
    with pytest.raises(ValueError):
        secrets.use(proj, "nope")
    secrets.add(proj, "prod")
    with pytest.raises(ValueError):
        secrets.add(proj, "prod")


def test_describe_gives_names_and_never_a_value(proj):
    (proj / ".env").write_text("LLM_API_KEY=very-secret\n")
    (proj / ".env.example").write_text("LLM_API_KEY=\nSTT_API_KEY=\n")
    out = secrets.describe(proj)
    assert out == {"current": "dev", "environments": [{"name": "dev", "names": ["LLM_API_KEY"]}],
                   "example": ["LLM_API_KEY", "STT_API_KEY"]}
    assert "very-secret" not in repr(out)
