# operonx: ops, graphs, layout, traces

## operonx in one page

operonx is a Python dataflow framework: **ops** (units of work) wired
into **graphs**; a scheduler runs ops when their inputs arrive.

Op kinds you will meet (exact APIs — verify in the installed source):
- **FuncOp** — a plain function made an op with the `@op` decorator.
  `@op(transient=True)` marks ports whose values are evicted after
  consumption (streaming audio etc.).
- **GraphOp** — a graph nested as a single op; has declared input/
  output ports; its members execute per dispatch.
- **BranchOp** — routing: `if_(...)` / cases with conditions, plus a
  default. Footgun: a Ref-vs-Ref comparison inside `if_()` silently
  captures the right side as a literal — compute booleans in an @op.
- **LLMOp** — `LLMOp.of(...)`; structured mode available. Footgun: the
  `user=` and `validators=` parameters can silently kill the LLM turn.
- Resource-backed ops: EmbeddingOp, RerankOp, VectorSearchOp,
  DocFetchOp; audio ops (STT/TTS/denoise) in projects that use them.
- Generator ops stream (yield); streaming consumption is sequential by
  default. A trace's "Slow op" duration on a generator is CUMULATIVE
  across yields, not first-frame latency.

Other gotchas: `None` does not bind to an input (the op won't fire);
declared cells — long-running ops can't read cells, cell inputs are
traced; the root graph is named after the engine variable; use
`operonx.LOGGER`, never `print()`.

## Project layout

A project is a directory with an `operonx.toml` manifest:
- `[project]` — name, entry module.
- `[serve]` — how the graph is served (transports are an extension
  point; `operonx-serve` runs it).
- `[studio]` — `traces = "<dir>"` (where runs are recorded),
  `ingress = [...]` / `egress = [...]` (the ops that face the outside).

Convention: every project exposes ONE main served graph
(ingress → flow → egress), usually named `main_flow`.

Projects have their own venv (`.venv`, uv-managed). Run things through
it: `uv run pytest ...` from the project root, or
`.venv/bin/python ...` — bare `python3` misses the deps.

## Traces

The `[studio] traces` directory holds one subdirectory per run; each
contains `nodes.jsonl` — one JSON record per op execution with fields
like `op_name`, `op_full_name` (dotted path), `ctx` (dispatch context —
GraphOp members share it), `status`, `duration_ms`, `start_time`,
`inputs`, `outputs`. Read these to answer "what actually happened on
run X". Large values may be truncated at write time (media threshold);
that is by design.
