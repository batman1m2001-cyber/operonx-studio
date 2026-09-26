# operonx studio — the platform plan

Status: **agreed direction, not started.** Round 1 written 2026-09-27; the
decisions of round 2 (same day) are folded in throughout.
Builds on the `redesign/ui` branch (the visual system, the breadcrumb
header, the side panel, the phone layout).

The question this answers: what does a team need, from the first idea to
a product running in production, and which of it should live in the
studio? The plan answers it the way a user would walk through it, then
lays out the records and screens that serve that walk, then the order to
build them in.

---

## 0. Where we are — facts, not impressions

Every claim below was checked against the code or the disk on 2026-09-27.

| Area | Today | The gap |
|---|---|---|
| **Traces on disk** | One flat directory per project (`[studio] traces`). callbot's holds 72 runs mixed together (`live-*` calls, `int_*` test calls) and lives in `/tmp`. | No grouping by what produced a run. `/tmp` is wiped on reboot. |
| **Service runs** | The serve runner can merge metadata onto a run's trace; no transport uses it. | A service run cannot be found by service. |
| **Job runs** | A job tags each run with `job`, `job_run` and `key`, and each item in `items.jsonl` carries a `trace_id`. | `qc_cases` declares no `trace=`, so **none of its 235 item traces were recorded**. Every "Trace" link in the Jobs pane leads nowhere. |
| **Runbooks** | `run.json` holds the wires and a per-job tree. | There is no single path from a runbook run to its job runs, to their items, to their traces. |
| **Cost** | `LLMOp` records `usage` (tokens) and `cost_usd`, computed from the resource's `cost_per_input_token` / `cost_per_output_token`. The value is `None`, never `0`, when there are no prices. | No resource has prices, so all 31 recorded `cost_usd` values are `null`. Cost appears nowhere in the UI. |
| **Latency** | Every execution records `start_time`, `end_time`, `duration_ms`, `ctx` and its upstreams. | It is only read one run at a time: no aggregates, percentiles or trends. |
| **Run view** | Tree, plus a "workflow" canvas painted with the run. Every card shows kind chips, show-key values, a run badge (`4× 11871ms`), a heat border and dormant fading, all at once. | Everything competes on every card, so nothing stands out. |
| **Doing things** | Edit a literal param, run or resume a job, chat with an agent that edits code. | You can't run a graph with inputs, replay a run, try a prompt, or evaluate a change. The loop "change → run → compare" happens outside the studio. |

The strength to build on: **the code is the product.** Graphs are Python.
The application (`APP`) declares every service, job and runbook. The
studio reads what really exists; it never holds a second copy of the
truth that can drift. Every competitor that builds on a visual canvas
owns the flow in its own database, so the moment a team needs real code,
it leaves. operonx teams never have to leave.

---

## 1. Who uses this, and for what

Three people, one product:

- **The builder** (engineer) writes graphs and wires resources. They
  want the shortest loop from "I changed a prompt" to "is it better, and
  what did it cost". Mostly on desktop.
- **The operator** (on-call, QC) wants to know "is it healthy, what
  broke, which call, why". Often on a phone, over the tunnel, after an
  alert.
- **The reviewer** (PM, QC, domain expert) reads conversations and labels
  them good or bad, and never touches code. Their labels should become
  tests.

The journey all three share, and the studio's job at each step:

```
 idea ──► build ──► try ──► evaluate ──► ship ──► observe ──► improve
         Flow      Play-    Datasets    Serv-    Runs,       Review →
         Prompts   ground   Evals       ices     Monitor     dataset →
         Assistant          Compare     Jobs     Alerts      eval gate
```

Today the studio covers **build** (read-only, plus small edits) and one
slice of **observe** (one run at a time). This plan fills in the loop,
because the loop is what wins. A builder who can go from a bad
production call to a regression test, to a better prompt, to a green
eval, without leaving one tool, will not go back.

---

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Who owns the trace structure | **operonx.** The changes are additive (§3); the engine's trace capture is not touched. |
| 2 | Where run records live | **A `RunStore` contract in operonx with pluggable backends**: files and SQLite first, then Postgres and Mongo. It is built on operonx's existing consumer and registry machinery, not beside it (§4). |
| 3 | Editing | **No drag and drop, ever.** The assistant is the editor, and it gets the investment a canvas editor would have had (§6). |
| 4 | Where it runs | **Personal first, shared-ready.** Nothing personal-only goes into the contracts; a team server is a backend swap, not a rewrite (§9). |
| 5 | Playground | **A general simulator with toys.** The toys follow what a service's doors carry, not which project it is. Voice (mic and headphones) is one toy among several (§7). |
| 6 | Cost of an in-house LLM | **Priced at $0 by default**, editable later in the Resources hub (§5.3). |
| 7 | Retention | **Services 30 days, jobs and evals forever, playground 7 days** by default, editable in Settings (§4.4). |

