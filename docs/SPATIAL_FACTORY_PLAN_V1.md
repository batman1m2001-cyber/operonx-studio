# OPERONX SPATIAL FACTORY (first version)

> Kept as the owner wrote it on 2026-11-15. Superseded by [SPATIAL_FACTORY_PLAN.md](SPATIAL_FACTORY_PLAN.md) wherever the two differ: no 3D, the flow view is the 2D editor, and the Factory picture is an architecture picture in four layers.
**Plan ID:** `OPERONX_SPATIAL_FACTORY_PLAN`

**Status:** F0 done (2026-11-15); F1 next

**Designer & Builder:** Fable 5.2

**Primary objective:** Transform OperonX Studio from a conventional workflow editor into a spatial environment for understanding, navigating, designing, and operating complex AI systems.

---

# 1. The owner's vision

OperonX is expected to support projects containing:

- Hundreds or thousands of workflows.
- Multiple REST APIs and WebSocket services.
- Background jobs and scheduled tasks.
- Workflows shared across multiple services and jobs.
- Nested workflows and complex dependencies.
- Multi-agent systems with tools, memory, and multiple LLMs.
- Large execution graphs containing hundreds of operations.

A conventional 2D graph editor is not sufficient as the only way to understand such a system.

When a graph becomes large, nodes spread across enormous horizontal and vertical areas. Users must continuously pan, zoom, and follow long connection lines just to understand the overall structure.

The problem becomes significantly worse when trying to understand relationships across an entire project.

**The new direction is Spatial Factory.**

Treat a project as a factory campus.

Treat its services, jobs, workflows, and agents as meaningful spatial structures.

Use pseudo-3D and isometric visualization to communicate the system's overall organization, while retaining a precise 2D environment for detailed workflow editing.

The objective is not to make everything 3D.

The objective is to make complex systems feel smaller, more organized, and easier to understand.

# 2. Core design decisions

These decisions are established design directions. Do not ask the owner to choose between alternatives.

## 2.1. Three complementary visualization levels

**Level 1 — Project Factory**

A pseudo-3D/isometric overview of the entire project.

Represents:
- Service buildings.
- Job buildings.
- Workflow zones.
- Shared workflow resources and dependencies.
- Major system relationships.
- Runtime activity.

The user should understand the overall project architecture without opening individual workflows.

**Level 2 — Workflow Factory**

A spatial overview of an individual workflow.

Large workflows should be organized into compact spatial modules rather than spreading every operation across one enormous 2D graph.

Represent:
- Processing stages.
- Logical groups.
- Parallel branches.
- Nested GraphOps.
- Agent departments.
- Input/output relationships.
- Major execution paths.

Use isometric or 2.5D visualization to communicate hierarchy and spatial organization.

**Level 3 — Detailed Flow Editor**

The existing 2D graph editor, redesigned and refined.

This remains the authoritative environment for:
- Editing individual operations.
- Connecting ports.
- Configuring nodes.
- Inspecting inputs and outputs.
- Understanding precise graph structure.
- Debugging individual operations.
- Inspecting execution traces.

These three levels must share the same underlying project and graph data.

Navigation should be flexible. Users must be able to jump directly to a workflow or component through search without navigating through every intermediate level.

## 2.2. 2D for precision, 2.5D for comprehension

Use 2D when precise positioning, connections, and configuration matter.

Use pseudo-3D when spatial grouping, hierarchy, and overall structure matter.

Do not force every interaction into a 3D environment.

Do not use true 3D or WebGL unless a compelling technical reason emerges. Prefer lightweight CSS/SVG-based isometric rendering.

## 2.3. Dark-first design

Dark theme is the primary visual direction.

- Dark is the default.
- Dark receives full design attention.
- Do not compromise Dark aesthetics to maintain theme parity.
- Light theme is optional and may be deferred.
- If implemented, Light must have its own visual language, not simply an inverted Dark palette.
- Reduce Transparency and accessibility must remain supported.

A single exceptional theme is preferable to two mediocre themes.

# 3. Factory information architecture

The proposed hierarchy:

