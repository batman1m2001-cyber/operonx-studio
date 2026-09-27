# operonx studio — refactor phase 2: assistant-first

Status: **done 2026-09-27 — R0–R6, see §10.** Branch
`feat/assistant-first`, off `feat/platform` (P0–P9 of
[PLATFORM_PLAN.md](PLATFORM_PLAN.md), all done).

Phase 1 built the loop: records, runs, monitor, playground, evals,
review, prompts, services, alerts, templates. Phase 2 changes how the
studio *feels* to use. It has one goal:

> **"Tell the AI what you want to accomplish,"** not "here is a
> complicated platform, learn how to use it."

Three things carry that goal:

- the **Assistant** becomes the primary interface;
- the **Flow** view becomes understandable at a glance and alive while
  something runs;
- the studio gets **fast through the tunnel**, where people actually use
  it.

A visual refresh (robotics and precision engineering, not cyberpunk)
runs across all three.

---

## 0. The audit — measured, not guessed

The studio was driven by a Playwright harness as a user would drive it
(`scripts/perf/`, §8, R0). There are two sets of numbers:

- **Local:** straight to `127.0.0.1:8766`.
- **Tunnel:** through the `lhr.life` tunnel, which is how the operator
  on a phone meets it.

The tunnel's round trip costs about 1.25 s on a cold connection and
about 0.75 s on a warm one. That makes every serial round trip the
dominant cost.

### 0.1 Performance

| # | What | Measured | Cause |
|---|---|---|---|
| P1 | **Open a project, until the first node is drawn** | Tunnel 2.8–3.6 s; local 0.43–0.74 s | A serial chain of 19 requests. First the HTML; then CSS and **16 separate scripts** (6 connections, so several waves of about 0.75 s); only after every script has run does the page start fetching the IR (24 KB gzipped, 1.5 s through the tunnel). |
| P2 | **An idle page keeps asking** | About 1.2 requests/s, forever, per open tab | `poll()` asks `/stamp`, then `/ui/actions`, one after the other, every 1.5 s. Through the tunnel one cycle takes about 3 s, so something the assistant opens reaches the screen up to 3 s late. |
| P3 | **Home** | Two round trips after the page (`/api/projects`, then `/api/projects/health`), 1.8 s to a full list through the tunnel | The health scan itself is ~0.2 s of server time for 25 projects; the rest is the extra hops. (A "duplicate" `/api/projects` seen in the first run was the harness's own login redirect.) |
| P4 | **Flow `render()`** | 60–100 ms for 34–50 nodes (about 2 ms a node) on each repaint, measured on callbot and educa_reminder_agent | A full DOM rebuild on every repaint: selection, run paint, re-extract. Zoom and pan are fine: p95 frame 17–20 ms, no long tasks. A 300-node graph would need about 0.6 s a repaint, so **live animation must not go through `render()`.** |
| P5 | **Assistant streaming** | Text lands in 1–2 s batches through the tunnel, and a fake typewriter smooths it | Turn-based polling. |
| P6 | **Errors from the tunnel** | The page throws `Unexpected token '<', "<h1>no tun"…` | `api()` parses every response as JSON, including the tunnel's HTML error page. |
| P7 | **Tunnel address** | The anonymous localhost.run tunnel changed its URL three times in about 40 minutes, then dropped the ssh session with "tunnel inactivity timeout" | Not studio code. It now runs under a loop that reconnects on its own and writes the current URL to a file. A fixed domain needs a localhost.run account key, which is the user's decision. |
| P8 | **Opening a screen through the tunnel** | Time = number of request hops in a row × about 0.75 s. Jobs: 3 hops, 2.3 s. Runs, Evals, Review and Settings: 2 hops, 1.5–1.9 s. Resources, Monitor, Services, Alerts and Prompts: 1 hop, 0.8 s. Locally, every screen is ready in 100–160 ms. | Screens chain requests: fetch a list, then fetch its first item's details. Each screen also refetches everything on every visit. |
| P9 | **Playground first open** | 1.8 s (p5demo) to 3.4 s (callbot) through the tunnel, locally 0.7 s | The bridge process — the project's own interpreter importing the project — starts on first use. (An earlier reading that its event poll "keeps going" after leaving was one trailing 4 s request; the loop stops.) |
| P10 | **Tunnel throughput** | About 150 KB/s after a 1.25 s cold connection | So bytes matter as well as hops: the 110 KB bundle is ~0.75 s of a first visit. |

What is already right, so it is not a target: static files are gzipped
and cached as immutable (`?v=<hash>`), and the IR is gzipped.

### 0.2 UX — as a demanding user

**The assistant**

- It is hidden. On a project page it sits behind the *Inspect* tab. On
  home it is a 48 px button in the corner.
- Its memory is this browser only: localStorage, one conversation per
  project. On the phone it is a different conversation, and clearing
  site data loses it.
- It has no sessions, titles, search, archive or retry.
- It shows no model, token, context or limit information.
- A tool chip shows only a name and a hint. There is no result,
  success or failure, or duration, and no way to see what the agent
  actually did.
- *Stop* kills the process and does not say what had finished.
- The empty state is one sentence. The input is a single line, with no
  newlines and no commands.
- On a phone, once it is opened, the sheet stays over 70% of every
  screen.

**Home**

- The user cannot say what they want. They have to pick a project
  first.
- Project rows are mostly `/tmp/claude-0/-home-…` paths.
- The two `ex17-jobs` projects can be told apart only by path.

**Flow**

- It opens at 100% at the top left. On callbot the user sees a
  fragment, with cards cut off at the left edge; on a phone, two half
  cards.
- Every node carries `FUNC` / `IO` / `SYNC` badges, so the technical
  detail is what the eye lands on first.
- Nothing moves while a playground session runs. A run shows on the
  canvas only after it has finished and been painted.

**Empty screens teach instead of doing.** *Evals* shows an
`operonx.toml` snippet to copy. *Runs* says "widen the range". Neither
offers "ask the assistant to set it up".

**The phone.** The breadcrumb truncates to `ed… / ws_ca…`.

### 0.3 What the assistant runtime gives us

These come from Claude Code 2.1.283's `stream-json` output, from a real
turn run with `haiku`:

| Event | Carries | Used for |
|---|---|---|
| `system/init` | `session_id`, `model`, `tools`, `mcp_servers`, `permissionMode` | The model badge and session details |
| `stream_event` | `text_delta`, and `thinking` block starts and deltas | Token-level text and a "thinking" state |
| `assistant` message | `usage`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is the context in use | The context meter |
| `result` | `total_cost_usd`, `duration_ms`, `usage`, `modelUsage[model].contextWindow` (200000), `maxOutputTokens` | Cost, the context limit and turn stats |
| `rate_limit_event` | 5-hour and 7-day utilization | Power-user details only |

The CLI flags in play: `--resume`, `--fork-session`, `--session-id`,
`--model`, `--effort`, `--max-budget-usd`, `--autocompact`.

**Verified at the start of R2** (real `haiku` calls, about $0.10 in all):

- `--resume X --fork-session` reports a new session id in `init`, and
  leaves X's transcript file untouched (its modification time did not
  change).