---

## 3. Records you can trust — operonx owns the structure

### 3.1 Every run knows where it came from

A run is one graph execution. Every run has exactly one **origin**:

```
Runs
├── Services
│   ├── call            (websocket /ws/call)      ← one run per call
│   └── call_summary    (http POST …/summary)     ← one run per request
├── Jobs
│   ├── qc_cases
│   │   └── run 20260926T140722  (235 items)      ← one run per item
│   │       └── educa_reminder-002 → its trace
│   └── backfill_call_logs
├── Runbooks
│   └── qc
│       └── run 20260926T140721
│           ├── qc_cases  → its job run above
│           └── qc_report → its job run
├── Playground
└── Ad hoc               (tests, scripts)
```

A runbook run is not a new kind of trace but a **group**: runbook run →
job runs → items → traces. The studio draws the group from the records
that already exist (`run.json` wires and tree, `items.jsonl`); nothing is
duplicated.

### 3.2 What changes in operonx, and what doesn't

The engine already builds a `WorkflowTrace` (one `OpExecution` per
execution, with timings, ctx, values and upstreams) and hands it to every
configured `Consumer` when the run ends. **None of that changes.** What
changes is what the trace carries and where the local consumer puts it:

| Change | Where in operonx | What it does |
|---|---|---|
| **Origin tags** | `app/serve/runner.py` (the metadata merge that exists today); the transports and the job runner pass the fields | Every run carries `origin` (`service` / `job` / `playground` / `eval` / `adhoc`) and its name fields: `service`, `transport`, `variant`, or `job`, `job_run`, `key` (jobs already do this). A runbook adds `runbook` and `runbook_run` to its jobs' runs. Anything untagged is `adhoc`. |
| **Default consumers** | `Application` + `Job` | The application declares its trace consumers once (`Application(trace=[...])`) and services and jobs inherit them unless they override. A job with no `trace=` can no longer silently record nothing. |
| **Version** | `Application` boot | The git commit and a dirty flag, read once at boot and merged into every run's metadata. "p95 went up" becomes "p95 went up after commit abc123". |
| **Layout** | `telemetry/consumers/local.py` | The directory is templated from metadata, default `{origin}/{name}/{day}/{trace_id}`, with the root under the project: `.operonx/runs/` (gitignored), not `/tmp`. The flat layout stays available as a setting, so nothing already written breaks. |

LangfuseConsumer needs no change, because tags already become Langfuse
tags and metadata, so Langfuse filters by service and job for free. The
studio reads the old flat directories and the new layout alike; it sorts
by tags, not by path.

**Cost:** one minor release (operonx 1.9.0), with tests covering all four
pieces. **Payoff:** the CLI, Langfuse, `ls` and the studio all see the
same structure, and job traces are recorded without anyone remembering a
flag.

---

## 4. The RunStore — one contract, any backend

### 4.1 What it is for

A trace is written once and read in two ways:

- **One run, fully**: every execution with its values. A run directory
  is good at this — one folder, open it.
- **Many runs, summarised**: "all `call` runs in the last 24 h, p95 per
  op, total cost, top errors." From folders, that means opening and
  parsing every `nodes.jsonl`. callbot's are about 185 KB per call, so a
  busy day is gigabytes read for four numbers.

The store therefore keeps two shapes. The first is a **summary** per
run: origin, status, duration, cost, tokens, errors, version and key
metadata. The second is a **per-op rollup** per run: op, count, total /
max / p95 duration, errors and cost. Lists, filters, search and
dashboards read those two. Opening a run reads its full record.

### 4.2 Built on what operonx already has — never beside it

| Already in operonx | Reused for runs as |
|---|---|
| `Consumer` (`telemetry/consumer.py`): pluggable writers of a finished trace, with `sanitize`, `offload_media` and `truncate` | **The write path.** A `RunStoreConsumer` writes a trace into any store. There is no second capture path. |
| The registry and resource categories (`trace_langfuse:`, `doc_store:`…), plus lazy factories with `operonx[extra]` install hints | **Configuration.** A store is a resource (`run_store:default`) in `resources.yaml`, like everything else. |
| The Postgres client dependencies (`psycopg`, `psycopg-pool`) used by doc stores and pgvector | **The Postgres backend**, with no new dependency. |
| `LocalConsumer`'s directory layout and media offload | **The files backend.** Run directories are the full record, and the summaries live in a SQLite file beside them. |
| The studio's `LayeredCache` (memory → Redis → disk) | **Stays a cache** of derived views, never the store of record. |

