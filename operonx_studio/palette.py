"""The studio's brand colour, as one setting.

The studio is drawn in lavender: a few tokens, ~120 colours written in
place in the stylesheets and the canvas code, and the pictures behind the
glass. A theme preset moves all of them to another hue at once, without
touching a file of the studio: every colour that is lavender (its hue in
the brand's band) is turned to the preset's hue as the stylesheets and the
scripts are served, lightness kept, and the pictures are drawn again once
(``python -m operonx_studio.palette <preset>``) into the studio's state.

    operonx_studio/themes.json     the presets: name -> {"hue": 0-360, "sat": factor}
    <state>/theme.json             which one this studio uses: {"preset": "golden"},
                                   or a hue of its own: {"hue": 160, "sat": 0.8}
    <state>/theme/<name>/          the pictures, drawn for that preset

What is not lavender is left alone: greys, and the colours that mean
something (ok green, warning amber, error red, the kinds of op).
"""

from __future__ import annotations

import colorsys
import json
import re
from pathlib import Path
from typing import Dict, Optional, Tuple

from .registry import state_dir

__all__ = ["BAND", "active", "picture", "presets", "recolor", "render", "stamp", "use"]

#: The brand's hues, in degrees: from the bluish violet of the glows to the pinkish one of a loop's edge.
BAND = (226.0, 295.0)
#: The brand's own hue; a preset keeps a part of each colour's distance to it, so a glow still has depth.
HOME, SPREAD = 262.0, 0.5
STATIC = Path(__file__).parent / "static"

_HEX = re.compile(r"(#|%23)([0-9a-fA-F]{6})([0-9a-fA-F]{2})?(?![0-9a-fA-F])")
_RGB = re.compile(r"(rgba?\(\s*)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(?=\s*[,/)$])")


# the canvas code keeps some colours as bare "r,g,b" strings, for rgba(${c},a)
_BARE = re.compile(r"""(["'`])(\d{1,3})(\s*,\s*)(\d{1,3})(\s*,\s*)(\d{1,3})\1""")


def presets() -> Dict[str, Dict]:
    return json.loads((Path(__file__).parent / "themes.json").read_text(encoding="utf-8"))


def _setting() -> Dict:
    try:
        got = json.loads((state_dir() / "theme.json").read_text(encoding="utf-8"))
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def active() -> Optional[Tuple[str, float, float]]:
    """``(name, hue, sat)`` of the theme this studio uses, or ``None`` for
    the studio as it is drawn."""
    setting = _setting()
    name = str(setting.get("preset") or ("custom" if "hue" in setting else ""))
    spec = presets().get(name, {}) if "hue" not in setting else setting
    if "hue" not in spec:
        return None
    return name, float(spec["hue"]) % 360, max(0.0, float(spec.get("sat", 1.0)))


def stamp() -> str:
    """Changes when the theme does: part of the version every asset is served under."""
    theme = active()
    return "" if theme is None else "theme:%s:%.1f:%.3f" % theme


def _turn(r: int, g: int, b: int, hue: float, sat: float) -> Optional[Tuple[int, int, int]]:
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    deg = h * 360
    if not (BAND[0] <= deg <= BAND[1]) or s < 0.18 or not (0.06 < l < 0.975):
        return None
    new = ((hue + (deg - HOME) * SPREAD) % 360) / 360
    out = colorsys.hls_to_rgb(new, l, min(1.0, s * sat))
    return tuple(round(c * 255) for c in out)  # type: ignore[return-value]


def recolor(text: str, theme: Optional[Tuple[str, float, float]]) -> str:
    """*text* (a stylesheet, a script, a page) with every lavender colour
    turned to the theme's hue. Six- and eight-digit hex, ``rgb()`` /
    ``rgba()`` and a quoted bare ``"r,g,b"`` are read; anything else is
    left as written."""
    if theme is None:
        return text
    _, hue, sat = theme

    def hexed(m: "re.Match[str]") -> str:
        v = m.group(2)
        got = _turn(int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), hue, sat)
        if got is None:
            return m.group(0)
        out = "%02x%02x%02x" % got
        return m.group(1) + (out.upper() if v.isupper() else out) + (m.group(3) or "")

    def rgbed(m: "re.Match[str]") -> str:
        r, g, b = int(m.group(2)), int(m.group(4)), int(m.group(6))
        got = _turn(r, g, b, hue, sat) if max(r, g, b) <= 255 else None
        if got is None:
            return m.group(0)
        return f"{m.group(1)}{got[0]}{m.group(3)}{got[1]}{m.group(5)}{got[2]}"

    def bare(m: "re.Match[str]") -> str:
        r, g, b = int(m.group(2)), int(m.group(4)), int(m.group(6))
        got = _turn(r, g, b, hue, sat) if max(r, g, b) <= 255 else None
        if got is None:
            return m.group(0)
        return f"{m.group(1)}{got[0]}{m.group(3)}{got[1]}{m.group(5)}{got[2]}{m.group(1)}"

    return _BARE.sub(bare, _RGB.sub(rgbed, _HEX.sub(hexed, text)))


