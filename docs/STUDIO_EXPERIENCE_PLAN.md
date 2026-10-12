# Studio Experience Plan: traces, node config, Resource Hub, one design system

Status: **plan, nothing built.** Written 2026-10-11 from the brief "OperonX Studio:
Comprehensive UI/UX Refactoring" and an audit of studio `main` 68602ed (operonx 1.21.1).
The audit used a real callbot call: `load-b121-a1da979e`, 118 executions, 43 s.

The project folder stays the source of truth. The studio reads it, shows it, and writes
small, checked edits back to the files the project already has. It does not become a
visual editor that generates code, and it adds no second config system.

---

## 1. What the audit found

Screenshots (desktop 1500 px, phone 390 px) are in the session scratchpad, `ux/shots/`.

### Tracing

| # | Problem | Where |
|---|---|---|
| T1 | The runs list shows id, origin, start and duration. It shows no input, no output and no error text. Cost and tokens sit off-screen when the right panel is open. | Runs |
| T2 | The assistant opens by default and takes 25% of the width on every screen, including the data-dense ones. | right rail |
| T3 | The tree's "When · how long" column clips its numbers (`0.`, `43`, `822`). The time bars have no shared axis. | Tree |
| T4 | Every row has `FUNC`/`SYNC`/`IO` badges. They describe how the op is scheduled, not what happened in the run. | Tree |
| T5 | An op's detail opens in the global right rail, so the run and the step can't be seen side by side. On a phone it's a sheet over the run. | Inspect |
| T6 | Values are a "Formatted/JSON" toggle over flat key/value cards. An LLM call is not shown as messages; there's no JSON tree with folding; long text doesn't fold. Audio does play (`values.js`); images and video have no preview. | Inspect |
| T7 | There's no routing. A run, an op or a tab has no URL; Back leaves the app; a run can't be linked to a teammate. | whole app |
| T8 | A call is a conversation, but nothing reads it as one: what the caller said, what the bot understood, what it answered, with the audio. The turns exist (`_turns_of`) but appear only as a strip. | run page |
| T9 | The Service's `key_ops` (the latencies a caller feels) are pinned on the Monitor but not marked in a run. | Tree |

### Configuration and resources

| # | Problem | Where |
|---|---|---|
| C1 | The one edit the inspector allows is a call-site literal, typed as JSON (`literalEditor`, its comment: "the one edit the studio allows"). | Inspect |
| C2 | Prompts lists only `llm_classify`, and stayed on "Reading this op's recorded executions…". The agents' real prompts (`src/agents/*/prompts.yaml`, 5,208 lines: intents with descriptions and examples, states, templates) can't be reached. | Prompts |
| C3 | Resources is read-only cards. The only write is an LLM's price. No add, no delete, no edit of a URL, model or timeout. | Resources |
| C4 | "Used by" says "No op uses it" for every agent, but the call graph picks the agent at run time from `agent_type`. | Resources |
| C5 | A node edit re-plans at apply time (`/edit`). The diff you approved is not checked against what gets written, so a file changed in between is overwritten silently. `apply_plan(expected=)` exists and isn't used. | `app.py` |
| C6 | A prompt save finds its file by searching every file for the exact text. It fails once the text appears twice. | `prompts/save` |

### Design system

| # | Problem |
|---|---|
| D1 | `studio.css` (4,221 lines) has 91 tokens but also 224 raw hex colours and 229 `border:` declarations. |
| D2 | `studio.js` is 6,621 lines. Every view lives in it, so a change to one screen risks the others. |

### What already works (kept)

- The run stores, Langfuse import, the `$media` blob route, and recorded inputs and outputs per execution.
- Re-run of an op, the Workflow and Data Flow views, and the canvas.
- The edit machinery: `operonx_project/pyedit.py` edits Python by AST span, `yamledit.py` and `edit.py` edit YAML and `.env` line by line, and edits show a diff before they're written.
- `buildcheck.py` builds the project with the network blocked.
- The file watcher and the project stamp.
- The IR already gives every op its kind, bindings (literal or reference), resource, code, and `defined_at`/`wired_at` file and line.
- Every resource category is a pydantic `YamlModel` in operonx's registry, so each type's fields and types come from its JSON Schema.

