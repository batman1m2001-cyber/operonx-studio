# Factory data audit (SPATIAL_FACTORY_PLAN F0)

2026-11-15, `main` at aab646a. Plan: [SPATIAL_FACTORY_PLAN.md](SPATIAL_FACTORY_PLAN.md).

What the Spatial Factory can draw from the data the studio already serves, checked on three real
projects through a studio from this branch (port 8767, its own state). Nothing here is assumed: every
row was read from a response.

| project | graphs | services | jobs | largest graph |
|---|---|---|---|---|
| runline-lab | 13 | 0 | 13 | `kitchen_sink`: 17 ops, 22 edges, 2 nested graphs, 2 agents |
| educa_reminder_agent (the callbot) | 2 | 3 (websocket, http, asgi) | 2 | `ws_callbot_pipeline`: 26 ops, 28 edges, 3 branches, 2 nested graphs |
| meeting-prep-brd | 2 | 2 (http) | 1 (eval) | `on_email`: 4 ops on top, 11 nested graphs up to 3 deep, 6 agents |

Not inspected: mr-finance (14 flows, 67 routes). It is the owner's live project and the standing rule
is not to open it from another studio. It is the only project here with one flow behind many routes,
so F3 is checked against it only through the same fields (`variants`, several services per graph).

## 1. Sources

| source | gives |
|---|---|
| `GET /api/p/{pid}/ir` | the whole project in one response: `graphs`, `services`, `jobs`, `resources`, `application` |
| `GET /api/p/{pid}/flows/stats?days=7` | per top-level graph: `runs`, `errors`, `daily[7]`, `avg_ms` |
| `GET /api/p/{pid}/runs?…` | recorded runs, filterable by origin (service, job, playground, eval) and name |
| `GET /api/p/{pid}/trace/{run}/flow` | one run laid on its graph: which ops ran, their status and time |
| `state.ir`, `state.graph`, `FlowRail.items()` | the same data already in the page |

## 2. Entities

