"""The studio's project toolkit: the manifest view, graph extraction, and
typed source edits (Python by AST span, YAML and ``.env`` by line).

Extraction runs inside a target project's own environment, so this stays
dependency-minimal. The conventions linter and the project template are
core's (``operonx lint``, ``operonx init``).
"""

from operonx_studio_toolkit.manifest import (
    MANIFEST_NAME,
    GraphSpec,
    Manifest,
    ManifestError,
    ResourceSpec,
    ServeSpec,
)

__version__ = "0.2.0"

__all__ = [
    "MANIFEST_NAME",
    "GraphSpec",
    "Manifest",
    "ManifestError",
    "ResourceSpec",
    "ServeSpec",
    "__version__",
]