- Tool results arrive in `user` events as `tool_result` blocks carrying
  the `tool_use_id` (and `is_error` on failure).
- Headless `/compact` works: `status: compacting`, then
  `compact_boundary` with `pre_tokens`/`post_tokens` (22,505 → 2,077 in
  the check), then a `result`.
- The localhost.run tunnel passes a chunked response through as it is
  written (lines 0.5 s apart arrived 0.5 s apart) and let a 30 s stream
  finish. The ~10 s cut measured in phase 1 was another tunnel; the
  design keeps short windows anyway, since the provider changes.

---

## 1. Principles

1. **Tell, don't learn.** Every empty state and every error offers the
   one action that fixes it, and usually that action is "ask the
   assistant".
2. **Measure, fix, measure again.** Every performance change has
   before-and-after numbers from the same harness, local and through
   the tunnel. A loading animation is never the fix.
3. **Motion has a job.** Energy on the canvas means something is
   executing, right there, right now. Nothing else pulses, glows or
   loops.
4. **Keep what works.** Runs, RunStore, evals, jobs, services, alerts,
   the playground and the templates keep their APIs and behaviour. New
   server routes are additive. The 464 studio tests stay green.
5. **Progressive disclosure.** Tokens, context windows, models, session
   ids and tool inputs are one click away, never in the way.
6. **No complexity without a measured problem.** That rules out a node
   build toolchain, new infrastructure, and WebGL, Workers, WASM or Rust
   unless a benchmark in this plan fails its budget.

---

