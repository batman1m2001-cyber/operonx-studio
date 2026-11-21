# One picture plan

Factory, Flow, Services and Jobs become one place: the project's picture. It is what opens first, and
a flow, a service or a job is something you open *from* it, not a tab beside it. The owner's idea,
2026-11-22.

**Status: proposed. Nothing is built. Waiting for the owner's go.**

## Today

```
Factory | Flow | Prompts | Services | Jobs        ← five tabs, four of them about the same things
```

| Tab | What it really is (read from the code) | Only here |
|---|---|---|
| Factory (`factory2d.js`) | the whole project: workflows, stores, services, jobs, what passes between them | hover / select, the Details card with a workflow's doors and real ops |
| Flow (`canvas.js`, `play.js`) | one flow's editor: canvas, Play, data flow, runs | everything — it needs the whole screen |
| Services (`services.js`, 204 lines) | **the listeners** (a host:port and the services bound to it), not a list of routes | up/down, Start/Stop, logs, the environment check, queues and Requeue; per service: show on picture, Play, Monitor |
| Jobs (`jobs.js`, 360 lines) | the jobs with their last run → one job's runs → one run's items or step tree | Run / Resume, the run records, polling while a run is open |

Two things follow. Services and Jobs are not "tables of doors" that the picture already replaces —
they hold actions (Start, Stop, Requeue, Run, Resume) that exist nowhere else. And the picture already
opens first on a project with more than one flow, and already draws every service and job; what is
missing is doing something with them there.

## Proposed

```
Picture | Prompts                                  ← Flow, Services, Jobs are opened from the picture
```

One example, start to end: open mr-finance → the picture. Click the job `news_ingest` beside `news`
→ the side panel shows that job: schedule, last runs, **Run**. Click a run → its items, in the same
panel. Double-click the `news` platform → its flow editor, with `Picture / news_flow` as the way back.

| You want | Today | Proposed |
|---|---|---|
| see one job's runs, run it | Jobs tab → find the job | click the job on the picture (or in the list) → side panel |
| is the server up, start it, read its log | Services tab | a listener line on the picture (`:8030 ● up · 90 services`) → side panel |
| find one route among 90 | Services tab, read cards | the picture's find box (`/`), or the left rail — one filterable list of flows, services and jobs |
| edit / play a flow | Flow tab | double-click its platform; `Picture / flow` crumb or Esc to come back |
| what failed last night | Jobs tab + Runs | failed jobs and workflows are already red on the picture; List sorts failed first |

## Decisions

1. **The pages' code is re-hosted, not rewritten.** `jobs.js` and `services.js` already draw into a
   box; the box becomes the side panel. Their APIs and behaviour do not change.
2. **Flow stays a full screen.** It is a level under the picture, not a panel in it: editing and
   playing need the canvas. Only its tab goes.
3. **The left rail is the picture's index, and the only list.** Today it does two jobs at once: a
   "Project picture" row that is navigation, above a flow list that repeats what the picture draws
   and does not react to it. Proposed: the "Project picture" row goes (the crumb is the way back);
   the rail lists what the picture holds — **Flows · Services · Jobs** as three chips over one list,
   with today's filter and sorts (busiest, slowest, errors). Hover a row lights it on the picture,
   click selects it, double-click opens it; selecting on the picture marks the row. Past 30 flows the
   rail lists domains, as the picture does. Inside a flow the rail stays the flow switcher it is now.
   So the table of 90 services lives in the rail, not in a second list in the right panel.
4. **A listener is drawn as a line of text in the picture's header, not as a new shape.** Mock 14 is
   locked; no new entity enters the picture.
5. **A single-flow project still opens on its flow**, as today.
6. **Old addresses and assistant actions keep working**: the Services and Jobs URLs and `open_jobs`
   open the picture with the panel on the right thing.

## Parts

Each part is shippable alone and ends with screenshots on mr-finance and the callbot.

| Part | What | Gate |
|---|---|---|
| **O1** job in the panel | click a job (marker, door-list row, card row) → the Jobs screen's job view in the side panel: runs, items / step tree, Run, Resume, polling | everything the Jobs tab does for one job works from the panel; Jobs tab still there |
| **O2** listeners | listener line in the header; panel shows up/down, Start/Stop, logs, environment check, queues + Requeue; click a service → its card with Play and Monitor | everything the Services tab does works from the picture; Services tab still there |
| **O3** rail as index | Flows · Services · Jobs chips over one list; rail ↔ picture hover and selection both ways; "Project picture" row removed; domains past 30 flows | find any of mr-finance's 90 services in two actions; a row and its shape always agree |
| **O4** flow as a level | Flow tab removed; double-click or "Open in the editor" enters; crumb and Esc return to the picture as it was left | deep links to a flow, Play and the flows rail work as today |
| **O5** remove | Services and Jobs tabs go; their URLs and `open_jobs` redirect | no dead link in the studio, the assistant's hand or the docs |

O1–O3 add; O4–O5 remove. If O1–O3 feel worse than the tabs, we stop there and nothing is lost.

## Risks

- **The side panel is narrow** for a run's items or a runbook's tree. The panel can be dragged wider
  today; if that is not enough, a run opens as a sheet over the picture. Decided in O1 on real runs.
- **Discoverability**: a new user will look for "Jobs". The header counts (`90 services · 24 jobs`)
  become buttons that switch the rail to that list.
- **The assistant's hand** points at tabs by name in a few places; O5 has to move each one.

## Not in this plan

Prompts, Runs, Monitor and the other hubs; any change to the picture's look; engine changes.
