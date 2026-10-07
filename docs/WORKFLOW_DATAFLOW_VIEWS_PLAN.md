# Workflow and Data Flow views — plan

Branch `feat/workflow-dataflow-views` (from main f61b0d5). Page-side only:
no IR, backend, layout-engine or execution change.

## 1. What exists (analysis)

| Concept | Where it lives today | Drawn? |
|---|---|---|
| Node | IR `graph.nodes[]`; `opCard()` builds the card | yes |
| **ControlEdge** `a → b` | IR `graph.edges[]` → `FlowLayout.layout()` → `L.wires`, drawn by `render()` as beams (`energyEdge`) | yes, the canvas |
| Control port | `.port.in` / `.port.out`, top and bottom of a card | yes |
| **DataBinding** `M.out → N.in` | IR `node.inputs[i].binding = {kind: "ref", from, output}` | **no** (inspector text only) |
| Graph input | a `ref` whose `from` is the graph itself | no |
| SCRATCH read | `binding = {kind: "scratch", key}` | no |
| GraphOp export | IR `graph.exports[] = {from, output, as}` | no |
| Literal / unset | `binding.kind = "literal" / "unset"` | no (not data flow) |

The model already keeps the two relationships apart. The page draws only one.
Nothing in the architecture blocks the design: no rewrite needed.

## 2. Model (new, page-only)

`dataBindings(graph, expanded) → DataBinding[]`, a pure function over the IR:

```
DataBinding = {
  from: {kind: "op" | "input" | "scratch", key, port},   // key = card key, "" for root
  to:   {key, port},
  id,                                                     // stable, for highlight
}
```

Opened GraphOps: a binding into or out of an opened GraphOp resolves through
its inputs/exports to the op inside (shown as two hops, never hidden).
Pure and unit-tested (`tests/js/dataflow.test.mjs`).

## 3. Views

A segmented control at the head of the canvas toolbar: **[ Workflow | Data Flow ]**.
Key `D` toggles. The choice is per project (localStorage).

### Workflow (default)
- The canvas exactly as today. No data drawn.
- **Select a node → its data, only.** The selected card grows a *port
  tray* (its bound inputs on the left, outputs on the right). Each partner
  node gets a small *port tag* docked on its side naming only the involved
  port. One labelled connector per binding: partner tag → tray row.
  Everything else dims a little. Esc or a click on the canvas: back to clean.
- **Broadcast sources** (graph inputs, SCRATCH) are never wired: the tray
  row says where the value comes from (`START.conversation`, `scratch.clock`).

### Data Flow
- Control edges fade (≈15 %, no sparks, no direction dots). Layout and
  positions do not change: the user's mental map survives the switch.
- Every card shows its **bound ports** as rows: inputs left, outputs right.
  Unbound ports are not listed.
- **One connector per node pair** (output side → input side), weighted
  by how many values it carries; its label lists them on hover. Never one
  wire per binding.
- Broadcast sources: chips on the reading port row, not wires.

### Port lineage (both views)
Click a port row, tag or connector:
- an **input port**: its source (op output, graph input or scratch key),
  then that source op's own inputs, one level further, dimmer;
- an **output port**: every reader of it.

Everything else dims. Click again or Esc to clear.

## 4. What does not change

Execution, IR, `flowlayout.js` routing, beams, runs and live replay, and the
inspector (its Ports section stays the full text record).

## 5. Order

1. Model + toggle (Workflow looks exactly as before).
2. Workflow: selection → tray, tags, connectors.
3. Data Flow: port rows, pair connectors, faded control.
4. Port lineage.
5. Light and dark, phone, then the gates.

## 6. Gates

- `node --test tests/js/*.test.mjs` (model tests), studio pytest suite.
- `scripts/perf/layout_audit.py … --widths --touch --sheets`: 0 errors.
- Screenshots after each step, desktop 1440 and phone 390, light and dark,
  on callbot `ws_callbot_pipeline` (large), qc-snatcher `qc_flow` (GraphOps)
  and meeting-prep.

## 7. State and backlog (2026-10-07)

**Built so far** (branch commits, latest first): START/END/SCRATCH terminals,
clickable (click → every op its values reach opens, wires drawn, rest dimmed;
Esc/click again closes); one trunk per terminal; routing that never crosses a
card (shares a lane before it would); 16px wire clearance; wider layout gaps
when data shows; GraphOp frames reserve side room for two-hole pass-through
plates; lineage routes first and hides other wires; hover peek = faint
edge-to-edge wires, no tags. Last full audit (scratchpad `ds/audit.py`, 502
states): 470 clean — only shared lanes left, mostly qc_flow.

**Next, in order:**

1. ~~One split point per source~~ — **done (2026-10-07).** A variable
   read by one op is a plain wire. A variable read by several runs as ONE
   line to its hub — a ring in the channel above its first reader, off every
   card, control edge and other hub — and splits there once: lanes left
   (farthest reader on top), right (mirrored) and down; siblings never meet
   again. Variables never share a hub.
   **One variable at a time** (decided after the all-at-once START view
   proved a hairball): an open START/SCRATCH/END lights every reader's hole
   and wires only the variable under the pointer, or the one clicked; a
   selected op with more than 5 wires does the same with its plugs. Wires
   carry one glowing comet each (bright head, soft tail), source → reader at
   ~2.6x the control dots' speed (follows the Direction toggle and
   reduced-motion).
2. ~~INGRESS/EGRESS door frames count as obstacles~~ — done.
3. ~~Generator ops as a 3D stack~~ — done: two empty copies of the card
   stepped 6px down-right behind it.
4. qc_flow dense fan-in: more frame spacing when plates show, so shared
   lanes become free lanes.
5. Gates: full `ds/audit.py` (0 card-crossings/overlaps), `layout_audit.py`,
   JS tests + studio pytest, phone 390 + light theme screenshots → PR.