| entity | where | fields that matter for drawing |
|---|---|---|
| Project | `ir` | `name`, `description`, `application` |
| Workflow (top-level graph) | `ir.graphs[]` | `name`, `nodes`, `edges`, `entries`, `exits`, `loops`, `width`, `height`, `variants` |
| Service | `ir.services[]` | `name`, `kind` (http, websocket, asgi), `path`, `port`, `session`, `workers`, `graph`, `job` |
| Job | `ir.jobs[]` | `name`, `kind` (job, eval), `graph`, `items`, `reduce`, `description` |
| Op | `graph.nodes[]` | `kind` (FuncOp, LLMOp, BranchOp, GraphOp, AgentOp, TTSOp, EmitOp, Vector…), `name`, `inputs`, `outputs`, `resource`, `routes`, `loop`, `is_gen`, `serve_role` |
| Nested graph | `node.graph` on a GraphOp | a whole graph inline (`nodes`, `edges`, …), `subgraph_ops` count; nests to any depth |
| Agent | `node.agent` | `name`, `model`, `tools[]` (name, kind op/graph, readonly, approval, target), `limits` |
| Edge | `graph.edges[]` | `src`, `dst`, `type`, `soft`, `back` (a loop's return), `route`, `origin` |
| Resource | `ir.resources` | `keys` (`llm:triage`, `vector_store:docs`, …), `details`, `env` |

## 3. Relationships

| relationship | available? | how |
|---|---|---|
| Service → workflow | **yes** | `service.graph` = `module:graph`; the name after `:` matches `ir.graphs[].name` (as `flowrail.js` already does, variants included) |
| Service → job | **yes** | `service.job` |
| Several services → one workflow (a shared entry) | **yes** | group services by their graph |
| Job → workflow | **partly** | `job.graph` is a graph name. It matches `ir.graphs` in runline-lab (13 of 13) and in neither of the other two projects (`golden_case`, `check_case`, `backfill_log` are not served in `ir.graphs`) |
| Workflow → nested graph | **yes** | `node.graph`, inline |
| Workflow → another top-level workflow (reuse) | **no** | a nested graph arrives inline with `name: null`; nothing says "this is `on_approve` used inside `on_email`" |
| Op → resource | **yes** | `node.resource` (a name or a list), against `ir.resources.keys` |
| Workflows sharing a resource | **yes** | derived from the row above |
| Agent → tools | **yes** | `node.agent.tools[]`, each with its `target` |
| Agent tool → workflow | **partly** | a tool of `kind: "graph"` has a `target` (`module:name`); it resolves only when that graph is in `ir.graphs` |
| Workflow → runs, errors, speed | **yes** | `/flows/stats` |
| Service or job → runs | **yes** | `/runs?origin=…&name=…` |
| A run → the ops it executed | **yes** | `/trace/{run}/flow` |
| Which runs are executing now | **partly** | a run with status `running` in `/runs`; there is no push, the page polls |
| Logical groups or stages inside a flat graph | **no** | the IR has no group or stage field |

## 4. What can be grouped without inventing anything (plan §4.1)

Derivable from structure alone, so a module always maps back to real nodes:

1. **A nested GraphOp** is a module. Its inside is `node.graph`.
2. **An agent** is a department: the AgentOp, its model and its tools.
3. **A branch** is a switch with one lane per route: the nodes reachable from one route edge up to
   the point where the lanes meet again.
4. **A fan-out** (one op feeding several that join later) is a set of parallel lanes.
5. **A loop** is the nodes between a back edge's target and its source.
6. **A chain** of ops with one way in and one way out, between two of the structures above, is a
   stage. It gets no invented name: it is labelled by its first and last op and its count
   (`greet … frames · 5 ops`).

Not derivable: named stages ("ingest", "decide"), and repeated-pattern detection beyond identical
structure. Neither is drawn.

## 5. Scale

No project on this machine has hundreds of workflows. The largest real inputs are 26 ops in one graph
and 13 graphs in one project. For F1 and F7 the scale checks use a **stress set made by repeating
these real graphs** under numbered names (`kitchen_sink#041`). It lives in `factory-lab` and in tests
only, is labelled as generated wherever it appears, and is never shown as a project's data.

## 6. Needs backend

Recorded here and in the plan's §16. None is worked around.

| # | missing | why existing data is not enough | what it prevents |
|---|---|---|---|
| B1 | The identity of a nested graph (which top-level or shared graph a GraphOp calls) | `node.graph.name` is null and the subgraph is inlined | "Which workflows depend on this workflow", shared-workflow buildings, workflow → workflow lines (plan §5.2). Until then a nested graph is drawn inside its parent only |
| B2 | A job's graph when it is not a served flow | `job.graph` names a graph that is absent from `ir.graphs` in 2 of 3 projects | Drawing the production line inside those job buildings; the building shows its name, kind, items and runs, and says the line is not available |
| B3 | Named stages or groups | no such field | Stage names; only structural modules (§4) are drawn |
| B4 | Live execution events | runs are polled | A building lighting up the moment a run starts; status is as fresh as the last poll |

## 7. Initial spatial proposal

- **Project Factory (level 1).** Three districts on one isometric ground: services, jobs, workflows.
  A service is a building whose shape says its kind (http, websocket, asgi), a job a longer shed, a
  workflow a low platform whose footprint grows with its op count. A line joins a service or a job to
  the workflow it runs, because that relationship is real. Resources sit at the edge as utilities;
  selecting one lights the workflows that use it. Height is not decoration: it is 7-day runs, and a
  red cap means errors in the same window.
- **Workflow Factory (level 2).** The graph collapsed to its modules (§4): one block per nested
  graph, agent, branch lane, parallel lane, loop and chain, laid out in flow order on an isometric
  floor. A block shows its name, its op count and, with a run loaded, its status. Blocks keep the
  op-kind colours; wires between blocks are one bundle per pair, with the count of real edges on it.
- **Detailed editor (level 3).** The existing canvas, unchanged in behaviour. Opening a block lands
  on the same nodes, selected and fitted.
- **Level of detail** is one continuous zoom on the workflow: blocks → blocks with their subgroups →
  the real op cards. The far level hides ops instead of shrinking them.
- **Rendering:** SVG and CSS transforms on a 2:1 isometric grid. No WebGL, no new dependency.
