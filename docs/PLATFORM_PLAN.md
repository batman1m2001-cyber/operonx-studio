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

## 7. Decisions — round 2 (2026-09-27)

The first round's open questions, answered, and what each answer
changes. Section 8 turns them into designs.

| # | Question | Decision |
|---|---|---|
| 1 | Who owns the trace structure | **operonx.** The changes are additive (§8.1); the engine's trace capture is not touched. |
| 2 | Where the run records live | **A `RunStore` contract in operonx, with pluggable backends**: files and SQLite first, then Postgres and Mongo. It is built on operonx's existing consumer and registry machinery, not beside it (§8.2). |
| 3 | Editing | **No drag and drop, ever.** The assistant is the editor. It gets the investment drag and drop would have had (§8.3). |
| 4 | Where it runs | **Personal first, shared-ready.** Nothing personal-only goes into the contracts: the run store, auth and project registry are all written so a team server is a backend swap, not a rewrite (§8.4). |
| 5 | Playground | **A general simulator with toys.** It isn't callbot-specific: the toys are chosen by what a service's doors carry, and voice (mic and headphones) is one toy among several (§8.5). |

---

## 8. Designs for the round-2 decisions

### 8.1 operonx owns the trace structure — what changes, and what doesn't

The engine already builds a `WorkflowTrace` (one `OpExecution` per
execution, with timings, ctx, values and upstreams) and hands it to each
configured `Consumer` when the run ends. **None of that changes.** What
changes is the metadata the trace carries and where the local consumer
puts it: four small, additive pieces.

| Change | Where in operonx | What it does |
|---|---|---|
| **Origin tags** | `operonx/app/serve/runner.py` already merges `metadata` onto the trace; the transports and job runner pass it | Every run carries `origin` (`service` / `job` / `adhoc` / `playground` / `eval`) and its name: `service`, `transport`, `variant`, or `job`, `job_run`, `key` (jobs do this today). A runbook run adds `runbook` and `runbook_run` to its jobs' runs. |
| **Default consumers** | `Application` + `Job` | The application declares its trace consumers once (`Application(trace=[...])`). Services and jobs inherit them unless they override. A job with no `trace=` stops silently recording nothing. |
| **Version** | `Application` boot | The git commit and a dirty flag, read once at boot and merged into every run's metadata. |
| **Layout** | `operonx/telemetry/consumers/local.py` | The directory is templated from metadata, `{origin}/{name}/{day}/{trace_id}` by default, with the root under the project (`.operonx/runs/`). The old flat layout stays available as a setting, so nothing already written breaks. |

LangfuseConsumer needs no change: tags already become Langfuse tags and
metadata, so Langfuse filters by service and job for free. The studio
reads old flat directories and the new layout alike, sorting by tags,
not by path.

**Cost of doing it in operonx:** one minor release (1.9.0), with tests
covering all four pieces.

**Payoff:** the CLI, Langfuse, `ls` and the studio all see the same
structure, and callbot's job traces are recorded without anyone having
to remember a flag.

### 8.2 The RunStore — what the "index" is for, and how it stays backend-neutral

**What it is for.** A trace is written once and read in two ways:

- **One run, fully.** Every execution with its values. This is what the
  local directory is good at: one folder, open it.
- **Many runs, summarised.** "All `call` runs in the last 24 h, p95 per
  op, total cost, top errors." Answered from folders, that means opening
  and parsing every `nodes.jsonl`. callbot's are about 185 KB per call,
  so a busy day is gigabytes read for four numbers.

The "index" is the second shape: a small **summary** per run (origin,
status, duration, cost, tokens, errors, version, key metadata) plus a
**per-op rollup** per run (op, count, total, max and p95 duration,
errors, cost). Dashboards, filters and search read the summaries; opening
a run reads its full record.

**Why not just an index in the studio:** you are right that it should
not be one database welded to one tool. A team will want Postgres, or
the Mongo they already run. And operonx already has the pieces this
needs, so the studio must not grow a parallel set:

| Already in operonx | Reused for runs as |
|---|---|
| `Consumer` (telemetry/consumer.py): pluggable writers of a finished trace, with `sanitize`, `offload_media` and `truncate` | **The write path.** A `RunStoreConsumer` writes a trace into any store. There is no second capture path. |
| The registry and resource categories (`trace_langfuse:`, `doc_store:`…), plus lazy factories with `operonx[extra]` install hints | **Configuration.** A store is a resource (`run_store:default`) in `resources.yaml`, like everything else. |
| The Postgres client deps (`psycopg`, `psycopg-pool`) used by doc stores and pgvector | **The Postgres backend**, with no new dependency. |
| `LocalConsumer`'s directory layout and media offload | **The files backend.** The run directories are the full record; the summary lives in a SQLite file beside them. |
| The studio's `LayeredCache` (memory → Redis → disk) | **Stays a cache** of derived views, never the store of record. |

