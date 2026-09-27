"""Smaller scripts and styles for the page, with the same behaviour.

The studio's scripts are commented generously; through the tunnel every
byte of the bundle is felt on a phone. ``strip_js`` removes what the
engine ignores — comments, indentation, trailing and repeated spaces,
blank lines — and nothing else:

* every line break stays, so automatic semicolon insertion reads the
  program exactly as before;
* string, template and regex literals pass through byte for byte, a
  template's ``${…}`` expressions included (their code is code again).

A general minifier was measured first and rejected: rjsmin 1.2.5 collapsed
the spaces inside nested template literals (`` `nested  ${…}` ``,
`` {"k": `v  v`} ``), so the page's text would have changed while the
bundle still parsed.

Stylesheets go through rcssmin, which keeps ``calc()``'s spaces and every
string (checked on the constructs this stylesheet uses).
"""

from __future__ import annotations

import re
from typing import List

__all__ = ["strip_js", "strip_css"]

# after these, a `/` starts a regex literal, not a division
_REGEX_AFTER_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
                      "instanceof", "yield", "await"}
_IDENT = re.compile(r"[A-Za-z0-9_$]")


def strip_js(src: str) -> str:
    out: List[str] = []
    n = len(src)
    i = 0
    state = "code"                 # code | sq | dq | tpl | re | re_class | line | block
    tpl_depth: List[int] = []      # open templates: the brace depth of their ${…}
    at_line_start = True
    pending_space = False          # spaces seen in code, written only before the next token
    last = ""                      # the last significant code character written
    last_word = ""                 # the last identifier written

    def emit(text: str) -> None:
        nonlocal pending_space, at_line_start
        if pending_space and not at_line_start:
            out.append(" ")
        pending_space = False
        at_line_start = False
        out.append(text)

    def newline() -> None:
        nonlocal pending_space, at_line_start
        pending_space = False
        if not at_line_start:
            out.append("\n")
        at_line_start = True

    while i < n:
        c = src[i]
        if state == "code":
            nxt = src[i + 1] if i + 1 < n else ""
            if c == "\n":
                newline()
                i += 1
                continue
            if c in " \t\r\f\v":
                pending_space = True
                i += 1
                continue
            if c == "/" and nxt == "/":
                state = "line"
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                i += 2
                continue
            if c == "/":
                division = (last in ")]}" or bool(_IDENT.match(last))) and last_word not in _REGEX_AFTER_WORDS
                emit(c)
                i += 1
                if not division:
                    state = "re"
                last, last_word = c, ""
                continue
            if c in "'\"`":
                emit(c)
                i += 1
                state = {"'": "sq", '"': "dq", "`": "tpl"}[c]
                last, last_word = c, ""
                continue
            if tpl_depth and c == "{":
                tpl_depth[-1] += 1
            elif tpl_depth and c == "}":
                if tpl_depth[-1] == 0:          # the end of a template's ${…}: the template again
                    tpl_depth.pop()
                    emit(c)
                    i += 1
                    state = "tpl"
                    continue
                tpl_depth[-1] -= 1
            if _IDENT.match(c):
                j = i
                while j < n and _IDENT.match(src[j]):
                    j += 1
                word = src[i:j]
                emit(word)
                last, last_word = word[-1], word
                i = j
                continue
            emit(c)
            last, last_word = c, ""
            i += 1
        elif state in ("sq", "dq"):
            quote = "'" if state == "sq" else '"'
            if c == "\\" and i + 1 < n:
                out.append(src[i:i + 2])
                i += 2
                continue
            out.append(c)
            i += 1
            if c == quote or c == "\n":        # a newline ends a broken string: the engine will say so
                state = "code"
        elif state == "tpl":
            if c == "\\" and i + 1 < n:
                out.append(src[i:i + 2])
                i += 2
                continue
            if c == "`":
                out.append(c)
                i += 1
                state = "code"
                last, last_word = "`", ""
                continue
            if c == "$" and i + 1 < n and src[i + 1] == "{":
                out.append("${")
                i += 2
                tpl_depth.append(0)
                state = "code"
                last, last_word = "{", ""
                continue
            out.append(c)
            i += 1
        elif state in ("re", "re_class"):
            if c == "\\" and i + 1 < n:
                out.append(src[i:i + 2])
                i += 2
                continue
            out.append(c)
            i += 1
            if state == "re_class":
                if c == "]":
                    state = "re"
            elif c == "[":
                state = "re_class"
            elif c == "/":
                state = "code"
                last, last_word = "/", "x"      # after a regex (and its flags), a `/` divides
            elif c == "\n":
                state = "code"
        elif state == "line":
            if c == "\n":
                state = "code"
                newline()
            i += 1
        else:  # block comment
            if c == "*" and i + 1 < n and src[i + 1] == "/":
                state = "code"
                pending_space = True            # a/**/b stays two tokens
                i += 2
                continue
            if c == "\n":
                newline()
            i += 1
    text = "".join(out)
    return text if text.endswith("\n") else text + "\n"


def strip_css(src: str) -> str:
    import rcssmin

    return rcssmin.cssmin(src)
