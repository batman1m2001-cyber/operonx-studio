"""The dark theme's twins of the colours written in the stylesheet itself.

The studio's colours are tokens (``--surface``, ``--k-func`` …) with a
hand-tuned dark value each (``studio-dark.css``). The stylesheet also
writes ~300 colours in place — tints, the canvas's cells and beams, chips.
Copying each rule by hand would be large and would drift, so the dark
twin of every rule that sets a colour is generated from the light one,
when the stylesheet is served (``with_dark``):

* the twin follows its rule, in place, with the same selector and the
  same specificity (``:where(…)`` adds none) — so whatever overrode the
  rule in the light still comes later and overrides the twin in the dark;
  only the declarations whose colour changes are written;
* a neutral flips its lightness (white surfaces go dark, dark ink goes
  light); a pale tint becomes a dark tint of the same hue; a strong hue
  is lightened until it reads on a dark surface; a shadow stays dark and
  deepens;
* an inline SVG's own colours (a chevron drawn in ``url("data:…")``) are
  ink, and turn light like the text;
* masks (their black is opacity) and keyframes are left alone, and so are
  the tokens (``:root``), which are hand-tuned.

The hand-tuned rules in ``studio-dark.css`` come after, and win where the
arithmetic is not enough.
"""

from __future__ import annotations

import math
import re
from typing import List, Tuple

__all__ = ["with_dark", "to_dark"]

DARK = ':root[data-theme="dark"]'

_COLOR = re.compile(r"#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^()]*\)|\bwhite\b|\bblack\b")
_URL = re.compile(r"url\((?:\"[^\"]*\"|'[^']*'|[^)]*)\)")
_ENCODED = re.compile(r"%23([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])")
_PROPS = re.compile(r"^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|"
                    r"box-shadow|text-shadow|fill|stroke|stop-color|caret-color|accent-color|column-rule(-color)?|"
                    r"text-decoration(-color)?|--[\w-]+)$")
_SHADOW = ("box-shadow", "text-shadow")


# ── colour arithmetic (sRGB <-> OKLab) ────────────────────────────────────