Not reused, deliberately:

- **The doc-store contract.** It forbids writes, a line its authors drew
  to stop it growing into an ORM.
- **The checkpointer.** It records state deltas within a run, not runs.

### 4.3 The contract

Narrow on purpose, in the doc stores' spirit:

```python
class RunStore(ABC):
    # write — called by RunStoreConsumer when a run ends
    async def put_run(self, summary: RunSummary, record: RunRecord) -> None
    # read
    async def list_runs(self, where: RunFilter, order, limit, cursor) -> Page[RunSummary]
    async def get_run(self, trace_id) -> RunRecord            # every execution + values
    async def op_rollups(self, where: RunFilter) -> list[OpRollup]
    # housekeeping
    async def delete_runs(self, where: RunFilter) -> int      # retention
```

`RunFilter` is a small data object (origin, name, time range, status,
version, metadata equals), never a query language, so every backend can
implement it natively. Percentiles across runs come from the per-run
rollups. They are exact where the backend can compute them (Postgres
`percentile_cont`) and approximate otherwise, and the UI says which.

**Backends, in order:**

1. `files`: the default, run directories plus a SQLite summary, zero
   setup.
2. `sqlite`: a single file.
3. `postgres`: the team backend.
4. `mongodb`.
5. `langfuse`: read-only, for runs that live only there. This replaces
   the studio's own Langfuse reading code.

### 4.4 Retention

Each origin has a default keep period, and `delete_runs` enforces it
(a sweep when the studio starts, then daily):

| Origin | Default |
|---|---|
| Services | 30 days |
| Jobs and evals | forever |
| Playground | 7 days |
| Ad hoc | 30 days |

These are **editable in Settings**, per project, and saved in the
project (`[studio.retention]` in `operonx.toml`) so a team server
applies the same policy. Settings shows how many runs, and how much
disk, each policy would free before you save.

**Job records** (`run.json`, `items.jsonl`) move behind the same store
later, so a team server sees a job's runs without a shared disk. Until
then the studio reads them as it does today.

---

## 5. The screens over the records

### 5.1 Runs, by origin

- **Left:** the origin tree (§3.1), with counts and a red dot on anything
  that failed in the selected time range.
- **Main:** the runs in that folder. The columns answer what people look
  for: when, status, duration, cost, turns or items, and the first
  error.
- **Top:** a time range (1h / 24h / 7d / custom), status, a search over ids
  and metadata (`session_id:0912…`, `key:educa_reminder-002`), and sorting
  by slowest or most expensive.
- **Links run both ways.** A job item links to its trace, and a trace
  links back to "item `educa_reminder-002` of qc_cases run
  20260926T140722".
- **On a phone:** the tree becomes a picker; the list stays.

Everything here reads `list_runs`.

### 5.2 One run: show what matters, hide the rest

One principle: **one question at a time, and the answer shows first.**

**A. A header that answers "was this run OK?" in one line:**

```
● failed · 51.5 s · $0.042 · 12 LLM calls · 3.1k tokens · 2 errors  [Next error ▸]
  slowest: bot_prompts 11.9 s (23%) · most expensive: reply_llm $0.031
```

**B. Lenses instead of everything at once.** One segmented control:
**Path · Time · Errors · Cost · Values**.

- **Path** (the default) lights the ops that ran and fades the rest.
  Nothing else is shown.
- **Time** puts one number on each card (its total time in this run),
  shades each border by the op's share of the run, and badges the three
  slowest by rank.
- **Errors** colours only the failed ops, each showing the last line of
  its error.
- **Cost** gives a number only to the ops that cost money and fades the
  rest.
- **Values** shows today's show-key values, but on demand instead of
  always.

While a run is painted, the kind chips (FUNC/SYNC/IO) leave the cards.
They describe the code, not the run, and the Flow tab keeps them.

**C. A timeline you can scrub**, instead of a turn dropdown. A thin
waterfall strip sits under the header, with turns as segments; dragging
it repaints the canvas for that moment, and clicking a bar selects the
op. For a call the segments are the conversation; for a job item there
is a single segment.

**D. The side panel, in the order you need it:**

1. **Verdict:** status, duration, and rank among this op's runs ("3rd
   slowest of 12"). A failure shows the error first, traceback folded.
