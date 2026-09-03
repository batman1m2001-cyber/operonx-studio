# operonx-studio

The visual studio and project tooling for [operonx](https://github.com/batman1m2001-cyber/Operonx).

```
pip install operonx-studio

operonx-studio            # open the studio — pick, open, or create a project
operonx-new my_project    # scaffold a standard operonx project
operonx-lint              # lint the manifest and graphs
operonx-extract           # dump the project IR as JSON
```

`operonx-studio` serves a local web app: a home screen listing your
projects, and per-project an n8n-style canvas of every graph — pan, zoom,
click a node to inspect what feeds it, edit literal params in place. A
`[[serve]]` entry is drawn as the entry node it is, so no pipeline begins
from nowhere.

Extraction always runs in a subprocess under the **project's own**
interpreter: the studio needs nothing installed into the projects it
inspects, stale imports cannot lie to the page, and a project that crashes
on import reports the error instead of taking the studio down.
