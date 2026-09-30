"""The served scripts and styles are smaller and the same program.

``strip_js`` drops comments, indentation, trailing and repeated spaces and
blank lines; every line break and every literal stays. The whole bundles
were compared token by token with acorn (docs/ASSISTANT_NEXT_PLAN.md §8):
identical. Here: the tricky cases, run by node when it is installed.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from operonx_studio.minify import strip_css, strip_js

pytestmark = pytest.mark.unit

TRICKY = r'''/* a header
   over two lines */
"use strict";
// a line comment
const a = `two  spaces
   and an indented line ${ 1 +  2 } and ${`nested  ${"x  y"}`}`;   // after code
const re = /\s+  \/\/ not a comment/g, cls = /[/*]+/, d = 10 / 2 / 1;
const s = "quote  \" // not a comment", q = 'it\'s  /* kept */';
function f(x) {
  return /a  b/.test(x)     // a regex after return
}
const t = x => x  /2;
let i = 1
let j = i
++j                          // ASI: j is incremented, not i
const k = a/**/.length;
const tpl = `a${"`"}b ${ {k: 1}.k } c`;
console.log(JSON.stringify([a, re.source, cls.source, d, s, q, f("a  b"), t(8), i, j, k, tpl]));
'''


def test_comments_and_indentation_go_literals_stay():
    out = strip_js(TRICKY)
    assert "a header" not in out and "a line comment" not in out and "after code" not in out
    for literal in ("`two  spaces\n   and an indented line ${", "`nested  ${\"x  y\"}`", r"/\s+  \/\/ not a comment/g",
                    r"/[/*]+/", r'"quote  \" // not a comment"', r"'it\'s  /* kept */'", "/a  b/", "`a${\"`\"}b ${"):
        assert literal in out, literal
    assert "\n++j" in out                            # the line break that ASI reads is still there
    # code's own spaces collapse — a template's ${…} is code too — its literals' don't
    assert "x /2" in out and "${ 1 + 2 }" in out and "\n   and an indented line" in out
    assert "a .length" in out                        # a/**/.length: still two tokens
    assert len(out) < len(TRICKY)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_it_runs_the_same(tmp_path: Path):
    a, b = tmp_path / "a.js", tmp_path / "b.js"
    a.write_text(TRICKY, encoding="utf-8")
    b.write_text(strip_js(TRICKY), encoding="utf-8")
    run = lambda p: subprocess.run(["node", str(p)], capture_output=True, text=True, timeout=30)
    ra, rb = run(a), run(b)
    assert ra.returncode == 0 and rb.returncode == 0, (ra.stderr, rb.stderr)
    assert ra.stdout == rb.stdout


def test_styles_keep_their_spaces_where_they_mean_something():
    css = strip_css(".a { width : calc(100% - 16px); } /* c */ .b::after { content: '  two  '; }")
    assert css == ".a{width:calc(100% - 16px)}.b::after{content:'  two  '}"


def _bundle_and_css(monkeypatch, tmp_path, setting):
    from fastapi.testclient import TestClient

    from operonx_studio.app import build_studio_app
    from operonx_studio.registry import Recents

    if setting is None:
        monkeypatch.delenv("OPERONX_STUDIO_MINIFY", raising=False)
    else:
        monkeypatch.setenv("OPERONX_STUDIO_MINIFY", setting)
    app = build_studio_app(Recents(state_file=tmp_path / setting_dir(setting) / "studio.json"))
    with TestClient(app) as c:
        page = c.get("/").text
        src = page[page.index("/static/bundle/home.js"):].split('"')[0]
        return c.get(src).text, c.get("/static/studio.css").text


def setting_dir(setting):
    return f"state-{setting or 'default'}"


def test_the_page_is_served_small_unless_asked_not_to(monkeypatch, tmp_path):
    js, css = _bundle_and_css(monkeypatch, tmp_path, None)
    assert "/* ── icons.js ── */" not in js and "\n\n" not in js
    assert "/*" not in css and "{\n" not in css
    js_off, css_off = _bundle_and_css(monkeypatch, tmp_path, "off")
    assert "/* ── icons.js ── */" in js_off and "/*" in css_off
    assert len(js) < 0.85 * len(js_off) and len(css) < 0.85 * len(css_off)
