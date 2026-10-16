"""``operonx-extract``, and two old names kept as aliases of core's commands.

    operonx-extract [PATH]           build PATH's graphs and emit Project IR
    operonx-lint [PATH] [--build]    = ``operonx lint``  (core, operonx >= 1.31)
    operonx-new [PATH] [--name N]    = ``operonx init``  (core)

The conventions linter and the project template are core's: one set of
rules, written into every project's ``AGENTS.md`` by ``operonx init``, and
checked by ``operonx lint`` wherever operonx is installed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

from operonx_studio_toolkit.manifest import Manifest, ManifestError

__all__ = ["main", "extract_main", "new_main"]


def main(argv: Sequence[str] | None = None) -> int:
    """``operonx-lint``: core's ``operonx lint``, under its old name."""
    from operonx.cli.lint import main as lint

    return lint(argv)


def extract_main(argv: Sequence[str] | None = None) -> int:
    """``operonx-extract`` — build a project's graphs and print the IR.

    Output is deterministic: keys sorted, no timestamps, no object ids. Two
    runs over unchanged source must produce byte-identical JSON, which is
    what makes the IR safe to cache and to diff.
    """
    import json

    from operonx_studio_toolkit.extract import ExtractError, extract_project

    parser = argparse.ArgumentParser(prog="operonx-extract", description=extract_main.__doc__)
    parser.add_argument("path", nargs="?", default=".", help="project root (default: cwd)")
    parser.add_argument("-o", "--output", help="write here instead of stdout")
    parser.add_argument("--compact", action="store_true", help="no indentation")
    args = parser.parse_args(argv)

    root = Path(args.path)
    # The IR is the only thing on stdout: while the project's graphs are
    # built, fd 1 points at stderr, so a print or a LOGGER warning in the
    # project cannot corrupt the JSON.
    import os

    sys.stdout.flush()
    saved, real_stdout = os.dup(1), sys.stdout
    os.dup2(2, 1)
    sys.stdout = sys.stderr      # a Python-level stdout that is not fd 1, too
    try:
        ir = extract_project(Manifest.load(root))
    except (ManifestError, ExtractError) as exc:
        print(f"operonx-extract: {exc}", file=sys.stderr)
        return 1
    finally:
        sys.stderr.flush()
        sys.stdout = real_stdout
        os.dup2(saved, 1)
        os.close(saved)

    text = json.dumps(ir, sort_keys=True, indent=None if args.compact else 2) + "\n"
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        graphs = len(ir["graphs"])
        nodes = sum(len(g["nodes"]) for g in ir["graphs"])
        print(f"operonx-extract: {graphs} graph(s), {nodes} node(s) -> {args.output}")
    else:
        sys.stdout.write(text)
    return 0


def new_main(argv: Sequence[str] | None = None) -> int:
    """``operonx-new``: core's ``operonx init``, under its old name."""
    from operonx.cli.main import main as operonx

    return operonx(["init", *(sys.argv[1:] if argv is None else list(argv))])


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
