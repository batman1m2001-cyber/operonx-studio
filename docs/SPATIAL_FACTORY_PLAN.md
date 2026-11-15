# OPERONX FACTORY PLAN

**Plan ID:** `OPERONX_SPATIAL_FACTORY_PLAN` (refactored 2026-11-15)

**Status:** F0–F3 done. F4 is next.

**The first version of this plan**, as the owner wrote it, is kept word for word in
[SPATIAL_FACTORY_PLAN_V1.md](SPATIAL_FACTORY_PLAN_V1.md). This file replaces it wherever the two differ.

---

## 1. What changed, and why

The lab (F1) tried five spatial looks on real data. The owner rejected all five:

| tried | why it failed |
|---|---|
| isometric tiles | a flat dashboard with perspective |
| a 3D galaxy of shapes | scattered objects, hard to read |
| the 2D layout bent in space | a circuit board, tiny cards |
| stations and towers round a core | unrelated buildings, not the project |
| the flow graph tilted in space | 2D cards with a tilt, not 3D and not better than 2D |

Two things came out of that, and they reshape the plan:

1. **The owner's decisions (2026-11-15).** No 3D. The flow view is the studio's existing 2D editor.
   The united Factory picture stays. The first plan is still the plan, refactored.
2. **The real problem is the architecture, not the rendering.** Every rejected picture showed the
   flows as separate objects, because the data records no link from one flow to another. The links
   that exist are inside the flows: the same sub-graphs and ops are used by several of them. A picture
   that does not show those shared parts has nothing to connect, in any style.

**A second change, the same day (2026-11-15).** F3 was first built as the 2D picture this plan asked
for: four columns of cards with wires between them. On mr-finance (90 services, 24 jobs, 14 flows) the
owner judged it too tangled to read, whatever the wiring (one wire per pair, then buses, then zones and
bundles). At that density he reversed the "no 3D" decision **for the Factory picture only**: the
project is drawn as one isometric model, and 2D stays for a single flow. §3 below is the decision as it
now stands. The 2D picture is kept, unmerged, on the branch `ui/f3-factory-picture`.

## 2. Goal (unchanged)

A person opens a project and understands it as one system without opening each flow: what comes in,
which flows handle it, what those flows share, and what they depend on. It has to hold for a project
of hundreds or thousands of flows. From the picture they reach the exact flow, and edit it in the
editor they already know.

## 3. Decisions

These are fixed. Do not ask the owner to choose between alternatives.

- **Two levels, not three.** The Factory picture (the project) and the Flow editor (one flow). The
  middle level of the first plan, a spatial overview of one workflow, is dropped: the 2D editor is the
  flow view, unchanged.
- **The Factory picture is an isometric 3D model; a flow is 2D.** A core in the middle holds what the
  flows share (shared blocks) and need (resources); every flow is a cluster of parts round it, one part
  per op (past 30 flows a cluster is a domain, one part per flow); doors are small parts on a cluster's
  outer edge; links are cables in bundles from a cluster to the core. A fixed isometric camera: pan,
  zoom and fit, never a free orbit. The five looks in §1 failed as free 3D scenes of unrelated objects;
  this one is a fixed drawing of the model in §4.
- **Titanium is the material, colour is a signal.** Parts are machined titanium (natural, silver,
  dark, graphite) with glass panels; a part of each kind has its own construction, not its own colour.
  Colour appears only as small lights, in the flow canvas's own lavender and blue; red is an error.
  The colours are the `--fx-*` tokens in `static/factory.css` and nowhere else; no global token changes.
- **It is an architecture picture.** Its job is to show how the parts of a project connect. Anything
  on it that is not an entity or a relation of the project does not belong.