## 2. Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where conversations live | **A SQLite file beside the studio's state (`studio.json`), behind a small `ChatStore` interface.** Uses stdlib `sqlite3` in WAL mode. Search is `LIKE` over titles and message text: milliseconds at tens of thousands of items, so FTS5's extra index and its sync code are not worth it. | Conversations have to survive a reload and follow the user from desktop to phone, so they belong on the server; localStorage fails both. The studio already keeps its state in local files. Postgres or Redis would be new infrastructure for a single-user studio. Langfuse is a tracing tool, and remote. Claude Code keeps its own transcript for `--resume`; the studio stores what it *renders* (items, titles, usage, flags), linked by the Claude session id. The interface matches the RunStore decision: a team server is a backend swap. |
| 2 | Streaming | **Streamed windows.** A chunked NDJSON response streams events as they happen, ends itself after 20 s (a heartbeat line every 5 s of silence), and the client reconnects by cursor. The poll stays as the fallback. | Token-level delivery with one request per 20 s, instead of a poll round trip per batch. A proxy that cuts sooner (one tunnel did, at ~10 s) costs a reconnect, never an event: the cursor is the event's index. **Gate passed** (§0.3): the tunnel does not buffer. |
| 3 | Page liveness | **One `pulse` long-poll per page** (held up to 8 s) replaces `/stamp` + `/ui/actions`. It answers at once on a code change, an assistant action, a finished assistant turn, or a live-run event. | This fixes P2: from about 1.2 requests/s to at most 0.125/s when idle, and changes arrive immediately instead of up to 3 s late. |
| 4 | Scripts | **The server concatenates the project page's scripts into one bundle** in memory at startup, hashed and served as immutable. No node, no build step. | This fixes P1: 16 requests become one. Splitting code per screen would add a 0.75 s round trip on the first visit to each screen through the tunnel, which is worse, so no splitting. |
| 5 | The IR on first paint | **Inline it into the project page HTML** when the watcher has it cached (it usually does, via SWR); otherwise fall back to a fetch that starts in `<head>`. | This removes the last serial round trip in P1. |
| 6 | Regenerate and edit-and-resend | **Every turn runs as `--resume <previous turn's session> --fork-session`**, so each turn has its own session id, and the id of turn *n−1* is the state before turn *n*. Regenerate, and editing an earlier message, fork from that point. | This gives true rewind and branching with no transcript surgery. Prompt caching still applies because the prefix is identical. **Gate:** decision 2's verification of `--fork-session`. Fallback: Retry re-sends in the same session and says so. |
| 7 | Live Flow | **The playground bridge emits per-op events while a session runs.** This is an additive operonx change: the bridge watches `trace.nodes`, which every op execution is appended to as it finishes. **A recorded run gets an animated replay** from its recorded timings. It is rendered in SVG and CSS (transform, opacity, `stroke-dashoffset`), with per-node class toggles and never a full `render()`. | The data already exists: live for sessions the studio drives, recorded for everything else. Canvas, WebGL, Workers, WASM and Rust are not justified. The largest real graph zooms at a 17–20 ms p95 frame. Revisit only if the 300-node synthetic benchmark (§5) misses its budget *after* repaints are incremental. |
| 8 | Model choice | **The CLI default, unless the session picks one** of `opus`, `sonnet` or `haiku`, stored on the session. | Normal users never see it; power users can. |
| 9 | Session titles | **The first message, trimmed, straight away; then a one-line title from `haiku` after the first reply,** in the background. `OPERONX_STUDIO_CHAT_TITLES=off` turns it off. | A good title is what makes a session list usable, and a `haiku` call costs a fraction of a cent. The heuristic title means nothing ever waits for it. |
| 10 | The old localStorage transcripts | **Imported once.** The first time the new panel loads, it posts any `oxchat:*:log` it finds as an "imported" session, then clears the key. | Nobody loses a conversation to the refactor. |
| 11 | Fonts | **Keep the system font stack.** No webfont. | A webfont blocks rendering and costs a tunnel round trip. "Precision" comes from tabular numerals, weights, spacing and hairlines, not a typeface. |

---

## 3. The Assistant (A)

### 3.1 Where it lives

- **Desktop project page:** the right column, open by default.
  - Its tab comes first (Assistant, then Inspect).
  - Clicking a node still opens Inspect, as it does today. The
    inspector's header gets an **Ask about this** button that switches
    back with the node attached as context.
  - While a turn runs, the Assistant tab shows a live dot.
- **Focus mode** (a button in the header, or `Ctrl/⌘ J`): the assistant
  takes the whole stage, with the session list on its left, like
  claude.ai. The canvas and screens stay one click away. This is for
  long work.
- **Home:** a hero composer, "What do you want to build or fix?", above
  the projects. Below it, recent sessions across all projects. The home
  assistant can create a project from a template and open it (the
  template API already exists).
- **Phone:** an "Ask…" bar docked at the bottom of every screen. It
  opens a full-screen assistant, and closing it returns to the same
  place. The 70% sheet is gone.

### 3.2 Sessions

- **Scope:** sessions belong to a project (or to home). The home screen
  can also list every project's sessions together.
- **Actions:** a session list with search across titles and content,
  rename, archive and unarchive, and delete (with a confirmation).
- **Restoring:** opening a session renders its stored transcript. If a
  turn is still running, it reattaches, from any device.
- **Long tasks:** a turn keeps running when the tab closes.
  - The session list shows a spinner beside it.
  - When it finishes, any studio page shows a toast (it arrives through
    `pulse`), plus a browser notification if the user allowed them.

### 3.3 A turn's states

A turn moves through: **starting → thinking → writing → running
*tool* → done**, or it ends as **stopped** or **failed**.

- **What the user sees:** the current state is one line under the
  newest message, with an elapsed timer, for example "Reading
  `app/main.py` · 4 s".
- **Stop:** sends SIGINT, and kills the process after 3 s. The turn is
  marked *stopped* and keeps whatever it had already written and done.