2. **Output:** the show-key values, large.
3. **Input:** what it received, and from which op; the link jumps there.
4. **Cost and usage** (LLM ops): model, tokens in / out / cached, cost,
   and the rendered conversation.
5. **Its other runs:** a mini-chart of every execution's duration; click
   a dot to move to it.

**Anomalies are flagged:** retries, a call over 3× the op's median, an
empty output where there is usually text, and a fallback model used.

**E. Compare two runs.** Put two runs side by side to see per-op
duration and cost deltas, and which ops ran in one run but not the
other. Paired with the version tag, this answers "what did my change
do?"

### 5.3 Monitor — latency and cost, per origin

"The call service" and "the nightly QC job" have nothing in common but
the code, so the dashboard is always per service or job, over a time
range. It reads `op_rollups`.

| Tile / chart | Why it earns its place |
|---|---|
| Runs, error rate, p50 / p95 duration, with the previous period as a ghost | "Is it healthy?" in four numbers |
| Runs over time, stacked ok / failed | When it broke |
| **Per-op latency table**: p50, p95, p99, max, calls per run, share of total time, trend arrow | Where the time goes; the slow op is on top |
| **Cost**: total, per run, per op, per model; tokens in / out / cached | Where the money goes, and what caching saves |
| Top errors grouped by message, with first seen, last seen, count and an example run | What broke, deduplicated |
| Version markers on every chart | Which commit changed it |

**Cost rules**, which follow operonx's own semantics:

- **Only ops that report `cost_usd` count.** Today that means LLM ops.
  Embedding, STT and TTS join once their resources carry prices.
- **Unpriced is never zero.** An unpriced op shows **"unpriced"**, never
  `$0`, and totals read "$1.24 + 3 unpriced ops". That keeps "we did not
  measure it" apart from "it cost nothing".
