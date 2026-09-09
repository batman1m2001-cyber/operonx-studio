"""Shared fixtures: keep every test hermetic.

The IR cache would otherwise write into the real ~/.operonx of whoever
runs the suite.
"""

import pytest


@pytest.fixture(autouse=True)
def _isolated_ir_cache(tmp_path_factory, monkeypatch):
    monkeypatch.setenv("OPERONX_IR_CACHE",
                       str(tmp_path_factory.mktemp("ircache")))
    # the suite tests features, not the login wall; auth has its own tests
    monkeypatch.setenv("OPERONX_STUDIO_AUTH", "off")
    # the process-wide cache singleton must not leak one test's values
    # into the next — a cached Langfuse trace serenely surviving the
    # "outage" test taught us that
    from operonx_studio.cache import studio_cache

    studio_cache(refresh=True)
