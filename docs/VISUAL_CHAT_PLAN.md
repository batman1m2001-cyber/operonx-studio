# The conversation shows the work: a visual-first assistant (VISUAL_CHAT_PLAN)

Status: plan, waiting for the owner's go (2026-10-31).

Owner's brief: "Visual-First Conversational Engineering Experience". The
assistant's work should be readable at a glance: file references,
tool activity, progress, changes, tests and relationships each get their
own visual form. The LLM does the reasoning and the studio does the
presentation. This plan covers how the work is shown; it does not rebuild
the agent.

## What is there today (audited on main a53b0d0)

**The pipeline.** The relay (assistant.py) turns Claude Code's stream
into typed **items** and stores them per session. The browser
(assistant.js) renders each kind and replays them on reload. Text streams
as deltas into the last `text` item.

| Item kind | What it carries | How it renders |
|---|---|---|
| `text` | Markdown | `md()` / `inline()`, hand-written: fences, headings, lists, tables, quotes, `code`, links |
| `tool` | `name`, `label` ("Ran pytest"), `input` (clipped JSON **text**), `output` (clipped at 4,000 chars), `status`, `ms` | A row in an activity group. The group head reads "Read 3 files, ran 2 commands"; a row opens to show Input / Result |
| `thinking` | text, ms | "Thought for 1.3 s", opens |
| `tool` = `mcp__studio__steps` | `plan` (data) | The **progress card** (progress.js, ASSISTANT_PROGRESS_PLAN): steps on a line, states, times, each step's tool calls |
| `changes` | `files [{path, added, removed, new}]`, `diff`, `sha` | The changes card: file list, one folded diff, Keep / Undo |
| `error`, `turn_end`, `compact` | — | Cards and lines |

`studio:` links (`run/ op/ tab/ board/ eval/ point/ monitor/ project/`)
render as chips that act on the studio (shell.js `oxStudioLink`).

