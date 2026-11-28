"""The studio's brand colour as one setting (operonx_studio/palette.py)."""

import colorsys
import json

import pytest

from operonx_studio import palette

GOLD = ("golden", 42.0, 0.95)


@pytest.fixture(autouse=True)
def state(tmp_path, monkeypatch):
    monkeypatch.setenv("OPERONX_STUDIO_STATE_DIR", str(tmp_path))
    return tmp_path


def _hue(hexed):
    r, g, b = (int(hexed[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return colorsys.rgb_to_hls(r, g, b)[0] * 360


def test_with_no_theme_nothing_is_changed(state):
    text = "a{color:#a78bfa;background:rgba(167, 139, 250, .17)}"
    assert palette.active() is None and palette.stamp() == ""
    assert palette.recolor(text, palette.active()) is text
    palette.use({"preset": "lavender"})                       # the studio as drawn is no theme
    assert palette.active() is None
    assert palette.picture("backdrop-dark.webp") == palette.STATIC / "backdrop-dark.webp"


def test_lavender_turns_and_what_means_something_stays():
    out = palette.recolor("a{color:#a78bfa;b:#7C3AED;c:#a78bfa80}", GOLD)
    turned = out[out.index("#"):out.index("#") + 7]
    assert 30 < _hue(turned) < 55
    assert "#a78bfa" not in out and out.endswith("80}")       # the alpha of an eight-digit colour is kept
    assert out[out.index("b:") + 2:out.index("b:") + 9].isupper() is True     # written in capitals, kept so
    for kept in ("#12733f", "#c93a30", "#98540b", "#1f6fe0", "#888888", "#ffffff", "#0f1419"):   # ok, error, warning, signal, greys
        assert palette.recolor(kept, GOLD) == kept


def test_rgb_forms_keep_their_shape_and_their_alpha():
    assert palette.recolor("rgba(167, 139, 250, .17)", GOLD).endswith(", .17)")
    assert palette.recolor("rgba(170,160,255,${a})", GOLD).endswith(",${a})")      # a script's template
    assert palette.recolor("rgb(167 139 250 / 50%)", GOLD).endswith(" / 50%)")
    bare = palette.recolor('const C = ["158,154,240", "255,90,79"], v = [1, 2, 4];', GOLD)     # the Factory's own form
    assert '"158,154,240"' not in bare and '"255,90,79"' in bare and "[1, 2, 4]" in bare
    assert palette.recolor('url("data:image/svg+xml,%23a78bfa")', GOLD) != 'url("data:image/svg+xml,%23a78bfa")'
    assert palette.recolor("#add #fab $('#decade') rgba(18, 115, 63, .5)", GOLD) == "#add #fab $('#decade') rgba(18, 115, 63, .5)"


def test_the_setting_names_a_preset_or_a_hue_of_its_own(state):
    palette.use({"preset": "golden"})
    assert palette.active() == ("golden", 42.0, 0.95) and "golden" in palette.stamp()
    palette.use({"hue": 160, "sat": 0.8})
    assert palette.active() == ("custom", 160.0, 0.8)
    palette.use({"preset": "no-such"})
    assert palette.active() is None
    (state / "theme.json").write_text("not json")
    assert palette.active() is None
    for name, spec in palette.presets().items():
        assert name == "lavender" or 0 <= spec["hue"] < 360


def test_a_drawn_picture_is_served_for_its_theme_only(state):
    palette.use({"preset": "golden"})
    drawn = state / "theme" / "golden" / "backdrop-dark.webp"
    assert palette.picture("backdrop-dark.webp") == palette.STATIC / "backdrop-dark.webp"   # not drawn yet
    drawn.parent.mkdir(parents=True)
    drawn.write_bytes(b"x")
    assert palette.picture("backdrop-dark.webp") == drawn
    palette.use({"preset": "blue"})
    assert palette.picture("backdrop-dark.webp") == palette.STATIC / "backdrop-dark.webp"


def test_the_command_sets_and_reports(state, capsys):
    assert palette.main([]) == 0 and "lavender (as drawn)" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        palette.main(["no-such"])
    palette.main(["lavender"])
    assert json.loads((state / "theme.json").read_text()) == {}
