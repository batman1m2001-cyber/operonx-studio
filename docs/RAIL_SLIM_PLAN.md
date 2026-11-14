# Rail slim plan — 13 screens on the left become 7

The left rail lists 13 screens in four groups (Build, Observe, Improve,
Operate). Several are halves of one job: Review reads runs, Alerts watch
Monitor's numbers, Services and Jobs are both "what runs", Settings holds
only run retention. The owner wants the rail short.

## The rail after

| Rail item | Its screens (tabs in the top bar) |
|---|---|
| Project | Project |
| Flow | Flow · Playground · Knowledge (when the project has one) |
| Runs | Runs · Review |
| Monitor | Monitor · Alerts |
| Improve | Evals · Prompts |
| Operate | Services · Jobs |
| Settings | Resources · Storage (the old Settings: run retention) |

No group labels: seven icons need none.

## How

- A rail item is a **hub**: `data-tab` = its first screen, `data-hub` = its
  name; the strip's buttons say their hub in `data-in` (shell.js `hubOf`). A click opens the screen
  of that hub the user was on last (remembered per project).
- The hub's screens are a segmented strip in the top bar (`#hubtabs`, class
  `tabs`, so every `.tabs button[data-tab]` hook — click, active state,
  Knowledge's show/hide, viewer `needs-edit` — keeps working). A hub with
  one visible screen shows no strip.
- Screen names, panes, addresses (`/p/<pid>/<screen>`), `switch_tab` and
  the hand's `tab:<name>` targets do not change; the hand points at the
  strip's tab, or at the hub's rail item when the strip is not showing.
- On a phone the strip wraps under the header.

## Gates

- `node --test tests/js/`, studio pytest green.
- Screenshots dark + light: the rail slim and wide, each hub's strip, a
  phone width; every old screen reachable by click and by address.
