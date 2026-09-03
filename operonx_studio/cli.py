"""``operonx-studio`` — open the studio.

    operonx-studio                open the app: pick, open or create a project
    operonx-studio PATH           open the app with PATH already opened
    operonx-studio --port 9000    a different port

The studio is a local web app. The old static-export mode is gone — it
existed so a diagram could be mailed around, but a page that cannot
re-extract lies the moment the code moves, and the daemon costs nothing
to run. Everything still works offline: no CDN, no calls out.
"""

from __future__ import annotations

import argparse
import threading
import webbrowser
from pathlib import Path
from typing import Sequence

__all__ = ["main"]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="operonx-studio", description=__doc__)
    parser.add_argument("path", nargs="?", default=None,
                        help="a project root to open immediately (optional)")
    parser.add_argument("--host", default="127.0.0.1", help="bind host (loopback by default)")
    parser.add_argument("--port", type=int, default=8765, help="bind port")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args(argv)

    open_path = None
    if args.path is not None:
        open_path = Path(args.path).resolve()
        if not (open_path / "operonx.toml").is_file():
            print(f"error: no operonx.toml in {open_path}")
            return 2

    from operonx_studio.app import serve_studio
    from operonx_studio.registry import project_id

    url = f"http://{args.host}:{args.port}/"
    if open_path is not None:
        url = f"http://{args.host}:{args.port}/p/{project_id(open_path)}"
    print(f"operonx studio · {url}")
    if not args.no_open:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()

    serve_studio(host=args.host, port=args.port, open_path=open_path)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