**What is missing against the brief:**
- **File references** are plain `code`. Nothing is clickable, although
  the Files page (#129) can open any file (`v.file`).
- **Tool rows all look the same.** A test run reads "Ran cd … && pytest
  -q" and only the raw output shows the result. Claude Code also writes
  files through **Bash** (heredoc, `sed -i`), so the edit rows do not show
  every edit. Only the git diff (the changes card) does.
- **The changes card has one diff** for all files. There are no per-file
  diffs, and the files that were read are not shown.
- **Nothing in a reply can draw.** There is no graph, chart or diagram
  block, so relationships and numbers come out as prose or tables.
- The progress card already covers most of brief §4. It lacks
  dependencies between steps, and a step's files and test results.

**Measured: where the tokens go** (live store, 79 turns). The output
tokens are about 1% of a turn's tokens. One mr-finance turn: 985k input
(933k cached), 10k output, 145 s. A reply averages **217 characters**.
The input is the context: knowledge.md (17 KB), the files read, and the
tool outputs. So moving presentation out of the LLM saves **reading**,
not much generation. The token goal in brief §9 is met by **adding no LLM
calls and nothing large to the prompt**: every derived block below is
computed by the server or the page, and the preset catalogue the model
needs is about 1.5 KB, cached with the rest of knowledge.md. V0 measures
the baseline and V6 measures it again.

## Decisions

**D1 · Two sources, never invented.** A visual comes either from
**runtime facts** (tool events, git, test output, the steps tool) or from
a **typed block the model writes** (a graph, a chart). Nothing is
inferred from prose. When the facts are missing, it stays text.

**D2 · Typed fences, not HTML.** The model draws with a fenced block
whose language names a preset, and whose body is JSON:

    ```ox-graph
    {"title": "Request path", "nodes": [{"id": "api", "label": "POST /mail", "group": "app"},
      {"id": "triage", "label": "triage", "state": "done", "file": "src/flows/triage.py"}],
     "edges": [["api", "triage"]], "groups": {"app": "HTTP layer"}}
    ```

- Presets: `ox-graph` (flows, dependencies, architecture with groups as
  boundaries, execution with node states) and `ox-chart` (`bar` / `line`
  / `spark`, with series and units).
- `md()` already parses fences, so a block is one more fence kind. There
  is no second pipeline.
- **While a block streams** (no closing fence yet), it shows "Drawing
  graph…". JSON that does not parse, or a schema miss, falls back to the
  code block as written, with a quiet "could not draw" line.
- Drawing is inline SVG with the studio's tokens, in light and dark. The
  layout is a small layered DAG of my own. flowlayout.js is built for
  IR graphs, so it is too heavy for this, and there is no library to load.
- A node may carry `file`, `target` (the `point` names) or `op`, and a
  click goes there.
- **Expanded view:** over 12 nodes, or on demand, the block opens in an
  overlay with zoom, pan and node selection. Inline it stays compact
  (≤ 260 px high).

Mermaid was considered: it is a 700 KB library, its look is its own, and
it cannot carry state or click targets. The JSON fences win.

**D3 · File references are links resolved against the real tree.**
- Inline code that **is** a project path (checked against the Files
  page's file list, fetched once per session) renders as a file reference:
  cyan, mono, a file icon, `:42` shown as a line. A click opens the Files
  page at that file and line.
- The model may also write `[app.py:42](studio:file/app.py#L42)`.
- A path that is not in the tree stays plain code, so nothing is guessed.
- Symbols (`name()`, `Class.attr`) and shell commands get subtle tints
  only when the fence or tool event says what they are. Prose is not
  scanned by regex.

**D4 · Tool rows by what they did.** Each tool call is classed from its
**name and input** (structured, not its label): read · edit · create ·
run · test · search · web · studio · git.
- Each class gets its own icon and verb colour. The resource is a file
  reference (D3) or a mono command.
- Runs of the same class fold into one row: "Read 6 files", with the
  files as chips.
- Details (input, output) stay one click away, as today.

**D5 · Tests are a runtime fact.** When a Bash call runs a test runner
(pytest, node --test, npm test, jest, vitest, go test, cargo test), the
relay parses the **full** output before clipping it. It reads the summary
line and the failing test ids, and puts `tests: {passed, failed, skipped,
errors, failures: [{id, line}]}` on the item. The row shows a pass/fail
bar ("137 passed · 3 failed"), and the failures open with their output.
No summary line means no report, and the row stays as it is.

**D6 · One file-activity strip per turn.** It merges two sources:
- The turn's **reads** (Read tool events).
- Its **writes** from git, the truth since Bash writes files: modified,
  created, and deleted (the relay adds `deleted`).

The changes card becomes:
- A strip like "Read 6 · Modified 3 · Created 1 · Deleted 0".
- Then the files, each with **its own folded diff** (the one diff split
  per file).
- Keep / Undo as today.

**D7 · The progress card, finished.**
- A step may name `after: [i]`. When any step does, the card draws the
  top-down structure with connectors.
- An open step lists its files (D6) and test result (D5) next to its tool
  calls.
- The steps tool keeps its shape: one optional field.

**D8 · Knowledge: preset-first, and the reply does not repeat the
cards.** One section (~1.5 KB) of knowledge.md:
- The two fences and their fields.
- When to draw: relationships of 4 or more things; numbers worth
  comparing.
- When not to: trivial content, anything a card already shows.
- The reply keeps the reasoning, decisions and caveats in words, and
  leaves out lists of files, test counts and step recaps.

## Phases

| | What | Est. |
|---|---|---|
| V0 | Baseline script over the store: tokens in/out, reply chars, tools per turn, time to first item, total time. Committed with numbers | 15 min |
| V1 | File references (D3): the tree index, inline-code resolution, `studio:file/` links, the Files page opens at a line; symbol and command tints from fences and tools; node tests | 45 min |
| V2 | Tool rows by class (D4) plus the folding of same-class runs; the test report (D5) in the relay plus its row; pytest tests on recorded outputs | 60 min |
| V3 | The file-activity strip and per-file diffs (D6); `deleted` in the relay | 40 min |
| V4 | `ox-graph` and `ox-chart` (D2): parse, validate, layout, SVG, streaming placeholder, fallback, click targets, the expanded overlay; node tests on layout and validation | 90 min |
| V5 | Progress card: `after` dependencies plus per-step files and tests (D7) | 30 min |
| V6 | Knowledge section (D8). A/B on Sonnet, 3 real tasks × old/new knowledge (6 turns): output tokens, reply chars, time to first UI update, total time; numbers into this doc | 30 min |
| V7 | Gate: replay real recorded sessions through the renderer at stream speed (mid-stream and done), 1440 / 1100 / 390, light and dark; studio suites once; PR and merge | 30 min |

## Gates

- Nothing renders that the events or the model's block did not say. A
  path not in the tree, a test run with no summary, or a malformed block
  all stay text.
- Markdown, code blocks, tables, `studio:` chips, the steps card, Keep /
  Undo and streaming behave as before. The existing node and pytest
  suites pass.
- Mid-stream, an unclosed `ox-graph` never shows broken SVG or raw JSON
  flicker.
- Light and dark contrast: text in the new blocks is at least 4.5:1,
  measured on the pixels.
- V6: no extra LLM calls per turn, and the prompt grows by at most 2 KB.
  Output tokens and reply chars are reported as measured, whichever way
  they move.

## Out of scope

- A new agent or a change to how Claude Code runs; LLM-written HTML; a
  chart or graph library.
- Highlighting statuses in prose ("success", "failed") by regex. Statuses
  come from items only.
- Diagram editing, and graphs over 60 nodes (they fall back to the
  expanded view's list).