Not reused, on purpose: the doc-store contract (it forbids writes, a
line its authors drew to stop it growing into an ORM), and the
checkpointer (it records state deltas within a run, not runs).

**The contract** is deliberately narrow, in the doc stores' spirit:

```python
class RunStore(ABC):
    # write — called by RunStoreConsumer at run end
    async def put_run(self, summary: RunSummary, record: RunRecord) -> None
    # read
    async def list_runs(self, where: RunFilter, order, limit, cursor) -> Page[RunSummary]
    async def get_run(self, trace_id) -> RunRecord            # every execution + values
    async def op_rollups(self, where: RunFilter) -> list[OpRollup]
    # housekeeping
    async def delete_runs(self, where: RunFilter) -> int      # retention
```

`RunFilter` is a small data object (origin, name, time range, status,
version, metadata equals) and never a query language, so every backend
can implement it natively. Percentiles over many runs come from the
per-run rollups: exactly, where the backend can compute them (Postgres
`percentile_cont`), and approximately otherwise. The UI states which.

**Backends, in order:** `files` (the default: directories plus a SQLite
summary, zero setup) → `sqlite` (single file) → `postgres` (team) →
`mongodb` → `langfuse` (read-only, for runs that live only there; this
replaces the studio's own Langfuse code).

**Job records** (`run.json`, `items.jsonl`) move behind the same store
later, so a team server sees a job's runs without a shared disk. Until
then the studio reads them as it does today.

### 8.3 Assistant-first: the editor is a conversation

With drag and drop off the table, the assistant is how structure
changes. It is already a real Claude Code session with the project
briefing and what the user is looking at. What turns it from a chat
window into the editor:

1. **Studio actions as tools.** Open a run, filter runs, run the
   playground, run a job or an eval, read a dashboard, add runs to a
   dataset, set a resource price. It can do what the user can do, and
   every action shows up on screen as it happens: the canvas and panes
   move, so the user watches rather than reads.
2. **Changes as reviewable diffs.** Every code edit is proposed as a
   diff card (file, hunk, reason) with Apply and Discard buttons. The
   studio re-extracts on apply, and the canvas redraws the new graph
   with the changed ops highlighted. Edits happen on a scratch branch or
   worktree, so "undo everything this conversation did" is one click.
3. **It verifies its own work.** After an edit it runs the relevant
   check (the playground case the user was looking at, the eval
   dataset, the tests) and reports the numbers before and after. "I
   changed the prompt; pass rate 111/129 → 119/129, cost per case
   +4%."
4. **Rich answers, not walls of text.** Replies can hold a run card, a
   mini chart, a table of ops, or a link that selects a node. It speaks
   in the studio's own components.
5. **Context without typing.** The selection, painted run, lens, time
   range, open dataset and failing cases ride along. "Why did this
   fail?" needs no ids.
6. **Starting from nothing.** "A RAG bot over these PDFs with a daily
   eval" produces a graph, resources, a dataset and a job from the
   templates (§3.8), and opens the playground on the result.
7. **Proactive, not noisy.** When a run fails or an alert fires, an
   offer appears ("look into it?") and it never acts unasked.

All of this is **studio work plus a small tool bridge**. The agent
itself stays Claude Code, and the studio exposes its actions as tools
(MCP) that the session can call.

### 8.4 Personal first, shared-ready

What "shared-ready" means concretely, so personal mode never paints
itself into a corner:

- **Runs:** personal uses the `files` store. A team points every service
  and the studio at one Postgres store. Same contract, same UI.
- **Auth:** today it's one login. The auth check sits behind one
  function that returns a *user*. Personal mode returns the single
  local user; a team server returns real accounts (OIDC later). Stored
  things (labels, datasets, comments) record the user from day one.
- **Projects:** personal mode is a folder on this machine. The team
  shape is the same project at a git remote, checked out on the server.
  The registry keeps a `source` field now so the team shape fits later.
- **Not built until teams are real:** permissions, sharing, comments,
  audit.

### 8.5 The simulator playground — toys on doors

**The idea.** Every service already declares its doors: `ingress` ops
where data enters, `egress` ops where it leaves, and a transport
(websocket, http, asgi). The playground puts a **toy** on each door: a
widget that produces what the ingress expects and renders what the
egress emits. Which toys a service gets follows from what its doors
carry, never from which project it is.

**The toys:**

| Toy | Speaks | Good for |
|---|---|---|
| **Form** | Typed inputs from the graph's signature (the door contract operonx already checks) | Any request/response graph, jobs' single items |
| **Chat** | Text in, streamed text and events out | Chat agents; voice agents in text mode |
| **Voice** | Browser mic in, speaker out (headphones advised to avoid echo), a live transcript beside it | Voice agents: callbot, and any audio door |
| **Files** | Drop a PDF, image or audio file; it becomes the door's payload | RAG, document and vision pipelines, audio-file tests |
| **Events** | A timeline of everything egress emitted that isn't content (hangup, transfer, tool calls, sync) | Seeing what the product *did*, not only what it said |
| **Simulated user** | An LLM persona that plays the other side, following a script ("a busy parent who wants to reschedule"), for N conversations in parallel | Stress and regression for conversational products; every conversation becomes a dataset row |
| **Conditions** | Inject latency, silence, noise, an error from a resource | How the product behaves when the world misbehaves |

The **simulated user** is the one competitors mostly don't have, and it
makes voice and chat agents testable at scale. It is also just a graph
(an `LLMOp` with a persona prompt) wired to the other side of the door,
so it is operonx all the way down.

**How it stays general.** A toy speaks a small **studio protocol**
(content chunks: text, audio frames, files, json; plus events). A
service's door speaks its own protocol, and callbot's ingress parses
telco packets, because door ops stay fat by design. Between them sits a
**codec**: a small adapter that translates toy messages to the
service's protocol and back.

- **Built-in codecs** cover plain transports: http JSON ↔ form,
  websocket text ↔ chat, websocket binary PCM ↔ voice.
- **A project ships its own codec** when its protocol is its own. For
  callbot, that's mic PCM ↔ telco audio packets and `play_frame` ↔
  speaker, the same translation `mock_chat` and the telco perform today.
  The codec lives in the project next to the doors it adapts, declared
  on the service (`Service(..., playground=codec)`).
- A service with no codec for a toy simply doesn't offer that toy.

**Where the run happens.** The playground runs the service's graph in
the **project's own interpreter** (the studio never imports a project,
the same rule as extraction), through a small `operonx-play` bridge
process. The browser connects to the studio, the studio to the bridge,
the bridge to the graph through the real door ops. Runs are tagged
`origin=playground`, so they land in their own folder, and every
session is a real trace that can be opened, replayed, or added to a
dataset.