- **Errors:** an error is a card with a plain sentence, the details
  folded away, and **Retry**.

### 3.4 What the transcript shows

| Item | Shows | On demand |
|---|---|---|
| **Your message** | The text | **Edit & resend**, which forks the session (decision 6) |
| **Answer** | Markdown: headings, lists, tables, code with a copy button, and `studio:` links as rich chips (a run with its status, an op, a screen) | Copy, and **Regenerate** on the last answer |
| **Thinking** | A quiet "thinking…" line | The thinking text, when the model gives it |
| **Tool call** | A human verb ("Read `app/main.py`", "Ran tests"), a spinner, then ✓ or ✗ and its duration | The input and output (4 KB, trimmed) |
| **Studio action** | "Opened run `abc`", as a link | — |
| **Changes** | The existing diff card, with Keep and Undo | The diff |
| **Flow changed** | After the edit is re-extracted: which ops were added, changed or removed, and **Show on canvas** | — |
| **Turn footer** | Nothing by default | Time, tokens and cost: on hover, or always in details mode |

**What did it do?** Each turn has an *Activity* view: every tool call
with its input and output, the files it changed, the studio actions it
took, and what it cost. A whole session can be exported as Markdown.

### 3.5 Composer

- The input is multi-line and grows as you type. **Enter** sends;
  **Shift+Enter** adds a new line.
- **`/` commands:**
  - `/new` and `/sessions`
  - `/compact`
  - `/model`
  - `/retry`
  - `/help`
  - `/focus`
- **Context chips** show what rides along with the message: the
  selected op, the run painted on the canvas, the screen and filter.
  Each can be removed. This makes the view context the studio already
  sends visible.
- The user can keep typing while a turn runs; the send button becomes
  Stop.

### 3.6 Smart starts

`GET /api/p/{pid}/assistant/suggest` returns starters built from the
project's state. It uses the RunStore, the IR and the alerts:

- runs that failed in the last day → "Why did 3 runs of `call` fail
  today?";
- no evals → "Set up an eval for `call`";
- an alert firing → "Look into the alert `call errors`";
- a service not running;
- an op selected → "Explain `route_1`" / "Why is `route_1` slow?".

Generic starters fill the rest. They show in an empty session, and as
contextual chips above the composer.

### 3.7 Progressive disclosure

- **Normal view:** nothing technical. A thin context meter appears only
  once the context is more than 50% full. Above 80%, it suggests
  **Compact**.
- **Session details (ⓘ):**
  - model;
  - context used and its limit;
  - input, output and cache tokens for the session;
  - cost;
  - number of turns;
  - Claude session id;
  - the agent's reach (read, edit or full) and its working directory.
- **Settings:** the default model; the reach is shown read-only when
  the deployment fixes it.

### 3.8 Compact

`/compact`, or the button, compacts the conversation. The studio
session carries on, with a "compacted — N tokens → M" divider in the
transcript.

If headless `/compact` turns out not to work (the §0.3 check), the
fallback is: the model writes a continuation summary, a fresh Claude
session is seeded with it, and the same divider shows.

### 3.9 Server API

All of it is additive. The old `/chat` routes stay while anything uses
them, then go, with their tests moved to the new routes.

```
GET    /api/assistant/sessions?scope=&q=&archived=   list and search
POST   /api/assistant/sessions                       {scope, model?}
GET    /api/assistant/sessions/{sid}                 session + items
PATCH  /api/assistant/sessions/{sid}                 {title?, archived?, model?}
DELETE /api/assistant/sessions/{sid}
POST   /api/assistant/sessions/{sid}/turns           {message, view, fork_at?}
POST   /api/assistant/sessions/{sid}/compact
POST   /api/assistant/import                         old localStorage transcripts
GET    /api/assistant/turns/{tid}/stream?cursor=     NDJSON, ≤ 8 s a window
GET    /api/assistant/turns/{tid}?cursor=            poll fallback
POST   /api/assistant/turns/{tid}/stop
GET    /api/p/{pid}/assistant/suggest
GET    /api/p/{pid}/pulse?stamp=&ui=&chat=           decision 3
```

**Schema:**

- `sessions`: `id`, `scope`, `title`, `title_source`, `created`,
  `updated`, `archived`, `model`, `claude_session`, `usage` (JSON),
  `running_turn`
- `items`: `session`, `seq`, `turn`, `kind`, `payload` (JSON),
  `created`
- `turns`: `id`, `session`, `claude_session_before`,
  `claude_session_after`, `state`, `started`, `ended`, `usage`, `cost`
- `items_fts`: title and text

**Writes:** the turn relay appends items as events arrive, in batches of
250 ms or 20 events, so a studio restart loses at most a quarter of a
second of a running turn's transcript.

---

## 4. Performance (B)

