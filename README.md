# operonx-studio

The visual studio and project tooling for [operonx](https://github.com/batman1m2001-cyber/Operonx).

```
git clone https://github.com/batman1m2001-cyber/operonx-studio
operonx-studio/install.sh           # again after a `git pull` to upgrade

operonx-studio            # open the studio — pick, open, or create a project
operonx-studio PATH       # … with the project at PATH already open
operonx-new my_project    # scaffold a standard operonx project
operonx-lint              # lint the manifest and graphs
operonx-extract           # dump the project IR as JSON
```

`operonx-studio` serves a local web app: a home screen listing your
projects, and per-project an n8n-style canvas of every graph — pan, zoom,
click a node to inspect what feeds it, edit literal params in place. A
`[[serve]]` entry is drawn as the entry node it is, so no pipeline begins
from nowhere.

The canvas has two views (switch with `D`):

- **Workflow** shows what runs after what.
- **Data Flow** shows which value goes where.

Data wires are faint hairlines; a spark runs along each one the way the data goes:
- A value read by several ops splits at one point.
- An input fed by several alternatives (branches) meets at one merge ring.
- A router's inputs plug straight into the condition that reads them.

Clicking an op in either view draws all its data wires. Pointing at a
variable or a wire singles it out; clicking a variable follows its value
through the graph. The **?** button on the canvas explains every mark.

`install.sh` installs the commands as a uv tool, in an environment of their
own (with plain pip when uv is missing); operonx comes from PyPI. Inside a
project, `operonx studio` does the same as `operonx-studio .`. If a studio
is already running, it adds the project to that studio and opens it.

The first sign-in is `root` / `123` (or `OPERONX_STUDIO_USER` /
`OPERONX_STUDIO_PASS` at first start), and the studio asks for a new
password right away. Its state (accounts, conversations) lives in
`OPERONX_STUDIO_STATE_DIR`, default `~/.operonx`.

Extraction always runs in a subprocess under the **project's own**
interpreter: the studio needs nothing installed into the projects it
inspects, stale imports cannot lie to the page, and a project that crashes
on import reports the error instead of taking the studio down.

A project that serves a knowledge base built with
[operonx-kb](https://github.com/batman1m2001-cyber/operonx-kb) — its admin
app, `operonx_kb.admin.kb_admin_app`, as an `asgi` service — gets a
**Knowledge** tab: its collections and documents, each page with the boxes
the parser drew, the chunk inspector, and an Ask page whose answers' `[n]`
open the cited page with the cited boxes lit. The studio finds it by asking
the running service (`/.well-known/operonx-kb`) and reads it over HTTP; it
never imports operonx-kb.