def _lin(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _gam(c: float) -> float:
    c = min(1.0, max(0.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def _to_oklab(r: float, g: float, b: float) -> Tuple[float, float, float]:
    r, g, b = _lin(r), _lin(g), _lin(b)
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def _from_oklab(L: float, a: float, b: float) -> Tuple[float, float, float]:
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (_gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            _gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            _gam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s))


def _parse(text: str) -> Tuple[float, float, float, float]:
    t = text.strip().lower()
    if t == "white":
        return 1.0, 1.0, 1.0, 1.0
    if t == "black":
        return 0.0, 0.0, 0.0, 1.0
    if t.startswith("#"):
        h = t[1:]
        if len(h) in (3, 4):
            h = "".join(ch * 2 for ch in h)
        vals = [int(h[i:i + 2], 16) / 255 for i in range(0, len(h), 2)]
        return vals[0], vals[1], vals[2], vals[3] if len(vals) == 4 else 1.0
    nums = [p.strip() for p in t[t.index("(") + 1:-1].replace("/", ",").split(",")]
    rgb = [float(p[:-1]) / 100 if p.endswith("%") else float(p) / 255 for p in nums[:3]]
    alpha = 1.0
    if len(nums) > 3:
        alpha = float(nums[3][:-1]) / 100 if nums[3].endswith("%") else float(nums[3])
    return rgb[0], rgb[1], rgb[2], alpha


def _fmt(r: float, g: float, b: float, alpha: float) -> str:
    rgb = [round(c * 255) for c in (r, g, b)]
    if alpha >= 0.999:
        return "#%02x%02x%02x" % tuple(rgb)
    return f"rgba({rgb[0]}, {rgb[1]}, {rgb[2]}, {round(alpha, 3)})"


# the dark ramp's own cool cast (the tokens' graphite, e.g. --surface #161a20)
_TINT = (-0.003, -0.011)


def to_dark(text: str, prop: str = "color") -> str:
    """One colour's dark counterpart (see the module's rules). *prop* is the
    property it is written in: a shadow stays dark, and a colour already
    made for a dark place (a code block's background, the light ink on it)
    stays as it is."""
    try:
        r, g, b, alpha = _parse(text)
    except (ValueError, IndexError):
        return text
    L, a, bb = _to_oklab(r, g, b)
    C = math.hypot(a, bb)
    if prop in _SHADOW:
        if C < 0.06:          # a neutral shadow stays a shadow: darker, a little stronger
            return _fmt(0.0, 0.0, 0.0, min(0.6, alpha * 2.2))
        return text           # a coloured glow glows on dark as well
    # a pale wash's hue is its meaning (a warning's cream, an error's rose)
    # even at low chroma; elsewhere a little chroma is only a warm or cool grey
    if C < (0.012 if L > 0.86 else 0.04):
        ink = prop == "color"
        surface = prop.startswith("background") or prop.startswith("border") or prop.startswith("outline")
        if alpha >= 0.5 and ((surface and L < 0.4) or (ink and L > 0.72)):
            return text       # already dark-place colours: a code block, the ink on it
        # neutrals: lightness flipped onto the dark ramp (white -> the page,
        # black -> the ink), with the ramp's cool cast
        L2 = 0.20 + (1.0 - L) * 0.74
        t = max(0.0, 1.0 - abs(L2 - 0.2) * 1.4)          # most cast on the darkest greys
        return _fmt(*_from_oklab(L2, _TINT[0] * t, _TINT[1] * t), alpha)
    elif L > 0.86:
        # a pale tint (a chip's or a card's wash): a dark wash of the same hue
        L2 = 0.28 + (1.0 - L) * 0.6
        scale = 0.55
    elif L < 0.72:
        # a strong hue used as ink or a line: lightened until it reads on dark
        L2 = max(L + 0.18, 0.72)
        scale = 0.95
    elif prop.startswith(("background", "border", "outline", "fill", "stop-color", "column-rule")):
        # a mid-light tint as a fill or a line (a timeline's bars): dark-mid,
        # same hue, and inverted like the neutrals — what stood out most from
        # the white page stands out most from the dark one (a hover, say)
        L2 = 0.30 + (0.86 - L) * 0.9
        scale = 0.75
    else:
        L2 = L                 # as ink it already reads on dark
        scale = 0.9
    return _fmt(*_from_oklab(L2, a * scale, bb * scale), alpha)


# ── the stylesheet, rule by rule ──────────────────────────────────────────

def _split_top(text: str, sep: str) -> List[str]:
    out, depth, cur, quote = [], 0, [], ""
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = ""
            continue
        if ch in "\"'":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == sep and depth == 0:
            out.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    out.append("".join(cur))
    return out


def _skip(css: str, i: int) -> int:
    """Past the comment or string starting at *i* (or *i* itself)."""
    if css.startswith("/*", i):
        end = css.find("*/", i + 2)
        return len(css) if end < 0 else end + 2
    if css[i] in "\"'":
        j = i + 1
        while j < len(css) and css[j] != css[i]:
            j += 2 if css[j] == "\\" else 1
        return j + 1
    return i


def _find_open(css: str, i: int) -> int:
    """The next `{` outside comments and strings, or -1."""
    while i < len(css):
        j = _skip(css, i)
        if j != i:
            i = j
        elif css[i] == "{":
            return i
        else:
            i += 1
    return -1


def _block_end(css: str, i: int) -> int:
    """The index just past the `}` matching the `{` at *i*."""
    depth = 0
    while i < len(css):
        j = _skip(css, i)
        if j != i:
            i = j
            continue
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return len(css)


_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def _scope(selector: str) -> str:
    sel = selector.strip()
    if sel.startswith(":root"):
        return sel.replace(":root", DARK, 1) if "[data-theme" not in sel else ""
    if sel.startswith("html"):
        return 'html:where([data-theme="dark"])' + sel[4:]
    return f":where({DARK}) {sel}"


def _darken_value(value: str, prop: str) -> str:
    """A declaration's value with each colour darkened. Inside ``url(…)``
    only an inline SVG's URL-encoded colours (``stroke='%231f1b13'``) are
    touched — they are the icon's ink; a bare ``#`` written into a data URI
    would end it."""
    out, last = [], 0
    for m in _URL.finditer(value):
        out.append(_COLOR.sub(lambda c: to_dark(c.group(0), prop), value[last:m.start()]))
        out.append(_ENCODED.sub(lambda c: "%23" + to_dark("#" + c.group(1), "color")[1:], m.group(0)))
        last = m.end()
    out.append(_COLOR.sub(lambda c: to_dark(c.group(0), prop), value[last:]))
    return "".join(out)


def _rule(selectors: str, body: str) -> str:
    decls = []
    for decl in _split_top(body, ";"):
        if ":" not in decl:
            continue
        prop, value = decl.split(":", 1)
        prop = prop.strip().lower()
        if not _PROPS.match(prop) or "mask" in prop:
            continue
        # a token re-declared in the light stylesheet (a component's own
        # custom property) is darkened too
        if "mask" in value:
            continue
        dark = _darken_value(value, prop)
        if dark != value:              # a var(), a colour kept as it is: the rule itself serves
            decls.append(f"{prop}:{dark.strip()}")
    if not decls:
        return ""
    sels = [s for s in (_scope(x) for x in _split_top(selectors, ",")) if s]
    return f"{','.join(sels)}{{{';'.join(decls)}}}" if sels else ""


def with_dark(css: str) -> str:
    """*css* as written, each colour-setting rule followed by its dark twin."""
    out: List[str] = []
    i = 0
    while i < len(css):
        brace = _find_open(css, i)
        if brace < 0:
            out.append(css[i:])
            break
        end = _block_end(css, brace)
        head = _COMMENT.sub("", css[i:brace]).strip()
        if head.startswith(("@media", "@supports", "@container")):
            out.append(css[i:brace + 1] + with_dark(css[brace + 1:end - 1]) + "}")
        else:
            out.append(css[i:end])
            if not head.startswith("@") and not (head.startswith(":root") and not head[5:].strip()):
                twin = _rule(head, _COMMENT.sub("", css[brace + 1:end - 1]))
                if twin:
                    out.append("\n" + twin)
        i = end
    return "".join(out)
