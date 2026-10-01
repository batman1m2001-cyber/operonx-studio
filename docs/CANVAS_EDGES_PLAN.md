# Canvas edges — plan

*2026-10-01. From the meeting-prep demo (an agent graph expanded inside a workflow):
edges cross and run through each other, bend in curve-then-straight shapes, show no
direction, and a loop's return edge does not stand out.*

**Rule for this work:** one change per commit, each with a before/after screenshot of the
same two views, so any one can be reverted without the others. Keep Studio's look (curved
wires, centred spine, light cards) — the ELK attempt was rejected for right angles and a
zig-zag spine; nothing here goes back to that.

**The two views every commit is checked on**
1. meeting-prep · `on_mail` · `brief` expanded (fan-out to crm/cal/memory/asks, three
   research agents, fan-in to `facts`).
2. meeting-prep · `brief` · `news` expanded (the agent loop and its return edge).
Plus `scripts/perf/layout_audit.py` on meeting-prep and the analyze project: its overlap
count must not go up; a new **crossings** count (commit 0c) must go down where the plan says.

## Commits

| # | commit | what changes | done when |
|---|---|---|---|
| 0a | `fix(canvas): drag inside an opened GraphOp pans` | the pan fix already written (studio.js mousedown + cursors) | dragging a container body pans |
| 0b | `fix(ir): a card's op count is what opening it shows` | `subgraph_ops` counts the laid-out members (a loop's members, not its one hidden graph) | `news` reads 12, opens to 12 |
| 0c | `audit: count edge crossings and edges through cards` | `layout_audit.py` reports crossings (pairs of wires that intersect) and wire-through-card hits per view | a baseline number for both views |
| 1 | `feat(canvas): one smooth curve per edge, no straight runs` | every route (`routeAvoiding`'s lane, side-step, bow; `rowWirePath`; `rowTiePath`) produces waypoints, and one `smoothPath(points)` draws them as a single C¹-continuous cubic spline (Catmull-Rom → Bézier). No `L` segments: the "curve, then rigid, then curve" shape is gone. Stays M/C only, so `pathSampler` and the sparks keep working | no `L` in any edge `d`; both views look curved end to end |
| 2 | `feat(canvas): a loop's return edge looks like a loop` | `returnPath` routed in its own outside lane (right margin of the loop's group), drawn as a distinct style: amber, wider, a soft dashed flow running *backwards* (bottom → top), a "↻ loop" pill at its apex, and the arrowhead into the loop's first step | the return edge reads as the loop at a glance, and never overlaps a forward edge |
| 3 | `feat(canvas): direction — a light dot travels each edge` | Flow view only: one small light dot per edge moving source → target (CSS `offset-path` / SMIL `animateMotion` on the same `d`), slow and faint; return edges carry it backwards in amber. Off for `prefers-reduced-motion`, paused when the tab is hidden, capped to edges on screen (≤ 150) so a 300-op graph stays smooth; a toolbar toggle | dots visible in Flow only; render time on the analyze project within 10% of before (`render_cost.py`) |
| 4 | `feat(layout): order each row to minimise crossings` | `layout.py`: barycenter sweeps (down, up, repeat until no gain, max 8) to order nodes within a layer — today only the initial order is used | crossings in view 1 drop; no new overlaps |
| 5 | `feat(layout): long edges get their own lane` | `layout.py`: dummy nodes for edges spanning more than one layer, taking part in the ordering of commit 4; the canvas draws the edge through the dummies' positions with commit 1's spline — the crm/cal → facts edges stop running through the research row | no edge through a card in view 1 |
| 6 | `feat(canvas): fan-in and fan-out spread over the card's edge` | edges into one card (6 into `facts`) arrive at ports spread across its top, ordered by source x; edges out of one card leave spread across its bottom — instead of all meeting at one dot, which is where most crossings start | the six edges into `facts` arrive side by side, uncrossed |
| 7 | `feat(canvas): an expanded GraphOp is laid out with its siblings` | when a container opens, its siblings are re-ordered and moved around it (commits 4–6 run with the container as one big node), instead of shifting rows of a grid laid out for closed cards — the wires from crm/cal no longer cut across the opened `website` | no sibling edge crosses an opened container in view 1 |

Order: 0a–0c first (no visual risk), then 1 → 2 → 3 (drawing only, each easy to judge and
revert), then 4 → 5 → 6 → 7 (layout, measured by the audit). Screenshot after each; stop and
show you after 3 and again after 7.

## Risks

| risk | handling |
|---|---|
| a smooth spline through waypoints overshoots into a card | waypoints get tension and a clearance check; a hit falls back to the old route for that edge only |
| animation cost on big graphs | capped to on-screen edges, one shared animation, paused off-screen; measured with `render_cost.py` |
| layout changes move cards people know where to find | order changes only within a layer; the spine stays centred; a stable tie-break keeps today's order when there is no gain |
| scope creep into a new layout engine | no new dependency; each layout commit is one function in `layout.py` |
