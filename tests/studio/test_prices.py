"""Prices on LLM resources, edited as text — P4.

Gates: a field that exists is replaced in place (its trailing comment
kept), a missing one is added at the end of its block, every other line
is untouched, a declared 0 stays the integer 0, tiny per-token prices
never turn into e-notation YAML would read as a string, the endpoint
shows the diff before it writes, and after writing the store reads the
new price back through operonx.
"""

from __future__ import annotations

import pytest
import yaml

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient

from operonx_studio.app import _per_token, build_studio_app
from operonx_studio.registry import Recents
from operonx_studio.yamledit import YamlEditError, set_fields, yaml_scalar

pytestmark = pytest.mark.unit

RESOURCES = """# LLMs this project calls.
llm:
  # our own gateway
  inhouse:
    api_type: openai
    model: ${LLM_MODEL:gemma}  # moves per environment
    cost_per_input_token: 0.5  # old

  remote:
    api_type: openai

agent:
  a:
    prompts: p.yaml
"""


def test_replace_in_place_add_missing_and_touch_nothing_else():
    out = set_fields(RESOURCES, "llm", "inhouse", {"cost_per_input_token": 0, "cost_per_output_token": 0})
    lines = out.splitlines()
    assert "    cost_per_input_token: 0  # old" in lines          # replaced, comment kept
    assert lines.index("    cost_per_output_token: 0") == lines.index("    cost_per_input_token: 0  # old") + 1
    assert out.count("\n") == RESOURCES.count("\n") + 1          # one line added, none lost
    for original in RESOURCES.splitlines():
        if "cost_per_input_token" not in original:
            assert original in lines
    data = yaml.safe_load(out)
    assert data["llm"]["inhouse"]["cost_per_input_token"] == 0 and data["llm"]["remote"] == {"api_type": "openai"}


def test_a_field_lands_in_the_right_block():
    out = set_fields(RESOURCES, "llm", "remote", {"cost_per_input_token": 0.000002})
    data = yaml.safe_load(out)
    assert data["llm"]["remote"]["cost_per_input_token"] == pytest.approx(0.000002)
    assert "cost_per_output_token" not in data["llm"]["inhouse"]
    assert data["agent"] == {"a": {"prompts": "p.yaml"}}


def test_missing_blocks_and_bad_names_are_refused():
    with pytest.raises(YamlEditError, match="no `ghost:` entry"):
        set_fields(RESOURCES, "llm", "ghost", {"x": 1})
    with pytest.raises(YamlEditError, match="no `tts:` block"):
        set_fields(RESOURCES, "tts", "a", {"x": 1})
    with pytest.raises(YamlEditError):
        set_fields(RESOURCES, "llm", "inhouse", {"bad key": 1})


@pytest.mark.parametrize("per_million, expected", [(0, 0), (2.0, 2e-06), (0.15, 1.5e-07), (15, 1.5e-05)])
def test_prices_are_per_token_numbers_yaml_reads_back(per_million, expected):
    value = _per_token(per_million)
    assert value == pytest.approx(expected) and type(value) is (int if per_million == 0 else float)
    text = yaml_scalar(value)
    assert "e" not in text.lower()  # PyYAML reads "2e-06" as a STRING
    assert yaml.safe_load(f"x: {text}")["x"] == pytest.approx(expected)


def test_the_endpoint_previews_then_writes(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "operonx.toml").write_text('[project]\nname = "p"\n', encoding="utf-8")
    (root / "resources.yaml").write_text(RESOURCES, encoding="utf-8")
    client = TestClient(build_studio_app(Recents(state_file=tmp_path / "s.json")))
    pid = client.post("/api/open", json={"path": str(root)}).json()["id"]

    preview = client.post(f"/api/p/{pid}/resources/price",
                          json={"resource": "remote", "input_per_1m": 2, "output_per_1m": 8}).json()
    assert preview["changed"] and not preview["applied"]
    assert "+    cost_per_input_token: 0.000002" in preview["diff"]
    assert (root / "resources.yaml").read_text() == RESOURCES  # nothing written yet

    done = client.post(f"/api/p/{pid}/resources/price",
                       json={"resource": "remote", "input_per_1m": 2, "output_per_1m": 8, "apply": True}).json()
    assert done["applied"]
    data = yaml.safe_load((root / "resources.yaml").read_text())
    assert data["llm"]["remote"]["cost_per_output_token"] == pytest.approx(8e-06)

    assert client.post(f"/api/p/{pid}/resources/price",
                       json={"resource": "remote", "input_per_1m": -1, "output_per_1m": 1}).status_code == 400
    assert client.post(f"/api/p/{pid}/resources/price",
                       json={"resource": "ghost", "input_per_1m": 1, "output_per_1m": 1}).status_code == 400


def test_a_saved_price_prices_the_next_call(tmp_path):
    """End to end through operonx: the LLM config reads the edited file."""
    from operonx.providers.llms.config import LLMConfig

    out = set_fields(RESOURCES, "llm", "remote", {"cost_per_input_token": _per_token(2),
                                                  "cost_per_output_token": _per_token(8)})
    block = yaml.safe_load(out)["llm"]["remote"]
    cfg = LLMConfig.model_validate({**block, "model": "m", "api_key": "k"})
    assert cfg.cost_per_input_token == pytest.approx(2e-06) and cfg.cost_per_output_token == pytest.approx(8e-06)