## 2. Decisions

1. **Vanilla JS, no framework, no CDN.** A rewrite would be the opposite of "avoid unnecessary rewrites", and the studio has to keep running offline and installing with pip. Instead, `studio.js` is split into one module per view, served through the existing bundler (`/static/bundle/{stem}.js`).
2. **The trace page owns its detail panel.** The run is on the left and the selected step on the right, in a split pane you can resize. The global right rail is for the assistant only, and it starts closed on Runs, Monitor and Evals; your choice is remembered.
3. **Every screen has a URL**, for example `/p/{pid}/runs/{run}?step={op_id}&view=tree`. Back works and a link opens the same view.
4. **Edits stay small, typed and checked:**
   - Python: AST span edits (`pyedit`).
   - YAML and `.env`: line edits (`yamledit`, `edit`).
   - No round-trip YAML library (ruamel would reformat lines it didn't need to touch).
   - Every write has to prove it changed only what it meant to (§5).
5. **Forms come from types:**
   - Resource forms come from the category's JSON Schema.
   - Op fields come from the function signature (type hint, default) in the IR.
   - A raw JSON box is the fallback for a value that has no type, not the default.
   - Secrets are written as a `${VAR}` reference; the value goes to `.env` and is never shown back.
6. **One visual direction, decided by me** from the audit and the Langfuse reference, shown through screenshots of each phase. Nothing waits on a choice.

## 3. The trace experience (the heart of the plan)

### Runs list
- One row per run:
  - Status (an icon plus a word, never colour alone).
  - The run's input and output, one line each. These are the graph's parameters and its reply; for a call, the customer and the call result.
  - Duration, cost and tokens, and the `key_ops` latencies.
  - The first error's text on a failed row.
- Filters stay in one row above the list (status, time, origin, search, `key:value`). A filter set has a URL, so it can be saved and shared.
- Opening a run is one click, and its URL is the run.

### Run page
- **Header:**
  - Status, duration, start time, cost and tokens.
  - The run's input and output as two readable cards, not JSON.
  - Metadata: origin, service, session, code version.
  - On a failed run, a banner with the error and a jump to the step that failed.
- **Left, the steps.** Three lenses over the same records:
  - **Tree** (the default). One row per step: type icon, name, status, a duration bar on a shared time axis (no clipping), cost and tokens. The scheduling badges move to the detail panel. Errors are marked and can be filtered to. `key_ops` rows are marked. Levels fold. Keyboard: ↑/↓, ←/→ to fold, Enter to open, `/` to search, `e` for the next error.
  - **Timeline.** The waterfall, with the same rows and axis.
  - **Workflow.** The painted graph that exists today.
- **Turns.** When a run has level-1 turns (a call, a chat), a conversation strip sits above the lenses. Each turn shows what came in, the show-keys of its steps (heard, intent, reply) and its audio. Clicking a turn selects its steps. This is generic: it is built from `_turns_of` and `show_keys`, with nothing specific to the callbot.
- **Right, the selected step:**
  - Status, latency and when it ran.
  - **Input** and **Output**, each rendered for what it is (below).
  - **Fed by** and **feeds**, each a link that selects that step.
  - Collapsed below: metadata (kind, scheduling, ctx, attempt), code location, and Re-run.

### Value viewers (one component, used everywhere a value shows)
- **Text:** folds after a few lines and keeps line breaks; long values get "show all".
- **JSON:** a tree that folds, with type colours, copy value and copy path.
- **LLM call:** the messages as a chat (system, user, assistant, tool), plus model, tokens, cost and latency.
- **Audio:** player, duration and a waveform from the PCM peaks (no new dependency).
- **Images:** a thumbnail that opens full size. **Video:** a player.
- **Tables:** a list of flat records shows as a table.
- **Large values:** fetched only when expanded; the size is shown before then.

### Done when
- **Speed:** a run of 118 steps renders in under 300 ms; a synthetic run of 5,000 steps renders in under 1 s (row virtualisation), measured.
- **Five tasks on the real call**, each in 3 clicks or fewer from the runs list:
  - find the slowest STT step and play its audio;
  - read the LLM's messages on turn 2;
  - open the failed step of a failed run;
  - copy a value's JSON path;
  - send a teammate a link to a step.
- **Review:** screenshots at desktop and phone width for every screen, and a side-by-side with Langfuse on the same kind of trace.

## 4. Node configuration

The **Configure** panel for an op, in the Flow view and from any run step:

| What | Comes from | Edited as | Written by |
|---|---|---|---|
| Literal arguments at the call site | IR bindings + signature | Field by type: switch, number, choice (a `Literal`), one-line text, multi-line text | `pyedit.set_op_param` |
| Its resource | IR `resource` + Resource Hub | Picker of resources in the right category, with health | `pyedit.set_op_resource` |
| Policy (`timeout=`, `retry=`, `show_keys=`) | the decorator at `defined_at` | Number fields; a key picker from its outputs | new `pyedit.set_decorator_kwarg` |
| An LLM op's prompt | the prompt's source location (from extract, not a text search) | Prompt editor: variables highlighted, preview on a recorded input | `prompts/save`, located by file and line |
| An agent (`agent:<name>`) | its `prompts.yaml` | Agent editor: intents as cards (description plus example chips), states, templates; search across them | new `yamledit` list/map edits |

- Validation runs as you type: types from the signature, enums, required fields, and a referenced resource must exist.
- On save, the change goes through §5's checks.
- A value that isn't a literal in code (a reference, an expression) is shown read-only with its source line. It is never rewritten.

**Done when:** each kind round-trips on the callbot's own files.
- Edit, then the diff touches only that value's line, the canvas shows the new value, and undo restores identical bytes.
- An external edit to the same file between preview and save is refused with "file changed — reload".

## 5. Safe writes (shared by §4 and §6)

1. **Preview.** The plan carries a diff and the file's sha256.
2. **Apply** with that sha. If the file changed since, nothing is written and the panel shows "changed on disk", with the new diff to re-approve.
3. **Prove the scope:**
   - YAML: parse before and after; the semantic difference must be exactly the intended path.
   - Python: parse before and after; the trees outside the edited node must be identical.
   - Otherwise nothing is written.
4. **Write** atomically (temporary file, then rename).
5. **Build** with `buildcheck`, network blocked. If the build breaks, the old bytes go back and the error is shown.
6. **Record.** Every write goes to the team activity log with its diff, and undo is one click.
7. **Stale state.** When the watcher sees a file change, open views reload. An editor with unsaved input keeps it and shows "changed on disk: reload / compare".

**Done when:** tests cover each refusal (sha mismatch, out-of-scope change, broken build, unparsable file), plus a concurrent external edit.

## 6. Resource Hub

- **Browse:** grouped by category, one row each. A row shows health (env vars set or missing; a reachability check on demand), its key fields, and "used by".
- **Used by:**
  - Static references from the IR (`resource=`).
  - For categories looked up by name at run time (agents): "chosen per run by `agent_type`", plus how many runs used it in the last 7 days, from run metadata.
  - This fixes C4.
- **Add:**
  - Pick a category, then a form from its JSON Schema.
  - Required fields, enums and URL fields are checked.
  - A secret field takes a variable name and writes the value to `.env`.
  - The new block goes at the end of its category in the resources file, in the file's own style.
- **Edit:** the same form, changing only the fields that changed (`yamledit.set_fields`, extended).
- **Delete:** refused while something references it statically, with the list. A warning when it's looked up by name at run time.
- **Writes:** all of them go through §5.

**Done when:**
- add, edit and delete round-trip on the callbot's `resources.yaml`: comments and unrelated blocks are byte-identical, and the project builds;
- a secret's value never appears in an HTTP response, the HTML or a log.

## 7. Design system

- **Tokens** for colour (surfaces, ink, accent, status, op kinds), type scale, a 4 px spacing grid, radius and elevation, each with light and dark values.
  - Raw hex colours in `studio.css`: 224 → 0.
  - Separation by space and surface tint instead of borders: 229 `border:` declarations → under 60.
- **Components:** Panel, SplitPane, Tabs, Disclosure, Field (with every type above), Badge (status and kind only), ValueViewer, Diff, Toast, EmptyState, Skeleton.
- A built-in style page (`/styleguide`) renders every component in both themes, for review and for screenshot tests.
- **Chart colours** are checked with the dataviz palette validator (CVD-safe, contrast) before use.
- **Applied everywhere:** Flow, Runs, Monitor, Evals, Review, Prompts, Resources, Services, Jobs, Alerts, Playground. A screen not yet moved over still works.

## 8. Phases

One branch per phase, merged when its gate passes. Screenshots at desktop and phone width after every UI change.

| Phase | What | Gate |
|---|---|---|
| **P1** | Foundations: tokens, components, URL routing, `studio.js` split by view. No screen changes yet. | Every existing test passes; a screenshot of each screen is unchanged or improved; the hex count drops |
| **P2** | The trace experience (§3) | §3 done-when |
| **P3** | Safe writes (§5) | §5 done-when |
| **P4** | Node configuration (§4) | §4 done-when |
| **P5** | Resource Hub (§6) | §6 done-when |
| **P6** | Every remaining screen on the design system; accessibility (contrast, focus, keyboard); dead CSS removed | Hex count 0, `border:` under 60; an axe-style check has no serious findings on the main screens |

P3 can run beside P2 (server-side only). P4 and P5 need P3.

## 9. Not in scope

- A visual editor that writes graph code, or adding and removing ops and edges by drag.
- A new config format or store. The files stay what they are.
- A framework, a CDN, or a hosted service.

## 10. Risks

- **Line-based YAML edits** can miss exotic YAML (anchors, flow style). The scope proof in §5 turns that into a refusal, never into damage.
- **The `studio.js` split** touches every screen. P1 changes no behaviour, and the screenshot comparison is its gate.
- **Run metadata for "used by"** depends on the trace store; when it's away, the hub shows the static references only.

## 11. Progress

| Phase | State | Evidence |
|---|---|---|
| **P1** foundations | done: studio #43 | Every screen has an address (`router.js`; a browser test covers deep link, Back, the old `?run=` link). `studio.js` is split into 9 view files, with the same bundle text in the same order. Raw colours in rules went from 348 to 8 (masks, filters, the scrollbar); 219 palette tokens plus 23 snapped to semantic ones. Every screen at desktop and phone, light and dark, pixel-compared with `main`: identical except a live latency figure. |
| **P2** traces | done: operonx 1.22.0 (#147) and this branch | **operonx:** a run keeps its input and output: the graph's parameters and declared cells, or a door graph's first items. Every store keeps a 4 KB preview (ClickHouse schema 5), and Langfuse gets them. **Studio, runs list:** an input → output column. **Studio, run page:** the input and output cards, the turns, the steps (tree or timeline, virtualised, search, errors, key ops, keyboard) beside the selected step. The step is fetched by its id (`/trace/{run}/step`), and its panel shows what it fed, folded details, copy link and Open in Flow. **Values:** waveforms, tables, path copying. **Headers:** a service's key ops replace "slowest", and generators are no longer called slow. **Measured:** the real call (118 steps) opens in 133–175 ms including the fetch; a 5,000-step run in 0.72–0.80 s, scrolling at 23–27 ms a frame. All four tasks done in 3 clicks or fewer (the LLM-messages task had no run with an LLM call; `io.js` covers that rendering in its own tests). |

| **P3** safe writes | done: this branch | `operonx_studio/safewrite.py`. Every project-file write goes through it: `/edit` (studio and daemon), the LLM price, the prompt save, retention. The preview carries the file's sha256 and the apply names it; a moved file is refused with the change against the file as it is now. The scope is proved: Python by the op's own statement (or the graph body for structural edits) plus it must parse; YAML and TOML by the paths changed; `.env` by key; a prompt by its span. The write is atomic and keeps the mode. The project is re-extracted in a fresh interpreter, and a project that built before gets its bytes back if it no longer does. A journal backs `/writes` and `/writes/{id}/undo`, and the toast offers Undo. 8 unit tests, 1 endpoint test (stale, then apply, then undo), and a browser run of the same flow in the inspector. |

| **P4** node configuration | done: this branch | **Settings** (`configure.js`): each literal or defaulted input gets a field matching its type (switch, number, choice, text, a prompt's parts, a list, JSON as the last resort). Types come from the op's signature, extracted with type, choices, default and description. A Review button appears once the field changes; Review shows the diff, Apply writes through safewrite, and the toast offers Undo. A default-valued input is added to the call (`set_param add=True`). **How it runs:** the op's `@op(...)`: `show_keys` as checkboxes of its outputs, `bound`, `transient`; other keywords are shown as the code has them, and a computed one is refused (`pyedit.set_decorator_kwarg`, `/op-config`, `/op-decorator`). **Resource:** a picker when `resource=` is a literal. **YAML files** (`yamlview.js`, `yamldoc.py`): an agent's `prompts.yaml` and any resource's YAML file, edited value by value. Each edit is `set`/`append`/`remove`/`add`/`delete` at the span PyYAML reports, so comments, quotes and order are kept, and it is checked by `yaml_scope`. Opened from a resource's file field; it has its own address. Measured on a copy of the callbot's real `prompts.yaml` (2,542 lines): set changes 1 line, append 1, remove 1, add 4, all in scope. Tests: 11 server, a browser run of each field kind on desktop and phone, and edit, undo and add on the YAML editor. The old JSON literal editor in the inspector is gone. |

| **P5** Resource Hub | done: this branch | Resources are rows by category, from the project's own file (`/resources/hub`). Each row shows its key fields and an environment light (the missing variable named), and what uses it: an op, the project's config (`operonx.toml`'s `trace_local:mine`), or a parameter that picks it per run (`agent_type`, with run counts from operonx 1.22's inputs, `/resources/usage`). A row opens onto its fields, each edited in place: Review, diff, Apply through safewrite, with comments kept. A secret shows its `${VAR}`, and "Set in .env" writes the value (`/env`), never returned. A field not yet written is added from the category's fields. **Add:** a form built from the category: the fields the project writes first, then operonx's schema; a secret takes a variable (named after the resource) and its value goes to `.env`. The variable must not already be set; the YAML and `.env` land together or not at all. **Delete:** refused while an op or the config names the resource; otherwise only its block goes. Literal secrets in the file are masked in responses, and credential names are matched narrowly (`api_key`, `secret_key`, `access_token`; not `cost_per_input_token` or `public_key`). Tests: 5 server, a browser run of add, edit, refused delete and delete. |

| **P6** sweep | done, with one gate not met | **Accessibility:** axe-core on 9 screens (flow, runs, a run, resources, monitor, prompts, settings, configure, YAML), light and dark. Serious and critical findings went from 4 rules (96 nodes: unlabelled fields, empty fold buttons, unnamed selects, tabs without roles) to 0, all in code from this effort; no contrast failures. **Dead CSS:** 138 rules no code can produce were removed (303.6 KB to 290.9 KB), pixel-identical on every screen in both themes. **Raw colours in rules:** 8 to 4, the 4 left being mask luminance (`#000` in a mask is opacity, not colour). **Monitor:** deploy labels no longer overlap (a label only where it fits; every mark has a hover title), and a jump past 10x reads as the two values, not "▲ 1814863%". **Floating surfaces** (popovers, menus, tooltips, the canvas toolbars, cards on the home page): a shadow only in light, the edge kept in dark. **`test_minify`** failed earlier only because my test environment lacked `rcssmin`; it passes with it installed. |

**Gate not met: `border:` under 60.** 230 visual border declarations became 206 drawn in light. Most of the rest are the canvas's own art (node cards, the router's patch panel, the agent cell), which is the visual language and stays, or the borders inputs, buttons and tables need. Getting below 60 means restyling about 130 chrome components, each needing review on desktop and phone, light and dark: a screen-by-screen design pass rather than a sweep. It is the open item of this plan.

**Closed 2026-10-12 by `CHROME_SURFACES_PLAN.md`:** chrome `border` declarations 56 (the canvas's 44 counted apart, untouched). One card everywhere — a tint, never an edge — and no box inside a box on any of 104 shots.

**Known gap, found by the tasks:** a call's STT input (`speech_audio`, raw float32 samples) is recorded as `application/octet-stream`, so it can't be played. The TTS audio plays. Fixing it means the callbot recording speech audio as `audio/L16` at 16 kHz in its trace.
