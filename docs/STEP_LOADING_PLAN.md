# A step opens without waiting

**Status:** done (2026-10-13).

## Why a click was slow

I measured `demo-conv-eab18f` (87 rows):

| Path | One step click |
|---|---|
| The studio on this machine | 170–250 ms until the values show. One request, about 85 ms of it on the server. |
| Through the localhost.run link | Every request waits about 1.25 s before its first byte, even for a tiny static file. A click takes about 1.4–1.6 s. |

About 85% of a click is the round trip through the tunnel's relay. The other cost is the server: every `/step` reads the whole run from ClickHouse again (`_record` → `store.get_run`) and resolves every row's inputs, just to return one of them.

Redis would not help. It would only replace the 85 ms part, and every click would still pay the round trip. The studio is one process, so a cache in its own memory does the same job without an extra network hop.

## What changes

1. **Preload.** When a run page or Workflow view loads a run's tree, the browser fetches every step's values in one request (`GET …/trace/{run}/steps`) in the background. A click then reads from the browser.
   - A run that is still running is not preloaded; its steps load per click.
   - The server stops at a size cap (`max_bytes`, 4 MB of JSON by default) and says the set is incomplete.
   - For anything not preloaded, a click fetches that step plus the next steps in one request (`…/steps?ids=`), so the next clicks are already there.
2. **Browser cache.** A step's values are kept once fetched, by run and step id. A recorded step never changes, so the cache needs no invalidation.
3. **Server cache.** A finished run's rows, its record and its resolved inputs stay in memory, bounded at 24 runs with the least recently used dropped first.
   - The tree, step, op, timeline and compare views all read through it.
   - A running run is never cached. Deleting a run drops it.
4. **Theme.** The header's theme control becomes one button that flips light ↔ dark.
   - Before the first click, the page follows the system's setting; after it, your choice is kept.
   - Settings keeps the three-way choice, including System.

## Out of scope

The tunnel itself. A relay nearer the viewer would cut about 1 s from every request, but tunnels are localhost.run only, by your rule.