| # | Change | Fixes |
|---|---|---|
| B1 | A single script bundle for the project page and one for home (decision 4) | P1 |
| B2 | The IR inlined into the page HTML (decision 5) | P1 |
| B3 | `pulse` replaces `/stamp` + `/ui/actions` polling (decision 3) | P2 |
| B4 | Home: one `/api/projects` request; the health result cached until a project's stamp changes | P3 |
| B5 | `api()` survives a non-JSON body, retries safe GETs once on a network error, and sends a 401 to the login page | P6 |
| B6 | Incremental Flow repaints | P4 |
| B7 | A screen gets what it needs in **one hop**: the list endpoint embeds the first item's details (Jobs, Evals, Review, Settings, Runs, Playground). Showing a revisited screen's last data at once is deferred: after one-hop loads, measure whether it is still felt. | P8 |

**B6 in detail:**

- Profile `render()` to find its cost; forced reflows inside loops are
  the suspect.
- Painting a run, selecting a node and live-run state all become class
  and attribute toggles on nodes that already exist.
- `render()` runs only when the graph's shape changes.

**Budgets:**

| Measure | Budget | Today |
|---|---|---|
| Project open to first node, through the tunnel, repeat visit | ≤ 1.6 s | 2.8–3.6 s |
| Idle requests | ≤ 0.13/s | ≈ 1.2/s |
| First visit to any screen, through the tunnel | ≤ 1 hop (≈ 0.9 s) | 0.8–2.3 s |
| Revisiting a screen | Its last data on screen at once | a full refetch |
| Selection or run-paint on callbot | < 16 ms | 60–100 ms |
| Full render on callbot | < 40 ms | 60–100 ms |
| Full render on a synthetic 300-node graph | < 200 ms | — |
| Streamed assistant text | on screen within one network hop of being generated | — |

---

## 5. Flow (F)

- **F1 — Open fitted.** The first view fits the top level of the graph
  to the stage and centres it, never below a readable zoom. Once the
  user pans or zooms, that view is remembered and restored.
- **F2 — Calm cards.**
  - A node shows its name and one small glyph for its kind.
  - The `IO`, `SYNC` and transient badges move to Inspect, or show on
    hover and in a "details" canvas mode.
  - Show-key values stay; they are the useful part.
- **F3 — Alive while running.** Bridge `ops` events (decision 7) drive
  the canvas:
  - A node goes idle → active → done or failed, with an
    opacity and transform transition of 150–250 ms.
  - On completion, a small particle travels each incoming edge.
    Particles are SVG circles on the edge path with an `offset-path`
    animation, or a dash sweep, whichever is cheaper when measured.
    There are at most 24 at once; the oldest is dropped first.
  - A header line reads, for example, "call · live · 12 ops · 3.4 s".
  - `prefers-reduced-motion` turns the particles off and keeps the
    state colours.
- **F4 — Replay a recorded run.** A recorded run replays on the canvas
  at 1×, 4× or instantly, from its recorded start and end times, using
  the same drawing as F3. This works for any run, including production
  calls.
- **F5 — Large graphs.** A synthetic 300-node graph goes into the perf
  harness. Culling off-screen nodes is added only if B6 still misses
  the budget.

---

## 6. Visual system (V)

**Direction:** robotics, advanced AI infrastructure, precision
engineering. Clean, calm and exact.

- **Neutrals:** cool graphite instead of today's warm cream.
- **Hairlines:** 1 px borders; one shadow layer at most.
- **Radii:** 6–8 px.
- **Type:** tabular numerals wherever numbers line up; monospace only
  for identifiers.
- **Colour:**
  - one **signal** colour, used only for live and active state;
  - the brand gold stays on the mark and the primary action;
  - status colours are reserved for status.
- **Motion:** 120–180 ms ease-out transitions on hover, press, panels
  and new messages (opacity plus a 4 px rise); nothing loops except
  live state.
- **Ruled out:** neon, glow, HUD chrome, decorative grids, stacked
  gradients, and cards that exist only to be cards.

**Colour checks:** the palette is validated with the `dataviz` skill's
validator (CVD separation and contrast) before it ships.

**Dark mode:** the studio has none today. All colours move to tokens in
this phase. Outside its token block, `studio.css` still has 210
hard-coded hex colours (136 distinct), so today a theme cannot be
swapped. After this phase, a dark theme is a token swap. Dark mode itself ships only if the
token work leaves time; it is not a gate.

---

## 7. Everything else a user trips on (U)

- **Home:**
  - Rows show the name and a short path (`~/…`, or `…/scratchpad/p5demo`).
  - When two projects share a name, the parent folder tells them apart.
  - Health dots explain themselves on hover.
- **Empty states** offer the assistant action next to the manual one.
  For example, Evals gets "Ask the assistant to set up an eval for
  `call`".
- **Errors:** every error is one human line, the details folded away,
  and a retry.
- **Phone:**
  - The bottom Ask bar and full-screen assistant (§3.1).
  - The breadcrumb collapses to the project name.
  - The rail drawer stays as it is.

