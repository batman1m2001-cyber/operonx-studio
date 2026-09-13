# Traces Refactor — time, state, and the run as the unit

The flow view answers "what is this system?". A painted trace should
answer "what HAPPENED?" — and today it only half-does: durations tint
the cards, a waterfall lives in a separate view, scratch state is
invisible, and the inspector buries per-run values under wiring info.

Three asks drive this refactor (user, 2026-09-13):

1. **Trace the Scratch** — the state of each step, not just op I/O.
2. **Timeline canvas** — keep the workflow's structure, but relocate
   the ops that ran onto a vertical ms axis: when did each run start,
   how long did it hold the flow.
3. **Run-first trace panel** — input/output VALUES of each execution,
   first-class, because a generator op runs many times per trace.

---

## What the records already give us (measured, not assumed)

One run = `<traces>/<run>/meta.json + nodes.jsonl + media/`. Each
`nodes.jsonl` line is one EXECUTION:

```
op_id "engine.stt#main.[3]"     ← op + dispatch ctx: re-runs are distinct
start_time / end_time / duration_ms   (monotonic seconds, µs precision)
status ok|error|cancelled + error
inputs {name: value}            ← full recorded values
outputs {name: value}
upstreams [{from_op_id, from_key, to_key}]  ← exact provenance per input
```

So: **(2)** and **(3)** are pure studio work — the data is already
there, including which execution fed which. The real callbot cases
(184 executions / 46 s call) are the fixture.

**(1) is the gap**: `workflow_trace.py` records OpExecutions only.
Nothing anywhere records a cell write. Scratch state must either be
reconstructed or recorded.

---

## Phase 0 — settle the scratch question (evidence, then a decision)

How does a value get INTO a cell at runtime?

- If every scratch write is a **declared binding** (`op["x"] >> S["y"]`
  style, visible in the IR the way `PARENT.*` exports are), then the
  studio can REPLAY state: walk executions in start-time order, apply
  recorded outputs through the declared write-bindings, and the scratch
  state after every step falls out — **zero operonx changes**.
- If ops can write cells **imperatively inside their body**, replay is
  blind to those writes, and honesty requires recording: an additive
  event in the recorder — `{"kind": "cell", "cell", "value",
  "writer_op_id", "ts"}` appended to the same jsonl, behind an opt-in
  flag, old traces still parse.

Deliverable of P0 is a one-page answer with the operonx source lines
that prove it, and the A-or-B decision. **Option B touches operonx
core — it ships only with explicit approval, as its own tiny PR,
nothing else riding along.**

## Phase 1 — scratch state per step

Whichever path P0 picks, the studio ends up with one thing: a **state
timeline** — `[{after: op_id, cells: {name: value}, changed: [names]}]`,
served by `GET /api/p/{pid}/trace/{run}/state` (computed server-side,
cached; values go through the same clamp rules as the value renderer —
a 3 MB audio buffer in a cell must become a size token, not a payload).

UI:
- Inspector, trace painted: a **Scratch** section on every execution —
  the state as of that step, changed cells highlighted, unchanged ones
  folded.
- The flow-info panel (nothing selected): final state of the run, with
  a step scrubber.

## Phase 2 — the timeline canvas (time-warp mode)

Not a second page — the SAME canvas, warped. With a run painted, a
toggle (`Flow ⇄ Timeline`, hotkey T) relocates ops onto a vertical time
axis:

- **y = start time** on a ms axis drawn at the left edge — ticks,
  labels, and a ruler that follows the cursor. 46 s of call with µs
  gaps needs a **piecewise-compressed axis**: dense bursts get room,
  idle gaps collapse into a marked break (`≈ 12.4 s idle`), labels stay
  true ms.
- **x = the op's flow-layout lane**, unchanged. That is what keeps the
  workflow's shape readable while time reorders the vertical — the
  structure survives, sequence becomes literal.
- **One card per EXECUTION**, not per op: `stt` that dispatched 9 times
  is 9 slim instance cards in `stt`'s lane, each sized by its duration
  (min-height clamped; a 0.1 ms op is still clickable). The card reuses
  the cell visual, slimmed (name + ctx + ms).
- **Edges = recorded provenance**: draw the `upstreams` links between
  instance cards — the dataflow that actually happened, not the static
  possibility. Static wires fade to a ghost layer. Energy beams reused.
- Ops that never ran: parked, dimmed, in a thin strip — same dormancy
  language as today.
- Selection stays in sync across the toggle: pick execution #3 in
  timeline mode, flip to flow mode, the op is selected with run #3
  active in the panel.

Perf gate: 184 executions renders trivially; the timeline endpoint caps
at 3000 spans today — instance cards inherit the cap, plus windowed
rendering if a fixture proves it necessary (measure first).

## Phase 3 — the run-first trace panel

When a run is painted and an op (or instance) is selected, the panel
leads with executions, not wiring:

1. **Run picker** — every execution of this op: ctx, start (run-relative
   ms), duration, status. Generators show their dispatch fan honestly.
2. **The selected execution**: inputs and outputs as VALUES (the
   existing values.js renderer), each input chip linking to the
   upstream execution that produced it (provenance jump — click
   `transcript ← stt#[3]` and land on that instance).
3. **Scratch at this step** (from Phase 1).
4. Wiring (ports/links) folds below — it is reference, not the story,
   once a run is painted.

No selection + run painted: run summary, error list with jump, final
scratch, step scrubber.

## Phase 4 — verification and tests

- Python: state-replay unit tests (tiny graph fixture with known cell
  writes); endpoint tests incl. the value-clamp guarantee; cap
  behaviour.
- JS: axis compression is a pure function → `tests/js/timeline.test.mjs`
  (gap collapse, tick placement, min-height clamp, ctx sort).
- Playwright: the four recorded callbot cases screenshot-verified in
  timeline mode (busy-then-join is the generator-heavy one); fleet
  audit stays 18/18 in flow mode.

## Order and size

P0 (half a day, produces a decision) → P2 (the big visible win, ~2-3
sessions) → P3 (1 session) → P1 (depends on P0's answer; replay ≈ 1
session, recorder path adds the operonx PR + approval gate).

P2 before P1 on purpose: the timeline is pure studio work on data that
already exists, while scratch may block on the core question — the
refactor should not idle behind it.

## Decisions I need from you

1. **Instance cards vs stretched op**: one card per execution (above) —
   or one card per op stretched from first start to last end with
   beads for each run? Plan assumes instance cards.
2. **Scratch recording**: if P0 finds imperative writes, do you approve
   the additive operonx recorder event (Option B)?
3. **Axis**: compressed-with-marked-breaks (assumed) vs strictly linear?