```text
PROJECT FACTORY
│
├── SERVICE ZONE
│   ├── REST API Building
│   │   ├── Service Endpoint
│   │   ├── Workflow Dependencies
│   │   └── Shared Workflows
│   │
│   └── WebSocket Building
│       ├── Event Handlers
│       └── Workflow Dependencies
│
├── JOB ZONE
│   ├── Daily Batch Building
│   │   ├── Scheduled Tasks
│   │   ├── Workflow Dependencies
│   │   └── Execution Stages
│   │
│   └── Background Processing Building
│
└── WORKFLOW ZONE
    ├── Standalone Workflows
    ├── Shared Workflows
    └── Nested Workflows
```

This is a conceptual visualization hierarchy, not a proposal to change the backend data model.

Actual entities, relationships, and grouping must be derived from existing application data.

Do not invent Service-to-Workflow or Job-to-Workflow relationships.

If the existing data does not expose a relationship, document it under `Needs backend`.

## 3.1. Visual semantics

| Existing entity | Factory representation |
|---|---|
| Project | Factory campus |
| Service | Service building |
| Job | Production building |
| Workflow | Production line / spatial zone |
| Nested GraphOp | Block / sub-room |
| AgentOp | Agent department |
| Individual Op | Machine |
| BranchOp | Routing switch |
| Loop | Return conveyor |
| START / END | Loading docks |
| Run | Active production path |

A Service and a Job must look distinguishable at a glance.

An Agent department must be recognizable as a different type of structure from an ordinary operation.

Do not represent everything as identical rectangular boxes.

Use consistent geometry, colors, and iconography to communicate entity types.

# 4. Spatial compression and adaptive detail

**This is one of the most important requirements of the entire project.**

Large workflows must not require enormous canvases just because they contain many operations.

The current graph visualization exposes too much implementation detail simultaneously.

The new visualization must introduce semantic grouping and adaptive levels of detail.

## 4.1. Spatial grouping

Investigate ways to organize related operations into compact visual modules.

Possible grouping candidates:
- Existing nested GraphOps.
- Existing logical groups.
- Parallel processing branches.
- Agent departments.
- Processing stages.
- Repeated workflow patterns, when their structural similarity can be established.

Do not group unrelated nodes merely to improve visual appearance.

Do not silently alter graph semantics.

Where no meaningful grouping can be derived, preserve the original structure.

## 4.2. Adaptive Level of Detail (LOD)

The visualization must change its level of detail according to zoom level and available screen space.

**Far zoom — System overview**

Show:
- Spatial modules.
- Module names.
- Operation counts.
- Major input/output connections.
- High-level execution status.

Hide individual operations.

**Medium zoom — Module overview**

Show:
- Module names.
- Internal subgroups.
- Branches.
- Agent departments.
- Connection relationships.
- Important metadata.

**Close zoom — Detailed structure**

Show:
- Individual operations.
- Ports.
- Connections.
- Operation types.
- Selection and contextual actions.

The transition between levels must feel natural.

Do not merely scale down every node until its labels become unreadable.

Do not allow excessive detail to remain visible when zoomed out.

## 4.3. Connection compression

Large graphs often contain excessive connection lines.

Investigate:
- Shared entry and exit points.
- Connection bundling where relationships are unambiguous.
- Hierarchical routing.
- Compact representations of repeated connection patterns.
- Highlighting relevant dependency paths.
- Hiding secondary connection details at overview level.

Never invent, remove, or misrepresent actual dependencies.

A summarized connection must remain traceable to its underlying relationships.

## 4.4. Spatial layout

Investigate pseudo-isometric layouts with:
- Compact spatial footprints.
- Clear module boundaries.
- Meaningful depth and hierarchy.
- Minimal overlap.
- Readable labels.
- Predictable navigation.
- Clear entry and exit points.

Avoid decorative geometry that consumes space without communicating information.

Do not allow perspective to obscure important relationships.

The purpose of spatial depth is to organize information, not to create visual spectacle.

# 5. Project Factory — System topology

The Project Factory should become the primary way to understand the architecture of an entire project.

## 5.1. Factory overview

Show the project as a spatial campus containing Service, Job, and Workflow zones.

At a glance, users should understand:
- What components exist.
- How the project is organized.
- Which workflows are shared.
- Which components depend on each other.
- Where execution activity occurs.

Use semantic grouping rather than displaying hundreds of individual entities simultaneously.

## 5.2. Dependency visualization

This is a core capability.

Users should be able to select an entity and understand its relationships.

