---
title: A long tool call shows its stages, its real progress and whether it is alive
status: plan
phases:
  - {id: E1, title: "Every shell call observed: the hook wraps foreground and background calls, records the shell's pid", status: open}
  - {id: E2, title: "progress.py: one parser registry (tests, install, build, lint, fetch, docker, generic) → stages and counts", status: open}
  - {id: E3, title: "Stages of a chained command: a conservative top-level split, markers between the parts", status: open}
  - {id: E4, title: "The relay: liveness from /proc, coalesced progress events, background calls linked to their task, stop one call", status: open}
  - {id: E5, title: "The page: the running row's bar, counters, liveness and stages; the status line; node tests", status: open}
  - {id: E6, title: "Knowledge: separate stages, background past two minutes, never poll", status: open}
  - {id: E7, title: "Live gate: a Sonnet turn on the scratch studio, shots, overhead and gap measurements", status: open}
rows: []
updated: 2026-11-01
---

# A long tool call shows what it is doing (EXECUTION_PROGRESS_PLAN)

Owner's brief (2026-11-01), "Improve Execution Granularity & Fine-Grained
Progress Tracking": a test suite, a build, an install or any long command
shows today as one spinning row for minutes. The fix should be systematic
rather than one tool at a time, and it must be honest. Its principle is:
**break down what can be broken down, instrument what cannot, and show real
progress, not artificial activity.**

