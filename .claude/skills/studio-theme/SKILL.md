---
name: studio-theme
description: Change the colour theme of operonx studio (lavender, golden, platinum, blue, or any hue), add a theme preset, or check that a screen follows the theme. Use this whenever someone asks to recolour, rebrand or re-skin the studio, wants "a gold/blue/grey studio", asks why some part is still purple under another theme, or adds UI colours, canvas drawing code or pictures that must follow the theme.
---

# Studio colour theme

The studio is drawn in lavender. A theme does not edit any file: `operonx_studio/palette.py` turns
every lavender colour to another hue when the studio serves it. One setting covers the stylesheets,
the scripts (the canvas code holds colours too) and the pictures.

```text
themes.json (presets)  ->  <state>/theme.json (the one in use)  ->  palette.recolor() on every .css / .js served
                                                                ->  <state>/theme/<name>/*.webp|png, drawn once
```

`<state>` is `OPERONX_STUDIO_STATE_DIR`, default `~/.operonx`. A theme belongs to one studio
install, not to a project.

## Change the theme

```bash
# from the operonx-studio checkout; set OPERONX_STUDIO_STATE_DIR if the studio uses another state folder
uv run --with pillow --with numpy python -m operonx_studio.palette golden      # a preset
uv run --with pillow --with numpy python -m operonx_studio.palette --hue 140   # any hue, 0-360
uv run python -m operonx_studio.palette lavender                               # back to as drawn
uv run python -m operonx_studio.palette                                        # what is in use
```

Pillow and numpy are needed only here, to draw the pictures again; the running studio does not need
them. No restart: the next page load shows the theme. Changing the theme of a studio people are
using is theirs to ask for; try it on a scratch state folder first.

## Add a preset

Add one line to `operonx_studio/themes.json`:

```json
"emerald": {"hue": 150, "sat": 0.9, "note": "green"}
```

`hue` is where lavender (262°) lands; `sat` scales how much colour there is (0.1 is nearly grey).
Then set it and look at it (next section). A light theme is not a preset: the studio is dark only.

## Look at it, always

Colours hide in places a quick look at the home page misses, so take the shots and read them:

```bash
uv run --no-project --with playwright==1.44.0 python .claude/skills/studio-theme/scripts/shots.py \
  http://localhost:<port> <out dir> <tag> [username password [project name]]
```

It shoots the home page (desktop and phone), a project, its **Picture** and its settings. Give a
project with many flows as `project name`: the Picture is a canvas drawn by `factory2d.js`, and it
is the screen most easily left lavender.

## When something stays lavender

Find how that colour reaches the browser, in this order:

1. **A file served without the theme.** `.css`, `.js`, `.webp` and `.png` under `/static/` have
   routes in `app.py` that apply it. Another file type, or another mount, does not. Give it a route
   (and a line in `access.py`).
2. **A colour form `recolor` does not read.** It reads `#rrggbb(aa)`, `%23rrggbb`, `rgb()/rgba()`
   and quoted `"r,g,b"`. `hsl()`, three-digit hex and colours computed at run time are not read:
   write the colour in a form that is.
3. **A colour outside the two bands.** Hues 226–295° are the brand (`BAND` in `palette.py`) and
   turn fully. Hues 200–226° are the studio's second colour, the blue of selections, links, wires
   and code ops (`SECOND`): they turn to the theme's hue too, with less colour (`MUTE`), so the two
   still differ; a theme that is itself blue leaves them. Everything else (green, amber, red,
   greys) stays. Do not widen a band without looking at every screen again.
4. **A picture not drawn again.** Run the palette command again; it redraws all of `static/`.

Tests: `tests/studio/test_palette.py`, and the theme test in `tests/studio/test_app.py`.
