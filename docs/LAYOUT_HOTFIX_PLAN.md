# Flow canvas auto-layout — audit and hotfix plan

Status: **plan written 2026-09-27; the audit is not run yet, nothing
fixed yet.** Branch `feat/assistant-first` (after 73c2c9f).

Written for the next session: the user saw a "weird layout" on the Flow
canvas and asked for a full audit of the auto-layout, played as a UI/UX
tester — normal cases, edge cases, bug-prone states, each one
screenshotted — and then a hotfix plan. The context was compacted right
after this was written.

## 1. The reported bug

Screenshot (educa_reminder_agent, the `is_audio` decision card): both of
the card's condition wires leave from its **top-left corner** instead of
from their row's port dot. The dashed `else` wire then cuts diagonally
**across the card** to reach its dot on the right.

**Diagnosis. This is a hypothesis from reading the code; it has not been
reproduced yet** (a repro run was interrupted):

- `render()` measures each decision row with `rrow.offsetLeft`,
  `offsetTop`, `offsetWidth` and `offsetHeight`, and stores the result
  as `it.condPorts`. A condition wire starts at
  `A.x + condPorts[t].x, A.y + condPorts[t].y`.
- If `render()` runs while the canvas is **not displayed** (`#stage` is
  `display: none` on every tab except Flow and the run workflow view),
  every offset is 0. The port becomes (−1 or +1, 0) — the card's
  top-left corner. That matches the screenshot exactly.
- The same hidden render skips the width pass (`laidOut.shown` is
  false) and keeps the 64 px guessed heights. So names can come out
  truncated, and rows are parted from guesses. **Nothing re-renders
  when the canvas is shown again**, so the damage stays.
- Ways a hidden render happens:
  - the pulse sees a code change while the user is on another tab
    (`load(false)` calls `render()`);
  - an expand or collapse triggered from elsewhere;
  - a semantic zoom level change scheduled with `requestAnimationFrame`
    just before a tab switch;
  - any other `render()` call made while
    `state.tab !== "flow" && !state.workflowOn`.
- Also check: `#world.dataset.zoom` changing while the canvas is
  hidden.

**Repro to run first** (Playwright, `scripts/perf/`):

1. Open `/p/9595297a4df8`.
2. Read `condPorts` of `is_audio`.
3. Switch to Runs, call `render()`, switch back to Flow.
4. Read `condPorts` again and screenshot the card. Expected: all ports
   at about (±1, 0).

Also repro the real trigger: touch a `.py` file in the project while the
Runs tab is open, wait for the pulse, go back to Flow.

## 2. How the layout works (for whoever fixes it)

1. **Server** (`operonx_studio/layout.py`, `app.py:_placed`): Sugiyama
   minus crossings-polish.
   - Layers come from the longest path, ignoring edges the author wrote
     as loop returns.
   - Rows are ordered with barycentre sweeps (6).
   - A router with 3 or more same-row targets has its right half
     mirrored.
   - Nodes sit in fixed slots (`NODE_W` 260, `H_GAP` 56, `V_GAP` 78),
     and a gap grows by 12 px for every long edge beyond two crossing
     it.
   - Three alignment passes pull children under their parents.
   - Nested graphs are laid out recursively.
2. **Client** (`static/studio.js`):
   - `placeGraph` (recursive): an expanded container widens every node
     in its x column and its y row (`extraX`/`extraY` shifts);
     `withBoundaries` puts START/END knobs on the container.
   - `flattenModel` produces absolute coordinates.
   - `render()` then:
     - steps serve doors up or down by 70 px when the lane is clear;
     - puts the cards in the DOM;
     - runs the **width pass** (measured, batched; a card is 180–310 px
       and keeps its slot centre);
     - runs the **height and port pass** (the `condPorts` above);
     - **parts the rows** (`partRows` — deepest containers first, then
       the top level; a row whose boxes collide with the ones above is
       pushed down, keeping a 46 px gap);
     - computes the extent (START is 96 px above the entries, END below
       the exits);
     - draws the wires (`bezier`, `routeAvoiding` with lanes,
       `returnPath` for loops, condition wires from their row, a
       masked repaint over decision cards);
     - draws the door zones and the START/END ties.
   - Semantic zoom re-renders once each time the zoom level changes
     (`hi` ≥ 0.85, `lo` ≤ 0.45; the name font grows at mid and far zoom,
     since R4).

## 3. The audit, to run

**Harness to write:** `scripts/perf/layout_audit.py`. It has the same
login and base URL as the other scripts, and writes one JSON report and
screenshots per case.

**Projects** (studio at :8766):

| pid | Project | What it exercises |
|---|---|---|
| 3d65b3e448e4 | callbot | serve doors, 2 decisions, nested graphs, generators |
| 9595297a4df8 | educa_reminder_agent | the reported card `is_audio`, nested graphs |
| c3d87c6cae2e | branchy-demo | a 6-way router on both sides |
| 5f5c06a34d20 | ex05 loops and branches | loops, a nested agent loop |
| d5e0f6b8b653 | ex13 graph | nesting, composition |
| adbca90511ee | ex09 agent | |
| 67155a45bfd6 | ex11 parallel | |
| 0c745df89ed3 | ex06 streaming | |
| af28abc41e22 | p6demo | a WebSocket door |
| 64121f45b5db | p8demo | 3 graphs |
| aa5476d3b0b9 | big300 | 302 ops, 20 chains |
| 4efc1a6a2c78 | ex18 variants | |
| **0a8872a2074a** | **layout-edges** — built for this audit (`scratchpad/p12/edge`) | the edge cases below |