For a workflow, answer:
- Which services use it?
- Which jobs use it?
- Which workflows depend on it?
- Which workflows does it depend on?
- Is it shared across multiple entry points?

Only display relationships supported by actual application data.

Selecting an entity should highlight its relevant dependency paths while de-emphasizing unrelated structures.

Avoid turning the entire factory into an unreadable network of lines.

## 5.3. Navigation and search

A project with thousands of entities must not require users to search visually.

Provide a fast search experience that can locate:
- Workflows.
- Services.
- Jobs.
- Agents.
- Operations, when appropriate.

Search results should communicate the entity type and its location in the factory.

Selecting a result should navigate directly to the relevant building, zone, module, or detailed editor.

Preserve navigation context and provide an obvious way to return to the previous level.

# 6. Workflow Factory — Large graph visualization

The existing Flow screen should evolve into a two-mode experience.

**Overview mode**

A spatial 2.5D representation of the workflow.

The objective is to understand:
- Major processing stages.
- Parallel execution paths.
- Nested structures.
- Agent departments.
- Inputs and outputs.
- Overall flow direction.

It should remain compact even when the underlying graph contains hundreds of operations.

**Edit mode**

The detailed 2D graph editor.

Preserve and improve:
- Existing graph structure.
- BranchOp rail.
- Agent cards and fan-out stacks.
- Ports and socket shapes.
- Selection.
- Double-click inspection.
- Port lineage.
- Side panel.
- Pan and zoom.
- Run-line visualization.

A user must be able to navigate from an overview module directly to the corresponding detailed graph structure.

The overview must never become a separate, disconnected representation of the workflow.

# 7. Runtime and execution visualization

A factory should communicate not only structure but also activity.

Derive execution visualization from the existing trace and run data.

Represent:
- Running workflows.
- Active jobs.
- Failed operations.
- Completed execution stages.
- Execution paths.
- Relevant errors.

A run should illuminate the actual execution path.

The current run-line visualization must be preserved.

Do not introduce fabricated execution states or metrics.

Avoid excessive animation. Runtime highlighting should help users understand what is happening without distracting them.

# 8. Existing Studio and visual language

The redesign must preserve the established visual identity.

## 8.1. Visual language

- Dark, premium technical workspace.
- Indigo graph identity: `--k-graph`.
- Lavender routes and selection.
- Existing meaningful operation-kind colors.
- Glass surfaces using shared design tokens.
- Consistent depth, borders, shadows and radii.
- Restrained glow effects.
- Clear distinction between interactive and decorative elements.

Wire rules:
- Plain smooth curves.
- Lit 1px core over a blurred 3px halo.
- Wire type communicated by color and socket shape.
- No beads, pipes, crossties, waves, or decorative wire elements.

Selection:
- Click selects.
- Double-click opens or inspects.
- Lavender glow.
- Selection must not arbitrarily change component geometry.

## 8.2. Information density

No walls of text.

Prefer:
- Short titles.
- Numbers.
- Status indicators.
- Meaningful icons.
- One primary action.
- Contextual details.

Advanced information belongs in:
- Expandable sections.
- Tooltips.
- Hover details.
- Contextual inspection.
- `+N more` summaries.

Do not permanently display every available property.

## 8.3. Existing navigation

The left navigation has already been consolidated into five hubs under `RAIL_SLIM_PLAN`, #183/#184.

Do not redo that work.

Preserve:
- Existing screen addresses.
- Assistant screen-switching commands.
- Existing navigation behavior.
- Project and resource access.
- Existing application capabilities.

Other screens should eventually adopt the same visual language without being unnecessarily converted into spatial views.

# 9. Implementation phases

## F0 — Product and data audit

**Objective:** Understand what can genuinely be represented using existing data.

Inspect:
- Existing IR structures.
- All available project graphs.
- Existing Service data and APIs.
- Existing Job data and APIs.
- Existing run and trace data.
- Existing relationships and references.
- Existing graph rendering and layout algorithms.
- Existing frontend navigation and state.

Use real project data.

Required test datasets:
- The 13 representative runline-lab workflows.
- The large callbot workflow in `/home/thanglq/educa-reminder-agent`.
- A representative project containing multiple graphs, where available.

