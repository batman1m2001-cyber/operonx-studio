# UX Refactor Plan — the studio as a normal user meets it

Written 2026-09-09, after re-reading the whole UI surface (studio.js,
chat.js, values.js, studio.css, home/login/project pages) and walking
every journey as someone who has NEVER read our code or our design
notes. The first plan (UI_REFACTOR_PLAN.md) made the studio look right;
this one is about **whether a stranger can drive it**.

The test persona: an engineer opening the studio for the first time
over the tunnel. They know operonx a little. They know none of our
conventions. Every item below is a place that persona stumbled.

Legend: **S/M/L** effort · journeys ordered by how often they happen.

---

## P1 — Orientation: the UI explains itself (do first)

The visual language is rich — beams, dashes, amber conditions, glyphs
(⚡ ≋ ∥ ⧉ ↺), heat tint, boutons — and completely undocumented on
screen. A normal user sees a beautiful picture and cannot read it.

1. **Legend popover** (S). A `?` button in the toolbar opening a small
   card: one sample of each edge voice with its meaning, the glyph
   table, the heat gradient, badge meanings. Static HTML, one evening,
   removes the single biggest "what am I looking at".
2. **Keyboard cheat-sheet in the same popover** (S). `/` find, space
   drag, 0 fit, 1 = 100%, +/-, Esc. Today these live in a `title`
   tooltip on the zoom control that nobody hovers.
3. **Condition text discoverability** (S). The if/else condition is an
   SVG `<title>` on a 4px path — precise hover, OS-delayed, invisible
   on touchpads. Add a small amber `?` glyph pill mid-edge (we already
   buffer glyphs); hover OR click it shows the condition; clicking the
   router node already shows the route table.
4. **Inspector close button** (S). There is literally no ✕ — the only
   way out is clicking empty canvas, which a user discovers by
   accident. Add ✕ in the sticky header; Esc closes it too.
5. **Find is invisible** (S). `/` and Ctrl+K exist but no UI hints at
   them. Add a 🔍 button next to Fit that opens the same find box.
6. **Friendlier extraction failure** (M). Today: a wall of raw
   traceback in a red box. Show the last line (the actual error) big,
   the traceback folded underneath, and a hint ("fix the import and
   save — the studio reloads itself").

## P2 — Run investigation: from "it ran" to "what happened" faster

Painting a run on the canvas is our best trick, but the moment after
painting is underpowered.

1. **Run summary strip** (M). The banner says only the run name. Add:
   total wall time, op count, error count — and when errors exist, a
   **"jump to error →"** button that centers + selects the first
   errored node (and cycles on repeat click). Hunting for the red node
   in a 60-op flow is today's workflow.
2. **Timestamps in executions** (S). Records carry `start_time`; the
   drill-down shows none of it. Add a relative time column ("2.1s into
   run") — correlating an error with "when" is half of debugging.
3. **Errors-only filter** (S). A run with 300 executions and 3 errors:
   one checkbox above the exec table.
4. **Trace timeline view** (L). The traces tab is only a run *list*;
   the only way to see inside a run is per-op via canvas clicks. Add a
   run detail: horizontal waterfall (op rows × time, bars colored by
   kind, errors red), click a bar → same values detail we already
   render. This is the classic trace view every APM user expects, and
   we already have every datum it needs.
5. **Refresh + housekeeping on the runs table** (S). A refresh button
   (today: switch tabs twice), and a per-row delete with confirm — old
   runs pile up forever.

## P3 — Big-flow navigation (callbot-sized graphs)

1. **Esc / arrow keys** (S). Esc deselects (and closes find/inspector);
   left/right walks to the selected node's neighbor along edges. Cheap,
   makes the canvas feel inhabited.
2. **Expand/collapse all** (S). One toolbar toggle; opening five
   GraphOps one by one to see a whole pipeline is ritual, not choice.
3. **Breadcrumb for nested selection** (S). Inspector header shows
   `asr › denoise › vad` instead of bare `vad` — users lose track of
   which container a member lives in.
4. **Minimap** (M). Bottom-left, 140px, extent rectangle + viewport
   box, click to jump. Optional until callbot lives here daily; then
   it's not.
5. **Selection without full re-render** (M, perf-feel). `select()`
   re-renders the whole canvas (visible blink on big graphs). Toggle
   classes on the two affected cards + edge classes instead; re-render
   only on structure change.

## P4 — Home: 17 projects is a list, not a launcher

1. **Cards carry signal** (M). Today: name + path. Add: op/graph count
   and health dot (extraction ok/broken — the IR cache already knows),
   last trace activity ("3 runs · newest 2h ago"). A broken project
   should look broken from here, not after a click.
2. **Filter-as-you-type** (S). One input, filters cards by name/path.
3. **Quick switcher on the project page** (S). Clicking the "studio"
   crumb to go home and re-click is the only way to switch projects.
   Make the project name in the top bar a dropdown of recents.
4. **"manifest missing" cards explain themselves** (S). Dead card,
   no cursor change, no hint. Say what happened ("operonx.toml is gone
   — moved? deleted?") and offer forget.

## P5 — Assistant: from chat window to copilot

1. **Context handoff** (M, highest leverage here). The agent gets the
   project briefing but not what the user is LOOKING at. Include with
   each message: selected node, expanded containers, painted run name,
   active tab. "why is this slow?" should not need the user to type
   the op name the studio already knows they clicked.
2. **Busy fab** (S). Close the panel mid-task and nothing shows a task
   is running; add a pulse/dot on ✦ while a turn is live.
3. **Panel resize/expand** (S). 400px is fine for chat, cramped for
   code blocks. Drag the left edge (we already did this for the
   inspector) + a ⤢ maximize toggle.
4. **Turn cost/model footer** (S). The done event carries cost; show
   it small and honest ("$0.34 · fable"). Users on quota deserve it.
5. **Copy button on bot messages** (S).

## P6 — Enablers (engineering, invisible, do alongside)

1. **Split studio.js** (M). 1630 lines: canvas.js (layout/edges/view),
   inspector.js, traces.js, find.js + shared state module. Was P3 of
   the old plan, still right, now blocking review speed.
2. **Kill phantom assets** (S). `_page()` rewrites home.css/home.js
   that don't exist; home page inlines its script (no fingerprint,
   no cache). Extract to real files, drop phantoms.
3. **tsc --checkJs in CI** (S). Already agreed as the middle path;
   catches the `store/recall` shape drift the split will invite.
4. **A tiny toast helper** (S). "applied ✓", "run painted", "copied"
   currently live in scattered inline spans or nowhere. One shared
   toast = consistent feedback for every action above.

---

## Suggested order

Week 1: all of P1 (six smalls, one medium) + P5.1 context handoff.
Week 2: P2.1–2.3 + P3.1–3.3 + P4.2/4.3 + P6.2/6.4.
Then: P2.4 timeline (the one Large), P4.1 cards, P3.4/3.5, P6.1/6.3.

Rationale: P1 changes what every session feels like on day one; the
context handoff makes the assistant we just wired actually feel wired;
run investigation is what this studio is *for*; everything else builds
on a user who can already read the screen.

## Explicitly out (and why)

- Dark mode — the gold theme is the identity; one look, done well.
- Mobile — it's an engineer's bench, not a phone app.
- Editing wiring from the canvas — code is edited as code (standing
  decision); the param edit + the assistant cover the rest.
- Run comparison / diffing — real value, but after the timeline view
  exists, not before.
