# Flow canvas auto-layout — audit and hotfix plan

Status: **done 2026-09-27: audited, 14 findings, all fixed; results in
§6.** Branch `feat/assistant-first` (after 73c2c9f). The audit harness
`scripts/perf/layout_audit.py` is the gate before any canvas change.

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

## 6. Results

The audit ran as planned: 13 projects, every graph, and 328 cases at
desktop, phone (390 px) and tablet (768 and 1024 px) widths. Every case
was checked by geometry and screenshotted. All 52 contact sheets were
then read by eye.

- **Before:** 12,636 error findings.
- **After:** 0 error findings and 0 warnings.

Two of the findings (F12 and F13) came from the eye review, not the
checks. Every cause below was confirmed by a measurement or a repro
before its fix.

### 6.1 Findings and fixes

**F1: the reported bug.** A render while the canvas is hidden measured
0.
- *Repro:* 3 of 4 paths put `is_audio`'s ports at (±1, 0) and left the
  card at its guessed 260 px (268 px when measured). The logged render
  showed `shown: false, tab: traces`. The baseline had 392 port findings.
- *Everyday triggers:*
  - leaving a run's **Workflow view for Flow** (`leaveWorkflow()` renders
    before `switchTab` shows the stage);
  - a **code change landing while another tab is open** (pulse →
    `load(false)`);
  - opening a page with `#assistant=` (focus mode).
- *Fix (HF1):* `render()` defers while `#stage` has no client rects. The
  canvas is drawn at the end of `switchTab("flow")`, and a
  `ResizeObserver` catches any other way it comes back. `load(first)`
  fits the view once the canvas shows.
- *Fix (HF2):* a row that measures 0 wide gets no port.

**F2: wires detached from their ports, on every project at the landing
zoom.**
- *Cause:* below about 85% zoom, cards are 48–51 px tall, but
  `it.h = max(64, measured)` kept the layout's 64 px guess. Every wire out
  of such a card started 14 px below its port dot.
- *Measured:* 5,909 model-versus-card findings and 6,139 wire-end
  findings in the baseline.
- *Fix:* `it.h` is the measured height.

**F3: members hung out of their container** (ex05 `graded`: its END
knob at y 2726, its members down to 2770).
- *Cause:* the END knob stood in the gap between two members, shared no
  column with them, and so was not pushed down with them. The
  container's height follows the knob.
- *Fix:* END is kept under the lowest member (`withBoundaries`' rule).

**F4: the flow's END pill landed on a card** (loopy: `ag` and END
overlapped by 66×13). The exit's tie also ran straight through that card.
- *Fix:*
  - START and END are placed clear of every card in their column,
    before the extent is computed;
  - ties are routed like any other wire (`routeAvoiding`);
  - ties go knob to knob, not box to box (deepnest: 24 px off).

**F5: a router wire to a target directly beneath it** curved back
through the router's own card (loopy, ex05 `route_1`).
- *Fix:* the wire steps out beside the card and below its bottom before
  dropping into the target.

**F6: Find picked "router" when "out" was typed.**
- *Fix:* an exact name wins, then a name that starts with the text, then
  one that contains it; among equals, the shallowest.

**F7: switching graphs left the side panel on the previous graph**
(loopy showed "deepnest").
- *Fix:* `renderFlowInfo()` and `pushView()` run on the switch.

**F8: the "Replaying … done" pill rode back to the Flow tab.**
- *Cause:* `leaveWorkflow()` stopped the replay quietly, and a quiet stop
  never hides the pill.
- *Fix:* a normal stop.