---

## 8. Phases

Each phase ships alone and is measured alone.

| Phase | Content | Gate |
|---|---|---|
| **R0 — plan and harness** | This document. The audit and screenshot scripts go into `scripts/perf/`, runnable against any base URL. | Committed |
| **R1 — fast** | B1–B5, B7 | The budget table in §4 met or explained; the numbers recorded in §10 |
| **R2 — assistant backend** | The §0.3 checks first; then `ChatStore`, forked turns, streamed windows, usage and limits, suggest, pulse, import, titles | Unit tests for the store, turn relay, fork, stop, restore and import, using a fake `claude` binary that replays recorded `stream-json`; then one real `haiku` turn end to end |
| **R3 — assistant UI** | §3.1–3.8: the panel, sessions, composer, cards, focus mode, phone | Screenshots on desktop and phone; an extensive real-assistant test pass (§9) |
| **R4 — Flow** | F1–F5; the operonx bridge `ops` event (an additive change on the operonx branch) | Render budgets; live and replay screenshots; operonx tests green |
| **R5 — visual system and states** | §6 and §7 across every screen | Palette validator green; before-and-after screenshots of every screen |
| **R6 — verification** | Major flows end to end, the assistant extensively, the Flow view, responsiveness, performance measured again, regressions fixed, polish | §10 filled in |

**Every phase:**

- Studio tests stay green; new behaviour gets tests.
- Commits are made as Bruce Win, with no co-author line. Nothing is
  pushed until asked.
- The live studio on :8766 is restarted after Python changes.

---

## 9. How the assistant will be tested

**Offline** (in CI, at no cost): a fake `claude` binary that replays
recorded `stream-json` files, including the tool, error, stop and
compact variants. It covers:

- the relay;
- persistence;
- restore after a restart;
- forking;
- stop;
- the streamed windows and cursor resume;
- search, archive and delete;
- the old-transcript import.

**Live**, on the real CLI, through the tunnel, on desktop and phone:

1. a question about the project;
2. a task that edits code, then Keep, then Undo;
3. a task that uses studio tools (open a run, monitor);
4. stop mid-tool;
5. a reload mid-turn, and reattaching from the phone;
6. retry after a forced error;
7. regenerate;
8. edit-and-resend;
9. compact;
10. switching sessions while one runs;
11. search, archive and delete;
12. a long turn left running while the user moves to another screen.

The live pass uses the host's Claude login; `haiku` is used wherever the
model does not matter.

---

## 10. Progress

| Phase | State | Numbers |
|---|---|---|
| R0 | done — plan and harness (5f5a562) | baseline in §0 |
| R1 | done — see below | |
| R2 | done — see below | |
| R3 | done — see below | |
| R4 | done — see below | |
| R5 | done — see below | |
| R6 | done — see below | |

**R6 — verification**, on the finished build:

- **Major flows** (`scripts/perf/flows.py`, no model spend): **21/21** —
  home with health and the assistant first; a project opening on its
  flow; select an op, Ask about it (the op lands on the composer); Runs
  → a run → Workflow → Replay; Monitor; an eval run; Jobs with runs and
  items on one screen; a playground form; Review; Settings' preview;
  Alerts; Services; nested graphs opening in place; find with `/`; no
  page errors.
- **The assistant, live** (`live_assistant.py`, real haiku turns):
  **23/23** again after R4–R5. **The home assistant** created a working
  project from the RAG template in 9.7 s through its `new_project` tool,
  and its link opened the project on its flow.
- **The Flow view:** replay and live-session following on real runs and
  a real WebSocket session (R4); the 302-op graph within budget.
- **Responsive:** 1440 desktop, 1024 and 768 tablets, 390 phone. Found
  and fixed: at 768 px the docked assistant squeezed the Runs table to
  ~150 px — between 761 and 1099 px the side panel now floats over the
  content, starts closed, and the Ask bar opens it.
- **Performance, again through the tunnel** (same two projects):

| Measure | R0 baseline | Final |
|---|---|---|
| Home to a full list | 1.8 s | **1.1 s**, 0 API calls |
| Project open, first visit | 3.9 s, 19 requests | **2.8 s**, 3 requests (1.8 s of it the 130 KB bundle at ~150 KB/s) |
| Project open, repeat | 2.4 s | **1.7 s**, 0 API calls |
| Any screen | 0.8–2.3 s | **0.77–0.99 s**, one hop (Resources 1.2 s: a fresh tunnel connection — the endpoint answers in 6 ms) |
| Playground, cold | 1.6–2.0 s | 1.3–3.6 s, one hop; the rest is the project's interpreter starting (P9) |
| Idle requests | ≈ 1.2/s | **≈ 0.1/s** (one held pulse) |

Small fixes from the pass: Claude Code loading its deferred tool
definitions (`ToolSearch`) now reads "Loaded the studio's tools" and no
longer counts as work in an activity summary.