def picture(name: str) -> Path:
    """The file to serve for the static picture *name*: the one drawn for
    the active theme when there is one, the studio's own otherwise."""
    theme = active()
    if theme is not None:
        drawn = state_dir() / "theme" / theme[0] / name
        if drawn.is_file():
            return drawn
    return STATIC / name


def use(setting: Dict) -> None:
    """Write which theme this studio uses. ``{}`` is the studio as drawn."""
    path = state_dir() / "theme.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(setting) + "\n", encoding="utf-8")


def render(theme: Tuple[str, float, float]) -> int:
    """Draw the studio's pictures again in *theme*'s hue, into the state.
    Needs Pillow and numpy, which the studio itself does not: run it with
    ``uv run --with pillow --with numpy python -m operonx_studio.palette``."""
    import numpy as np
    from PIL import Image

    name, hue, sat = theme
    out = state_dir() / "theme" / name
    out.mkdir(parents=True, exist_ok=True)
    done = 0
    for src in sorted(list(STATIC.glob("*.webp")) + list(STATIC.glob("*.png"))):
        image = Image.open(src).convert("RGBA")
        rgb = np.asarray(image, dtype=np.float32)[..., :3] / 255
        alpha = np.asarray(image)[..., 3:]
        hsv = np.asarray(Image.fromarray((rgb * 255).astype("uint8"), "RGB").convert("HSV"), dtype=np.float32)
        deg = hsv[..., 0] * (360 / 255)
        # a pixel is the brand's when its hue is in the band and it has some colour; faint ones turn in part,
        # so a glow fades into the dark without an edge
        weight = ((deg >= BAND[0] - 14) & (deg <= BAND[1] + 14)) * np.clip(hsv[..., 1] / 255 / 0.22, 0, 1)
        turned = hsv.copy()
        turned[..., 0] = ((hue + (deg - HOME) * SPREAD) % 360) * (255 / 360)
        turned[..., 1] = np.clip(hsv[..., 1] * sat, 0, 255)
        new = np.asarray(Image.fromarray(turned.astype("uint8"), "HSV").convert("RGB"), dtype=np.float32) / 255
        mixed = rgb + (new - rgb) * weight[..., None]
        result = Image.fromarray(np.concatenate([(mixed * 255).round().astype("uint8"), alpha], axis=2), "RGBA")
        if src.suffix == ".webp":
            result.convert("RGB").save(out / src.name, "WEBP", quality=88, method=6)
        else:
            result.save(out / src.name, "PNG", optimize=True)
        done += 1
    return done


def main(argv: Optional[list] = None) -> int:
    import argparse

    known = presets()
    parser = argparse.ArgumentParser(prog="python -m operonx_studio.palette",
                                     description="Set the colour theme of this studio (its state folder).")
    parser.add_argument("preset", nargs="?", help=f"one of: {', '.join(known)}; or 'custom' with --hue")
    parser.add_argument("--hue", type=float, help="a hue of your own, 0-360 (red 0, gold 42, green 140, blue 214)")
    parser.add_argument("--sat", type=float, default=1.0, help="how much colour: 1 as drawn, 0.1 nearly grey")
    args = parser.parse_args(argv)
    if args.preset is None and args.hue is None:
        now = active()
        print("theme:", "lavender (as drawn)" if now is None else "%s (hue %.0f, sat %.2f)" % now)
        print("presets:", ", ".join(known))
        return 0
    if args.hue is not None:
        use({"hue": args.hue, "sat": args.sat})
    elif args.preset not in known:
        parser.error(f"no preset named {args.preset}; there are: {', '.join(known)} (add one to themes.json, or use --hue)")
    else:
        use({"preset": args.preset} if "hue" in known[args.preset] else {})
    theme = active()
    if theme is None:
        print("theme: lavender (as drawn). A running studio shows it on the next page load.")
        return 0
    try:
        count = render(theme)
    except ImportError:
        print("the theme is set, but the pictures were not drawn: Pillow and numpy are needed.\n"
              "Run:  uv run --with pillow --with numpy python -m operonx_studio.palette " + " ".join(argv or __import__("sys").argv[1:]))
        return 1
    print("theme: %s (hue %.0f, sat %.2f); %d pictures drawn in %s. A running studio shows it on the next page load."
          % (*theme, count, state_dir() / "theme" / theme[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