- **In-house models are priced at $0 by default.** An LLM resource that
  points at your own gateway (callbot's `llm:inhouse`) gets explicit
  prices of `0`. That is a *declared* zero ("it costs us nothing per
  token"), which is different from *unpriced* ("we don't know"): the
  first sums as $0, the second shows as "unpriced". External providers
  with no prices stay unpriced.
- **Prices are edited in the Resources hub.** Each LLM resource shows its
  input and output price per 1M tokens, with an Edit control. A change
  is written to `resources.yaml` as a diff card (§6.2), the same path as
  every other edit, so prices stay in the project's code. Only calls
  made after the change are priced at the new rate; past runs keep the
  cost recorded at the time.

**Key ops.** A service can pin a few ops, declared in code the way
`show_keys` is, so the table's first rows are always the ones the team
cares about. For callbot that means time to first audio, STT latency, LLM
latency and TTS latency: the numbers the team assembles by hand from
logs today.

---

## 6. The assistant is the editor

No drag and drop, ever. Structure changes through code, and the assistant
is how most people will change it. It is already a real Claude Code
session that knows the project and what the user is looking at. What
turns it from a chat window into the editor:

1. **Studio actions as tools** (served to the session over MCP). It can
   open a run, filter runs, run the playground, run a job or an eval,
   read a dashboard, add runs to a dataset, or set a resource price —
   anything the user can do. Every action shows on screen as it happens:
   the canvas and panes move, so the user watches rather than reads.
2. **Changes as reviewable diffs.** Every code edit arrives as a diff card
   (file, hunk, reason) with Apply and Discard. On Apply, the studio
   re-extracts and the canvas redraws with the changed ops highlighted.
   Edits land on a scratch branch or worktree, so "undo everything this
   conversation did" is one click.
3. **It verifies its own work.** After an edit it runs the relevant
   check (the playground case, the eval dataset, the tests) and reports
   before and after: "I changed the prompt; pass rate 111/129 → 119/129,
   cost per case +4%."
4. **Rich answers.** Replies can hold a run card, a small chart, a table
   of ops, or a link that selects a node. It speaks in the studio's own
   components, not walls of text.
5. **Context without typing.** The selection, the painted run, the lens,
   the time range, the open dataset and the failing cases all ride
   along, so "why did this fail?" needs no ids.
6. **From nothing to a working project.** Ask for "a RAG bot over these
   PDFs with a daily eval" and it produces the graph, resources, a
   dataset and a job from the templates (§8.6), then opens the
   playground on the result.
7. **Proactive, not noisy.** When a run fails or an alert fires, it
   offers to look ("look into it?") and never acts unasked.

The agent itself stays Claude Code. The studio's work is the tool
bridge, the diff cards and the components the replies render with.

---

## 7. The simulator playground — toys on doors

### 7.1 The idea

Every service already declares its doors: `ingress` ops where data
enters, `egress` ops where it leaves, and a transport (websocket, http,
asgi). The playground puts a **toy** on each door: a widget that
produces what the ingress expects and renders what the egress emits. The
toys a service gets follow from what its doors carry, never from which
project it is.

| Toy | Speaks | Good for |
|---|---|---|
| **Form** | Typed inputs from the graph's signature (the door contract operonx already checks) | Any request/response graph; a job's single item |
| **Chat** | Text in; streamed text and events out | Chat agents, and voice agents in text mode |
| **Voice** | Browser mic in, speaker out (headphones advised against echo), with a live transcript beside it | Voice agents — callbot, and any audio door |
| **Files** | Drop a PDF, image or audio file; it becomes the door's payload | RAG, document and vision pipelines; audio-file tests |
| **Events** | A timeline of everything egress emitted that isn't content: hangup, transfer, tool calls, sync | Seeing what the product *did*, not only what it said |
| **Simulated user** | An LLM persona playing the other side from a brief ("a busy parent who wants to reschedule"), N conversations in parallel | Stress and regression tests for conversational products; every conversation becomes a dataset row |
| **Conditions** | Injected latency, silence, noise, or a resource error | How the product behaves when the world misbehaves |

The **simulated user** is the toy competitors mostly don't have, and it
makes voice and chat agents testable at scale. It is itself a graph (an
`LLMOp` with a persona prompt) wired to the other side of the door:
operonx all the way down.

Beyond live sessions, the playground also **replays** runs:

- **Replay a run:** feed a recorded run's inputs to the current code.
- **Re-run one op:** run a single op with the inputs it had in a recorded
  run. A failing op deep in a call is retried in a second, without
  making a call.

### 7.2 How it stays general

- **Toys speak one protocol.** It is a small **studio protocol**: content
  chunks (text, audio frames, files, json) plus events.
- **Doors speak their own.** Callbot's ingress parses telco packets,
  because door ops stay fat by design.
- **A codec sits between them**, translating toy messages to the
  service's protocol and back:
  - **Built-in codecs** cover plain transports: http JSON ↔ Form,
    websocket text ↔ Chat, websocket binary PCM ↔ Voice.
  - **A project ships its own codec** when its protocol is its own. For
    callbot that means mic PCM ↔ telco audio packets and `play_frame` ↔
    speaker: the same translation `mock_chat` and the telco perform today.
    The codec lives in the project next to the doors it adapts, declared
    on the service (`Service(..., playground=codec)`).
  - **No codec, no toy.** A service without a codec for a toy doesn't
    offer it.

### 7.3 Where the run happens

The playground runs the service's graph in **the project's own
interpreter**; the studio never imports a project, the same rule as
extraction. The path is browser → studio → a small `operonx-play` bridge
process → the graph, through its real door ops. Runs are tagged
`origin=playground`, so they land in their own folder, and every session
is a real trace that can be opened, replayed, or added to a dataset.

### 7.4 Voice specifics

- **Capture:** `getUserMedia`, with an AudioWorklet resampling to the
  door's rate (8 kHz for callbot, declared on the codec).
- **Playback:** egress audio plays through the same worklet, with a jitter
  buffer.
- **Access:** mic access needs HTTPS or localhost; the local studio and
  the tunnel both qualify.
- **Echo:** echo cancellation is the browser's; the UI recommends
  headphones.

**Order:** Form and Chat first (most products), then Events, then Files,
then Voice with the callbot codec as its proof, then Simulated user, then
Conditions.

---

## 8. The rest of the loop

Each item builds on machinery that already exists.

### 8.1 Datasets and evals: turn production into tests

callbot's `qc` runbook already *is* an eval (cases in, one verdict per
case, a report). Generalise what it proved:

- **Datasets:** a named list of inputs, with expected outputs where they
  are known, stored in the project as JSONL. Rows come from "Add to
  dataset" on any run or item, from the simulated user (§7), from the
  review queue (§8.3), or from a file.
- **Evaluators:** code assertions, LLM-as-judge with a rubric, or exact
  and fuzzy match. They are written as ops, so they are graphs too.
- **An eval run is a Job** (`source=dataset`, `graph=system under test`,
  plus evaluators). There is no new runtime: the job records hold the
  verdicts, and the runs carry `origin=eval`.
- **Compare eval runs by version:** pass rate, per-case flips (pass →
  fail), cost and latency. This becomes a merge gate: `operonx-run`
  already exits non-zero on failure, so CI can run it.

### 8.2 Prompt workbench

LLM ops are where most iteration happens. Open an LLM op to see its
prompt; edit it and run it against N recorded inputs from real runs. The
results appear side by side with the recorded outputs, with tokens and
cost. Saving writes the prompt back to where it lives (`prompts.yaml` or
code) as a diff card, the same path the assistant's edits take (§6.2).

### 8.3 Review queue

A reviewer opens a queue of runs (by origin, or by eval failure) and
reads each as a conversation, not a trace tree. They mark it good or bad,
add labels, and write a note. Labels are stored beside the run, and one
click sends a bad run to a dataset. This is callbot's manual QC workflow,
made into a screen.

### 8.4 Services control

This lists the application's services and their state (running or
stopped, port, workers, live sessions). In dev you can start and stop
them, follow their logs, and see health (`/health` and the env
contract). It builds on `APP.serve()`, and Monitor links to it and back.