**Left as they are, on purpose:** minification (≈0.25 s once per deploy,
not worth a dependency), a dark theme (semantic tints need their own
pass), culling for huge graphs (302 ops is within budget), prewarming
the playground bridge (a project interpreter per open page).

**R5 — visual system and states.**
- The graphite tokens (R3) now reach the last warm leftovers: the modal
  and drawer backdrops, the phone sheet's shadow, the "scratch" chip.
  What stays hard-coded is meaningful colour (syntax, values, the
  inspector's amber outputs), not the old palette.
- Empty screens lead with the action that fixes them — the assistant
  doing it (Set up an eval, Add a job, Serve this graph, Add an LLM
  step), or a plain button (Try it in the Playground, Show the last 30
  days, Run the job); a manual recipe folds under "Or do it by hand".
- Screens that could not load say so in one line with **Try again**
  (Evals, Alerts, Services, Review, Settings, Jobs, Monitor, Runs); a
  playground that could not start offers Try again and "Ask the
  assistant why"; its cold start says what it is doing.
- Home: short paths (the full one on hover); two projects with one name
  carry their parent folder.
- The phone header gives a one-graph project's name the room ("Flow ·
  educa_reminder", was "ed… / ws_ca…").
- Screens settle in with a 180 ms transform/opacity transition.
- **Dark mode is not shipped.** The remaining hard-coded colours are
  semantic tints that would each need a dark counterpart; the plan kept
  it out of the gates.

**R4 — the Flow view**, measured with `scripts/perf/render_cost.py`
(and a layout-geometry dump compared byte for byte before and after):

| Measure | Before | After |
|---|---|---|
| `render()`, callbot | 60–108 ms, 202 forced layouts | **36–40 ms** (50 ms with every nested graph open) |
| `render()`, educa_reminder_agent | 70–98 ms | **28–44 ms** |
| `render()`, synthetic 302 ops (`p10/big300`) | — | **126–130 ms** steady, ≤ 260 ms cold (budget 200) |
| Zoom/pan frames, 302 ops (4,555 DOM nodes) | — | p95 **17 ms**, no long tasks |
| Selecting an op, callbot | — | **9 ms** script, 13.5 ms with layout (p50) |
| Wire paths drawn, callbot | 153 | **55** |
| Frames during a replay | — | p50 16.6 ms, p95 20 ms |

- **B6:** the width pass measured card by card (write a style, read a
  width, write it back, read again) — two full layouts of the canvas per
  card. One class now switches every name line to max-content, all
  widths are read in one layout, the laid-out widths in a second, then
  everything is written; the decision rows' positions are all read
  before their sides are set. The geometry dump of four projects at
  three zooms is identical before and after.
- **F1:** the flow opens fitted — whole when it fits at ≥ 70%, else
  across its width at ≥ 70% — and names grow at middle and far zoom so
  they stay ~10 px on screen. A view the user sets is remembered per
  project and graph; Fit returns to the landing view.
- **F2:** the organic "cells", cyan neon selection, glow halos, white
  filaments and static spark dots are gone (the brief rules out glow and
  decoration, and dots on idle wires said "flowing" when nothing was).
  Cards are white on a hairline border with a kind tile; kind/bound chips
  show on hover, selection and close zoom; selection is a signal ring.
- **F3:** operonx's `serve_session(on_start=)` hands the playground the
  run's handle; the bridge streams `ops` batches as executions finish
  (operonx 8a0ea7d, 2225 tests). The page keeps listening while a
  session is open, even off the playground, and the Flow canvas follows
  it: the op at work rings in signal blue, finished ops settle green or
  red, particles run the wires to the consumers, a pill says what is
  moving and stops it.
- **F4:** any recorded run replays from its timings (Replay / 4× in the
  run view), a 2 ms job and a 55 s call alike compressed to 3–12 s; with
  **Live** on (the canvas bar, default on) each new run of the graph on
  screen replays as it lands, unless a live session already showed it.
- **F5:** culling is not needed — the 302-op graph meets the budget.

Found on the way, and fixed: **a project whose graph construction logs
a warning could not be extracted at all.** operonx's LOGGER writes to
stdout, the same stream the extractor's JSON went out on ("extractor
returned invalid JSON"). The daemon and `operonx-extract` now keep
stdout for the IR alone (fd-level, as the playground bridge does); two
tests cover a print at import and an unwired-op warning.

**R3** — `static/assistant.js` replaces `chat.js`: one component placed
as the project page's right column (the default tab now), the whole
stage (focus, Ctrl J), a phone's full screen (from an Ask bar on every
screen), and the home page's opening question, with Recent
conversations beside the projects. Sessions (search, rename, archive,
delete), turns grouped with a collapsible activity block per run of
steps (each step's input and result a click away), streamed text
rendered once per frame, Stop, Regenerate, edit-and-resend (it offers
to put back files a replaced answer changed), `/` commands, context
chips for what rides along, the context meter past 50%, a details
popover (model, context, tokens, cost, plan usage, reach, session id,
compact, export), cross-tab "finished" notices through the pulse, and
old browser transcripts imported once. The old `/chat` routes are gone;
their tests now cover the new routes.

Two changes to the plan: the new token palette (§6) landed at the
start of R3 rather than in R5, so the assistant was built in its final
look; and **turns load only the studio's own MCP server**
(`--strict-mcp-config`, `OPERONX_STUDIO_CHAT_STRICT_MCP=off` to undo):
measured init 1.7–1.9 s against 3.0–3.2 s, and the host's personal
connectors (mail, drive, calendar) stay out of the studio agent's reach.

The live gate (`scripts/perf/live_assistant.py`, real haiku turns through
the page): **23/23** — a streamed answer (first text 13.7 s on a
read-the-code question, 4–5 s on a plain one), an edit arriving as a
card and Undo restoring the file on disk, Stop keeping the partial
answer, Regenerate replacing rather than adding, an edit forking to one
turn, `/compact` (24k → 2.0k), a reload mid-turn reattaching, sessions
new/search/archive/delete, the phone sheet; no page errors.

Found by it, and fixed:
- **Doubled first words** ("TheThe `scored` op…"): an item event held
  the live dict its deltas kept growing, so a reader a moment behind got
  the text twice. Events carry snapshots now; a test rebuilds the text
  from the events and failed ("HelloHello") before the fix.
- The title stayed "New conversation" until the turn ended; it is set
  from the first message as it is sent.
- A step that failed and was recovered from marked the whole activity
  red; the group now keeps its check and counts the failures.

**R2** — `operonx_studio/assistant.py` (ChatStore + Relay), the
`/api/assistant/*` routes, `suggest`, the pulse's `chat` field, and the
home assistant's own tools (`list_projects`, `new_project`). 14 offline
tests against a fake `claude` that replays real-shaped stream-json.
One real turn end to end, through the tunnel on `haiku`: the first answer
token was on the client 8.2 s after sending (a file read first); the
rest arrived token by token in the same window; 6 items persisted; the
context meter read 24,539 of 200,000; $0.027.

Found by that real turn, and fixed:
- A tool label kept an absolute path: the hint was cut to 80 characters
  before it was made relative, and the project's path is longer than 80.
- The model-made title answered the conversation instead of naming it
  ("I can't find operonx.toml…"). The title call now has its own system
  prompt, no tools and no MCP servers, and anything that does not read
  as a title is dropped. The same conversation now gets "Dataflow graph
  HTTP API project" ($0.003).

**R1, measured through the tunnel** (`scripts/perf/audit.py`, same two
projects, 2026-09-27; local numbers in brackets):

| Measure | Before | After |
|---|---|---|
| Home, to a full list with health | 1.8 s, 3 hops | **1.0 s, 1 hop, 0 API calls** [0.27 s] |
| Project open, first visit (bundle not cached) | 3.9 s, 19 requests | **2.7 s, 3 requests** — 1.7 s of it is the 110 KB bundle at P10's throughput |
| Project open, repeat visit | 2.4 s | **1.7 s, 3 requests, 0 API** [0.40–0.46 s] |
| Idle requests | ≈ 1.2/s (12–14 per 10 s) | **1 per 8 s** |
| Assistant action → on screen | up to ~3 s | **at once** (the pulse test wakes in < 3 s of a 6 s hold; measured 47 ms locally) |
| Code change → redrawn | 1.5 s poll + extraction | **~1 s after the save** (extraction included) |
| Jobs | 2.3 s, 3 hops | **0.77 s, 1 hop** |
| Evals / Review / Settings | 1.5–1.9 s, 2 hops | **0.77–0.91 s, 1 hop** |
| Runs | 2.0–2.3 s, 2 hops | **0.79–0.81 s, 1 hop** |
| Playground | 1.6–2.0 s, 2 hops | 1 hop; 1.8–3.4 s is the bridge's cold start (P9) |
| Watcher fingerprint (educa_reminder_agent) | 65 ms | **14 ms** — `.operonx` (2.3 k run records) is no longer walked |

Not done, on purpose: **minification.** Measured: −31 KB gzipped JS and
−7 KB CSS, about 0.25 s once per deploy at P10's throughput. Not worth a
new runtime dependency. **Prewarming the playground bridge** would spend
a project interpreter per open page; the screen says it is starting
instead (R5).

---

## 11. Not changing

- **No drag and drop.** Code stays the product; the assistant stays the
  editor.
- **The business logic** of runs, stores, evals, jobs, services, alerts,
  the playground and the templates.
- **No new infrastructure:** no Redis, no Postgres requirement, no node
  build.
- **The login wall** stays the security boundary, and the agent's reach
  (`OPERONX_STUDIO_CHAT_MODE`) stays a deployment decision.