This plan builds on [ASSISTANT_PROGRESS_PLAN](ASSISTANT_PROGRESS_PLAN.md)
(the `steps` card, which shows the model's own plan) and
[VISUAL_CHAT_PLAN](VISUAL_CHAT_PLAN.md) D6 (test counts as a run goes).
Those cover the levels *above* a tool call. This plan covers what happens
*inside* one.

## 1 · What is there today (audited on main abc1ae0)

**The studio does not run commands.** The Claude CLI runs them and the
studio relays its `stream-json` (assistant.py `Relay`). So the studio cannot
split a command the model wrote into separate executions. It can do three
things:

- see the call before it runs, through the PreToolUse hook;
- read what the call writes;
- tell the model how to work, through knowledge.md.

**What a running call sends today:**

| Signal | What it says | Used for |
|---|---|---|
| `assistant` tool_use | the call and its input | the row, its label, `t0` |
| `tool_progress` (~every 30 s) | the CLI's heartbeat: `tool_use_id`, `elapsed_time_seconds` | only the idle watchdog's "heard" |
| testhook.py (PreToolUse) | **test commands only, foreground only**: output teed to `live-<turn>/<call>.out` | `_watch_tests` reads it at 1 Hz → `tests` counts on the item (#137) |
| `background_tasks_changed`, `task_notification` | a background task started or ended (its description) | the "waiting" state, the 120-min wait limit (#138) |
| `user` tool_result | the end: the output (clipped to 4,000 chars), the error flag | status, `ms`, the test report |

Every other call, whether a build, an install, a script, a lint run or a
chained `a && b && c`, is a spinner and a clock until it ends. A
background call ends at once ("running in background with ID …"), and
then nothing shows its progress at all.

**The hook already runs for every shell call.** Its matcher is `Bash`, and
it decides inside whether to wrap the command. It takes 0.10 s per call
(measured, 3 runs), so wrapping every call costs no new process.

**Updates replace the whole item.** `_replace` sends the item with its
input and output, each up to 4,000 chars, on every count change. A
reconnect replays every event from its cursor.

**Stop** sends SIGINT to the CLI's process group (`start_new_session=True`),
then a kill. Nothing stops a single call.

### What actually runs long: 44,025 shell calls, 30 days of transcripts

Measured from `/root/.claude/projects/*/*.jsonl`: each Bash `tool_use`
timestamp is matched to its `tool_result`. The script is in the session
scratchpad as `cc_bash.py`.

| Kind | Calls | > 60 s | > 5 min | p90 | Timed out |
|---|---|---|---|---|---|
| tests | 4,933 | 756 | 89 | 93 s | 3 |
| scripts (python, node, uv run) | 10,261 | 351 | 26 | 21 s | 2 |
| **waiting: `sleep`, `until`, `pgrep` loops** | 3,127 | 301 | **84** | 54 s | 1 |
| fetch (git, curl, gh) | 2,765 | 42 | 1 | 12 s | 9 |
| install | 434 | 17 | 0 | 24 s | 0 |
| build | 240 | 16 | 2 | 38 s | 1 |
| lint | 801 | 6 | 0 | 7 s | 0 |
| everything | 44,025 | 1,549 | 207 | 16 s | **17** |

What this shows:

- **Timeouts are rare: 17 in 44,025 calls.** Most hit the CLI's 2-minute
  default on a call that set no timeout. Raising limits would not fix what
  the owner sees, and the brief rules it out anyway.
- **The long rows are tests, scripts and the model waiting on itself.**
  3,127 calls were polling loops. In the owner's FEATURE_FLOWS chat
  session:
  - the suite was started in the background;
  - the model then sat in `timeout 590 bash -c 'until ! pgrep -f pytest …'`, a 590 s row showing nothing;
  - the next call was another 68 s loop.

  The CLI already wakes the turn when a background task ends, so these
  loops are needless (D8).
- One studio store (52 sessions, 111 calls) has the same shape: p99 240 s,
  max 590 s, and every call over 60 s was a wait loop.

### Two costs measured before deciding

- **bash's DEBUG trap**, to see each command as it starts: a 200,000-pass
  shell loop took 1.1 s plain and **16.4 s** with a deduplicating trap.
  Rejected.
- **Plain markers** between the top-level parts of a command: 0.95 s,
  which is no cost. Taken (D3).

## 2 · Decisions

### D1 · One wrap for every shell call, foreground and background

testhook.py becomes **runhook.py**. It wraps every Bash call: tests, and
also builds, installs, scripts and background runs.

- The wrap is the one in production since #137:
  - the command runs in the shell itself, so a `cd` still holds;
  - its exit status is kept;
  - output also goes to `<live>/<call>.out`;
  - `PYTHONUNBUFFERED=1` is set.
- It adds one line, `echo $$ > <live>/<call>.pid`: the shell's pid, which
  liveness (D4) and stopping one call (D7) need.
- The hook still steps aside, leaving the call exactly as written, when:
  - the shell is not bash;
  - the call id is odd;
  - the hook fails.
- E1 checks the wrap keeps a command's meaning, as tests on real bash:
  - exit codes: 0, 1, 130, and a `set -e` failure;
  - `cd` persisting to the next call;
  - heredocs and a trailing comment;
  - `exit` inside the command;
  - stdin-reading commands;
  - background runs.

  One real-CLI check confirms `run_in_background` calls go through the
  hook.

### D2 · progress.py: one parser registry, three honest modes

`progress.parse(command, output_so_far) → Progress | None` replaces
`testreport.progress`. testreport keeps the end-of-run report.

A parser is picked by **the command first, then the output**. Each one
knows its tool's semantics. One that does not recognise the output returns
nothing; it never guesses.

```
{"mode": "measured" | "estimated" | "indeterminate",
 "current": 312, "total": 570, "unit": "tests",          # total only when the tool printed it
 "activity": "tests/test_board.py",                      # the last meaningful line, in words
 "stages": [{"id": "collect", "title": "Collect", "state": "done", "t0": …, "t1": …, "summary": "570 items"},
            {"id": "run", "title": "Run", "state": "active", "current": 312, "total": 570}, …],
 "lines": 4120, "bytes": 391204, "at": <last output time>}
```

- **measured** means the tool printed both the count and the total. Only
  then is there a percentage and a solid bar.
- **indeterminate** means there is a count or an activity but no total. It
  gets a counter and the activity line, never a bar.
- **estimated** comes from history, never from the run itself. The store
  already has `ms` for past calls with the same label. The row then says
  "last run 8 min 17 s", with a dashed outline bar marked *est.* It never
  shows as a measured percentage.

The parsers in E2, each with output fixtures:

| Family | Stages | Measured from |
|---|---|---|
| pytest (`-q` dots, `-v`, per-file lines) | collect → run (per file under `-v`/default) → report | `collected N items` + `[ NN%]`/counted results |
| node --test, jest, vitest, go test, cargo test | run → report | counted results; the total when the runner prints a plan (`1..N`, `Tests: … of N`) |
| pip / uv / npm / pnpm / yarn / apt | resolve → download → install | uv `Resolved N` → `Installed N`; apt `N newly installed` → `Setting up` lines; pip/npm: indeterminate, the current package |
| make / cmake, cargo build, tsc, vite / webpack, docker build, xcodebuild | per target / per step | cmake `[ NN%]`, docker `[n/m]`, webpack `NN%`; vite `N modules transformed`; cargo `Compiling x` counted |
| ruff, eslint, mypy, pyright | one stage | indeterminate; the end gives the count |
| git clone/fetch, curl, wget | one stage | `Receiving objects: NN% (n/m)`, curl's `%` column |
| anything else | one stage (or D3's parts) | indeterminate: lines, bytes, the last non-empty line as activity |

### D3 · A chained command shows its parts as stages, without changing its meaning

`ruff check . && pytest -q && npm run build` is one call made of three
parts. The hook splits it only when the command is a plain top-level
list:

- the parts are joined by `&&`, `;`, `||` or newlines;
- it uses shlex tokens, so quoted text is respected;
- it does **not** split when it sees a heredoc, `$(`, backticks, `(`/`{`
  groups, `if`/`for`/`while`/`case`, a function or a background `&`.

When it does split, it puts `printf 'part n\n' >&8` before each part. fd 8
is the live file's marker channel, so stdout is untouched.

The page then shows the parts as stages:

- the ones still to come, from the split;
- the one running now, from its marker;
- each part's output parsed by its own D2 parser, so the pytest stage
  counts tests and the build stage counts modules.

A command it does not split stays one stage. It is still instrumented
by D2.

The DEBUG trap is not used: it measured 15× slower on loops (§1).

### D4 · Alive, quiet, stalled: from the process, not from words

The pid file (D1) lets the relay read, about once a second, the call's
process tree from `/proc/<pid>/task/*/children`. That is the
shell and its descendants. It sums their CPU time from `/proc/<pid>/stat`
and compares it with the last output time.

| State | When | The row says |
|---|---|---|
| active | output in the last 15 s | the activity line |
| busy | no output, CPU time rising | "working · no output for 1 m 20 s" |
| idle | no output, no CPU, alive, under 2 min | "waiting · no output or CPU for 40 s" (network, a lock, a sleep) |
| stalled | the same for 2 min or more | "no output or CPU for 3 m — it may be stuck", and the row offers Stop (D7) |
| ended | the tree is gone but the CLI has not reported yet | "finished, waiting for the result" |

The CLI's `tool_progress` heartbeat confirms the CLI itself is alive, and
its `elapsed_time_seconds` is the elapsed time shown.

There is no `/proc` on macOS, so liveness says nothing there and the
output signals still show. The scan reads only the call's own pids, and
only while a call runs. It never reads `/proc/*/environ`.

### D5 · Small, coalesced, ordered progress events

There is a new client event:

```
{"t": "progress", "seq": n, "rev": k, "progress": {...}}
```

It carries only the item's progress, not its input and output. The
brief's schema, mapped onto the existing model:

- execution_id → the turn;
- step_id → the item's seq, or a stage id;
- parent_step_id → the plan step that was active when the call started
  (the existing D12 grouping) for a call, or the call for a stage.

How progress events behave:

- **At most one per second per running call, and only on a change.** The
  clock is not a change: the page ticks elapsed time itself from `t0`.
- **Coalesced.** When a call gets a new progress event, its previous one
  in `turn.events` is replaced with `{"t": "skip"}`, so cursors stay
  valid. A reconnect or a reload replays the latest state, not 1,800
  updates.
- **Ordered and safe.** `rev` rises per item. The page ignores:
  - an older `rev`;
  - any progress for an item that has ended.

  The final tool_result replaces the item whole and always wins.
- The item keeps its last progress, saved with the existing 0.25 s
  flush, so a reload rebuilds the row.
- **Measured.** When a call ends, the item records `{"events": n,
  "max_gap_ms": …}`: how many updates it sent and the longest stretch
  without one. That is the brief's §8, kept per call. `scripts/progress_stats.py`
  prints them from the store.

### D6 · A background call stays a live row until its task ends

The Bash call with `run_in_background` returns at once, with "Command
running in background with ID: b1". The relay then:

- reads that id;
- links the row to the task in `background_tasks_changed`;
- keeps the row running and fed by D2–D4 from its live file, until
  `task_notification` ends it.

The "waiting" status line then names the task and its progress, for
example "Waiting · Full suite · 312 / 570 tests · 4 m". The waiting limit
from #138 stays.

### D7 · Stop one call, not the turn

A running row gets a Stop button. `POST /api/assistant/turns/{id}/calls/{call}/stop`:

1. sends SIGINT to the call's process tree from the pid file;
2. after 5 s, sends SIGTERM;
3. records `stopped_by_owner` on the item.

The command then ends with 130, and the CLI and the model carry on with
that result. The turn's Stop is unchanged. Before E4 ships, it is checked
on real bash and the CLI: whether a call's processes sit in the CLI's
process group, so that the turn's Stop also ends a background run, or are
left behind. Its access level is `edit`.

### D8 · Knowledge: let the work be seen

New rules in knowledge.md, in the section on running commands:

- Run independent stages as separate calls: install, then build, then
  test. A long chain of `&&` is one row.
- Anything likely to take more than two minutes runs with
  `run_in_background`.
- **Never poll** with `sleep`, `until` or `pgrep` loops. The studio
  shows the run's progress, and the turn wakes you when it ends.
- Use the plain progress output a tool already has: `pytest` without
  `-q` shows files, and uv and npm show their default progress. Never pass
  flags that silence progress just to shorten the output.

### D9 · The page: same timeline, more in the running row

The running tool row, both in the activity list and under a plan step,
shows one line:

```
⟳ Ran pytest  ▕████████░░░░▏ 312 / 570 tests · 55% · tests/test_board.py · 4 m 10 s   [Stop]
```

- **Measured:** a solid bar and the percentage. **Estimated:** a dashed
  outline bar marked *est.*, with "last run 8 m". **Indeterminate:** no
  bar, the counter and the activity.
- **Liveness** (D4): a small chip, shown only when the state is not
  active.
- **Opening the row** shows its stages:
  - a done stage: ✓ and its time;
  - the running one: lit, with its counters;
  - pending: grey; failed: ✕ and red; skipped: struck through;
  - the last 3 output lines.
- A plan step block shows its running call's line under its focus box.
  Its own head stays "n of m steps".
- **The status line** under the conversation says what the turn does now:
  - Thinking;
  - Writing;
  - Running · `<label>` · `<counter>`;
  - Waiting · `<task>` · `<counter>`;
  - Stopping.
- Nothing new pulses: the one spinner stays (ASSISTANT_PROGRESS D7). No
  progress event ever adds a message: it updates the row in place.
- Light and dark use the studio's tokens. At 390 px the counters wrap
  under the label.

## 3 · Phases

| | What | Est. |
|---|---|---|
| E1 | runhook.py wraps every Bash call (foreground and background), pid file, marker fd; the meaning tests on real bash (D1 list); one real-CLI check that a background call is hooked | 40 min |
| E2 | progress.py registry and parsers (D2 table), fixtures per family; testreport.progress folds in; estimates from the store's past `ms` | 60 min |
| E3 | the top-level splitter and markers (D3); tests on what splits and what must not | 30 min |
| E4 | relay: watcher for every running call, `/proc` liveness, `progress` events with `rev` and coalescing, the per-call stats, the background link, stop one call (route, access, fake-CLI tests) | 60 min |
| E5 | assistant.js + css: the running row, stages, liveness chip, status line, out-of-order handling; node tests; replay shots 1440/390, light and dark | 60 min |
| E6 | knowledge.md (D8) | 10 min |
| E7 | live gate (§4) | 30 min |

About 4 h 50 min in all. If it must be shorter, cut in this order:

1. D7, stopping one call (−25 min);
2. estimates from history (−15 min);
3. D3, stages of a chained command (−30 min).

## 4 · Gates

- **python, fake CLI:**
  - a call that writes output over time gets `progress` events, at most
    one per second;
  - a reconnect from cursor 0 gets only the latest progress per call;
  - a call with no output and no CPU goes idle, then stalled;
  - a background call stays live until its notification;
  - stopping one call ends it with 130 while the turn goes on.
- **python, parsers:** every family in the D2 table, with a real captured
  output each. The total appears only when printed, and the mode is
  never measured without a total.
- **python, meaning:** the D1 list on real bash, and the D3 split and
  no-split cases.
- **node:**
  - progress after the end is ignored, and so is an older `rev`;
  - the bar shows only in measured mode;
  - the estimated bar is dashed and labelled;
  - the stages render in every state.
- **live (E7, Sonnet, scratch studio on another port):** one turn that
  - runs the studio's own suite in the background;
  - runs `uv sync` and a chained lint-and-test command in the foreground.

  Shots at 1440 and 390, light and dark, mid-run and done. The numbers
  reported:
  - the longest gap between updates on each call;
  - progress events per call;
  - the hook's time per call;
  - the watcher's CPU while three calls run.

  A row must never go more than 15 s without either new output or a
  liveness state.
- The full suite (`tests/studio`, ~8 min) and `node --test tests/js/`
  once, at the end.

## 5 · Out of scope

- **A turn surviving a studio restart.** The CLI is the studio's child, and
  a restart already marks the turns it killed. Detaching the CLI is its
  own change.
- **Splitting a command into separate executions** behind the model's
  back. It would change what the model asked for. D3 shows the parts, and
  D8 asks the model to make separate calls.
- **Tools other than Bash** (Read, Edit, Grep): they take well under a
  second at p99.
- **Sub-agent (`Task`) internals:** their item stands for them, as now.

## Coverage: each section of the brief

| Brief | Where |
|---|---|
| 1 Hierarchical steps | plan step → call → stages (D2, D3, D5 parent ids); compact row, open for stages (D9) |
| 2 Break down long operations | D3 for chained commands, D8 for separate calls; the parsers cover tests, build, install, lint, fetch, scripts (D2); not split when unsafe (D3 rules) |
| 3 Real-time instrumentation | the hook's output channel and runner output (D1, D2); measured, estimated and indeterminate kept apart (D2) |
| 4 Long-running processes | background calls stay live (D6); reconnect gets the latest state (D5); stop one call (D7); no timeout raised (§1 evidence) |
| 5 Heartbeats, stalled | `/proc` CPU and output time, the CLI heartbeat (D4); no model calls |
| 6 UI | D9 |
| 7 Event architecture | D5 |
| 8 Performance | D5 per-call stats, E7 measurements, the DEBUG trap rejected on numbers |
| 9 Strategy and tests | §1 audit, §4 gates |