### 8.5 Alerts

Thresholds per origin: error rate, the p95 of a key op, cost per hour.
They are evaluated on the RunStore's summaries at no extra cost, and
delivered by webhook (Slack, Teams, an email relay). An alert opens the
Runs list filtered to the offending window.

### 8.6 Templates

"New project" offers a small gallery: a voice agent, a RAG
question-answerer, a batch scorer, and an HTTP API. Each is a working
graph with resources, a dataset, an eval and a job. The assistant builds
from the same templates (§6.6). A newcomer sees a green run, a trace and
a dashboard in the first five minutes.

---

## 9. Personal first, shared-ready

The team server is where this goes. Personal mode ships first, and
nothing in it may block the team shape:

- **Runs:** personal mode uses the `files` store. A team points every
  service and the studio at one Postgres store: same contract, same UI.
- **Auth:** today there is one login. The auth check sits behind one
  function that returns a *user*. Personal mode returns the single local
  user; a team server returns real accounts (OIDC later). Anything stored
  (labels, datasets, comments) records its user from day one.
- **Projects:** personal mode is a folder on this machine. The team shape
  is the same project at a git remote, checked out on the server. The
  registry gets a `source` field now so that shape fits later.
- **Built only when teams are real:** permissions, share links (read-only
  run pages), comments on runs and ops, and an audit trail.

---

## 10. Against the market