Produce:
- `docs/FACTORY_DATA_AUDIT.md`
- Entity inventory.
- Relationship inventory.
- Data availability matrix.
- Missing-data report.
- Initial spatial visualization proposal.

Do not start by assuming every desired relationship is available.

## F1 — Spatial Factory laboratory

Create an isolated prototype outside the Studio:

`/home/thanglq/factory-lab`

Explore:
- Isometric campus layouts.
- Workflow spatial modules.
- Compact block representation.
- Connection routing.
- Zoom-dependent LOD.
- Dark visual language.
- Navigation and drill-down.

Use actual exported application data.

Compare several layout experiments internally and select the best solution.

Do not ask the owner to choose between alternatives.

Use Playwright to capture screenshots and validate layouts.

Check:
- Module overlap.
- Label clipping.
- Connection readability.
- Spatial compactness.
- Zoom transitions.
- Large graph behavior.

The prototype must demonstrate a meaningful improvement over the existing 2D graph.

## F2 — Workflow spatial overview

Implement the selected spatial workflow representation.

Tasks:
- Integrate spatial overview into the Flow experience.
- Add overview/edit navigation.
- Implement semantic grouping where supported.
- Implement adaptive LOD.
- Implement compact connection routing.
- Preserve detailed graph editing.
- Preserve existing interaction behavior.

Keep the existing 2D canvas available until the new experience has passed regression testing.

## F3 — Project Factory overview

Implement the spatial campus.

Tasks:
- Project overview.
- Service zones.
- Job zones.
- Workflow zones.
- Building representation.
- Entity navigation.
- Grouping and visual hierarchy.
- Search integration where supported.

Do not invent missing Service or Job relationships.

If data is insufficient, document the exact limitation.

## F4 — Dependencies and navigation

Implement:
- Entity selection.
- Dependency highlighting.
- Upstream and downstream navigation.
- Shared workflow visualization.
- Direct navigation to detailed workflows.
- Search-to-location navigation.
- Context-preserving navigation.

Prioritize readability over displaying every relationship simultaneously.

## F5 — Runtime Factory

Integrate existing run and trace information.

Tasks:
- Execution path highlighting.
- Building and module status.
- Failed operation indicators.
- Run inspection.
- Trace navigation.
- Runtime status transitions.

Preserve the existing run-line visualization.

## F6 — Remaining Studio screens

Apply the refined visual language to:
- Top bar.
- Hub navigation.
- Playground.
- Prompts.
- Services.
- Jobs.
- Resources.
- Runs.
- Monitor.
- Settings.
- Assistant.

Use spatial visualization only where it improves comprehension.

Do not force Factory metaphors onto ordinary forms, tables, or configuration screens.

## F7 — Final optimization

Validate:
- Large projects.
- Large workflows.
- Hundreds or thousands of entities.
- Complex dependency relationships.
- Responsive behavior.
- Performance.
- Accessibility.
- Theme behavior.
- Navigation consistency.

Optimize rendering and layout to avoid unnecessary DOM/SVG complexity.

# 10. Frontend-only constraints

**This project must not change application logic.**

Allowed changes:
- `operonx_studio/static/**`
- `tests/js/`
- `docs/`
- Frontend-only assets and prototypes.

Forbidden:
- Any `.py` modification.
- API route changes.
- Request or response contract changes.
- Changes to the `operonx` package.
- Backend execution changes.
- Workflow semantic changes.
- Introducing new backend dependencies.

Data sources must be existing application APIs and frontend state.

The primary existing sources include:
- `GET /api/p/{pid}/ir`
- `GET /api/p/{pid}/trace/{run}/flow`

Inspect the actual frontend code for Service, Job, and other available data sources.

If data is missing, document it under `Needs backend`.

Do not add an endpoint.

Before every PR:

`git diff --stat origin/main -- '*.py'`

Must be empty.

# 11. Design and engineering rules

- Make design decisions independently.
- Do not ask the owner to choose between alternatives.
- Work in the main session, without subagents.
- Use real application data.
- Do not fabricate graph structures or runtime states.
- Do not introduce heavy rendering dependencies without justification.
- Do not over-engineer the spatial model.
- Keep pure graph-to-layout transformations testable.
- Keep the detailed editor functional.
- Prefer progressive disclosure.
- Optimize for actual usability rather than visual spectacle.

# 12. Visual validation

