# operonx studio — the platform plan

Status: **for discussion**. Nothing here is implemented.
Written 2026-09-27, on top of the `redesign/ui` branch.

The question this answers: what does a team need, from the first idea to
a product running in production, and which of it should live in the
studio? The answer is written as a user would walk it, then as the
screens and the data behind them, then as phases.

---

## 0. Where we are — facts, not impressions

What the studio does today, and what the records under it actually hold.
Every claim below was checked against the code or the disk on 2026-09-27.

| Area | Today | The gap |
|---|---|---|
| **Traces on disk** | One flat directory per project (`[studio] traces`). callbot's holds 72 runs mixed together: `live-*` calls, `int_*` test calls, nothing else. It lives in `/tmp`. | No grouping by what produced the run. `/tmp` is wiped on reboot. |
| **Service runs** | The serve runner can attach metadata to a run's trace, but no transport does, so a run doesn't know which service produced it. | A service run cannot be found by service. |
| **Job runs** | A job tags each run with `job`, `job_run` and `key`, and each item in `items.jsonl` carries a `trace_id`. | `qc_cases` declares no `trace=`, so **none of its 235 item traces were recorded**. Every "Trace" link in the Jobs pane leads nowhere. |
| **Runbooks** | `run.json` holds the wires and a per-job tree. | You can't get from a runbook run to its job runs to their items to their traces in one path. |
| **Cost** | `LLMOp` records `usage` (tokens) and `cost_usd`, computed from the resource's `cost_per_input_token` / `cost_per_output_token`. It is `None`, never `0`, when there are no prices. | No resource has prices, so all 31 recorded `cost_usd` values are `null`. There is no view of cost anywhere. |
| **Latency** | Every execution has `start_time`, `end_time`, `duration_ms`, `ctx` and upstreams. | Only ever read one run at a time. No aggregates across runs, no percentiles, no trend. |
| **Run view** | Tree, plus a "workflow" canvas painted with the run: every card shows kind chips, show-key values, a run badge (`4× 11871ms`), a heat border and dormant fading, all at once. | Everything competes on every card, so nothing stands out. |
| **Doing things** | Edit a literal param, run or resume a job, chat with an agent that edits code. | You can't run a graph with inputs, replay a run, try a prompt, or evaluate a change. The loop "change → run → compare" happens outside the studio. |

The strength to build on: **the code is the product.** Graphs are
Python, the application (`APP`) declares every service, job and runbook,
and the studio reads what really exists — it never holds a second copy
of the truth that can drift. Every competitor that builds on a visual
canvas owns the flow in its own database; the moment a team needs real
code, they leave. operonx teams never have to leave.

---

## 1. Who uses this, and for what

Three people, one product:

- **The builder** (engineer). Writes graphs, wires resources, wants the
  shortest loop from "I changed a prompt" to "is it better, and what
  did it cost". Lives on desktop.
- **The operator** (on-call, QC). Wants to know "is it healthy, what
  broke, which call, why". Often on a phone, over the tunnel, after an
  alert.
- **The reviewer** (PM, QC, domain expert). Reads conversations, labels
  good and bad, never touches code. Their labels should become tests.

The journey all three share, and the studio's job at each step:

```
 idea ──► build ──► try ──► evaluate ──► ship ──► observe ──► improve
          Flow      Play-   Datasets     Serv-    Runs,       Review →
          Prompts   ground  Evals        ices     Monitor     dataset →
          Resources Replay  Compare      Jobs     Alerts      eval gate
```

Today the studio covers **build** (read-only, plus small edits) and one
slice of **observe** (one run at a time). The plan fills in the loop,
because the loop is what wins: a builder who can go from a bad
production call to a regression test to a better prompt to a green eval
without leaving one tool will not go back.

---

## 2. Your three asks

### 2.1 Traces with a structure: every run knows where it came from

**The model.** A run is one graph execution. Every run has exactly one
**origin**, and the origin is the folder it lives in:

