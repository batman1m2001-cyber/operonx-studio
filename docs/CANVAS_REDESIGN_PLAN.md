# A canvas you can read at any size (CANVAS_REDESIGN_PLAN)

Status: C1 built (2026-11-13): the backdrop, clear glass for ops and for the frame. C2 built (2026-11-13): the agent card in the ops' glass, with its run state. C3–C4 not started.

Owner's brief:
1. **Liquid glass background.** Dark mode is deep charcoal with a hint of lavender; light mode is pearl with lavender-blue reflections. The graph stays readable.
2. **Agents that scale.** No decorative purple shapes around agents inside GraphOps. Use compact AgentOp nodes with clear labels, ports and execution states. GraphOp headers show Agent and Op counts. Large groups (for example, 10 agents) can be collapsed.
3. **Keep the architecture.** Both themes, no mock data, no duplicate components, no needless effects.

Owner's feedback on the mocks:
- The first glass looked cloudy. It is now clear, with a thin tint of the op's kind.
- The navy dark background made the lavender ops sink into it. It is now graphite with only a hint of lavender.
- The light background was too pale. It now has more lavender.
- The logo sat crudely in the middle-left. It is now a glass glyph in the bottom-right corner, where a graph rarely reaches.
- The top, left and right bars should be as clear as the canvas bar.

## C1 · Backdrop and clear glass (built)

| Dark | Light |
|---|---|
| ![dark](img/canvas/c1-flow-dark.png) | ![light](img/canvas/c1-flow-light.png) |

| Second project | Phone | Reduce Transparency |
|---|---|---|
| ![second project](img/canvas/c1-second-project-dark.png) | ![phone](img/canvas/c1-phone-light.png) | ![solid](img/canvas/c1-solid-dark.png) |

What changed (all in CSS, in the C1 sections at the end of studio.css and studio-dark.css):
- **Backdrop.** `static/canvas-bg-{light,dark}.webp` (31 KB and 37 KB, 2560×1440) sit under a softened dot grid on the Flow screen's `#stage`. They are generated from [img/canvas/backdrop.html](img/canvas/backdrop.html): an SVG with `?m=dark|light`, shot at 2560×1440 and saved as WebP at quality 0.86. There is no external asset.
- **Op glass on the backdrop.** The `--og-*` tokens are overridden on `#stage` only, not on `:root`. Other screens, and Reduce Transparency, keep the frosted ops. Light uses a 12% white fill and a 2% kind tint. Dark uses a 1.5% fill and a 9% kind tint, so on graphite the kind colour is what makes an op stand out. Blur is 2px. An opened GraphOp is a 2% tint, with a glass header.
- **Frame.** The top bar, rail, flows panel and side panel take the canvas bar's clear tint, with a 12px blur (`--glass-blur-frame`). Before, they used frost at 24px. The side panel's reading area is 45% of the surface, down from solid.
- **Faint text on glass.** `--text-3` becomes `--glass-text-3` on the canvas and in the flows panel.

Gate, measured on the pixels behind each text with the text hidden:
- Every text is at 4.9:1 or better, in both themes. This includes the agent subtitle: it was 4.06 before, and 3.81 with the new backdrop before the `--glass-text-3` fix. The only exceptions are the decorative "/" and "·" separators, and a top-bar "Live" label that measures the same on main.
- The canvas was checked on meeting-prep-brd and meeting-prep, at desktop and phone widths, and in Reduce Transparency.
- `node --test tests/js/` and pytest pass.

## C2 · One compact agent node (built)

| Dark | Light |
|---|---|
| ![dark](img/canvas/c2-flow-dark.png) | ![light](img/canvas/c2-flow-light.png) |
| ![second project dark](img/canvas/c2-second-project-dark.png) | ![second project light](img/canvas/c2-second-project-light.png) |

