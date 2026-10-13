# Run debugger — subgraph values, one trace source, a Workflow view that debugs (2026-10-13)

Three findings on the callbot (`educa_reminder_agent`), each reproduced on a
local call (`load-insp-71d649f9`, local ClickHouse) before this plan.

## What was found

| # | Finding | Evidence |
|---|---|---|
| 1 | A subgraph (`agent_turn`, any `@graph` used as an op) has no inputs or outputs in a trace. operonx never records it: `GraphOp.run` holds its inputs, outputs, start, end and error, but its `finally` emits no `OpExecution` where `BaseOp.run` does. The studio and Langfuse (`build_tree`) draw an empty container named after it. | `outer → sub → c` records `outer.p` and `outer.sub.c`, nothing for `outer.sub`. ClickHouse holds the 8 ops under `ws_callbot_pipeline.agent_turn` (×3 each), no row for `agent_turn`. The run page's row is `kind: container, op: None`. |
| 2 | The studio reads ClickHouse, else Postgres/Mongo/SQLite, else run files. Langfuse is never the primary source: its newest 50 runs are only merged into one list. The user's order is ClickHouse → Langfuse → local. | `operonx_studio/runs.py::_choose`; `app.py::traces`. |
| 3 | In Workflow, clicking an op shows nothing. The Runs tab is "dense", so its side panel starts closed, and on desktop a click opens it only on a phone. The op's executions render into a 0 px panel. The view has real value the tree lacks: the branches not taken, a turn strip, Replay, live following. But with no detail, it reads as decoration. | Browser: `greet` clicked; `#inspector` holds its executions and inputs at width 0, panel closed or not. `inspector.js:34`, `shell.js:131`. |

## Phases

**R1 — A subgraph is a step with values (operonx 1.22.3, studio).**
- **operonx:**
  - `GraphOp.run` records one `OpExecution` per run of a nested graph: `op_type="graph"`, its inputs (as `BaseOp` traces them: exclude/include, Media kept), its outputs, start, end, status, error, upstreams, at its own ctx. A streamed graph records one per item, like a generator op.
  - Not the root graph: the run already records its own input and output.
  - Not a synthetic loop graph: no author wrote it.
- **`build_tree`:** the container for `(graph path, ctx)` takes that record (`record` set, values on it), so the tree's shape is unchanged in the studio and in Langfuse. A record with no container yet becomes the container.
- **Rollups and summaries:** a graph's time contains its children's. `op_type="graph"` rows stay out of per-op rollups and "% of run time", and the run's step count names them apart.
- **Schema:** none. Same columns, one more row per subgraph run (a callbot call: about 4 on about 120).
- **Studio:** a container row with a record opens in the step panel like any step (inputs, outputs, time). An old trace's containers stay as today.
- **Callbot:** bump to 1.22.3; a call's `agent_turn` shows `agent_state` and the turn's result.

**R2 — One trace source, in the user's order.**
- The studio reads ClickHouse if the project names one. Next comes Langfuse, then local (`<project>/.operonx/runs`, a `trace_local` root, `[studio] traces`).
- Postgres, Mongo and SQLite stores, which are full stores like ClickHouse, rank with it, ahead of Langfuse.
- `[studio] runs` still overrides everything.
- **With Langfuse as the source:**
  - Runs, the run page and Review read it fully.
  - Monitor's per-op table and retention cannot, because Langfuse is read-only and refuses month-wide rollups. Those screens say so and name the fix (a ClickHouse store), never a blank.
- **With ClickHouse as the source:** Langfuse stays the second source it is today (its runs that ClickHouse lacks, badged).

**R3 — Workflow, the run debugger.**
- **Layout:** the canvas on the left and the same step panel as Tree on the right, always there (a sheet on a phone). It does not depend on the side panel.
- **Click an op:** its executions in the chosen turn, inputs and outputs, as Tree shows a step. Click a subgraph: its record (R1), then its children.
- **Turn strip and Replay drive both sides:**
  - picking a turn repaints the path and the panel;
  - Replay steps execution by execution, and the panel follows the step in focus.
- **Live:** a run still going (a Playground call) follows its newest step: the canvas lights the op, the panel shows the values as they land.
- **Lenses:** Path / Time / Errors / Cost / Values become the path plus one heat switch (time or cost). Errors are marked on the path anyway. Values live in the panel.

## Done when
- **R1:**
  - operonx tests: a nested graph's record (values, status, error, a streamed graph, root and synthetic skipped);
  - `build_tree` gives the same shape with the container holding the record;
  - rollups unchanged by graph rows;
  - a callbot call's `agent_turn` shows its values on the run page and in Langfuse's span.
- **R2:** a test project with each combination (ClickHouse only; Langfuse only; neither; ClickHouse and Langfuse) reads the source the order names, and Monitor says what Langfuse cannot do.
- **R3:**
  - in a browser, clicking an op with the side panel closed shows its values;
  - a turn pick and a Replay step move the canvas and panel together;
  - a live Playground call is followed;
  - desktop and phone, light and dark.
- Studio and JS tests pass at each phase.

## Progress

| Phase | State | Evidence |
|---|---|---|
| R1 | — | |
| R2 | — | |
| R3 | — | |