Each phase must produce before-and-after screenshots.

Required desktop:
- 1440×900.
- Dark theme.

Phone:
- 390px width.
- Dark theme.

Light theme screenshots are optional while Light remains deferred.

Store screenshots under:

`docs/img/factory/<phase>/`

Run:
- `node --test tests/js/`
- Relevant Python regression tests.
- Playwright visual checks.

A screenshot is not proof of functional correctness.

Test actual interactions and existing capabilities.

# 13. Development workflow

Use the designated worktree:

`/home/thanglq/operonx-studio-wt/factory-view`

Run an isolated Studio instance on port `8767`.

Never interfere with the live instance on `:8766`.

Use an isolated state directory.

Git rules:
- One branch per implementation phase.
- One PR per phase.
- Pull `origin/main` before every commit.
- Never use `git add -A`.
- Use the established commit author identity.
- No Co-Authored-By trailer.
- Verify frontend-only constraints before every PR.
- Squash-merge verified PRs into Studio `main`.

After each phase:
- Update this plan.
- Record changed files.
- Record tests.
- Add before-and-after screenshots.
- Record limitations and remaining work.

# 14. Acceptance criteria

The project is successful when:

1. A project with hundreds or thousands of entities can be understood through a spatial overview.
2. Services, Jobs, and Workflows are visually distinguishable.
3. Actual dependencies can be inspected without overwhelming the entire screen.
4. Large workflows no longer require users to navigate an enormous fully expanded graph just to understand their structure.
5. Adaptive LOD meaningfully reduces visual complexity.
6. The pseudo-3D representation improves comprehension and spatial organization.
7. Users can navigate directly from project overview to a specific workflow.
8. Detailed 2D editing remains precise and fully functional.
9. Existing run and trace capabilities continue to work.
10. The primary Dark experience feels like one coherent, professional product.
11. No backend logic, API contracts, or workflow semantics have changed.

# 15. Progress

| Phase | Status | PR | Write-up |
|---|---|---|---|
| F0 — Data audit | Done 2026-11-15 | `ui/f0-audit` | [FACTORY_DATA_AUDIT.md](FACTORY_DATA_AUDIT.md) |
| F1 — Spatial lab | Not started | | |
| F2 — Workflow Factory | Not started | | |
| F3 — Project Factory | Not started | | |
| F4 — Dependencies | Not started | | |
| F5 — Runtime Factory | Not started | | |
| F6 — Remaining Studio | Not started | | |
| F7 — Optimization | Not started | | |

# 16. Needs backend

Initially empty.

Only add items when the desired UX capability cannot be derived from existing application data.

For every item, document:
- The missing information.
- Why existing data is insufficient.
- Which visualization or interaction it prevents.

Do not implement backend changes as part of this project.

Found by F0 ([FACTORY_DATA_AUDIT.md § 6](FACTORY_DATA_AUDIT.md#6-needs-backend)):

| # | missing | why existing data is not enough | what it prevents |
|---|---|---|---|
| B1 | Which top-level or shared graph a nested GraphOp calls | the subgraph arrives inline with `name: null` | workflow → workflow dependencies and shared-workflow buildings (§5.2) |
| B2 | A job's graph when it is not a served flow | `job.graph` is absent from `ir.graphs` in 2 of 3 projects | the production line inside those job buildings |
| B3 | Named stages or groups | no such field in the IR | stage names; only structural modules are drawn |
| B4 | Live execution events | runs are polled | a building lighting up the moment a run starts |

---

# FINAL DESIGN DIRECTIVE

Think of OperonX as an intelligent production facility, not a conventional node editor.

A project is a factory campus.

Services and Jobs are distinct operational buildings.

Workflows are production lines.

Nested structures are spatial modules.

Agents are departments.

Operations are machines.

Execution is production activity.

The user should be able to understand the entire factory from a distance, enter any building, inspect its internal organization, and finally reach the precise operation they want to edit.

**Do not show everything at once.**

**Do not make the user navigate an enormous graph to understand a simple system.**

**Do not use 3D merely for decoration.**

Use spatial organization, hierarchy, adaptive detail, and meaningful visual relationships to make complexity understandable.

The final experience should feel compact, immersive, intuitive, and technically sophisticated.

**One factory. Multiple levels of understanding. One consistent underlying system.**