`layout-edges` has seven graphs, picked with the `#graph-pick` select:

- `longnames`: 40+ character names, a fan-out and fan-in;
- `router8`: 7 conditions plus `else`, one target a nested graph;
- `deepnest`: nesting 3 deep beside a plain op;
- `loopy`: an authored loop with a branch;
- `lonely`: an op with no edges;
- `fanin12`: a 12-way fan-in;
- `single`: one op.

It extracts cleanly.

**Scenarios per project and graph:**

1. The landing view (fitted).
2. Expand all nested graphs.
3. Collapse them again.
4. Zoom to `hi` (1.2), `mid` (0.7) and `lo` (0.4) — each change
   re-renders.
5. **Render while hidden**: switch to Runs, `render()`, back to Flow.
6. A code change lands while on another tab (touch a file, wait for
   the pulse), then back to Flow.
7. A run painted in the workflow view, with the time and values lenses
   (badges change card heights).
8. A replay running (the live classes must not move anything).
9. Phone (390 px) and tablet (768, 1024) widths.
10. The side panel opened, closed and resized, then Fit.
11. Selecting a node, then `centerOn` or find (`/`).
12. For multi-graph projects, switching graphs with the picker.

**Checks computed in the page, per case.** Take real rects from
`#nodes` children (`style.left/top`, `offsetWidth/Height`):

- **Ports:** any `condPorts` or `condDots` entry near (≤ 2, ≤ 2).
- **Overlaps:** cards at the same depth (not containers) whose rects
  overlap, and any gap under 8 px.
- **Containment:** every member inside its container, knobs on its
  border.
- **Wire ends:**
  - a wire's first point should be within 6 px of the source's port —
    the bottom centre, a row dot, or the END knob of an expanded
    container;
  - its last point within 6 px of the target's top centre or START
    knob.
- **Wires through cards:** sample 40 points per path
  (`getPointAtLength`); count points strictly inside a card that is not
  one of the wire's ends (inset 4 px). Report the count and which pair.
- **Names cut:** `.ntext` with `scrollWidth > clientWidth + 1`
  (expected only past the 310 px cap).
- **Extent:** every card and knob inside `state.extent`; START and END
  visible.
- **Door zones:** the frame around each gate, and no other card
  inside it.
- **Loop returns:** the return path stays inside the extent (it
  bulges into the right margin).
- **Stability:** the geometry after a re-render with nothing changed
  equals the one before (determinism).

Screenshot every case (desktop, plus phone for 1, 2 and 5), then read
them all by eye — the checks cannot see "looks wrong".

## 4. Hotfixes (first two already clear; the rest as the audit finds)

- **HF1: never lay out an invisible canvas.** At its top, `render()`
  checks whether `#stage` is displayed (`offsetParent !== null`, or
  `state.tab === "flow" || state.workflowOn`). If it isn't, it sets
  `state.renderPending = true` and returns. `switchTab` into Flow,
  `showRunWorkflow`, and leaving assistant focus (`body.ax-focus`,
  where `#stage` is also hidden) then run a pending render — plus
  `initView()` if the view was never initialised.
  - **Keep in mind:** code that reads `state.rendered` while the canvas
    is hidden. `performUi("select_op")` switches the tab first, so that
    is fine; `liveCanvas` returns when the tab isn't Flow. Check the
    callers of `state.rendered` and `state.cardEls`.
  - **Test:** the repro in §1, and the code-change-on-another-tab case.
- **HF2: belt and braces for ports.** In the port pass, if a row
  measures `offsetWidth === 0`, do not record `condPorts` or
  `condDots`: the wire then falls back to `routeAvoiding` from the
  card's port, and it is marked for a re-render.
- **HF3: the audit harness as a gate.** The invariants in §3 (ports,
  overlaps, containment, wire ends, extent, determinism) must hold on
  every project, graph and scenario. The script exits non-zero on a
  failure, so it can run before every canvas change.
- **HF4 onward:** each finding from the audit gets:
  - its case (project, graph, scenario);
  - a screenshot;
  - its cause, confirmed from evidence;
  - a fix and an invariant that would have caught it.

  Candidates to look at, from reading the code (not confirmed):
  - `partRows` groups rows by `Math.round(it.y)`: a door stepped ±70 px
    starts a row of its own.
  - Door stepping checks clashes against guessed heights, before
    measuring.
  - `extraX` widens the whole x column for one expanded container.
  - Two widened neighbours are only 6 px apart (310 against a 316 slot).
  - A condition wire's target is an expanded container: its `START`
    knob and its name lookup in `condPorts`.
  - `routeAvoiding` lanes in dense rows (fanin12, big300).
  - Rows parted at `hi` versus `lo` zoom (fonts differ since R4).

## 5. Rules for the fix

- Confirm each cause with evidence before changing code (the user's
  standing rule).
- Keep the geometry-identical check (`scratchpad/ux/geometry.py`,
  4 projects × 3 zooms) green for everything that is not meant to
  change, and regenerate the baseline only for an intended change.
- Screenshots before and after on desktop and phone, the studio test
  suite (479) green, and commits as Bruce Win with no co-author line.
