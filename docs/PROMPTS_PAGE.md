# The Prompts page — named prompts

Part P3 of the engine's `docs/PROMPTS_PLAN.md` (operonx ≥ 1.40.0).

## Result

A project keeps each prompt as a file, `prompts/<name>.md`, and code asks for
it by name: `prompt("chat.system")`. The page now shows those files, not only
what a run happened to record.

| Before | After |
|---|---|
| The list held LLM ops only; a prompt was whatever the last run sent | A **Prompts** section lists every `prompts/*.md` with the version `production` points at |
| No way to see what changed between two wordings | Versions, newest first, and a diff between any two (or against the working text) |
| A prompt was edited in the source file | Save the working text, **Publish as vN**, **Serve as production** — from the page |
| A sample said when it ran | A sample also says which version answered: `chat.system v1` |

![a named prompt](img/prompts/named.png)

An op whose part was asked for by name shows a link to the prompt instead of a
copy of its text:

![an op that uses a named prompt](img/prompts/op.png)

## How it flows

```mermaid
flowchart LR
  F[prompts/chat.system.md] -->|"prompt('chat.system')"| O[LLM op]
  O -->|"attrs.prompts = name, version, label, hash"| R[run row]
  F --> P[Prompts page]
  R -->|"which version answered"| P
  P -->|save| F
  P -->|publish| V[prompts/.versions/chat.system/N.md]
  P -->|serve as production| L[prompts/labels.toml]
```

A label is read when a service starts, so a moved label is served after the
next restart; the page says so under the versions.

## Code

- `operonx_studio_toolkit/extract.py` — a node carries the `prompts` its op declared.
- `operonx_studio/app.py` — `GET /api/p/{pid}/prompts`, `…/prompts/text`,
  `…/prompts/diff`; `POST …/prompts/write` (refuses a stale base with 409),
  `…/prompts/publish`, `…/prompts/label`. A sample carries its run's `prompts`.
- `operonx_studio/access.py` — the three reads are open to readers, the three writes to editors.
- `operonx_studio/static/prompts.js` — the Prompts section, the named-prompt view, the link from an op.
- `tests/studio/test_prompts.py` — a prompt's life (write, publish, label, diff) and a sample naming its prompt.