**Voice specifics.** The browser captures audio with `getUserMedia` and
an AudioWorklet that resamples to the door's rate (8 kHz for callbot,
declared on the codec). It plays egress audio through the same worklet
with a jitter buffer. Mic access needs HTTPS or localhost; both the
local studio and the tunnel qualify. Echo cancellation is the browser's,
and headphones are recommended in the UI.

**Order within the playground:** Form and Chat first (most products),
then Events, then Files, then Voice with the callbot codec as its proof,
then Simulated user, then Conditions.

---

## 9. Revised phases

| Phase | Content | Up | Studio |
|---|---|---|---|
| **P0 — records you can trust** | §8.1: origin tags, application-level default consumers, version tag, templated layout under `.operonx/runs/`. callbot: set LLM prices, declare `trace=` on the app. | ● 1.9.0 | reads both layouts |
| **P1 — RunStore** | §8.2: contract, `RunStoreConsumer`, `files` + `sqlite` backends, `langfuse` read-only; the studio reads runs only through it | ● | switch readers |
| **P2 — Runs by origin** | §2.1 screen: origin tree, filters, search, job ↔ trace links, runbook groups | | ● |
| **P3 — the run view** | §2.2: header, lenses, timeline, side panel order, anomalies, compare | | ● |
| **P4 — Monitor** | §2.3: per-origin dashboard from `op_rollups`, cost with "unpriced", pinned key ops | small | ● |
| **P5 — assistant tools** | §8.3 items 1, 2, 5: studio actions as MCP tools, diff cards with apply/discard on a scratch branch, richer context | | ● |
| **P6 — playground** | §8.5: `operonx-play` bridge, studio protocol, Form + Chat + Events toys, built-in codecs, `origin=playground` | ● bridge | ● |
| **P7 — evals** | §3.2 on top of jobs + playground; assistant item 3 (verifies its own changes) | small | ● |
| **P8 — voice + simulated user** | Voice toy with the callbot codec; the simulated user; conditions | small | ● |
| **P9 — Postgres/Mongo stores, prompts, review, alerts, templates** | as in §3 and §8.2 | ● | ● |
| **Teams** | §8.4's deferred list | | ● |

Gates are unchanged from §6: callbot is the acceptance project, numbers
are recomputed from the raw records in tests, and every screen is
screenshotted at three widths.