States on real meeting-prep-brd runs (done: 03ffb4fa; failed and skipped: 650e3842, where the email agent's model call failed and the run stopped there):

| Done | Failed | Skipped |
|---|---|---|
| ![done](img/canvas/c2-run-done-light.png) | ![failed](img/canvas/c2-run-failed-dark.png) | ![skipped](img/canvas/c2-run-skipped-light.png) |
| ![done](img/canvas/c2-run-done-dark.png) | ![failed](img/canvas/c2-run-failed-light.png) | ![skipped](img/canvas/c2-run-skipped-dark.png) |

What changed:
- **The card is an op.** `.ag2` takes the `--og-*` glass of `.node.cell` (edge, fill, spec, rim, drop, blur); the kind colour is only in the 62px icon band. `.agentframe` lost its purple border and fill: an opened agent is a container like any other, its mark the icon in its title.
- **Run state in the header pill.** `ag2-st` now says at work (`turn 2 / 8`), done (`3 turns`), failed (`failed · 1 turn`, red) or skipped (dashed, when a finished run never reached the agent). Failed is read from the run's records: the agent's own record or any step under it (`turn → model`) — not from `runNumbers`, which is keyed by op name and would blame an agent for its same-named GraphOp. The card's edge follows the cells' `live-active` / `live-done` / `live-failed`.
- **The error badge sits inside the card**, under the title, not across its bottom border.
- **Shared fix:** `.badge.err` ink is 80% `--err` into `--text`. On the C1 clear glass the pure red read 4.0:1, on every op.
- The subtitle is `--text-2` (it read 4.1:1 on the card's band).

Gate, measured as in C1 (text hidden, the 1st/99th percentile of the pixels behind each text):
- Flow, meeting-prep-brd: 5.09 light, 5.56 dark. Flow, meeting-prep: 5.73 light, ≥6.1 dark (one card measured 4.07 where the flows panel covers half of it; the crop shows the panel's text, not the card's).
- Run, failed: 4.78 light, 4.53 dark. Run, done: 6.02 light, 5.81 dark.
- Not met, by design: a skipped card is faded to .35 like every op a run did not reach, so its text reads 3.8–4.2:1.
- Not shot: the live `turn n / cap` pulse. It needs a live run, which costs model credit; the card takes the cells' `live-active` class, set by the same motion code.

Today, an agent inside an opened GraphOp is the `.ag2` card. It has a purple border at 46% and a purple fill, so it is the one card that does not look like the ops around it. An opened agent is `.agentframe`, which also has a purple border.

- The card gets the same glass as `.node.cell`: border `--og-line`, the same fill and the same rim. The kind colour stays only in its icon band, as it does for every other op.
- `.agentframe` loses its purple border and becomes a container like the others. The header keeps the agent icon.
- Execution states use the classes a cell already has (running, done, error, skipped), in the same place: the status dot in the header. `ag2-st` today shows only run and done.
- No new component: the `.ag2` card stays the one agent node.

Gate: the agent and its neighbours read as one family in both themes. States are shown on a real run of meeting-prep-brd. Text is at 4.5:1 or better.

## C3 · Counts on GraphOp headers

- An opened GraphOp header reads "email · GraphOp · 1 agent · 4 ops". `containerKind` counts agents at any depth, from the same walk the chips use.
- A folded GraphOp shows that count line in place of the purple chips from A2. Clicking the count opens a small list of the agents. Each entry runs `revealAgent(key)`, so the path to an agent is kept.

Gate: counts match the IR on both projects, and a test covers `containerKind`.

## C4 · Collapsing large groups

When one layer of an opened graph holds 6 or more agents side by side (a fan-out), they draw as one stacked node, for example "10 agents ▸", using the generator stack's look (`#stacks .genghost`). Opening it lays them out as today. The threshold is a constant, and the open state is kept in `state.expanded` like any container.

Gate: a test graph with 10 parallel agents folds and opens. Layout stays stable when it opens and closes. A JS test covers the grouping.

## Order

C1 → C2 → C3 → C4, one PR each. Each PR includes screenshots in both themes on both projects.