- **Real data only.** Every box is an entity the studio already serves; every line is a relation read
  from it or derived from it by a stated rule. A relation the data does not carry goes under
  [Needs backend](#9-needs-backend), and is not drawn.
- **Dark-first.** Designed and checked in Dark only; Light is deferred (UX_OVERHAUL_PLAN, theme strategy).
- **Frontend only.** No change to `.py`, API contracts or workflow semantics.

## 4. The architecture model

Four layers, top to bottom, the way work moves through a project:

```text
DOORS          services (http, websocket, schedule, asgi) and jobs: how work comes in
   │
FLOWS          the top-level graphs
   │
SHARED BLOCKS  sub-graphs and ops that more than one flow uses: the project's real core
   │
RESOURCES      models, stores and other declared resources
```

| relation | source today | note |
|---|---|---|
| service → flow | IR: `service.graph` | |
| schedule → job | IR: `service.job` | a schedule service runs a job |
| job → flow | IR: `job.graph` | absent when the job's graph is not a served flow (B2) |
| flow → shared block | **derived**: nested graphs of the same op functions, kinds and wiring are one block; ops defined at the same file and line are one op | one named identity needs B1 |
| flow → resource | IR: `node.resource`, nested graphs included | |
| flow → flow | not in the data | B1 |
| grouping (domain) | IR: the module in `graph.entry`, e.g. `pages.graph:pages_flow` → `pages` | |

Checked on mr-finance (a copy of the repository, read with the studio's own extractor):

| layer | what is there |
|---|---|
| doors | 90 services (66 http, 22 schedule, 1 websocket, 1 asgi) and 24 jobs |
| flows | 14, in 13 domains; `pages_flow` alone holds 36 ops on one level |
| shared blocks | 8 blocks, 4 of them shared between flows: one nested graph of 9 ops (`held_*`) is used 11 times by 4 flows, and three op functions are each used by 2 flows |
| resources | 8 declared, 3 of them used by a flow, each by one flow |
| unresolved | 13 jobs run `market_flow`, which is not among the 14 flows (B2) |

So on a real project the shared blocks are what ties the flows together, and resources tie almost
nothing. The first plan's hierarchy (service zone, job zone, workflow zone) had no place for them.

## 5. Scale rules

The picture must stay one screen of meaning at 14 flows and at 3,000.

- **Group before drawing.** Flows are grouped by domain; a domain is one box with counts until it is
  opened. Doors are grouped by the flow they lead to (`pages_flow` ← 9 services, not 9 boxes).
- **One line per pair.** All relations between two boxes are one line with a count.
- **Selection is the filter.** Selecting a box shows its own upstream and downstream and quiets the
  rest; nothing else needs to be hidden by hand.
- **Unresolved is shown, not dropped.** A door whose flow the data does not list sits in a marked
  group ("runs a graph the IR does not list").
- **Search goes to the place.** Find a flow, service, job or block by name; the picture opens its
  group and selects it.

Test data, in `/home/thanglq/factory-lab/data`: the real exports (runline-lab, callbot, meeting-prep,
mr-finance) and generated stress projects of 200, 1,200 and 3,000 flows (`gen.py`). Generated projects
are copies of real graphs under made-up names and are labelled as generated wherever they are shown.

## 6. Phases

One branch and one PR per phase. Before every PR `git diff --stat origin/main -- '*.py'` is empty.
Screenshots in Dark. Each finished phase gets a write-up linked from [Progress](#8-progress).

### F0 — Product and data audit (done)

[FACTORY_DATA_AUDIT.md](FACTORY_DATA_AUDIT.md). mr-finance was not inspected then; §4 above adds it.

### F1 — Lab (done, closed)

Result: the five spatial looks in §1 were rejected and removed; the lab keeps the test data, the
generator and two pure modules. Findings carried into this plan: the model in §4, the scale rules in
§5, and that the studio's layout engine runs unchanged outside the studio.

### F2 — The factory model

A pure module, no UI: `factorymodel.js` turns the IR (and flow stats) into the four layers, their
relations with counts, the domains, the derived shared blocks and the unresolved group.

- Node tests on the real exports and on the 1,200-flow generated project.
- A written check against mr-finance: the numbers in §4 come out of the module.
- Done when: the module answers, for any entity, "what leads here" and "what does this lead to".

### F3 — The Factory picture (done)

The project as one isometric model, drawn from the factory model and nothing else. Write-up:
[FACTORY_PICTURE.md](FACTORY_PICTURE.md).

- Where it lives: the Flow hub. The flows rail's first row is "Project picture"; choosing a flow, in
  the rail or by its name on the picture, opens the 2D editor as today.
- Built first as a static page in the lab on mr-finance and on the generated 1,199-flow project; the
  owner reviewed it there through five rounds (layout, then material, then colour) before it was wired.
- It costs nothing until opened: three.js (vendored, 0.7 MB) and the scene are imported on first use.
- Left for F4: selecting a part (upstream and downstream), opening a flow from a domain cluster,
  search. Left for F5: runs on the picture beyond the red light of a flow with errors.

### F4 — Dependencies and navigation

- Select: upstream and downstream highlighted, the rest quiet; a side card lists them with counts.
- Open: a flow box opens that flow in the editor; coming back returns to the same place and selection.
- A shared block lists the flows that use it and opens any of them at the block.
- Search-to-location.

### F5 — Runtime

From data the studio already serves (`/flows/stats`, runs): runs and errors per flow on the picture,
a failing flow visible from the top level, a link to its runs. The run line in the editor is unchanged.
Live updates are not part of this (B4).

### F6 — Remaining Studio screens

Most of the first plan's F6 was done by UX_OVERHAUL_PLAN (U0–U6). What is left is a check that
Services and Jobs link into the picture (a service row → its place on it) and back.

### F7 — Scale and polish

The 1,200 and 3,000-flow projects: first paint and interaction stay responsive; phone width; keyboard
reach for select, open and search.

## 7. Acceptance criteria

1. A project with hundreds or thousands of flows can be understood from one picture.
2. Services, jobs, flows, shared blocks and resources are told apart at a glance.
3. What a thing depends on, and what depends on it, can be read without the rest crowding it.
4. The parts several flows share are visible as shared.
5. From the picture, any flow is two actions away, and opens in the 2D editor.
6. The 2D editor, runs and traces work exactly as before.
7. The picture belongs to the same product as the flow canvas in Dark: its lights are the canvas's lavender and blue.
8. No backend logic, API contract or workflow semantics changed.

## 8. Progress

| phase | status | PR | write-up |
|---|---|---|---|
| F0 — Data audit | Done 2026-11-15 | #204 | [FACTORY_DATA_AUDIT.md](FACTORY_DATA_AUDIT.md) |
| F1 — Lab | Done 2026-11-15, closed: its five looks dropped | lab repo, to 2e41956 | §1, §4, §5 of this file |
| F2 — Factory model | Done 2026-11-15 | `ui/f2-factory-model` | [FACTORY_MODEL.md](FACTORY_MODEL.md) |
| F3 — Factory picture | Done 2026-11-15 | `ui/f3-factory-iso` | [FACTORY_PICTURE.md](FACTORY_PICTURE.md) |
| F4 — Dependencies and navigation | Not started | | |
| F5 — Runtime | Not started | | |
| F6 — Remaining screens | Not started | | |
| F7 — Scale and polish | Not started | | |

## 9. Needs backend

Not built by this plan. Each item says what the picture cannot show without it.

| # | missing | why existing data is not enough | what it prevents |
|---|---|---|---|
| B1 | Which graph a nested GraphOp is | the sub-graph arrives inline with `name: null` | exact shared blocks (today matched by their op names) and flow → flow lines |
| B2 | A job's graph when it is not a served flow | `job.graph` names a graph absent from `ir.graphs` (13 of 24 jobs in mr-finance) | those jobs' place under a flow; they sit in the unresolved group |
| B3 | Named stages or groups | no such field in the IR | stage names inside a flow |
| B4 | Live execution events | runs are polled | a box lighting up the moment a run starts |
| B5 | A declared area for each service, job and flow (a convention, owner 2026-11-15) | areas are guessed from the module path, and a service or job has one only through the flow it runs | exact zones: today a door with no flow has no area, and two modules of one business area are two domains |
