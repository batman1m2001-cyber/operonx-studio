# Run line plan — the Workflow view as a line beside the step

The run page's **Workflow** view borrowed the Flow tab's canvas: it moved
`#stage` into the run pane, painted each card with the run (lenses, heat,
agent steps), and moved it home on leaving. Owners found it confusing: the
cards are the editor's, the run is hidden in them, and the step panel is a
sheet beside a scrolled canvas. The Timeline and Tree views were fine.

The replacement is a **run line**: the flow drawn as a metro line (a commit
graph) — one row per op in the order the run reached it, lanes for forks and
joins, a fading lane for a route not taken — beside the selected step's real
data (the panel the Tree view already uses). It follows the flow's shape; in a
big flow it dims what is not around the selected step and scrolls.

Prototyped and checked in `~/runline-lab` (13 flows covering every node type
and shape: chains, n-way branches, no match, fan-out/in, 3-level nesting,
loops, a capped loop, streams, LLMOp, AgentOp with graph tools, retry,
timeout + on_error, a raised error, races on soft edges, EmitOp, invoke(),
vector ops, and all of them nested in one flow; 21 views × 2 themes).

## Audit — what the Workflow view is today

- `runpage.js` `showRunWorkflow(run)` (≈120 lines): picks the run's graph
  (`graphForRun`), borrows `#stage` (`state._stageHome`, `state.flowHome`),
  paints agent steps (`paintSteps`, `AgentSteps.withSteps`), sets
  `state.run / runByOpTurn / runRollups / heatMax / runTurn / runSteps /
  runFocus`, `state.workflowOn`; the step panel `#wfstep` (`renderRunStep`,
  `runStepRows`, `innerRunRows`), the stepper (`runStepper`, `stepBy`,
  `focusStep`, ← → keys), `landOnAgent`, `walkErrors`, `leaveWorkflow`.
- `canvas.js` reads `state.run` (≈30 places) to paint cards with the run:
  lens colours, heat borders, values, turn picks.
- `inspector.js` (`#wfstep` routing), `runview.js` (`lensBar`, `focusOp`,
  `walkErrors`, `render`), `studio.js` (`pushView` mode), `shell.js`
  (`open_run`, follow-newest) call into it.

## Steps

**W1 — the layout, pure.** `static/runline.js` (`RunLine.layout(graph, rows,
{turn, errors, open})`, `RunLine.around`): flatten the graph (open GraphOps
that have a shape), attach the run's rows to stations (executions, retries,
LLM / tool calls, invoke, errors, pre-1.22.3 subgraphs by their inner ops),
drop back edges (loops), sequence by when the run reached each station
(a group's rows contiguous), branch routes, join waits and races, then the
lanes. Tests in `tests/js/runline.test.mjs` on small hand-made graphs: every
station once, groups contiguous, a wire is "ran" only between stations that
ran, order follows the run, one route per branch, an error is drawn.

**W2 — the view.** `static/runlineview.js` (`RunLineView.show(run)`), the
Tree view's frame (`.rt` root, `runHeader`, turn strip, `.rt-split` with a
resizable `.rt-step`): left the line (SVG lanes + one row per station: name,
kind chip, what happened — routes, waits, races, retries, ×n, failed — took,
a when-bar on the run's time axis, a legend); right the station's summary
(status, why it did not run, routes, waits, attempts) above the existing
`renderExecPanel` for its execution (chips when it ran more than once).
↑ ↓ move, the address keeps `?view=workflow&step=`. Colours: wires and bars
GraphOp indigo (`--k-graph`), routes lavender, kinds from the studio's
kind colours. `showRunWorkflow` becomes `RunLineView.show`; `focusOp`,
`focusExec`, "Next error" and `pushView` route to it. A run whose graph is
not drawn keeps the "Open as tree" note.

**W3 — the canvas comes home for good.** Remove the canvas borrowing and the
run paint that only the old view used: the stage move, `paintSteps`,
`landOnAgent`, the stepper, `#wfstep`, `renderRunStep`, the lens bar, and
`canvas.js` / `inspector.js` branches on `state.workflowOn` / `state.run`.
The Flow tab never shows a run.

## Gates

- `node --test tests/js/` green (the new tests included).
- Screenshots, dark and light: the lab's kitchen_sink, branchy (a route not
  taken), failures (retry + on_error + raise), loop_cap (stopped) on a studio
  pointed at `~/runline-lab`; one real project run (meeting-prep-operonx).
- The Flow tab after visiting a run: its own graph, unpainted.