| | Visual builders (n8n, Dify, Langflow, Flowise, Agent Builder) | Observability and evals (LangSmith, Langfuse, Braintrust) | operonx studio after this plan |
|---|---|---|---|
| Where the flow lives | Their database, their canvas | Your code (they don't build) | **Your Python**, drawn live |
| How you change it | Drag and drop | — | **An assistant that edits code**, shows diffs and checks its work |
| Real-time and streaming (voice) | Weak or none | Record-only | **First-class**, with a voice playground and simulated users |
| Batch jobs and runbooks | Partial | No | **Declared in code**, run and scheduled |
| Traces → datasets → evals | Partial | **Strong** | Same loop, on **your storage** (files, Postgres, Mongo) |
| Cost and latency | Basic | Strong | Per origin and per op, with key ops pinned |
| Offline and on-prem | Self-host options | Mostly SaaS | **The default** |

**Where we don't compete:** hundreds of SaaS connectors (n8n) and no-code
for non-developers (Dify). **Our lane:** teams that ship real AI products
in code and want one tool from the first graph to the production
dashboard. In one line: *the product is the code; the studio and its
assistant close the loop around it.*

---

## 11. Information architecture

The top tabs (Flow · Traces · Jobs · Resources) outgrow themselves once
Playground, Monitor, Datasets and Review exist. They move to a left rail,
grouped by the journey:

```
Build     Flow · Prompts · Resources
Run       Playground · Services · Jobs
Observe   Runs · Monitor · Alerts
Improve   Datasets · Evals · Review
          ─────────────
          Settings        (retention, prices overview, trace store, members later)
```

- **The assistant** is present on every screen, in the side panel beside
  the inspector.
- **On a phone**, the rail becomes a bottom bar with the four groups, and
  the operator's paths (Monitor → Runs → one run) stay one tap apart.
- **Carried over from `redesign/ui` unchanged:** the breadcrumb header,
  the side panel and the design system.

---

## 12. Phases

Each phase ships alone and is useful alone. **Up** is work in operonx;
**Studio** is work in the studio.

| Phase | Content | Up | Studio |
|---|---|---|---|
| **P0 — records you can trust** | §3: origin tags, application-level default consumers, version tag, templated layout under `.operonx/runs/`. callbot: `llm:inhouse` priced at 0, `trace=` on the app. | ● 1.9.0 | reads both layouts |
| **P1 — RunStore** | §4: contract, `RunStoreConsumer`, `files` + `sqlite` backends, `langfuse` read-only, retention sweep; the studio reads runs only through it, and gains a Settings page for retention | ● | switch readers, Settings |
| **P2 — Runs by origin** | §5.1: origin tree, filters, search, job ↔ trace links, runbook groups | | ● |
| **P3 — the run view** | §5.2: header, lenses, timeline, reordered side panel, anomalies, compare | | ● |
| **P4 — Monitor** | §5.3: per-origin dashboard from `op_rollups`, cost with "unpriced", key ops, price editing in the Resources hub | key ops | ● |
| **P5 — assistant tools** | §6 items 1, 2, 4, 5: studio actions over MCP, diff cards on a scratch branch, rich replies, context | | ● |
| **P6 — playground** | §7: `operonx-play` bridge, studio protocol, Form + Chat + Events toys, built-in codecs, replay, re-run one op | ● bridge | ● |
| **P7 — evals** | §8.1 on jobs + playground; §6 item 3 (the assistant verifies its work) | evaluator helpers | ● |
| **P8 — voice and simulated user** | §7: Voice toy with the callbot codec, simulated user, conditions | small | ● |
| **P9 — more stores and screens** | Postgres and Mongo RunStores, prompt workbench, review queue, services control, alerts, templates, the left rail | ● | ● |
| **Teams** | §9's deferred list | | ● |

**Why this order:**

- **P0 first.** Every screen is only as good as the records under it; a
  dashboard over untagged runs and null costs would look good and be
  wrong.
- **P1 before any screen**, so no screen is written twice.
- **P2–P4** are the tracing and dashboard asks.
- **P5–P8** turn the studio from a viewer into the place the product is
  built.

**Gates, every phase:**

- **callbot is the acceptance project.** Every screen is checked on its
  real runs.
- **Numbers are recomputed from the raw records in tests.** For example,
  a Monitor p95 is checked against `nodes.jsonl`.
- **Screenshots at three widths** (desktop, tablet and phone) for every
  new screen, compared against the previous version.
- **Upstream work** goes on its own operonx branch and release; the
  studio pins the release it needs.

---

## 13. Still open

Nothing blocks P0. Questions will be added here as the phases raise them.

---

## 14. Progress (updated 2026-09-27)

Branches (nothing pushed, nothing released):

| Repo | Branch | Commits |
|---|---|---|
| operonx `/home/thanglq/Operon` | `feat/runs-records` | P0 c32ee0c · P1 9b5d430 · P2 488193c · P4 fa32993 (key_ops) · P6 630e77f 31b43b4 8ecd986 7e291ae (playground bridge) · P7 905224e b646d6b (evals) |
| studio worktree `/home/thanglq/operonx-studio-redesign` | `feat/platform` (off `redesign/ui`) | P1 68a27e8 · P2 350a00a · P3 f13fad5 · P4 91e0776 · P5 a7581bc 0f0bd55 · P6 53356f4 · P7 (this commit) |
| callbot `/home/thanglq/educa-reminder-agent` | `feat/runs-by-origin` (checked out) | 7ce0a17 (runs by origin, $0 inhouse) · 8faad98 (key_ops) |

Done and tested (operonx 2191 tests, studio 447, screenshots desktop/tablet/phone):

- **P0** origin tags, application-level `trace=`, jobs always traced, git version, `.operonx/runs` origin layout.
- **P1** `operonx.telemetry.runs` RunStore (files+sqlite index, sqlite, langfuse read-only), `run_store:` resource, retention; studio reads only through it; Settings page (retention, preview, save).
- **P2** Runs screen by origin (tree, filters, search, job/runbook strips, links both ways), `RunStore.groups()`, batched indexing (8.9 s → 0.54 s). Fixes found on the way: all-defaults resource `{}` resolved as missing; `trace_local:` key needed an earlier telemetry import.
- **P3** run view: verdict header, lenses (Path/Time/Errors/Cost/Values), timeline strip, exec panel in reading order, anomaly flags, compare two runs. Session-long ops (heartbeat) never count as "slowest".
- **P4** Monitor tab (tiles vs previous period, runs + p95 charts with version marks, per-op table, cost, grouped errors), `Service(key_ops=)`, LLM price editor in Resources (text YAML edit, diff first).

- **P5** the assistant's hands: `operonx_studio/mcp.py` (stdio MCP server — list_runs, open_run, op_values, monitor, compare_runs, select_op, run_job, set_llm_price; read-only chat mode gets only the read tools); per-turn git snapshot (`git stash create`) → `changes` event with only the agent's edits (the user's uncommitted work is in the snapshot, never attributed to the agent); chat renders it as a diff card (files ±, folded diff, Keep / Undo); "undo everything this conversation changed" (first snapshot + union of live cards' files; hidden once every card is undone); `studio:` links in replies are buttons (run / op — by node or function name / tab / monitor), http links open a new tab; the page follows what the agent opens (`/ui/actions`); ops whose code changed are tagged on the canvas. Verified end to end on a scratch git copy of ex17: Undo and Undo-all leave `git status` clean.

- **P6** the playground. operonx: `operonx.app.play` — a bridge process (`python -m operonx.app.play`, `operonx-play`) in the project's own interpreter, JSON lines on stdio; a session is a `BoundedSession` through the service's real `ServeRunner` gate (`on_session`, variants, input contract; `session.meta["playground"]` is True), `serve_session`, door ops and trace consumers, tagged `origin=playground` + `toy`, carrying `playground_script` and `playground_query` for replay; codecs (`Codec.to_door/from_door`; built-in `JsonCodec` for http → Form, `TextCodec` for websocket → Chat + Form; `Service(playground=MyCodec)` for a door's own protocol; no codec, no toy); re-run one op of a service's or a job's graph with given inputs, recorded as its own run (`toy=rerun`, `rerun_of`); a door with no consumers still records locally; stdout protocol kept clean at the fd level. Studio: `operonx_studio/play.py` (one bridge per project, event buffer polled by cursor, restarts itself when the code changed and nothing is live, idle stop after 15 min), `/play/*` routes (doors, open/send/end, events, rerun-plan, rerun, restart), the Playground tab (door picker, Chat toy with streamed items merged into one reply that says how many items it holds, Form toy with JSON payload, connection query rows, Events column, Recent sessions with Open / Replay), "Re-run" in the run view's execution panel (recorded inputs editable; values the graph never kept — transient streams, media — are named and left to fill; Then / Now side by side; the panel survives a code reload), assistant tools `rerun_op` and `play` (not in read-only mode).
  - Scope note: **replay covers playground runs**. A production service run cannot be replayed from its trace, because door items flow through transient ports that operonx deliberately never records (audio frames); replaying production traffic needs an opt-in recording of ingress items — a P9 candidate, not done here.

- **P7** evals. operonx: `operonx.app.evals` — `Dataset` (JSONL cases `{id, input, expected, tags, from}`; a bare line is its own input; stable ids; deduped appends; `dataset:name` → `datasets/name.jsonl`), evaluators as plain/async functions or `@op`s taking any of `input, output, expected, row, outputs` and returning a bool, a score or `{passed, score, reason}` (built-ins `exact`, `contains`, `fuzzy`, `json_match`, `llm_judge` — an `LLMOp` with `fields` parsing `{passed, score, reason}`, its cost kept), `Eval(Job)` with `origin="eval"`: the job runtime unchanged but for three additive hooks (`Job.item_of`, `judge` after each item → `ItemResult.verdict`, `summarize` before finish → `run.json["eval"]` + the gate: fail when a case fails or the rate is under `threshold`, so `operonx-run` exits 1 for CI); `[[job]]` with `dataset`/`evaluators`/`threshold` builds an Eval. Studio: Evals tab (evals with pass-rate sparkline, datasets; a run case by case with checks and reasons, output vs expected, fixed/regressed against the run before or any earlier run, filters All/Failed/Changed; dataset rows), "Add to dataset" on one-message playground sessions (input = what was sent, expected = what the door sent back, recorded from the egress op), assistant tool `run_eval` (pass rate before → after with the flipped cases) and `studio:eval/<name>` links.

Then P8 voice + simulated user → P9 (Postgres/Mongo stores, prompt workbench, review queue, services control, alerts, templates, left rail).

Dev environment: studio on :8766 = `OPERONX_STUDIO_RETENTION=off PYTHONPATH=/home/thanglq/operonx-studio-redesign:/home/thanglq/Operon /home/thanglq/operonx-studio/.venv/bin/python -m operonx_studio.cli --no-open --host 127.0.0.1 --port 8766`; the lhr tunnel points at it. Screenshot scripts in the session scratchpad (`shot_p2.py` … `shot_p4.py`). Release order when asked: operonx 1.9.0 (PR from `feat/runs-records`, user merges), then bump pins in studio (`operonx>=1.9.0`) and callbot.
