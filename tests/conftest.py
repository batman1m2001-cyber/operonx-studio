"""Shared fixtures: keep every test hermetic.

The IR cache would otherwise write into the real ~/.operonx of whoever
runs the suite.
"""

import pytest


@pytest.fixture(autouse=True)
def _isolated_ir_cache(tmp_path_factory, monkeypatch):
    monkeypatch.setenv("OPERONX_IR_CACHE",
                       str(tmp_path_factory.mktemp("ircache")))
