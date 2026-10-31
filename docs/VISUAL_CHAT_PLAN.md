# The conversation shows the work: a visual-first assistant (VISUAL_CHAT_PLAN)

Status: in progress on feat/visual-chat (2026-10-31): V0 done.

Owner's brief: "Visual-First Conversational Engineering Experience", in 12
sections. The assistant's work should be readable at a glance: references,
tool activity, progress, changes, tests, errors and relationships each get
their own visual form. Technical depth stays one click away.

The LLM reasons and engineers. The studio does the predictable
presentation and interaction. This plan changes how the work is shown and
what the model is told about it. It does not rebuild the agent or change
how Claude Code runs.

Every requirement of the brief is traced to a decision and a phase in
[Coverage](#coverage-every-point-of-the-brief), at the end.

## 1 · What is there today (audited on main a53b0d0)

**The pipeline.**
- The relay (assistant.py) turns Claude Code's stream into typed **items**
  and stores them per session. This is the server.
- The browser (assistant.js) renders each item kind, streams text as
  deltas into the last `text` item, and replays every item on reload.
- Presentation already sits apart from execution: the relay records facts
  and the page draws them.

| Item kind | What it carries | How it renders |
|---|---|---|
| `text` | Markdown | `md()` / `inline()`, hand-written: fences, headings, lists, tables, quotes, `code`, links |
| `tool` | `name`, `label` ("Ran pytest"), `input` (clipped JSON **text**), `output` (clipped at 4,000 chars), `status` (`running`/`ok`/`error`), `ms` | A row in an activity group. The head reads "Read 3 files, ran 2 commands"; a row opens to Input / Result |
| `thinking` | text, ms | "Thought for 1.3 s", opens |
| `tool` = `mcp__studio__steps` | `plan` (data) | The **progress card** (progress.js, ASSISTANT_PROGRESS_PLAN): steps on a vertical line, six states, times, the tool calls of each step, the hand rings each step's target |
| `changes` | `files [{path, added, removed, new}]`, one `diff`, `sha` | The changes card: file list, one folded diff, Keep / Undo |
| `error` | text | A red card with the first line |
| `turn_end` | state, ms, cost, tokens, model | The turn's last line |
| `compact` | — | A divider |

`studio:` links (`run/ op/ tab/ board/ eval/ point/ monitor/ project/`)
render as chips that act on the studio (shell.js `oxStudioLink`).

**Reusable today:**
- `W.Icons`.
- `W.Values` (a JSON tree).
- The progress card (progress.js).
- The changes card.
- Activity groups.
- `codeBlock` / `foldable`.
- The hand (`point`).
- The Files page (#129), which opens any file (`v.file`).
- The studio's colour tokens, light and dark (theme.py twins).

**Limits against the brief:**
1. **References are plain `code`.** Nothing is clickable, nothing tells
   a file from a symbol or a command, and nothing shows whether a file
   was read or changed.
2. **Tool rows all look the same.** A test run reads "Ran cd … && pytest
   -q", and only the raw output shows the result.
3. **Claude Code writes files through Bash** (heredoc, `sed -i`), so the
   edit events do not show every edit. Only git does (the changes card).
4. **The changes card shows one diff** for every file. It shows no reads
   and no deletes.
5. **Errors are one red style**, whether a turn died or a command failed
   and the turn recovered. Nothing summarises several failures.
6. **Nothing in a reply can draw.** There is no graph, chart or diagram,
   so relationships and numbers come out as prose or tables.
7. **The progress card has no `blocked` state** (`waiting` means "needs
   you"). It has no subtasks, no dependencies between steps, and no files
   or test results inside a step.
8. **Status colours are set per component**, not as one shared set.
9. **The model is told nothing about what the page can show.** It
   re-describes in words what a card already shows (the file list, test
   counts, the step recap).

**Measured: where the tokens go** (live store, 79 turns, 434 items):
- The output is about **1%** of a turn's tokens. One mr-finance turn:
  985k input (933k of it cached), 10k output, 145 s.
- A reply averages **217 characters**.
- The input is the context: knowledge.md (17 KB), the files read and the
  tool outputs.

So moving presentation out of the LLM mostly saves **the owner's
reading**, not generation. The token goal of brief §9 is met by four
rules:
- **Add no LLM call.** Every derived block is computed by the relay or
  the page.
- **Grow the prompt by at most 2 KB**, cached with knowledge.md.
- **Never make the model re-send a visual it already sent** (D10).
- **Cut the replies' repetition of what cards show** (D11).

V0 measures the baseline and V7 measures it again.

**V0 baseline** (2026-10-31, main d737464; `scripts/perf/chat_baseline.py`
over a read-only copy of the live store, `scripts/perf/render_chat.py` on a
scratch studio):

| Metric | Value |
|---|---|
| Turns measured | 70 |
| Median input / output tokens per turn | 47,215 / 375 |
| Output share of all tokens | 16.8k of 1.72M (1.0%); 1.64M of the input was cached |
| Median LLM calls per turn | 2 (the long mr-finance turn: 21) |
| Median time to the first tool or text item | 5.6 s |
| Median total turn time | 7.7 s (the long turn: 145 s) |
| Median reply length | 125 chars |
| Median stored bytes per turn | 2.0 KB (the long turn: 61 KB) |
| `ox-` fences / callouts used | 0 / 0 |
| Render of a 434-item session | median 248 ms, one long task ~280 ms, 5,495 DOM nodes |

## 2 · Decisions

### D1 · Two sources of truth, nothing invented

A visual element comes from one of two places:
- **Runtime facts:** tool events, git, test-runner output, the steps tool,
  the turn's usage.
- **A typed block the model writes:** a graph or a chart (D9).

Nothing is inferred from prose. When the facts are missing, the element
stays text. Progress, counts and percentages are always counted, never
estimated. Each derived fact is computed once, by the relay when it needs
the full tool output (tests), otherwise by the page.

### D2 · The block protocol: items and typed fences, one registry

Brief §8 proposes a `MessageBlock` union. Its types map onto what exists,
plus two fences:

| Brief's block | Here | Source |
|---|---|---|
| TextBlock | `text` item, Markdown | model |
| CodeBlock | a fenced block in `text` | model |
| FileReferenceBlock | an inline reference inside text and tool rows (D4) | model text, resolved against the real tree |
| ToolActivityBlock | `tool` item, classed (D5) | runtime |
| ProgressBlock | the `steps` tool item (D12) | model, through the tool |
| DiffBlock | `changes` item, per file (D7) | git |
| TestResultBlock | `tests` on a `tool` item (D6) | test-runner output |
| DiagramBlock | an ` ```ox-graph ` fence (D9) | model |
| ChartBlock | an ` ```ox-chart ` fence (D9) | model |
| (new) Callout | `> [!NOTE]` / `[!WARNING]` / `[!FINDING]` / … (D3) | model |
| (new) Turn outcome | the `turn_end` item, grown (D8) | runtime |

No new message format and no second pipeline:
- An item stays an item.
- A text item stays Markdown.
- Rich content inside a reply is a fence whose language names a preset.

**One registry:**
- `static/blocks.js` holds `W.oxBlocks.register(name, {validate, render,
  partial, update})`.
- `md()` asks the registry for any fence language it knows.
- `append()` asks it for item kinds.
- A new visual type is one file that registers itself. assistant.js does
  not change.

**Streaming:**
- `partial(text)` renders a placeholder while a fence is still open:
  "Drawing graph…" at the block's reserved height, so nothing jumps.
- On close, `validate` checks the JSON against the preset's schema.
- When the JSON fails, the block falls back to a code block as written,
  with a quiet "could not draw: <reason>" line.
- The LLM never writes HTML.

**Talking to the studio:** blocks act through what already exists, never
by reaching into other components:
- `oxStudioLink`, extended with `studio:file/<path>#L<n>`.
- The hand (`point`).
- `performUi`.

### D3 · One status vocabulary everywhere

**Shared tokens:**
- Seven statuses: `--st-ok`, `--st-warn`, `--st-err`, `--st-run`,
  `--st-pending`, `--st-blocked`, `--st-skip`.
- Each has a light and a dark twin and a muted tint.
- Text in these colours keeps ≥ 4.5:1 contrast on its surface.

**One helper:** `status(kind)` returns the icon, the colour and the word.
Steps, tool rows, test reports, graph nodes, errors, the outcome strip and
callouts all use it, so a failure looks the same everywhere.

**Statuses come from items, never from prose.** "Failed" in a sentence
stays a word.

**Important findings are marked by the model, in structure:**
- GitHub-style callouts in a blockquote: `> [!NOTE]`, `> [!WARNING]`,
  `> [!ERROR]`, `> [!SUCCESS]`, `> [!FINDING]`.
- A callout renders as a thin left rule with the status colour and an
  icon. It is not a card.
- Knowledge allows one or two per reply, for what changes the owner's
  decision. A plain blockquote stays a plain quote.

### D4 · References: what the text names, resolved and styled

**Inline code is classified**, but only text the model already marked as
code. Resolution against real studio state wins over shape.

| Kind | How it is known | Look | Click |
|---|---|---|---|
| File | It **is** a path in the project's file tree (fetched once per session; outside a project, the path a tool event of this turn used) | cyan mono, file icon; `:42` / `#L42` as a line | Opens the Files page at the file and line |
| File touched this turn | A file reference this turn's facts (D7) read, modified, created or deleted | Same, plus a glyph: read `·`, modified `●` (amber), created `+` (green), deleted `−` (red, struck) | Same; modified ones also open their diff |
| Op | The name is one of the project's ops | the op chip (exists: `studio:op`) | Selects the op |
| Requirement, card, plan, question | `ROW-ID`, `F1`, `docs/X_PLAN.md`, `Q-16` that resolve | the point chip (exists) | Points |
| Symbol | `name()`, `Name.attr`, a CamelCase class: shape only | mono, violet tint | none |
| Config key | `a.b` under a toml or yaml file named in the same sentence, or `KEY=` | mono, slate tint | none |
| Command | starts with an executable on a short list (`git`, `pytest`, `uv`, `npm`, `python`, `node`, `make`, …) or carries `&&` / a flag | mono on a faint terminal background, `$` hint | Copies |
| Other code | — | as today | none |

- The model may also write explicit links:
  `[app.py:42](studio:file/app.py#L42)`.
- A path that is not in the tree stays plain code. Nothing is guessed
  into a link.
- In tool rows, the resource is a reference built from the tool's
  **input fields** (`file_path`, `path`, `command`), not from the label.
- Markdown links, fences, tables and `studio:` chips keep their current
  behaviour.
- The Files page gains line numbers, scrolling to a line, and a line
  highlight.

### D5 · Tool activity by what it did

**Classes.** Each call is classed from its **name and input**:

| Class | Matched by |
|---|---|
| read | Read |
| edit | Edit, MultiEdit, NotebookEdit; Bash with `sed -i`, `>` / heredoc into a file |
| create | Write of a new file |
| delete | Bash `rm` / `git rm` |
| search | Grep, Glob, LS; Bash `grep` / `rg` / `find` |
| run | any other Bash |
| test | Bash running a known test runner |
| build | Bash running a known builder: `npm/pnpm/yarn run build`, `vite build`, `tsc`, `cargo build`, `go build`, `make`, `docker build`, `uv build`, `python -m build` |
| git | Bash `git …`, its subcommand named ("commit", "push") |
| web | WebFetch, WebSearch |
| studio | `mcp__studio__*` |
| plumbing | ToolSearch, hidden as today |

**Each row** shows, before anything is opened:
- the class icon and verb in the class colour;
- the resource as a reference (D4), or the command in mono, cut to one
  line;
- the state from `status()`;
- the time.

**Folding:**
- Runs of the same class fold into one row: "Read 6 files", with the
  files as chips. Opening the row shows each call.
- The activity group's head keeps its one-line summary.
- Repetition never makes large messages: 30 reads are one row.

**Details stay one click away:** the input (as a JSON tree when it parses,
via `W.Values`), the output and the exit status. Raw logs are never shown
by default.

The model's **explanation** of a tool is text, and only a tool **event**
gets this styling, so "I'll run the tests" never looks like a run.

### D6 · Tests are a runtime fact

- When a test-class call ends, the relay parses the **full** output,
  before the 4,000-char clip:
  - the runner's summary line (pytest, node --test, npm/pnpm test, jest,
    vitest, go test, cargo test);
  - the failing test ids, each with its first error line.
- The result goes on the item:
  `tests: {runner, passed, failed, skipped, errors, ms, failures: [{id,
  line}]}`.
- **The row shows** a thin pass/fail bar and "137 passed · 3 failed ·
  4.2 s". The failures open as a list, each with its error line and the
  output around it.
- No summary line means no report: the row stays a run row.
- Recorded real outputs are the pytest fixtures for the parsers.

### D7 · File activity and diffs

**The changes card becomes the turn's file activity.** The relay records
two kinds of facts:
- Reads, from Read events and read-class Bash.
- Writes, from git, the truth because Bash writes files: modified,
  created, and **deleted** (the relay adds deleted files from `git
  status`).

**The card shows:**
- A strip on top: "Read 6 · Modified 3 · Created 1 · Deleted 1".
- The files, grouped by folder when there are more than 6, each with its
  glyph (D4), ± counts and **its own folded diff**: the one diff split per
  file, with hunk headers and add/del lines as today.
- The reads collapsed under "Read 6 files". They are a fact, not a change.
- Keep / Undo as today. Undo restores deleted files too.

**One diff viewer.** The per-file diff is a registered block (D2), so the
progress card (D12) and the Files page can open the same viewer.

### D8 · Errors, error distribution, turn outcome

**Severity**, through `status()`:

| Severity | What it means | Look |
|---|---|---|
| fatal | The turn stopped: the `error` item, or a killed / timed-out turn | red, a card |
| failed | A tool call failed and the turn did not recover | red row |
| recovered | A call failed and a later call of the same class succeeded | amber row, "recovered" |
| warning | A runner reported warnings, or a test was skipped | amber, inline |

- An error shows its first line and a severity icon.
- **Opening it** shows the command or input, the exit status, the full
  stored output, and the step it belonged to.

**Error distribution.**
- When a turn has 3 or more failures, the outcome strip shows them by
  class: "3 failed: 2 test, 1 run". It is a stacked bar, a chart with
  meaning.
- A click opens the list.

**Turn outcome (the implementation summary).** The `turn_end` line grows
into a one-line strip, from facts only:
- state, time and cost;
- files (modified / created / deleted);
- tests (last run per runner);
- steps done x / y;
- failures.

Steps, tests and failures appear only when the turn had them. This is the
"what happened" glance. The reply carries the "why".

### D9 · Graphs and charts the model draws: `ox-graph`, `ox-chart`

**`ox-graph`** covers execution sequences, dependencies, architecture and
workflows:

    ```ox-graph
    {"id": "mail-path", "title": "Request path", "direction": "down",
     "groups": {"app": "HTTP layer", "flows": "Flows"},
     "nodes": [{"id": "api", "label": "POST /mail", "group": "app"},
               {"id": "triage", "label": "triage", "group": "flows", "state": "done",
                "file": "src/flows/triage.py", "detail": "One LLM call, routes 4 ways"}],
     "edges": [["api", "triage", "body"]]}
    ```

- **Node fields:** `label`, and optionally `group`, `state` (the D3
  statuses plus `active`), `detail`, and one target (`file`, `op`, or a
  `point` name).
- **Edges:** `[from, to, label?]`.
- **Groups** draw as system boundaries: a faint frame and a title.
- **Highlighting:**
  - `state: active` pulses softly, unless the user prefers reduced motion.
  - done, failed, pending, blocked and skipped nodes use `status()`.
  - A node whose `file` this turn modified is marked **affected**
    automatically, from facts (D7), with the modified glyph and an
    outline.
  - `"highlight": [ids]` marks what the model says a change touches.
- **Inspecting a node:** a click selects it and shows a one-line detail
  under the graph (its `detail`, its file reference, its state). A second
  click on the target opens it.
- **Layout:** a small layered DAG written for this, cycles shown as back
  edges. flowlayout.js is built for IR graphs, so it is too heavy here,
  and there is no library to load.

**`ox-chart`:**
- `{"type": "bar" | "line" | "spark" | "stack", "unit", "series":
  [{"name", "points": [[x, y], …]}], "note"}`.
- For test results over runs, timings, counts, sizes and distributions.

**Two presentation levels:**
- **Inline:** a graph at most 260 px high, a chart at most 160 px, sized
  to the column. Up to 12 nodes are readable inline.
- **Expanded:** an overlay, full screen on a phone, with zoom (wheel,
  pinch, buttons), pan (drag), node selection with a detail panel, fit,
  and Escape to close. Over 12 nodes, inline shows a fitted overview with
  "Open".
- Over 60 nodes, the expanded view adds a searchable node list.

**Drawing:** inline SVG, the studio's tokens, light and dark. Text is
real text, selectable and at contrast.

**When not to draw** (knowledge, D11):
- fewer than 4 nodes or 2 relationships;
- fewer than 3 values;
- anything a card already shows (steps, files, tests).

### D10 · Not regenerating what was already sent

**A graph is updated, not redrawn by the model.**
- A later `ox-graph` with an `id` already drawn in this session and an
  `"update"` body changes the earlier graph in place:
  `{"id": "mail-path", "update": {"triage": "done", "send": "active"}}`.
  That is a few tokens instead of the whole graph again.
- The earlier graph shows "updated" with the time.
- An unknown id renders nothing, and says so in a quiet line.
- Charts update the same way, by appending points.

**Derived blocks are never sent by the model at all.** Tool rows, tests,
files, the outcome strip and errors come from facts. The page re-derives
them on reload from stored items.

**The catalogue is not re-sent.** It lives in knowledge.md as names and
fields (~1.5 KB, cached), and it is not injected per turn.

**The steps tool keeps its whole-list call.** The list is small, and
partial updates would add a failure mode for little gain. V0 measures
it. If the steps calls turn out to cost much, a `{"step": i, "state":
…}` short form is added.

### D11 · Knowledge: preset-first, adaptive, and no repeating the cards

knowledge.md gets one section, "What the page shows for you", of about
1.5 KB. It says six things.

1. **Shown without you:** tool calls, files read and changed, diffs, test
   results, errors, the turn's outcome. Do not list them in the reply,
   and do not recap the steps.
2. **What you draw:** `ox-graph` and `ox-chart`, their fields, when to
   draw them and when not to (D9), how to update by id (D10), and the
   callouts (D3).
3. **References:** write paths, ops and ids as inline code or
   `studio:file/` links. The page makes them clickable.
4. **Adaptive planning:**
   - For a task with several steps, plan with `steps` (exists). Add
     `after` and `sub` only when they help (D12).
   - Do not add "report the results" steps, since the page reports
     results by itself.
   - Draw one graph where the plan's structure is itself the point: a
     merge of 15 flows, a dependency change.
   - A simple task gets no plan and no graph.
5. **Quality first:** the reply still holds the reasoning, the decisions,
   the caveats and the debugging findings. Brevity applies only to what a
   card shows. Never skip inspection or validation to write less.
6. **One example**, in a few lines.

**Adaptive planning needs no extra call.** The catalogue is static, so
the model knows what the page can show before it plans.

### D12 · The progress card, finished

The steps tool gains three optional fields; the old calls stay valid:
- **`blocked`**, a new state: the step cannot go on for a reason that is
  not the owner (a failed dependency, a service down, a missing tool).
  It takes `detail` with the reason. `waiting` stays "Needs you".
- **`sub: [{title, state}]`**: one level of subtasks.
  - The step's progress is `done/total` of its subtasks.
  - When the step ran tests, its progress is the passed/total of its last
    run.
  - Otherwise no bar is shown. **No percentage is ever estimated.**
- **`after: [i]`**: dependencies.
  - When any step has them, the card draws the steps top-down as a
    connected structure.
  - Independent steps sit side by side; joins merge.
  - The active step is highlighted, the same as today.

**An opened step shows**, in this order:
- what it left (`result`) or why it failed (`error`);
- its files, from D7 facts, matched by time window;
- its tests (D6);
- its tool calls as classed rows (D5);
- its execution details: commands with exit status, durations.

The card's header keeps "x of y steps", now counted with `skipped`
excluded from the total.

### D13 · Look, states and density

- **One quiet visual language.**
  - No card inside a card.
  - At most one badge per row.
  - Borders only where they separate.
  - Statuses are colour plus icon plus word, so colour is never alone.
  - Saturation stays muted, via the tokens.
- **Every interactive element has states:** hover, `:focus-visible`
  (the accent ring), selected (graph nodes, file rows) and open (folds,
  rows). They are reachable by keyboard: Enter or Space opens, and the
  arrow keys move between graph nodes.
- **Streaming transitions:**
  - A new block fades in over 120 ms.
  - Placeholders reserve their height, and the log does not jump.
  - The live row's spinner turns into its status icon in place.
  - Updates by id cross-fade only the changed nodes.
  - `prefers-reduced-motion` turns all of this off.
- **Responsive:**
  - At 390 px, graphs fit the column, with "Open" for detail.
  - Tool rows wrap the resource under the verb.
  - Strips wrap.
  - The expanded view is full screen.
- **Themes:** light and dark from the token twins. Contrast is measured
  on the pixels behind each text (the liquid-glass contrast script), not
  judged.

## 3 · Phases

| | What | Est. |
|---|---|---|
| V0 | **Baseline.** A script over the store and the live stream, per turn: tokens in / out / cached, LLM calls, time to first meaningful UI update (first tool, steps or text item painted), total time, reply chars, stream bytes and stored item bytes, render ms of a 400-item session (`performance.now` around `renderAll`, plus long tasks). Numbers into this doc | 25 min |
| V1 | **Foundation.** `blocks.js` registry (D2), with `md()` and `append()` routed through it. Status tokens plus `status()` (D3), and the existing steps, rows and cards switched to it. Callouts. Node tests | 50 min |
| V2 | **References (D4).** File-tree index, inline-code classification and resolution, op/row/plan chips, `studio:file/` links, touched-file glyphs. The Files page gets line numbers, scroll and highlight. Node tests | 55 min |
| V3 | **Tool rows (D5) and tests (D6).** Classes from name and input, rows, folding, JSON-tree input. Relay test parsers on full output and `tests` on the item. Pytest on recorded real outputs, node tests on classes | 75 min |
| V4 | **File activity, errors, outcome (D7, D8).** Reads plus `deleted` in the relay, the strip, per-file diffs as a registered block, Undo covering deletes. Severity classes, error details, the distribution bar, the outcome strip | 65 min |
| V5 | **Graphs and charts (D9, D10).** Schema validation, layered layout, SVG, groups, states, affected marking, node selection and detail, streaming placeholder, fallback, update by id, the expanded overlay (zoom, pan, fit, list over 60). Node tests on validation, layout and update | 130 min |
| V6 | **Progress card (D12).** `blocked`, `sub`, `after` in mcp.py `check_steps`; the top-down structure; opened-step contents; step progress from facts only. Pytest and node tests | 55 min |
| V7 | **Knowledge (D11) and measurement.** The section; then an A/B on Sonnet with 3 real tasks on a scratch copy of a real project, each run with the old knowledge and the new (6 turns). V0's metrics again, plus malformed-block count and graphs drawn; LLM-side and frontend-side numbers reported separately | 45 min |
| V8 | **Gate.** Replay real recorded sessions through the renderer at stream speed, with text split into the deltas it arrived in; shots mid-stream and done at 1440 / 1100 / 390, light and dark; states by keyboard; the comprehension check below; studio suites once; PR and merge | 50 min |

Total ≈ 9 h of work. Each phase is its own commit on one branch (one
branch per plan). The PR is opened at V8.

## 4 · Gates

**Truth.**
- Every rendered status, count, file and test traces to an item or to the
  model's block.
- A path not in the tree, a run with no summary line and a malformed
  block all stay text.
- No mock data anywhere: tests use recorded real outputs and sessions.

**No regressions.**
- Markdown, fences, tables, `studio:` chips, the steps card, the hand,
  Keep / Undo, streaming, reload replay and the composer behave as
  before.
- The existing node and pytest suites pass.

**Streaming.**
- Mid-stream, an unclosed fence shows its placeholder: never raw JSON
  flicker, never broken SVG.
- Rows change state in place.
- The log does not jump while you read above.

**Look.**
- ≥ 4.5:1 contrast for text in every new element, light and dark,
  measured on the pixels.
- No horizontal overflow at 390.
- Focus is visible on every control.

**Efficiency (V7).**
- No extra LLM call per turn, and the prompt grows by ≤ 2 KB.
- Render time of a 400-item session grows by ≤ 20%, and its long task by
  ≤ 20%. (V0 found the baseline's own long task at ~290 ms, so "no long
  task over 100 ms", first written here, failed before any change; it is
  measured against the baseline instead.)
- Stream and stored bytes are reported.
- Output tokens and reply chars are reported as measured, whichever way
  they move.

**Comprehension.** On 3 replayed real turns, these seven questions must
be answerable from the folded view, without opening anything:
1. What is it doing?
2. What is it working on now?
3. Which files are involved?
4. How do the operations relate?
5. What changed?
6. Did it pass?
7. What is left or blocked?

Every fact that was in the old text must still be reachable within one
click. I check this from the shots, and the owner rates the same 3 turns.

## 5 · Out of scope

- A new agent, or a change to how Claude Code runs.
- LLM-written HTML.
- A chart or graph library, and Mermaid. Mermaid is a 700 KB library
  with a look of its own, and it cannot carry states or click targets.
- Highlighting statuses in prose by regex.
- Editing diagrams.

## Coverage: every point of the brief

| Brief | Requirement | Where |
|---|---|---|
| §1 | File paths cyan, variations by read / write / edit / create, line refs, clickable to the file | D4 · V2 |
| §1 | Tool names and calls distinct; read / run / search / edit / test treatments; events vs explanations | D5 · V3 |
| §1 | Functions, classes, identifiers, config keys recognisable; commands mono with background; inline code distinct | D4 · V2 |
| §1 | Success / warning / error / pending / in-progress consistent; findings easy to spot without shouting | D3 · V1 |
| §1 | Structured metadata over regex; keep Markdown, code, fences, links | D1, D2, D4 · gates |
| §2 | Short explanations → concise text | D11 |
| §2 | Task progress → progress blocks | D12 · V6 |
| §2 | Execution sequence → flow diagrams | D12 (`after`), D9 · V5–V6 |
| §2 | Dependencies → interactive node graphs | D9 · V5 |
| §2 | File activity → indicators | D4, D7 · V2, V4 |
| §2 | Code changes → diff previews | D7 · V4 |
| §2 | Tests → visual reports | D6 · V3 |
| §2 | Architecture → diagrams | D9 (groups) · V5 |
| §2 | Metrics → charts | D9 (`ox-chart`) · V5 |
| §2 | Errors → severity + expandable details | D8 · V4 |
| §2 | Tool execution → compact activity | D5 · V3 |
| §2 | No long text for what is visual; never drop technical explanations | D11 (points 1, 5) |
| §3 | Execution graphs: steps as nodes, direction, active highlighted, done/failed/pending/skipped | D12, D9 · V5–V6 |
| §3 | Dependency graphs: inspect nodes, highlight affected parts | D9 (selection, `highlight`, affected from facts) · V5 |
| §3 | Architecture diagrams: relationships, data flows, boundaries, exploration | D9 (groups, edge labels, expanded view) · V5 |
| §3 | Charts and metrics, compact inline | D9 · V5 |
| §3 | File change summaries, test summaries, workflow diagrams, error distributions, implementation summaries | D7, D6, D9, D8 (distribution, outcome) · V3–V5 |
| §3 | Inline and expanded levels (zoom, pan, select, inspect) | D9 · V5 |
| §3 | No separate dashboard needed | everything renders in the conversation |
| §4 | Title, status, progress where meaningful, subtasks, dependencies, completion/failure | D12 · V6 |
| §4 | Pending, In progress, Completed, Failed, Blocked, Skipped | D12 (`blocked` added; `waiting` kept) · V6 |
| §4 | Top-down connected structure; active highlighted | D12 (`after`) · V6 |
| §4 | Expand a step: files, tool activity, details, results, validation | D12 · V6 |
| §4 | Progress from real events, never fabricated | D1, D12 · gates |
| §5 | Compact indicators; read / create / modify / delete; grouping; highlighting; navigation | D7, D4 · V2, V4 |
| §5 | Expandable diffs; inspect changes without searching the chat | D7 · V4 |
| §6 | Read, edit, search, terminal, test, build, other tools | D5 · V3 |
| §6 | Operation, resource, running/completed/failed first; details on expand; no raw logs by default | D5 · V3 |
| §7 | Summaries first; diffs, failed tests and node details on expand; repeated tools grouped | D5, D6, D7, D9 · V3–V5 |
| §7 | Neither too much text nor too much decoration | D11, D13 |
| §8 | Inspect the architecture first; typed blocks over regex/HTML; the MessageBlock question | §1 audit, D2 |
| §8 | Mixed content, keep Markdown, streaming, malformed content, sync with execution state, talk to the studio, presentation apart from execution, extensible | D2 · V1 |
| §8 | No separate pipeline | D2 |
| §9A | Preset-first: reuse components, send data only | D2, D9, D11 · V5, V7 |
| §9B | Structured payloads; layout and styling by the renderer; nothing the frontend can derive | D1, D5–D8, D10 |
| §9C | Know the presets before planning; text only where needed; custom visuals last; no overhead for simple tasks | D11 (points 1, 4) |
| §9D | No repeated explanations; no formatting LLM calls; no repeated schemas; no regenerated payloads; reuse state; deterministic rendering; focused context | D10, D11 · V7 |
| §9E | Quality not cut for tokens | D11 (point 5) · V7 gate |
| §9F | Tokens, LLM calls, first UI update, total latency, render performance, payload, completeness and comprehension; LLM vs frontend separated | V0, V7, V8 · gates |
| §10 | Design system, hierarchy, typography, spacing, muted colours, light/dark, streaming transitions, responsive, hover/focus/selected/open; nothing excessive | D13 · V8 |
| §11 | Inspect, identify reuse and limits, strategy, then incremental | §1, §2, phases |
| §11 | No rebuild; no mock data or fabricated events; Claude Code unchanged; no regressions; real state; both themes; validate while streaming; fall back to text | D1, D2 · gates, V8 |
| §12 | What, now, files, relations, changes, success, what is left, with minimal reading | Comprehension gate (7 questions) · V8 |
