# UI Refactor Plan — the studio's second pass

Status: **for review** — nothing here is implemented.
Scope: `operonx_studio/static/*` (+ small, additive extraction fields).
Non-goals: no framework, no CDN, no drag-and-drop editing (agent chat is
the future editor), no light theme. Everything stays vanilla and offline.

---

## Why a second pass

The first pass made the studio *truthful* — wraps, containers, doors,
loops, recorded values. It did not make it *efficient to read*. An honest
audit of what exists today:

| # | Flaw | Where |
|---|------|-------|
| 1 | Every value is a pretty-printed JSON `<pre>` — a 5-key dict eats 8 lines; a callbot frame eats a screen | inspector values, executions |
| 2 | Side panel is fixed 340px, unresizable; code and prompts are read through a letterbox | `#inspector` |
| 3 | One generic card for every op type; only FuncOp (code) and LLMOp (prompt) have any specific treatment | inspector |
| 4 | **Branch routes are invisible.** `route_1` fans into `asr` and `skip_stt` on `condition` edges and nothing says which condition goes where — extraction doesn't even carry it | canvas + extraction |
| 5 | Executions history: every record is a `<details>` with two full JSON dumps — 50 records ≈ 3000 lines of DOM | inspector |
| 6 | Node cards: 210×76px with 2 short text lines and wrapping badges — low info density, and at fit-zoom the badges are noise | canvas |
| 7 | No way to find a node but eyeballing; no keyboard navigation; selecting doesn't scroll the panel to top | canvas/inspector |
| 8 | Trace runs table shows name/date/KB — nothing about what happened in the run (turns? errors? duration?) | traces tab |
| 9 | No copy button anywhere — values leave the studio by manual selection | inspector |
| 10 | Edge glyphs (`≋`, `∥`, `⧉`, labels) overlap each other on dense rows | canvas |

Design principles for the fix, in priority order:

1. **Answer first.** The one thing the click was for (a value, a route,
   a duration) renders first, large, and complete-enough.
2. **Density is respect.** A line of panel space carries a fact or it
   goes. JSON dumps, repeated headers and blank padding all pay rent.
3. **Type-aware, not type-themed.** Each op kind gets the *layout* its
   information wants, not just a colored strip.
4. **Progressive disclosure.** Everything is reachable in one click;
   almost nothing is unfolded by default.

---

## A. Panel framework

- **Resizable width.** 4px drag handle on the panel's left edge;
  pointer-drag resizes 280–720px; double-click resets to 360. Width
  persists in `localStorage` per browser. Cursor `col-resize`, body gets
  `user-select:none` during drag.
- **Sticky header.** Node name + chips stay pinned while the body
  scrolls; selecting a node always scrolls the body to top.
- **Section rhythm.** One 10px-caps section title style, 8px vertical
  rhythm, no `<section>` margins beyond it. Target: the common case
  (FuncOp with a painted run) fits in one panel height without scrolling.
- **Copy affordance.** Every value block and code block gets a hover
  `⧉ copy` button (clipboard API; falls back to select-on-click).

## B. The value renderer (kills flaw #1, #5 — the biggest win)

One `renderValue(v)` used everywhere a recorded value appears
(latest values, execution rows, future places). Rules:

- `null/bool/number` → inline token, colored by type.
- string ≤ 100 chars → inline, quoted, amber; longer → 2-line clamp
  with `▸ 1.2 KB` expander; full text on expand, scrollable at 240px max.
- array → `[12]` collapsed count; expand shows items one per line,
  first 3 shown inline when all scalars (`[1, 2, 3, …+9]`).
- object → devtools-style tree: `{5}` collapsed; expanded rows are
  `key: value` at 12px mono with indent guides; nested collapse per node.
- **Domain tokens styled, not dumped**: `{"$media": …}` → `▮ media (23 KB, wav)`;
  `{"$unserializable": "Event"}` → `⊘ Event`; base64/audio-looking
  strings ≥ 1 KB → `▮ 34 KB payload` with expander.
- Keys the op declares (its outputs list) sort first inside objects.

Executions history becomes a **dense table**: `# · member · ms · status`
one line each, duration bar inline (max-scaled), error rows red. Click a
row → the value renderer for that record in a detail area *below the
table* (one open at a time, not 50 accordions). The latest record is
pre-selected.

## C. Type-specific inspector cards

Common header for all: name, chip row (kind/bound/⚡/⛁/↺), role note.
Then per kind:

| Kind | Primary block (top) | Secondary (folded) |
|------|--------------------|--------------------|
| **FuncOp** | run values (B); signature line `(item, qty=3) → line` derived from inputs/outputs | Code (syntax-tinted, see below), wiring |
| **LLMOp** | run values: rendered **conversation** when the traced input has `messages`/prompt — role-labelled bubbles, response emphasized | Prompt templates (system/user), param chips, wiring |
| **BranchOp / if_** | **route table**: condition text → target node (click target = select it); painted run shows which route actually fired and how often | wiring |
| **GraphOp** | op list of members (name+kind, click = select inside), open/close button; painted run shows per-member ms/err mini-table | wiring |
| **EmbeddingOp / RerankOp / SearchOp / FetchOp** | resource card (key, model/backend from resources extract), run values | params, wiring |
| **EmitOp / InterruptOp** | channel / payload+timeout summary | wiring |
| **ingress / egress doors** | role note + traffic count from run (`214 items in`) | code (custom doors), wiring |

Code block: keep ≤8KB source, add a ~40-line hand-rolled Python
tokenizer (keywords/strings/comments/decorators — 4 colors, no CDN),
line numbers, `file:line` header, copy button. Default collapsed.

### C-requires: two additive extraction fields

1. **Branch routes** (fixes #4): `_node` on a BranchOp emits
   `routes: [{label, condition, target}]` — condition as source text,
   recovered from the op's stored predicates (`_slot` inspection;
   fallback: the `wired_at` line's source text). Edges from a branch
   carry `route: label` so the canvas can label them too.
2. **Signature**: FuncOp param defaults already live in `inputs`;
   nothing new needed — the signature line is derived client-side.

Both additive; IR consumers that ignore them are unaffected.

## D. Canvas polish

- **Cards, denser** (#6): 190×64px; kind as a 14px icon glyph
  (ƒ ✦ ⑃ ▣ ⚡ ⛁) left of the name instead of a text line; the
  `FuncOp · sync` line is demoted to a tooltip. Badges reduce to at most
  two: run stats chip (`4× 53ms`, red when erring) and one semantic
  badge (↺ / ▣ / ⚡). Everything else lives in the inspector.
- **Branch edges labelled** (#4): condition edges get their `route`
  label (`score ≥ 90`, `else`) in a small pill at the edge midpoint;
  pills claim slots so they never overlap the stream glyphs (#10 — one
  glyph lane above the edge, one label lane below).
- **Heat painting**: with a run painted, node border tint scales with
  avg ms (muted → amber), errors stay red. The eye finds the slow op
  without reading numbers.
- **Find** (#7): `Ctrl+K` / `/` opens a name filter; typing dims
  non-matches, Enter selects + centers the first match. Esc clears.
- **Selection affordances**: selected node's upstream/downstream edges
  already highlight; add dimming of unrelated nodes at ≥15-node graphs.

## E. Traces tab

- Run rows gain a cached summary chip set: total wall time, op count,
  error count (server keeps a tiny `<run>.summary.json` sidecar computed
  on first request, mtime-invalidated — no re-scan per listing).
- Newest-run auto-follow toggle: "paint latest" pin that repaints when a
  new run directory appears (the poll already notices).
- Langfuse rows show the trace name + host chip, same summary once
  fetched.

## F. Small infra

- Panel width + last tab + follow-pin in `localStorage` (per artifact
  conventions: wrapped in try/catch, absence-tolerant).
- Inspector render split into `views/` functions per kind — `studio.js`
  is 969 lines and will pass 1200 with this; split into `canvas.js`,
  `inspector.js`, `values.js`, `traces.js` (still plain scripts,
  concatenation-ordered in the HTML, no bundler).
- Tests: value-renderer unit tests run under `node --test` (pure
  functions, no DOM — renderer returns a spec tree, DOM assembly is a
  thin layer); route extraction + summary sidecar get pytest coverage.

---

## Phasing (each phase ships alone)

| Phase | Content | Est. effort |
|-------|---------|-------------|
| **P1** | A (resize/sticky/copy) + B (value renderer + executions table) | the big feel-change; ~1 session |
| **P2** | C (type cards) + extraction routes + D branch labels | needs the extraction field first |
| **P3** | D rest (heat, find, density) + E (trace summaries, follow) + F split | polish, parallelizable |

Decisions I've made (flagging, not asking): hand-rolled syntax tinting
over a CDN highlighter (offline rule); executions as table+detail over
virtualized accordions (simpler, fits sizes we actually have); no
minimap (Fit + find cover the need at ≤60 nodes; revisit if graphs grow).

**The one decision that is yours:** P2's route labels need me to read
`if_`'s stored predicates in extraction — that is reading operonx
internals (not changing them). If those internals don't expose condition
source cleanly, the fallback is showing the `wired_at` source line
verbatim. Fine either way, or would you rather expose route metadata
properly in operonx core (a small upstream addition) and have the studio
read a stable field?
