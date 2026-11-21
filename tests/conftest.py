"""Shared fixtures: keep every test hermetic.

The IR cache would otherwise write into the real ~/.operonx of whoever
runs the suite.
"""

import pytest


@pytest.fixture(autouse=True)
def _isolated_ir_cache(tmp_path_factory, monkeypatch):
    monkeypatch.setenv("OPERONX_IR_CACHE",
                       str(tmp_path_factory.mktemp("ircache")))
    # the studio's own state (accounts, conversations, the Claude sign-in
    # directory) lives here, never in the real ~/.operonx
    monkeypatch.setenv("OPERONX_STUDIO_STATE_DIR",
                       str(tmp_path_factory.mktemp("state")))
    # the suite tests features, not the login wall; auth has its own tests
    monkeypatch.setenv("OPERONX_STUDIO_AUTH", "off")
    # the process-wide cache singleton must not leak one test's values
    # into the next — a cached Langfuse trace serenely surviving the
    # "outage" test taught us that
    from operonx_studio.cache import studio_cache

    studio_cache(refresh=True)


@pytest.fixture(autouse=True)
def _every_look_at_the_files_is_fresh(monkeypatch):
    """A test edits a file and asks at once whether it changed; the studio
    lets one look answer a burst of requests (ProjectWatcher.CHECK_EVERY).
    tests/studio/test_daemon.py turns the burst back on to test it."""
    from operonx_studio.daemon import ProjectWatcher

    monkeypatch.setattr(ProjectWatcher, "CHECK_EVERY", 0.0)
