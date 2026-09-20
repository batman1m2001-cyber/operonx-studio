# Show keys: what a card says about its op

Status: plan, 2026-09-20. Owner: studio. Touches operonx core (one
keyword), the studio, and the callbot project.

## 0. Why

Zoomed in, a card prints the first three input names and the first
three output names. Inputs repeat what the wires already show. Outputs
are mostly plumbing every op passes along (`cmc_start_time`, `turn_id`,
`kind`). The card repeats the graph instead of saying what the op is
for, and a painted run has nowhere to put the one value that matters.

Measured on the callbot flow (24 ops): a pure dataflow heuristic picks
the right key for about half the ops (`transcript → text`,
`synthesize → audio`, `agent_turn → response` right; `transcribe →
embedding`, `detect_speech → kind`, `choose_reply →
conversation_history` wrong). So the author must be able to name the
key, and the heuristic is only the fallback.

## 1. The rule

Every op has **show keys**: the one or two outputs that stand for it.

Resolution order, first hit wins:

1. **Instance**: `show=` at the call site,
   `transcribe(speech_audio=..., show="transcript")`.
2. **Declaration**: `@op(show="text")` on the function.
3. **Kind default**: a class attribute on the op class. Built-ins ship
   theirs; a project's own op classes set their own.
4. **Auto**: the dataflow heuristic in §4, computed by the extractor,
   never by the runtime.

`show` accepts a string or a sequence of strings; it is normalised to a
tuple. Every key must be an output of the op. A wrong key raises
`ValueError("show key 'x' is not an output of 'op'")` at graph build,
in `GraphOp.build()` next to `_validate_ref_scope`, where outputs of
every member (GraphOps included) are final.

## 2. Core change (operonx)

One keyword, no behaviour change at runtime.

- `BaseOp.__init__(..., show=None)` → `self.show: tuple[str, ...]`.
  When `None`, falls back to `type(self).show_default`, a class
  attribute defaulting to `()`.
- `@op(show=...)` in `operonx/core/ops/transform/func_op.py`, threaded
  like `transient`: decoration value is the default, call-site value
  overrides.
- `"show"` joins `_BASE_INIT_KEYS` in `operonx/core/ops/_shortcuts.py`
  so the call-site keyword reaches the constructor instead of the
  input mapping. The decorator's existing collision warning covers a
  function with a parameter named `show` (none in the callbot).
- `@graph` needs nothing: its wrapper already forwards every base key
  to `GraphOp`.
- `BaseOp.serialize()` writes `"show": [...]` when non-empty, beside
  `description`.
- `GraphOp.build()` validates `show ⊆ outputs` for each member.

Kind defaults (`show_default`):

| class | default | why |
|---|---|---|
| `LLMOp` | extracted field keys when `fields=[...]`, else `("content",)` | with extraction the parsed field is the answer, not the raw text |
| `BranchOp` | `("target",)` | the inspector's value; the card shows the fired row instead |
| `EmbeddingOp` | `("embeddings",)` | |
| `RerankOp` | `("reranks",)` | |
| `VectorSearchOp` | `("ids", "scores")` | |
| `DocFetchOp` | `("rows",)` | |
| `GraphOp`, `FuncOp`, `EmitOp`, `InterruptOp` | `()` → auto | |

Tests: `tests/internal/core/ops/transform/test_func_op.py` (decorator,
call site, precedence, tuple normalisation, bad key raises at build),
`tests/internal/core/ops/graph/` (call-site `show` on a graph, member
validation), one test per provider default, `serialize()` carries it.
CHANGELOG under Unreleased; ships as 1.6.0 through `/publish`. The
callbot pins operonx from PyPI, so the publish precedes phase 4.

## 3. IR contract (extractor)

`operonx_project/extract.py::_node` adds, for every node:

```json
"show": ["transcript"],
"show_origin": "declared" | "kind" | "auto"
```

- `declared`: the op instance carries a non-empty `show` that differs
  from its class default.
- `kind`: equals the class default.
- `auto`: nothing declared; `_subgraph` fills it with §4 after all
  nodes of the graph are built, because the heuristic needs the whole
  graph.

Read through `_slot(op, "show", ())`, so a project on operonx 1.5.0
extracts as before with every node `auto`. Doors (`serve_role`) get
`show = []`: a door has nothing to say.

`operonx_studio/app.py` adds `"show", "show_origin"` to the node
projection tuple.

## 4. Auto heuristic

Inputs: this op's inputs and outputs, every op's outputs in the same
graph, every ref binding in the graph.

1. Candidates = outputs, minus keys that are also this op's input
   names (pass-through), minus keys starting with `_`
   (`__branch_target__`).
2. Rank by: how many ops in the graph output that key (fewer first),
   then how many refs consume it from this op (more first), then
   `required`, then name.
3. Take the first one. Auto never picks two.
4. No candidate left: the rarest output regardless of the filter;
   still none: `[]`.

Known misses on the callbot flow are listed in §0; they are the reason
`show_origin` is visible, so the author sees where to declare.

Tests in `tests/project/test_extract.py`: a fixture graph where the
rarity rule, the pass-through rule and the consumer tie-break each
decide one op; `declared`/`kind`/`auto` origins; a door has none.

## 5. The card, flow view

Semantic zoom keeps its three levels. What each level prints:

| level | scale | card |
|---|---|---|
| lo | ≤ 0.45 | name |
| mid | 0.45–0.85 | name, kind chips |
| hi | ≥ 0.85 | name, chips, **role line**, **show line**, hidden-input tag |

- **Role line**: the description's first clause, cut at 64 characters
  on a word boundary, muted. Ops without a description skip it.
