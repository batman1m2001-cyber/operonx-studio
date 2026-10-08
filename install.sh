#!/usr/bin/env sh
# Install (or upgrade, after a `git pull`) operonx-studio from this checkout:
# the `operonx-studio`, `operonx-lint`, `operonx-extract` and `operonx-new`
# commands, in an environment of their own.
#
#   git clone https://github.com/batman1m2001-cyber/operonx-studio
#   operonx-studio/install.sh
#
# With uv it is a uv tool; without, a plain pip install into the current
# Python. operonx itself comes from PyPI (pyproject's local ../Operon
# override is for working on both at once, so it is ignored here).
set -e
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  uv tool install --no-sources --reinstall .
else
  python3 -m pip install --upgrade .
fi
echo
echo "installed: run \`operonx-studio\` (or \`operonx studio\` inside a project)"