```
Runs
├── Services
│   ├── call            (websocket /ws/call)      ← one run per call
│   │   └── 2026-09-27  … live-reminder-1790…
│   └── call_summary    (http POST …/summary)     ← one run per request
├── Jobs
│   ├── qc_cases
│   │   └── run 20260926T140722  (235 items)      ← one run per item
│   │       └── educa_reminder-002 → trace
│   └── backfill_call_logs
├── Runbooks
│   └── qc
│       └── run 20260926T140721
│           ├── qc_cases  → its job run above
│           └── qc_report → its job run
└── Ad hoc               (tests, scripts, the playground)
```

A runbook run is not a new kind of trace. It is a **group**: runbook run
→ job runs → items → traces. The studio draws the group from the records
that already exist (`run.json` wires and tree, `items.jsonl`); nothing is
duplicated.

**What operonx must do (upstream, small):**

1. **Tag the origin on every run.** The serve runner already merges
   metadata onto a trace. Every service sets
   `origin=service, service=<name>, transport=<kind>, variant=<v>` there,
   the way a job sets `job`, `job_run` and `key`. Runs with no tag are
   `ad hoc`.
2. **Trace a job's items by default.** A Job with no `trace=` takes the
   application's default local consumer. The broken Trace links above
   stop happening by construction, not by remembering a flag.
3. **One default place, inside the project.** The LocalConsumer default
   becomes `<project>/.operonx/runs/` (gitignored) instead of `/tmp`.
   Laid out by origin:
   `runs/services/<service>/<YYYY-MM-DD>/<trace_id>/`,
   `runs/jobs/<job>/<job_run>/<key>/`,
   `runs/adhoc/<YYYY-MM-DD>/<trace_id>/`.
   A person can find a run with `ls`, and clearing one job's traces is
   one `rm -rf`.
4. **Record the version.** Every run's `meta.json` carries the git commit
   (and a dirty flag). Section 3 depends on this: "p95 went up" is only
   actionable as "p95 went up *after commit abc123*".

**What the studio does:**

- Reads old flat directories and the new layout alike. The origin comes
  from the tags, not the path, so old runs with tags still sort into
  place, and untagged ones land in "Ad hoc".
