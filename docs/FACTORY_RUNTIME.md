# Runs on the Factory picture (SPATIAL_FACTORY_PLAN F5)

**Result.** A failing flow is visible from the top of the project, without opening anything.

| on the picture | means | from |
|---|---|---|
| a red light, and a name edged red with "N failed" | runs of this flow failed in the last 7 days | `/flows/stats` → `errors` |
| a green light | it ran, and nothing failed (a cluster per flow only) | `runs > 0`, `errors == 0` |
| no light | it did not run | |
| "1,530 runs" on a name | runs in the window | `runs` |
| a domain's name: "3 failing" (past 30 flows) | flows of the domain with failed runs; each has its own red light on its part | |
| a door row of the card | opens that service's or job's runs in the Runs hub | `RunsView.openFolder` |

Example: `news_flow | 20 ops · 13 services · 6 jobs · 812 runs · 14 failed`, red, with a red light on
its plate; `pages_flow … 4,210 runs`, a green light.

Past 30 flows the green light is left out: a thousand green lights say nothing, and red must stand out.

## How

- The run lights are one small instanced mesh (and one for their glow), a slot per flow, apart from the
  parts. `setStats(stats)` writes the numbers into the model's flows, repaints those two meshes, the
  names and the legend. Nothing is rebuilt, and the camera and the selection stay as they were.
- `Factory.show()` fetches `/flows/stats` on every return to the picture and calls `setStats`.
- A run belongs to a service or a job, not to a flow (the Runs hub's folders), so the link to runs is
  on the doors of a flow, not on the flow.

```text
operonx_studio/static/
  factory3d.js   the run lights, setStats(); door rows call onRuns(door)
  factory.js     stats again on every show; onRuns → RunsView.openFolder
  factory.css    a failing name
```

No `.py` file changed.

## Checked

Headless Chromium against the test studio on mr-finance. Its copy has no runs, so the test answered
the stats call itself (4 flows with runs, 2 of them failing), then changed the numbers while a flow was
open: back on the picture the new numbers were there, with the selection kept.

## Not in F5

- Live updates: a light changes when the picture is returned to, not when a run starts (B4).
- Latency: `avg_ms` is in the model and not drawn.
