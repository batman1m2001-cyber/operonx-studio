# The factory view (FACTORY_VIEW_PLAN)

Status: not started (2026-11-15). Branch `ui/factory-view`, worktree
`/home/thanglq/operonx-studio-wt/factory-view`. Written for Fable 5.2, which does the design and the build.

## The owner's brief

2026-11-14: "upgrade the interface comprehensively, above all the flow view. Maybe turn it into a
**factory**, with the parts connected to each other in a **pseudo-3D** style. Later it grows into a
**multi-agent factory**, split by **zone, block and department**, so it gets more and more intuitive."

2026-11-15: **UI only. Do not touch backend logic.**

Already done, so not in scope: the left rail went from 13 items to 5 hubs (RAIL_SLIM_PLAN, #183/#184).

## Hard rules

1. **Frontend only.** Change `operonx_studio/static/**` (js, css, html, images), `tests/js/`, `docs/`.
   Do not change any `.py` file, any API route or payload, or the operonx package. Before every PR,
   `git diff --stat origin/main -- '*.py'` must be empty.
2. **Read the data the canvas already reads.** `GET /api/p/{pid}/ir` (the graphs: `state.ir`,
   `state.graph`) and `GET /api/p/{pid}/trace/{run}/flow` (a run). A zone, block or department is
   derived in the browser from that IR. If something truly cannot be derived, write it down under
   "Needs backend" below and stop that part. Do not add an endpoint.
3. **Keep what works.**
   - the run line (RUN_LINE_PLAN, #181): a simple line beside the real data, the shape of the flow;
   - the BranchOp rail (BRANCH_JUNCTION_PLAN);
   - the agent card and the fan-out stacks (AGENTOP_REDESIGN_PLAN, CANVAS_REDESIGN_PLAN C4);
   - glass on both themes (LIQUID_GLASS_PLAN, GLASS_EVERYWHERE_PLAN): use the surface tokens, never a
     hard-coded colour. A derived token (`--card`, `--panel`, …) must be declared again on a glass scope;
   - Reduce Transparency, phone width, keyboard access;
   - every screen's address and the assistant's "switch to screen" commands.
4. **The owner's taste, learned the hard way.**
   - A wire is a plain smooth curve. Its type is shown by colour plus the socket shape at each end
     (Blender / ComfyUI / Unreal). Never decorate the wire itself: no beads, pipes, crossties or waves.
     A wire is a lit 1px core over a blurred 3px halo.
   - A click selects with a lavender glow, the same shape. A double click opens the data.
   - No walls of text. Show a title, a number, a state, the one action; the rest goes in a `<details>`,
     a "+N more" or a hover.
   - Graph indigo `--k-graph`; routes lavender; no steel blue next to lavender.
5. **Decide the design yourself.** Do not add "owner picks A or B" gates. Build it, shoot it, show the
   screenshots as each part lands.

## Advice from the session before (Opus 5.5, 2026-11-14)

The **zones** carry the value, not the 3D. Fake 3D hides wires behind blocks, tilts labels and makes
editing and reading values harder. My suggestion was two levels:

- **the floor, the main working view:** flat 2D rooms. A zone is a room with a header, its machines
  inside, and the wires running between rooms;
- **the factory, a zoomed-out overview:** the same rooms as pseudo-3D blocks (isometric CSS/SVG, no
  WebGL library). It shows the whole product at a glance, and a click on a block flies into that room
  on the floor.

This is advice, not a rule. If a better design shows itself in the lab, take it and say why.

A first mapping from the IR (check it against the real node kinds in `static/canvas.js`,
`static/flowlayout.js` and `tests/js/containerkind.test.mjs`):

| IR | in the factory |
|---|---|
| a project's graphs (`state.ir.graphs`) | the site: one building per served graph or job |
| a GraphOp | a room (zone); nested GraphOps are rooms inside rooms (blocks) |
| an AgentOp | a department: the agent's desk, with its model, tools and memory as workstations |
| an op | a machine, coloured and iconed by its kind (the existing kind colours) |
| a BranchOp | a switch on the line (the existing rail) |
| a loop | a return conveyor |
| START / END, a service's door, a job's items | loading docks: in and out |
| a run | the lit path: machines that ran, the one running, the one that failed |

## Parts

Each part ends with the plan updated with what was done, the code changed, and before/after
screenshots (desktop 1440×900 and phone 390 wide, dark and light) in `docs/img/factory/`.

### F0 · The lab

A mock in its own folder, `/home/thanglq/factory-lab`, outside the studio, the way the run line started
in `/home/thanglq/runline-lab`.

- Use real data: IR JSON saved from a running studio (`/api/p/{pid}/ir`) for the 13 runline-lab flows
  (every node shape) and a big real one, the callbot in `/home/thanglq/educa-reminder-agent`.
- Draw the floor (2D rooms) and the overview (pseudo-3D), both themes.
- Use Playwright to shoot every case, and add a small layout check (no room overlaps another, no
  label is cut off).

### F1 · The floor in the studio

- Port the floor into the Flow screen as its view.
- Keep the current canvas behind a view switch until the owner says to drop it.
- Pan, zoom, select, double click to open, port lineage and the side panel all keep working.
- Add a `tests/js/` file for the pure part (IR → rooms → positions), like `flowlayout.test.mjs`.

### F2 · Runs in the factory

- A run lights its path on the floor and on the overview, from the trace flow endpoint.
- The run line stays beside the data.

### F3 · The overview and the multi-agent factory

- The pseudo-3D overview: a click on a block flies into its room.
- Ten or more agents fold into one department stack, as on the canvas today.
- Departments read as departments at a glance.

### F4 · The rest of the studio

- The same visual language on the other screens (top bar, hub tabs, panels, Runs, Monitor): CSS and
  markup only.

## How to work

- Run a studio from this worktree on its own port and state, and never touch `:8766` (the live one,
  served from `/home/thanglq/operonx-studio`):
  `OPERONX_STUDIO_STATE_DIR=<scratch>/state PYTHONPATH=/home/thanglq/operonx-studio-wt/factory-view
  /home/thanglq/operonx-studio/.venv/bin/python -m operonx_studio.cli --no-open --port 8767 <project>`
  (`--reset-password NAME` prints a password for a fresh state). Screenshot scripts with a login:
  `scripts/perf/audit.py`, `studio_login.py`.
- Run the tests: `node --test tests/js/`. The Python tests must stay green too, untouched.
- Git:
  - commit as `git -c user.name="Bruce Win" -c user.email=thanglq150189@gmail.com commit`, with no
    Co-Authored-By trailer;
  - `git pull origin main` before each commit;
  - never `git add -A` (logs/ is untracked on purpose).
- PRs and merging:
  - one branch per part, one PR per part, to studio `main`;
  - squash-merge your own verified PR right away, without waiting for CI.
- After a merge the owner restarts `:8766` (or you do: see "Restart :8766" in the memory note
  `reference_studio_public_link.md`).
- Talking to the owner:
  - answer in English: short, with one simple example;
  - work in the main session, with no subagents;
  - ask before starting another plan.

## Needs backend

Nothing yet. Anything listed here waits for the owner.

## Progress

| part | status | PR | write-up |
|---|---|---|---|
| F0 lab | not started | | |
| F1 floor | not started | | |
| F2 runs | not started | | |
| F3 overview + agents | not started | | |
| F4 rest of the studio | not started | | |
