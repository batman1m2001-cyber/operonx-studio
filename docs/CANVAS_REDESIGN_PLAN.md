# A canvas you can read at any size (CANVAS_REDESIGN_PLAN)

Status: C1 built (2026-11-13): the backdrop, clear glass for ops and for the frame. C2 built (2026-11-13): the agent card in the ops' glass, with its run state. C3 built (2026-11-13): agent and op counts on GraphOps, the agents one click away. C4 built (2026-11-13): 6 or more agents side by side fold into one stack. The plan is done.

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
- **Backdrop.** `static/canvas-bg-{light,dark}.webp` (31 KB and 37 KB, 2560×1440) sit under a softened dot grid on the Flow screen's `#stage`. They are generated from [img/canvas/backdrop.html](img/canvas/backdrop.html): an SVG with `?m=dark|light`, shot at 2560×1440 and saved as WebP at quality 0.86. There is no external asset. The images are shot with `?g=faint`: the glyph is drawn at 22% so a flow can run over it, and its light spots stay bright. At full strength it fought the cards on wide screens (owner, after C4).

  | before | faint, dark | faint, light |
  |---|---|---|
  | ![before](img/canvas/glyph-before-dark.png) | ![faint dark](img/canvas/glyph-faint-dark.png) | ![faint light](img/canvas/glyph-faint-light.png) |

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

## C3 · Counts on GraphOp headers (built)

| | Dark | Light |
|---|---|---|
| Folded, the list open | ![](img/canvas/c3-folded-list-dark.png) | ![](img/canvas/c3-folded-list-light.png) |
| Opened | ![](img/canvas/c3-opened-dark.png) | ![](img/canvas/c3-opened-light.png) |
| Second project, folded | ![](img/canvas/c3-second-project-folded-dark.png) | ![](img/canvas/c3-second-project-folded-light.png) |
| Second project, opened | ![](img/canvas/c3-second-project-opened-dark.png) | ![](img/canvas/c3-second-project-opened-light.png) |

What changed:
- `containerKind` and the agent walk (`agentsInside`) moved to `agentsteps.js`, where node can test them; canvas.js uses them from there. An opened GraphOp's header reads "GraphOp · 1 agent · 4 ops": agents at any depth, ops directly inside (the number the band shows). A graph with no agent reads "GraphOp · 7 ops"; one op is "1 op".
- A folded GraphOp holding agents shows "6 agents · 11 ops ▾" under its name, in `--text-2`, where the A2 chips were. A click opens the agents in the one menu (`menuList`, as the flows menu): name, and the path under it ("prepare › web_research"). A pick runs `revealAgent(key)`. Esc or a click away closes it.
- The header's "▾ collapse" is now a bare ▾ (its title and aria-label say Collapse), so the count line fits: on both projects every header with an agent reads in full. Two long-named graphs with no agent (extract_company_name, extract_company) still cut their "GraphOp · N ops", as before C3.
- The header's kind line and ▾ moved from `--muted` to `--text-2`: they read 3.8–4.3:1 on the clear glass.

Gate:
- Counts match the IR on both projects, both themes: each header and each folded count line was checked against a separate walk of the served graph (meeting-prep-brd: prepare 6 agents · 11 ops, each of its 6 agent graphs 1 agent · 4 ops; meeting-prep: prepare 3 agents · 10 ops, web_research 3 agents · 5 ops). Picking the last agent in the list opened its path and selected it on both.
- `tests/js/containerkind.test.mjs` covers `containerKind` and the walk.
- Contrast: the count line 6.6–8.5:1, the headers ≥5.0:1, both themes. The ↱ promoter glyph is decorative and unchanged.

- An opened GraphOp header reads "email · GraphOp · 1 agent · 4 ops". `containerKind` counts agents at any depth, from the same walk the chips use.
- A folded GraphOp shows that count line in place of the purple chips from A2. Clicking the count opens a small list of the agents. Each entry runs `revealAgent(key)`, so the path to an agent is kept.

Gate: counts match the IR on both projects, and a test covers `containerKind`.

## C4 · Collapsing large groups (built)

The fan-out below is a test fixture: meeting-prep's web_research holds three agents (website, news, people) with the same feeder and the same exit; the gate script cloned website 7 times in the page, so 10 sit side by side. Neither real project has a level with 6 such agents, so on both nothing changes.

| | Dark | Light |
|---|---|---|
| Fixture, folded | ![](img/canvas/c4-fanout-folded-dark.png) | ![](img/canvas/c4-fanout-folded-light.png) |
| Fixture, opened (50%) | ![](img/canvas/c4-fanout-opened-dark.png) | ![](img/canvas/c4-fanout-opened-light.png) |
| meeting-prep-brd, unchanged | ![](img/canvas/c4-brd-unchanged-dark.png) | ![](img/canvas/c4-brd-unchanged-light.png) |
| meeting-prep, unchanged | ![](img/canvas/c4-mp-unchanged-dark.png) | ![](img/canvas/c4-mp-unchanged-light.png) |

What changed:
- `FlowLayout.stackFanouts(g)` (flowlayout.js, pure): at each level, AgentOps with the same feeders, the same targets and the same START/END, entry, exit and final ties are one fan-out. `STACK_MIN` (6) or more become one container node, "10 agents", holding them as its inner level; their wires become one wire in and one out. Agents on a branch route, a back edge or in a loop are left alone. The input graph is never changed.
- The canvas draws `shownGraph()`, the stacked graph, memoised per `state.graph`. The stack is a container like any GraphOp: its band reads "◈ 10 ▸", it opens and closes through `state.expanded`, and folded it gets the generator's two ghost cards. Its count line names the first agents ("website, website_1 +8 ▾") and opens the agent menu. Opened, its header reads "fan-out · side by side".
- `FlowLayout.stackedKey` maps an agent's key to its key inside a stack, so `revealAgent` reaches a stacked agent from an old key.
- The inspector reads a stacked agent's ports from the level the stack stands for (`stack.home`), so it shows "input ← tasks.website" and "output → PARENT.website", as without the stack.

Gate:
- The 10-agent fixture folds into one card ("10 agents", 2 ghosts) and opens into 10 agent cards, both themes. After open → close every other card has the same x, y, w and h (0 moved). The menu lists the 10, and a pick selects the agent inside the opened stack. No page errors, including the inspector and the data view on the stack and on a member.
- `tests/js/fanout.test.mjs` (6 tests): 10 fold and are rewired; 5 stay; the input is not mutated; a branch route or a different feeder keeps an agent out; a fan-out inside a GraphOp stacks and entries/exits name the stack; `stackedKey`; open and close give back the same coordinates. JS 194/194.
- Both real projects: 0 stacks folded, 0 with every graph opened, both themes.

## Order

C1 → C2 → C3 → C4, one PR each. Each PR includes screenshots in both themes on both projects.
