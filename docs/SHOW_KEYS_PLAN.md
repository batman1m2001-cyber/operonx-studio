# Show keys: the outputs a card prints when zoomed in

Status: plan, 2026-09-20.

## The mechanism

An op has one or two show keys. First hit wins:

1. **Declared** by the author:
   ```python
   @op(show="text")                                  # on the function
   transcribe(speech_audio=..., show="transcript")   # at the call site, graphs too
   ```
2. **Kind default**: a class attribute `show_default` on the op class.
   Built-ins: `LLMOp` → the extracted field keys when `fields=[...]`,
   else `content`; `BranchOp` → `target`; `EmbeddingOp` →
   `embeddings`; `RerankOp` → `reranks`; `VectorSearchOp` → `ids`,
   `scores`; `DocFetchOp` → `rows`. A project's own classes set theirs
   (`STTOp` → `transcript`, `TTSOp` → `sub_text`, `audio`,
   `DenoiseClassifier` → `is_speech`).
3. **Auto**, computed by the extractor from the graph: candidates are
   the op's outputs minus keys that are also its inputs (pass-through)
   minus `_`-prefixed keys; ranked by how many ops in the graph output
   that key (fewer first), then how many refs consume it from this op
   (more first). Take one. Measured on the callbot flow this is right
   about half the time, which is what tiers 1 and 2 are for.

## The changes

1. **operonx core** — `show=None` on `BaseOp.__init__`, stored as a
   tuple, falling back to `type(self).show_default` (class attribute,
   default `()`); `show` in the `@op` decorator; `"show"` in
   `_BASE_INIT_KEYS`; `show_default` on the six built-in classes
   above. No build validation, no serialize change. Tests: decorator,
   call site, precedence, LLMOp with and without fields. CHANGELOG,
   ships as 1.6.0.
2. **Extractor** — `node["show"]` = declared or kind default via
   `_slot(op, "show", ())`, else the auto pick, filled per graph in
   `_subgraph`. `"show"` joins the app's projection tuple. A 1.5.0
   project gets auto everywhere. Doors get none. Tests: precedence and
   the three auto rules on a fixture graph.
3. **Card, hi zoom** — the `← inputs / → outputs` lines become one
   line `→ text`. Painted run: the same line shows the last
   execution's value per key, formatted by `values.js`, cut at 40
   chars, media as a size token. The flow payload carries `last` per
   op, bounded to printable scalars and markers. One js test for the
   one-line formatter.
4. **Callbot** — bump to 1.6.0, set `show_default` on the three custom
   classes, declare `show` on the ops where auto is wrong
   (`detect_speech`, `transcribe`, `choose_reply`, `commit_turn`,
   `frames`, `bot_prompts`, `agent_turn`, `speech_gate`, `play`).

Out: origin labels, build-time validation, route fire counts,
inspector marks, role line.
