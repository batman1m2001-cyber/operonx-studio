"""The dark theme: each light colour's dark twin (operonx_studio/theme.py),
the generated overrides' place in the cascade, and the served stylesheet."""

from __future__ import annotations

import math
import re

import pytest

from operonx_studio.theme import _parse, _to_oklab, to_dark, with_dark


def _lab(text):
    r, g, b, alpha = _parse(text)
    L, a, bb = _to_oklab(r, g, b)
    return L, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360, alpha


def _contrast(x, y):
    def lum(text):
        r, g, b, _ = _parse(text)
        lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (r, g, b)]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    hi, lo = sorted((lum(x), lum(y)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def test_neutrals_flip_their_lightness():
    page = to_dark("#ffffff", "background")
    ink = to_dark("#1f1b13", "color")
    assert _lab(page)[0] < 0.25 and _lab(ink)[0] > 0.75
    # the order holds: what was lighter in the light is darker in the dark
    assert _lab(to_dark("#f7f8fa", "background"))[0] > _lab(page)[0]
    assert _contrast(ink, page) > 7


def test_colours_made_for_a_dark_place_stay():
    assert to_dark("#1f2328", "background") == "#1f2328"   # a code block
    assert to_dark("#e6edf3", "color") == "#e6edf3"        # the ink on it


@pytest.mark.parametrize("wash", ["#e8f0fb", "#fdf3dd", "#fbe9ec", "#e7f5ee"])
def test_a_pale_wash_becomes_a_dark_wash_of_its_hue(wash):
    light = _lab(wash)
    dark = _lab(to_dark(wash, "background"))
    assert dark[0] < 0.4
    assert abs((dark[2] - light[2] + 180) % 360 - 180) < 6       # hue kept (8-bit rounding at C 0.01)


def test_a_strong_hue_is_lit_to_read_on_dark():
    L, C, h, _ = _lab(to_dark("#2f6fd0", "color"))
    assert L >= 0.72 and C > 0.1 and abs(h - _lab("#2f6fd0")[2]) < 3
    assert _contrast(to_dark("#2f6fd0", "color"), "#161a20") > 4.5


def test_a_mid_light_fill_inverts_so_its_hover_still_steps_out():
    rest, hover = to_dark("#c9d8ea", "background"), to_dark("#9db8d8", "background")
    assert _lab(hover)[0] > _lab(rest)[0]


def test_shadows_stay_dark_and_glows_keep_their_colour():
    assert to_dark("rgba(20, 20, 20, .12)", "box-shadow").startswith("rgba(0, 0, 0,")
    glow = "rgba(217, 165, 38, .36)"
    assert to_dark(glow, "box-shadow") == glow


def test_transparency_is_kept():
    assert to_dark("rgba(255, 255, 255, .55)", "background").endswith(", 0.55)")


def test_what_is_not_a_colour_passes_through():
    assert to_dark("rgba(nonsense)", "color") == "rgba(nonsense)"


DARK = ':where(:root[data-theme="dark"]) '


def test_each_twin_follows_its_rule_so_later_rules_still_win():
    css = ".a { color: #1f1b13; padding: 4px }\n.a.on { color: var(--accent) }\n.b .c { background: #ffffff }"
    out = with_dark(css)
    assert out.index(".a { color") < out.index(DARK + ".a{color:") < out.index(".a.on {") < out.index(DARK + ".b .c{")
    assert "padding:" not in out[out.index(DARK):out.index(".a.on")]
    assert DARK + ".a.on" not in out          # nothing to change: the rule itself serves


def test_the_stylesheet_is_kept_as_written():
    css = "/* a { note } */\n.a {\n  color: #333; /* why */\n}\n"
    out = with_dark(css)
    assert out.startswith(css.rstrip("\n"))
    assert "/* a { note } */" in out and "/* why */" in out


def test_tokens_keyframes_and_masks_are_left_to_the_hand_tuned_part():
    css = (":root { --surface: #ffffff; } @keyframes k { from { color: #000 } }"
           ".m { mask: linear-gradient(#000, transparent); color: #333 }")
    out = with_dark(css)
    twins = out[len(css):]
    assert "--surface" not in twins and "@keyframes" not in twins and "mask" not in twins
    assert DARK + ".m{color:" in twins


@pytest.mark.parametrize("at", ["@media (max-width: 700px)", "@supports (display: grid)", "@container (max-width: 400px)"])
def test_nested_rules_get_their_twins_inside_the_same_block(at):
    out = with_dark(at + " { .a { color: #333333 } }")
    assert out.startswith(at + " { .a { color: #333333 }\n" + DARK + ".a{color:")
    assert out.endswith("}")


def test_an_inline_svgs_ink_turns_light_and_the_data_uri_stays_whole():
    css = (".chev::after { background: url(\"data:image/svg+xml,%3Csvg stroke='%231f1b13'%3E%3C/svg%3E\")"
           " no-repeat center / contain; }")
    twin = with_dark(css)[len(css):]
    stroke = re.search(r"stroke='%23([0-9a-f]{6})'", twin).group(1)
    assert _lab("#" + stroke)[0] > 0.7
    url = re.search(r'url\("[^"]*"\)', twin).group(0)
    assert "#" not in url


def test_braces_in_strings_and_comments_do_not_end_a_rule():
    css = '.q::before { content: "}"; color: #333 } /* } */ .r { color: #444 }'
    out = with_dark(css)
    assert DARK + ".q::before{color:" in out and DARK + ".r{color:" in out


@pytest.fixture()
def served_css(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from operonx_studio.app import build_studio_app
    from operonx_studio.registry import Recents

    monkeypatch.setenv("OPERONX_STUDIO_MINIFY", "off")
    with TestClient(build_studio_app(Recents(state_file=tmp_path / "studio.json"))) as c:
        yield c.get("/static/studio.css").text


def test_the_stylesheet_carries_both_themes_hand_tuned_last(served_css):
    twin = served_css.index(DARK + ".crumbbtn::after")
    assert served_css.index(".crumbbtn::after {") < twin < served_css.index("--k-func: #318aff;")
