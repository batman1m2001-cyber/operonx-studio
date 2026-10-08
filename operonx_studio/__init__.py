"""Visual workspace for operonx projects.

Reads the Project IR produced by ``operonx-project`` and renders it. The
toolkit stays headless so projects and CI can depend on it without a web
stack; everything visual lives here.
"""

from operonx_studio.layout import Layout, layout_graph
from operonx_studio.render import render_html, render_project

# one version, the distribution's (pyproject.toml): the two drifted apart
try:
    from importlib.metadata import PackageNotFoundError, version

    __version__ = version("operonx-studio")
except PackageNotFoundError:  # a bare checkout on sys.path, not installed
    __version__ = "0.0.0+local"

__all__ = ["Layout", "layout_graph", "render_html", "render_project", "__version__"]