**F9: a short near-vertical hop blocked by a card bowed about 270 px
out, and out of its container** (loopy's END tie, ex05 `route_1 → END`).
The fixed bow sizes were too coarse for a card sitting low in a short
gap.
- *Fix:*
  - a side step: a lane just past the blocking card, then back;
  - a container's side walls count as obstacles for its members' wires
    (a new `escape` check covers this).

**F10: the run header's origin line was pushed off the right edge.**
Affected: every job, eval, service and playground run, in the Tree and
Workflow views.
- *Cause:* `.tlorigin { flex-basis: 100% }` was written for a row header.
  In the column-direction `.runhead` it made the line as tall as the
  header, and the wrap moved it into a second column (measured at
  x 1046, 172 px tall).
- *Fix:* `.runhead` doesn't wrap, and the line's basis is `auto`.

**F11: a loop's return wire left its container** (ex09's `loop`: its
peak 16 px past the wall, the "↺ loop" label outside).
- *Fix:* an opened graph with a loop keeps room on its right for the
  return and its label. The knobs stay centred over the content.

**F12: two neighbours grown to the width cap stood 6 px apart** (310 px
cards in 316 px slots).
- *Fix:* a row keeps 16 px between cards. The wider ones give width back
  about their centres, never below the slot's 260 px. A cut name shows
  in full on hover.

**F13: a run's Workflow view opened at the top-left corner**, and the
Flow tab lost its view afterwards.
- *Cause:* moving the canvas into the run pane resets its scroll; hiding
  it does not.
- *Measured, phone:* 3 of 27 cards on screen in the run view; back on
  Flow, scroll 419 → 0 (9 → 6 cards on screen).
- *Measured, desktop:* scroll 182 → 0.
- *Fix:*
  - the run pane fits its own box (`initView(true)`, the saved view left
    alone);
  - the Flow view (zoom and scroll) is remembered when the tab is left
    and restored exactly when the pane gives the canvas back.

**F14 (a guard against a race, not observed):** the Flow view is saved
500 ms after scrolling stops. The delayed save now re-checks that Flow
is still showing, so it can't store a run pane's scroll.

### 6.2 Checked, and left as they are

- **Phone landing view.** The phone opens the flow at 70%, centred, with
  its sides cut. That is the landing rule (readable over whole), not a
  defect.
- **Port dots without a wire.** A decision row whose route is a loop
  return or an exit shows its port dot with no wire. The loop return
  leaves from the card's flank. This is a design question.
- **Runs from other graphs.** A job run of a graph that isn't on the
  canvas (the `params` graph of a job) paints every card faded.
- **The edge project's long names.** Its `longnames` graph first used
  short instance names (s, a, b…), so the long function names never
  reached a card. It now uses long instance names; the width cap and
  name-cutting are exercised.

### 6.3 Evidence that nothing else moved

- **Geometry.** Dumped at 3 zooms for callbot, educa_reminder_agent,
  ex05, big300 and the edge project, committed code against the fix:
  - at 100%: callbot changed 0 cards and 2 wires (the ties now route knob
    to knob); big300 is identical;
  - at 60% and 35%: wires start at the real card bottoms (F2), and
    container END knobs sit 13–14 px higher;
  - ex05: its END knob and egress drop 59 px (F3), and `agent` widens
    for its loop (F11);
  - the edge project: only its two capped neighbours changed (F12);
  - no card's x position changed anywhere else.
- **Render cost is unchanged:**

  | Project | Committed | Fixed |
  |---|---|---|
  | callbot | 46–52 ms | 47–50 ms |
  | big300 | 123–210 ms | 116–134 ms |
  | ex05 | 32–34 ms | 32–35 ms |

  Zoom frames: p50 16.6 ms, no long tasks.
- **Checks:**
  - the reported-bug repro gives correct ports and widths on all paths;
  - `flows.py`: 21/21;
  - studio tests: 479 passed.

### 6.4 The gate

```
scripts/perf/layout_audit.py http://127.0.0.1:8766 <out> --widths --touch --sheets
```

- It covers 13 projects and 328 cases in about 5 minutes, and exits 1 on
  any error finding.
- `--touch` writes a probe file into scratch projects only.
- `--sheets` writes contact sheets for the eye review; the checks cannot
  see "looks wrong".