- **Show line**: `→ transcript`, at most two keys, in the output
  colour. Auto keys render lighter with the tooltip "auto-picked:
  declare show= to override".
- **Hidden-input tag**: `⌂ vad_pool, clock` for inputs bound to
  `SCRATCH` and the resource name for ops with one. These are the
  inputs the wires cannot show. Refs and literals are not listed.
- The port list (`← a, b, c +4` / `→ x, y, z +2`) goes away. The
  inspector keeps the full ports section.
- Decision cards are unchanged: their rows already are their content.
- Doors are unchanged.

The row-parting pass already reflows heights per zoom level, so a
taller hi-zoom card needs no layout work.

## 6. The card, painted run

When a run is painted (`state.run`), the hi-zoom lines fill with the
run:

- Role line stays.
- Show line becomes `transcript = "alo em nghe ạ"`: the **last**
  execution's value of each show key, one line each, formatted by a
  new pure function `brief(spec)` over `values.js::spec()`:
  strings cut at 40 characters, numbers and booleans as is, media as
  `media · 38 KB` (size when the marker has one), arrays as `[12]`,
  dicts as `{intent, error}` (first three keys), null as `∅`.
- The badge stays `12× 340ms · 2✗`. Generators show `⚡ 12 yields`.
- Decision cards show a count on each condition row: `kind == 'audio'
  ·· 31` and `else ·· 4`; the row that fired last is lit.
- Errors first: an op whose last execution failed prints the error's
  first 40 characters in red in place of the show line.

Mid and lo zoom keep the badge only, as today.

## 7. Server: values for the canvas

`_flow_records` (app.py) stays light but grows two per-op fields:

- `last`: the last record's outputs restricted to values a card can
  print: scalars, strings cut at 200 characters, media markers, and
  for lists and dicts only `{"$len": n}` / `{"$keys": [...]}`. Never
  a full payload. Which keys to keep is decided client-side from
  `show`; the server keeps every printable key of the last record so
  the inspector can show them too.
- `targets`: for records whose outputs carry `__branch_target__`, a
  `{target: count}` map plus `last_target`.

Langfuse records go through the same function. Tests in
`tests/studio/test_app.py`: last values bounded, media marker kept,
list collapsed to `$len`, route counts.

## 8. Inspector

Ports section lists show keys first, each with a ★ and its origin
(`declared`, `kind default`, `auto`). Nothing else changes.

## 9. Callbot project (phase 4)

Bump `operonx[standard]>=1.6.0`. Declare where auto is wrong or where
two keys tell the story:

| op | show |
|---|---|
| `audio_in` | door, none |
| `detect_speech` | `speech_audio` |
| `bot_prompts` | `preset_text` |
| `frames` | `kind`, `preset_text` |
| `transcribe` (GraphOp, call site) | `transcript` |
| `noise_filter` (`DenoiseClassifier`) | `is_speech`, `speech_prob` |
| `transcript` | `text` |
| `say_greeting` | `greeting_text` |
| `speech_gate` | `gate` |
| `agent_turn` (GraphOp, call site) | `response`, `intent` |
| `commit_turn` | `intent`, `new_state` |
| `choose_reply` | `text` |
| `synthesize` (`TTSOp`) | `sub_text`, `audio` |
| `play` | `played`, `interrupted` |
| `finish_call` | `ended` |
| `store_record` | `stored` |
| `heartbeat`, `loop_lag` | auto is right |
| inside `agent_turn`: `llm_classify` | kind default gives `intent` |
| inside `agent_turn`: `next_state` | `new_state` |

Custom classes set `show_default`: `STTOp ("transcript",)`,
`TTSOp ("sub_text", "audio")`, `DenoiseClassifier ("is_speech",)`.
Declarations live at the op, next to the Vietnamese docstring, so the
card's two lines come from one place.

## 10. Phases and gates

| phase | repo | work | gate |
|---|---|---|---|
| 1 | operonx | §2 keyword, defaults, validation, tests, CHANGELOG | `uv run pytest tests/ -m "not integration"` green; `/publish` 1.6.0 |
| 2 | studio | §3 extractor, §4 heuristic, §7 server, projection tuple, tests | `pytest tests/` and `node --test tests/js` green; callbot IR on 1.5.0 extracts with every node `auto` |
| 3 | studio | §5 card, §6 painted card, §8 inspector, `brief()` + js test, CSS | headless screenshots of `transcript`, `synthesize`, `is_audio` at hi zoom, flow and painted; row parting holds |
| 4 | callbot | bump, §9 declarations, IR check | suite green, oracles identical, studio shows `declared` on every op in §9 |

Phase 1 edits operonx core and starts only on explicit approval. Phase
2 lands independently of phase 1 (the extractor tolerates a missing
attribute), so the studio can ship auto keys first.

## 11. Compatibility and risks

- Projects on operonx ≤ 1.5.0: every node `auto`; nothing breaks.
- `show` becomes a reserved keyword for `@op` functions; the decorator
  already warns on collisions. No callbot op has that parameter.
- The heuristic is wrong about half the time on a real flow; it is
  labelled `auto` on the card and in the inspector so nobody trusts
  it silently.
- `last` values on the flow endpoint are bounded per key (200 chars,
  no payloads); a run with thousands of ops still returns one small
  object per op.

## 12. Status log

- 2026-09-20: plan written. Facts it rests on: `@op` accepts a fixed
  keyword set and `split_shorthand_kwargs` routes only
  `_BASE_INIT_KEYS` to the constructor; `_describe` precedent for an
  attribute riding the IR; trace records store outputs as native
  values with `{"$media_ref": ...}` markers; `values.js::spec()` is
  pure and node-tested; heuristic measured on the callbot IR
  (scratchpad run, 24 ops).