- Keeps an **index** (SQLite, in the studio's cache): one row per run
  with origin, status, duration, cost, tokens, error count, version and
  top-level metadata. It updates incrementally by file mtime and never
  reparses a run that hasn't changed. The Runs list, filters, search and
  every dashboard number read this index; opening one run still reads
  that run's files.
- Links both ways: a job item links to its trace, and a trace links back
  to "item `educa_reminder-002` of qc_cases run 20260926T140722".

**The Runs screen:**

- Left: the origin tree above, with counts and a red dot on anything
  that failed in the selected time range.
- Main: runs in that folder. The columns are the answers people look
  for: when, status, duration, cost, turns or items, and the first
  error.
- Top: a time range (1h / 24h / 7d / custom), status, a search box over
  ids and metadata (`session_id:0912…`, `key:educa_reminder-002`), and
  sort by slowest or most expensive.
- On a phone: the tree becomes a picker, and the list stays.

### 2.2 The run view: show what matters, hide the rest

The workflow canvas today paints five kinds of signal on every card at
once, so the eye has nowhere to land. The fix is one principle: **one
question at a time, and the answer shows first.**

**A. A header that answers "was this run OK?" in one line:**

```
● failed · 51.5 s · $0.042 · 12 LLM calls · 3.1k tokens · 2 errors  [Next error ▸]
  slowest: bot_prompts 11.9 s (23%) · most expensive: reply_llm $0.031
```

**B. Lenses instead of everything at once.** One segmented control:
**Path · Time · Errors · Cost · Values**.

- **Path** (default): ops that ran are lit and ops that didn't are faded.
  Nothing else is shown.
- **Time**: each card shows one number (total time in this run), and the
  border heat shows its share of the whole run. The three slowest are
  called out with a rank badge.
- **Errors**: only failed ops are coloured, each with the last line of
  its error on the card.
- **Cost**: only ops that cost money show a number. Everything else is
  faded.
- **Values**: today's show-key values, on demand instead of always.

The kind chips (FUNC/SYNC/IO) disappear from cards while a run is
painted. They describe the code, not the run, and the Flow tab still
has them.

**C. A timeline you can scrub, instead of a turn dropdown.** A thin
waterfall strip under the header, with turns as segments. Dragging it
repaints the canvas for that moment, and clicking a bar selects the op.
For a call, the turns are the conversation. For a job item, there is a
single segment.

**D. The side panel, in the order you need it:**

1. **Verdict:** status, duration, and this execution's rank among the
   op's runs ("3rd slowest of 12"). If it failed, the error comes first
   with the traceback folded.
2. **Output:** the show-key values, large and readable.
3. **Input:** what it received, and from which op (the link jumps
   there).
4. **Cost and usage** (LLM ops): model, tokens in/out/cached, cost, and
   the rendered conversation.
5. **Its other runs:** a mini-chart of every execution's duration, where
   clicking a dot moves to it.

Anything anomalous is flagged: retries, a slow call more than 3× the
op's median, an empty output where there is usually text, a fallback
model used.

**E. Compare two runs.** Pick two runs to see side by side: per-op
duration and cost deltas, and which ops ran in one run but not the
other. Paired with the version tag, this answers "what did my change
do?"

### 2.3 A dashboard: latency and cost. Yes, and more

Yes, and it should be per **origin**, because "the call service" and
"the nightly QC job" have nothing in common except the code.

**The Monitor screen, per service or job, over a time range:**

| Tile / chart | Why it earns its place |
|---|---|
| Runs, error rate, p50 / p95 duration (with the previous period as a ghost) | "Is it healthy?" in four numbers |
| Runs over time, stacked ok / failed | When it broke |
| **Per-op latency table:** p50, p95, p99, max, calls per run, share of total time, trend arrow | Where the time goes; the slow op is at the top |
| **Cost:** total, per run, per op, per model; tokens in, out, cached | Where the money goes, and what caching saves |
| Top errors, grouped by message, with first seen, last seen, count and an example run | What broke, deduplicated |
| Version markers on every chart | Which commit changed it |

**Cost rules** (they follow operonx's own semantics):

- Only ops that report `cost_usd` count. Today that means LLM ops;
  embedding, STT and TTS join when their resources carry prices.
- An unpriced op shows **"unpriced"**, never `$0`, and the total says
  "$1.24 + 3 unpriced ops". That keeps "we did not measure" separate
  from "it cost nothing".
- The Resources pane gets a "set prices" affordance on LLM resources.
  Today none are priced, so the cost dashboard would be empty until one
  is. This is step one, not an afterthought.

For callbot specifically, the latency table is what the team already
builds by hand from logs: time to first audio, STT latency, LLM latency
and TTS latency per turn. The table should be able to pin a few **key
ops** per service (declared in code, the way `show_keys` is) so the
first row is always the one the team cares about.

---

## 3. What else a strong platform needs

Ranked by how much each shortens the loop in section 1. Each item says
what it builds on, because most of the machinery already exists.

### 3.1 Playground: run anything from the studio (highest value)

- **Run a graph** with a form generated from its signature. The graph's
  inputs are its door contract, which operonx already checks, so the
  form cannot drift from the code. Results appear as a run in "Ad hoc",
  opened immediately.
- **Replay a run:** take a recorded run's inputs and run them against the
  current code. This is the fastest debugging loop there is.
- **Run one op** with the inputs it had in a recorded run. A failing op
  deep in a call can be retried in a second, without making a call.
- For streaming services (the voice call), the playground is a **text
  channel**: type the customer's lines and let the graph answer, the way
  `mock_chat` does today in a terminal.

### 3.2 Datasets and evals: turn production into tests

callbot's `qc` runbook already *is* an eval: cases in, one verdict per
case, a report. Generalise what it proved:

- **Datasets:** a named list of inputs (with expected outputs if known),
  stored in the project as JSONL. Rows come from "Add to dataset" on any
  run or item, from a file, or from the reviewer's queue (3.4).
- **Evaluators:** code assertions, LLM-as-judge with a rubric, or exact
  and fuzzy match. Written as ops, so they are graphs too.
- **An eval run is a Job** (`source=dataset`, `graph=system under test`,
  plus evaluators). No new runtime; the Jobs records hold the verdicts.
- **Compare eval runs** by version: pass rate, per-case flips (passed to
  failed), cost and latency. This becomes a merge gate the CLI can run
  in CI (`operonx-run qc` exits non-zero already).

### 3.3 Prompt workbench

LLM ops are where most iteration happens. Open an LLM op to see its
prompt, edit it, and run it against N recorded inputs from real runs.
Results come back side by side against the recorded outputs, with
tokens and cost. "Save" writes the prompt back to the file it lives in
(`prompts.yaml` or code) through the same edit path that literal params
use, as a diff you approve.

### 3.4 Review queue

A reviewer opens a queue of runs (filtered by origin or by an eval
failure) and reads each one as a conversation, not a trace tree. They
mark it good or bad, attach labels, and write a note. Labels are stored
beside the run. "Bad" runs can go to a dataset in one click. This is
callbot's manual QC workflow, made into a screen.

### 3.5 Services control

List the application's services with their state: running or stopped,
port, workers, and live session count. Start or stop them in dev,
follow logs, and see health (`/health`, env contract). This builds on
`APP.serve()`. The Monitor screen links to it and back.

### 3.6 Alerts

Thresholds on an origin: error rate, p95 of a key op, cost per hour.
Delivery is a webhook (Slack, Teams, email relay). They are evaluated on
the index, so it costs nothing extra. An alert links straight into the
Runs list, filtered to the offending window.

### 3.7 The assistant, promoted from chat to colleague

It already knows the selected op and the painted run. Give it studio
actions as tools: "open run X", "make a dataset from these 20 failed
calls", "write an evaluator for 'bot must confirm the class time'", and
"why is p95 up since yesterday" (answered from the index, with links).
Its code edits keep going through the normal diff path.

### 3.8 Start fast: templates

"New project" offers a small gallery: a voice agent, a RAG
question-answerer, a batch scorer, and an HTTP API. Each is a working
graph with resources, a dataset, an eval and a job. A newcomer sees a
green run, a trace and a dashboard in the first five minutes. Dify, n8n
and OpenAI's Agent Builder all lead with templates for this reason.

### 3.9 Later: teams

Real users instead of one `root` login, share links to a run (read-only),
comments on runs and ops, and an audit trail of who edited what. Worth
doing once more than one person uses a studio daily.

---

## 4. Where we stand against the market

| | Visual builders (n8n, Dify, Langflow, Flowise, Agent Builder) | Observability and evals (LangSmith, Langfuse, Braintrust) | operonx studio after this plan |
|---|---|---|---|
| Where the flow lives | Their database, their canvas | Your code (they don't build) | **Your Python**, drawn live |
| Real-time and streaming (voice) | Weak or none | Record-only | **First-class**: the callbot runs in production |
| Batch jobs and runbooks | Partial | No | **Declared in code**, run and scheduled |
| Traces → datasets → evals | Partial | **Strong** | Same loop, **on local files**, no SaaS |
| Cost and latency | Basic | Strong | Per origin and per op, key ops pinned |
| Runs offline and on-prem | Self-host options | Mostly SaaS | **Default** |
| Editing | Drag and drop | — | Code, plus the agent, plus safe in-place edits |

Where we should not try to win: hundreds of SaaS connectors (n8n) or
no-code for non-developers (Dify). Our lane is **teams that ship real AI
products in code and want one tool from the first graph to the
production dashboard.** The pitch in one line: *the product is the code,
and the studio closes the loop around it.*

---

## 5. Information architecture

The top tabs (Flow · Traces · Jobs · Resources) outgrow themselves once
Playground, Monitor, Datasets and Review exist. Move to a left rail,
grouped by the journey:

```
Build     Flow · Prompts · Resources
Run       Playground · Services · Jobs
Observe   Runs · Monitor · Alerts
Improve   Datasets · Evals · Review
```

On a phone the rail becomes a bottom bar with the four groups. The
operator's paths (Monitor, Runs, a run) stay one tap from each other.
The breadcrumb header, side panel and design system from `redesign/ui`
carry over as they are.

---

## 6. Phases

Each phase ships alone and is useful alone. **Up** is work in operonx,
**Studio** is work in the studio.

| Phase | Content | Up | Studio | Size |
|---|---|---|---|---|
| **P0 — records you can trust** | Origin tags on service runs; jobs traced by default; `.operonx/runs/` layout; version in `meta.json`. callbot: prices on the LLM resource. | ● | read both layouts | S–M |
| **P1 — Runs by origin** | Run index (SQLite); origin tree; filters and search; job item ↔ trace both ways; runbook → jobs → items → traces | | ● | M |
| **P2 — the run view** | Summary header; lenses (Path · Time · Errors · Cost · Values); scrubbable timeline; reordered side panel; anomaly flags; compare two runs | | ● | M–L |
| **P3 — Monitor** | Per-origin dashboard: health tiles, per-op latency table with percentiles, cost breakdown, grouped errors, version markers; pinned key ops | small (key ops on the service) | ● | M |
| **P4 — Playground** | Run a graph from a form; replay a run; re-run one op with recorded inputs; text channel for streaming services | run API for the studio | ● | L |
| **P5 — Datasets and evals** | Datasets in the project; evaluators as ops; eval run = Job; compare eval runs by version; CI gate | evaluator helpers | ● | L |
| **P6 — Prompts, Review** | Prompt workbench with write-back; review queue with labels → datasets | | ● | M each |
| **P7 — Services, Alerts, assistant tools, templates** | As in 3.5–3.8 | small | ● | M each |
| **Later — teams** | Users, share links, comments, audit | | ● | L |

**Why this order.** P0 comes first because every later screen is only
as good as the records under it: a dashboard over runs that don't know
their origin, and cost that is always null, would be pretty and wrong.
P1–P3 are your three asks. P4–P5 are what turn the studio from a viewer
into the place where the product gets built.

**Gates, per phase:**

- The callbot project is the acceptance test. Every screen is checked on
  its real runs, as the redesign was.
- Numbers are checked against the raw files. For example, the Monitor
  p95 for one op is recomputed from `nodes.jsonl` in a test.
- Screenshots at desktop, tablet and phone widths for every new screen.

---

## 7. Decisions that are yours

1. **Trace layout owned by operonx (recommended) or by the studio
   alone.** Upstream tagging and layout make every consumer (Langfuse,
   CLI, `ls`) see the same structure. A studio-only index is faster to
   ship but leaves the disk flat and the job traces unrecorded.
2. **Storage for the index: SQLite (recommended) or DuckDB.** SQLite is
   in the standard library and plenty for tens of thousands of runs.
   DuckDB is faster for analytics but adds a dependency. We can switch
   later without changing the UI.
3. **Editing stance.** It stays code-first (the standing decision:
   structure is edited as code, through the agent or by hand), with safe
   in-place edits for params and prompts. Should drag-to-wire editing
   ever be on the table? I recommend no: it is the one thing that would
   make us a second-rate n8n instead of a first-rate code platform.
4. **Where it runs.** Today it is local plus a tunnel. A shared team
   server (P7+, teams) changes auth, storage and multi-project
   assumptions. Decide before "Later", not now.
5. **Scope of P4's streaming playground.** A text channel for the voice
   service is straightforward. Real audio in the browser (WebRTC or mic
   to the websocket) is a larger, separate piece. Worth it for callbot?
