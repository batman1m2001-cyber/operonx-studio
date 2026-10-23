#!/usr/bin/env sh
# Install (or upgrade, after a `git pull`) operonx-studio from this checkout:
# the `operonx-studio` and `operonx-extract` commands (and `operonx-lint`,
# `operonx-new`: old names of core's `operonx lint` and `operonx init`), in
# an environment of their own.
#
#   git clone https://github.com/batman1m2001-cyber/operonx-studio
#   operonx-studio/install.sh
#
# With uv it is a uv tool; without, a plain pip install into the current
# Python. operonx itself comes from PyPI (pyproject's local ../Operon
# override is for working on both at once, so it is ignored here).
set -e
cd "$(dirname "$0")"
# the project builder (operonx-project) is not on PyPI: it comes from an Operon checkout beside this one,
# installed into the same environment so the Board and Project mode can act through it
BUILDER=""
[ -d ../Operon/packages/operonx-project ] && BUILDER="../Operon/packages/operonx-project"
if command -v uv >/dev/null 2>&1; then
  if [ -n "$BUILDER" ]; then
    uv tool install --no-sources --reinstall . --with "$BUILDER"
  else
    uv tool install --no-sources --reinstall .
  fi
else
  python3 -m pip install --upgrade . ${BUILDER:+"$BUILDER"}
fi
[ -n "$BUILDER" ] || echo "note: no ../Operon checkout, so no project builder: clone Operon beside this repo and run this again for the Board"
echo
echo "installed: run \`operonx-studio\` (or \`operonx studio\` inside a project)"
