# UX audit (UX_OVERHAUL_PLAN U0)

2026-11-15. Baseline of `main` at 4180fd1, before any change. Plan: [UX_OVERHAUL_PLAN.md](UX_OVERHAUL_PLAN.md).

How it was made: a studio from this branch on its own port and state, three real projects
(meeting-prep-brd: agents and 22 recorded runs; educa_reminder_agent: the callbot, a 26-op flow;
runline-lab: 13 flows, one per graph shape). Every screen was shot at 1440×900 and 390×844, dark and
light: 25 screens × 4 for the first project, the Flow and run screens for the other two. No page threw
a JavaScript error. Contact sheets of the baseline are in [img/ux-overhaul/u0/](img/ux-overhaul/u0/).

## The five findings that matter most

### 1. On the Flow screen the flow gets 43% of the screen, and a real flow does not fit

At 1440 px the canvas keeps about 626 px. The flows list takes 310 px and the assistant 420 px, and
both are open by default.

| 5 ops: fits | 17 ops: cut on both sides | 26 ops (the callbot): 13 of 28 cards visible |
|---|---|---|
| ![5 ops](img/ux-overhaul/u0/flow-5-ops.webp) | ![17 ops](img/ux-overhaul/u0/flow-17-ops.webp) | ![26 ops](img/ux-overhaul/u0/flow-26-ops-callbot.webp) |

- The landing zoom never goes below 70%, on purpose: below it a name is under 7 px. So a flow larger
  than about 12 ops opens as a fragment, and nothing on screen says how much is missing or where.
- Closing both panels by hand is not enough for 17 ops: ![closed](img/ux-overhaul/u0/flow-17-ops-panels-closed.webp)
- The graph runs under the panels instead of being placed in the free area.
- There is no overview and no level of detail. A card looks the same at every zoom, so zooming out
  makes it unreadable instead of simpler.

### 2. A card is big for what it says, and its shape carries no meaning

- An op is a 126×41 px oval (at 70%) that shows one word and an icon. The oval wastes its corners,
  so a row of six ops is 950 px wide.
- One 5-op flow shows three shapes: ovals, dashed boxes (ingress, egress) and stacked ovals (a
  fan-out). The shape does not tell the kind; the colour and icon already do.
- The smallest text on the canvas is 5.6 px on screen (`collect`, `*` on a wire).

### 3. The assistant's empty conversation is on almost every screen

"What should we work on?" with the same two or three suggestions takes 420 px on Flow, Playground,
Prompts, Services, Jobs, Review, Alerts, Environments, Storage and Project settings. On the Project hub
it is there twice in spirit: the hub's own chat, and the panel. It is the largest single thing on
most screens and, until the user asks something, it says nothing about the screen.

![flow hub](img/ux-overhaul/u0/flow-hub.webp)

### 4. Detail-level text sits at the top level

Examples, each the first thing under a page title:
- Runs: `files at /home/…/.operonx/runs` and `the default: no [tracing] or [studio] runs in operonx.toml`.
- Services: a two-line explanation of what a listener is.
- Alerts, Resources, Storage (Retention), Jobs (a records path): the same pattern.
- A run page's header is four lines of small facts before the first step: took, cost, LLM calls,
  tokens, steps, date, eval, item, run, code, slowest, most expensive.

The plan's rule (level 1, 2, 3) puts all of these at level 2 or 3.

### 5. The styles grew without a scale

Counted in `studio.css` (6,189 lines, 440 tokens):

| | distinct values | the scale that exists |
|---|---|---|
| font sizes | 36 (12px ×88, 11.5px ×62, 11px ×60, 12.5px ×51, 10.5px ×24 … down to 6.5px) | `--fs-xs … --fs-2xl`, used in 335 of 689 places |
| font weights | 10 (450, 550, 650 among them) | none |
| border radii | 49 | `--r-xs … --r-lg`, used in 165 of 450 places |
| box shadows | 101 | none |
| paddings | 222 | none |
| hard-coded colours outside the tokens | 183 hex, 92 rgba | 440 tokens |
| z-index values | 25 (up to 9001) | none |
| transition durations | 23 | none |

The screens look related because they share the glass and the lavender, not because they share sizes.
Page titles, for example, are a different size and weight on Board, Git, Files, Runs and Monitor.

## Screen inventory

Change classes: **S** simplify, **F** refine, **R** restructure, **E** expand.

