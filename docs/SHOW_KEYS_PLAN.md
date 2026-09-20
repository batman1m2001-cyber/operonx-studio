# Show keys: the outputs a card prints when zoomed in

Status: phases 1–3 done 2026-09-20; phase 4 waits for the operonx publish.
The keyword is `show_keys` (not `show_keys`): `GraphOp.show()` is the
existing debug printer, so the attribute name was taken.

## The mechanism

An op has one or two show keys. First hit wins:

1. **Declared** by the author:
   ```python
   @op(show_keys="text")                                  # on the function
   transcribe(speech_audio=..., show_keys="transcript")   # at the call site, graphs too
   ```
2. **Kind default**: a class attribute `show_keys_default` on the op class.
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

1. **operonx core** — `show_keys=None` on `BaseOp.__init__`, stored as a
   tuple, falling back to `type(self).show_default` (class attribute,
   default `()`); `show_keys` in the `@op` decorator; `"show_keys"` in
   `_BASE_INIT_KEYS`; `show_keys_default` on the six built-in classes
   above. No build validation, no serialize change. Tests: decorator,
   call site, precedence, LLMOp with and without fields. CHANGELOG,
   ships as 1.6.0.
2. **Extractor** — `node["show_keys"]` = declared or kind default via
   `_slot(op, "show", ())`, else the auto pick, filled per graph in
   `_subgraph`. `"show_keys"` joins the app's projection tuple. A 1.5.0
   project gets auto everywhere. Doors get none. Tests: precedence and
   the three auto rules on a fixture graph.
3. **Card, hi zoom** — the `← inputs / → outputs` lines become one
   line `→ text`. Painted run: the same line shows the last
   execution's value per key, formatted by `values.js`, cut at 40
   chars, media as a size token. The flow payload carries `last` per
   op, bounded to printable scalars and markers. One js test for the
   one-line formatter.
4. **Callbot** — bump to 1.6.0, set `show_keys_default` on the three custom
   classes, declare `show_keys` on the ops where auto is wrong
   (`detect_speech`, `transcribe`, `choose_reply`, `commit_turn`,
   `frames`, `bot_prompts`, `agent_turn`, `speech_gate`, `play`).

Out: origin labels, build-time validation, route fire counts,
inspector marks, role line.

## Status log

- 2026-09-20 — phase 1 on operonx branch `feat/show-keys` (fc5fd05):
  keyword, class defaults, tests (1830 passed), CHANGELOG under
  Unreleased. No version bump, no push: a version change on `main`
  auto-publishes, so the bump and merge are the owner's call.
- 2026-09-20 — phases 2 and 3 in this repo: extractor (declared or
  kind default, else the auto pick), IR cache prefix `ir6`, app
  projection, doors cleared, `last` outputs on the run summary
  (bounded), `Values.brief()`, the card's show line in flow and painted
  mode. Studio suite 370 passed, node tests 24. Verified on the
  callbot: every op auto-picked (its venv is still 1.5.0), `transcript
  → text`, `synthesize → audio = media · 18.0 KB` with a run painted.
- Phase 4 (callbot declarations) needs operonx ≥ 1.6.0 in the callbot
  venv: `show_keys=` on 1.5.0 lands in the input mapping and raises.
- 2026-09-20 — phase 4 done in the callbot working tree against a
  local 1.5.1 build (`uv pip install` of the branch): 14 ops declared,
  3 class defaults, suite 216 passed, IR verified. operonx bump commit
  d69c60e on `feat/show-keys`; push, PR and merge to `main` still to
  do (blocked for the agent by permission) — that publishes 1.5.1.
