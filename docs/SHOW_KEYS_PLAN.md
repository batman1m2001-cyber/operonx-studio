# Show keys: the outputs a card prints when zoomed in

Status: plan, 2026-09-20. Minimal version.

## The mechanism

An op may name the outputs that stand for it:

```python
@op(show="text")                      # on the function
def transcript(...): ...

transcribe(speech_audio=..., show="transcript")   # or at the call site (works for graphs too)
synthesize = TTSOp.of(..., show=["sub_text", "audio"])
```

No `show`: the card falls back to the op's outputs minus the ones that
are also its inputs (pass-through plumbing), first two, in schema
order. That is the whole rule.

## The four changes

1. **operonx core** — `show=None` on `BaseOp.__init__` stored as a
   tuple, `show` in the `@op` decorator, `"show"` in `_BASE_INIT_KEYS`.
   No validation, no class defaults, no serialize change. One test.
2. **Extractor** — `node["show"] = list(_slot(op, "show", ()) or [])`,
   plus `"show"` in the app's projection tuple. Works on 1.5.0 projects
   (empty list).
3. **Card, hi zoom** — the `← inputs / → outputs` lines become one line
   `→ text` from `show` or the fallback. Painted run: same line shows
   the last execution's value, formatted by `values.js` and cut at 40
   chars (media as a size token). Server adds `last` per op to the flow
   payload, bounded to printable scalars and markers.
4. **Callbot** — declare `show` on the ~12 ops where the fallback is
   wrong, after operonx ships the keyword.

Everything else from the first draft (origins, kind defaults, build
validation, route counts, inspector marks, role line) is out.