| screen | purpose · primary action | must stay visible | can move to level 2/3 | problems | change |
|---|---|---|---|---|---|
| Home | pick or start a project · open one | the composer, the project list | the four suggestion cards after the first project exists; the path under a project name | the project list, the reason most visits happen, is below the fold on a phone | F |
| Login, Team | sign in · manage members | the form | | fine; follow the U1 scale | F |
| Project › Now | talk to the assistant about the project | the conversation, what needs the owner | "Nothing waits for you / Nothing is in progress" (two empty headings) | a third of the width for two empty sentences | S |
| Project › Board | see the plan's cards | the columns and cards | the "ask the assistant…" paragraph | the assistant panel repeats the Now screen | S |
| Project › Git | review and ship changes | the changed files, the diff | Fetch/Pull/Push when nothing is to push | file names are cut at 30 characters while the diff pane is empty | F |
| Project › Files | read a file | the tree, the file | | "Pick a file." in a large empty pane | F |
| Project › Terminal | run a command | the terminal | | an empty bordered box until one is opened | F |
| **Flow** | understand and edit a flow · select an op | the graph, the selected op | the flows list (when one flow, or after picking), the assistant, the canvas help | findings 1 and 2 | **R, E** |
| Playground | try a service · Send | the payload, the reply | Connection, Conditions, "Events" and "Recent sessions" explanations | the reply area is a narrow column of explanations until the first send | R |
| Prompts | edit a prompt and try it on real samples | the prompt, the samples, then/now | sample metadata lines | the prompt box shows 4 lines of a long prompt; then/now columns are narrow | F |
| Services | start and stop listeners | each listener, its state, Start | the explanation paragraph | the Environment warning is repeated on Playground and Resources | S |
| Jobs | run a job, see its runs | the job list, Run, the last runs | the records path | | S |
| Runs | find a run | filters, the list | the storage path and config note | finding 4; the filter row is wider than the list it filters | S |
| Run page (tree, timeline, workflow) | see what happened and where it failed | status, the steps, the selected step's data | the four header lines except status, took, cost | the three views differ little at first sight; the first step starts 213 px down a 900 px screen | F, S |
| Review | mark runs good or bad | the run's answer, Good / Bad | labels and notes until a verdict is chosen | the answer is raw JSON in a small scrolling box | F |
| Evals | run an eval, compare experiments | the eval list, scores | "Score store files + SQLite · default…" | | S |
| Monitor | see health over time | the charts | | empty state is fine | F |
| Alerts | define alert rules | the rules | the explanation paragraph | | S |
| Resources | see and add models and stores | each resource, its state | the explanation paragraph | a missing key is shown here, on Services and on Playground with three different looks | F |
| Environments | deploy and operate hosts | the host, its services, Deploy | Work there, Variables, Commands (each a form that is always open) | the densest screen: 33 controls visible at once | R |
| Storage | retention | the five rows, Save | the "Runs" facts table (stored in, chosen by, backend) | titled "Settings" under a tab called "Storage" | S |
| Project settings | standard and git policy | the rows | | fine | F |
| Assistant panel | ask for work | the composer | the empty-state heading, paragraph and suggestions | finding 3 | **R** |
| Top bar, rail, hub tabs | where am I, go elsewhere | project, hub, tabs | the flow picker outside the Flow hub | the flow name shows on every hub, though only Flow and Runs use it | F |

Phone (390 px): the frame already reorganises well (hub tabs under the header, the assistant as a bar
at the bottom). The problems are the level-1 text of finding 4, which costs a full screen height on
Runs and Services, and the run page header, which pushes the first step to 43% of the screen height.
![phone](img/ux-overhaul/u0/phone-dark.webp)

## What must be preserved

Checked present in the baseline; each is a regression test for the phases:

- every address in `router.js` (`/p/<pid>/<screen>[/<run>]?view=…&step=…&op=…`), and the assistant's
  screen-switch actions that go through `performUi`;
- the canvas: pan, zoom, fit, find, click selects, double click opens an op's data, port lineage, the
  BranchOp rail, agent cards, fan-out stacks, opened GraphOps, loops;
- a run: tree, timeline, workflow (the run line), the step's input and output, formatted and JSON;
- both themes, Reduce Transparency, keyboard focus, the phone layout;
- 24 `tests/js/*.test.mjs` files and the Python tests, green.

## Backlog, in order

| # | change | class | the problem it solves | phase |
|---|---|---|---|---|
| 1 | One scale for type (6 sizes, 3 weights), radius (4), shadow (3), spacing (4 px grid), motion (3 durations), z-index (named layers); replace the literals with it | F | finding 5 | U1 |
| 2 | One page header: a title, at most one line of facts, the actions on the right; one empty state; one warning banner | F | titles and empty states differ per screen | U1 |
| 3 | The Flow canvas owns the screen: the graph is fitted into the free area; the flows list becomes a picker that opens on demand; the assistant is closed until asked for | R | finding 1 | U2 |
| 4 | Compact rectangular op cards, one shape for every kind; kind by colour band and icon; ingress, egress and fan-out as a mark on the card, not another shape | R | finding 2 | U2 |
| 5 | Levels of detail, the factory idea made useful: far out, a GraphOp or an agent is one labelled block (a zone) with its counts, and ops are small labelled chips; close in, the full cards. A minimap shows where the view is | E | a flow over ~12 ops cannot be read whole today; zooming out only shrinks text | U2 |
| 6 | The assistant's empty state shrinks to the composer plus one line; suggestions come on focus | S | finding 3 | U3 |
| 7 | Level-1 text moved to an info popover or `<details>` on every screen named in finding 4 | S | finding 4 | U3–U5 |
| 8 | The run page header: status, took and cost in one line; the rest behind "Details" | S | the first step starts 213 px down | U4 |
| 9 | Environments: Work there, Variables and Commands collapsed until opened | R | 33 controls at once | U5 |
| 10 | One missing-key notice, shown the same way on Resources, Services and Playground | F | three looks for one fact | U5 |
| 11 | Phone and tablet pass, Reduce Transparency, keyboard | F | | U6 |

On the pseudo-3D factory: the audit gives it one real job, item 5, the far-out overview where
blocks stand for zones. It will be drawn flat first with depth only as shading. An isometric tilt would
turn the labels and hide wires behind blocks, which the plan's own rules forbid ("spatial depth must
never obscure connections or labels"). If the flat overview reads well, depth stays a visual accent.

## Needs backend

Nothing.
