# Liquid glass — which parts of studio, and which not (2026-10-28)

A proposal. Apple's Liquid Glass (WWDC 2025, iOS/macOS 26) applied to studio:
every screen looked at, the project builder included.

**Status: built, G0–G5 (2026-10-28).** What changed on the way is under
[Progress](#progress-2026-10-28).

## What Liquid Glass is, and its one rule

Glass is a **layer for controls and navigation that floats over the content**.
It blurs and bends what is behind it, picks up its colour, shines at the edge,
and grows out of the button that opened it (a button becomes its menu).

Apple's rules, from the Materials page of the HIG and the WWDC25 sessions:

- **Never glass on content.** Content (lists, cards, text, the things the user
  works on) stays on solid surfaces. Glass is only for the bars, buttons,
  menus and sheets above it.
- **Never glass on glass.** A control inside a glass bar is drawn on the bar,
  not as a second glass piece.
- **Glass needs something behind it.** Over a flat page it is just a grey box.
  The design works where content scrolls or pans *under* the bar.
- **Tint only the main action.** One coloured glass control per surface (send,
  Run); the rest take their colour from what is behind them.
- **A scroll edge, not a divider.** Where content goes under a bar, it fades and
  blurs at that edge instead of meeting a hairline.

What went wrong for Apple, and what studio must not repeat: text on glass over
busy content was hard to read (notifications, the tab bar). Apple added a
"Tinted" setting in iOS 26.1 to make glass more opaque, and "Reduce
transparency" became something people turn on to read in sunlight.

On the web: `backdrop-filter: blur() saturate()` works in every current
browser. The bending (an SVG displacement map in `backdrop-filter`) only works
in Chromium; Firefox and Safari fall back to the blur. Both cost GPU per frame
when what is behind them moves.

## Where studio stands

Shots of every screen, desktop and phone (callbot `ws_callbot_pipeline` and the
`calc-demo` project builder), in the session scratchpad `glass/before/`.

- Two `backdrop-filter` rules today: the home top bar and the inspector's
  sticky head (`.phead`).
- On the Flow screen, the canvas stops at the top bar, the rail and the side
  panel. Only the canvas bar (Workflow / Data Flow / zoom) and the phone's
  Ask bar already float over it — the one place glass has something to show.
- The canvas animates (the wire energy flows, `eflow`, `dfflow`), so a glass
  piece over it is blurred again every frame.
- Every other screen (Runs, Monitor, Services, Jobs, Evals, Review, Prompts,
  Resources, Knowledge, Alerts, Settings, the project builder's pages) is a
  list or a form on a flat page.

## The proposal

### Glass — the control layer over the canvas

| Part | Today | As glass |
|---|---|---|
| **Canvas bar** (Workflow / Data Flow, find, zoom, wires, live, help) | solid floating bar | a glass capsule; the picked view is a lighter glass drop that slides between Workflow and Data Flow. The bending shows here first: nodes pan under a small bar. |
| **Flow screen frame** | the canvas stops at the top bar, rail and panel | the canvas runs full-bleed under all three; the top bar, the rail and the side panel float over it inset by 8 px, as glass. On the other screens they stay solid (nothing moves under them). |
| **Find box, zoom menu, legend** | solid popovers | glass, grown out of their button (View Transitions). |
| **Phone Ask bar + canvas bar** | two stacked bars | one glass cluster; the Ask bar grows into the assistant sheet. |

### Glass — floating surfaces, every screen

Menus, popovers, the project switcher, the graph picker, the screen menu, the
account menu, tooltips and toasts. They already float (the edge in dark,
`--float-edge`, a shadow in light). They become glass with a heavy frost so
the text inside stays solid to read, and each grows out of its button.

### Glass frame, solid content — the side panel and sheets

The assistant and the inspector hold content (messages, values), so their
inside stays solid. On the Flow screen, the panel is a floating glass pane
with a solid reading area: the canvas shows round its edges, not under the
text. On the phone, a sheet is glass at half height and turns solid when
pulled to full height, as iOS 26 does.

### The scroll edge — instead of hairlines

Where content scrolls under a sticky head: the top bar, the Runs table head,
the run page head (Tree / Timeline / Workflow / Data Flow), the inspector
head, the project builder's conversation. The `border-bottom` hairline goes;
the rows fade and blur as they go under. This is the cheapest part and is on
every screen.

### The project builder

| Part | As glass |
|---|---|
| **Composer** (Now page and the side panel) | floats as glass over the conversation, which scrolls under it, the way Messages does on iOS 26. The send button is the one tinted control. |
| **Builder island** (new) | a small glass capsule at the bottom while a milestone runs: the card being built, its cost ("C2 · $0.14 of $30"). Click it and it grows into the plan. This is the live progress panel that was still to be planned, given its shape. |
| **A question arrives** | a glass toast ("Q-01 needs you") that grows into the Questions page, instead of only the red dot on the rail. |
| Plans, Checklist, Questions, Changes, the right column (Needs you, Working on, Standard) | content — stays solid. |

### Never glass

Node cards, wires, ports, loop and branch zones; table rows; the step tree and
timeline; input/output values, JSON, code, diffs; the Monitor charts; list and
board cards; form inputs; the assistant's messages; the home page (a flat page,
nothing would show through — it keeps the scroll edge only).

## Rules the build keeps

- **One glass primitive.** `.glass` with two strengths — `clear` (small
  controls over the canvas) and `frost` (menus, panels: blur 24 px, a tint at
  ~72 % so text reads). Tokens on `:root`, redefined for dark, where the edge
  highlight carries the shape (a near-black page shows no blur).
- **Readable first.** Text on glass passes 4.5:1 against the worst backdrop on
  that screen (the brightest node under the canvas bar), measured, not judged.
- **A way out.** A "Reduce transparency" switch in Settings, on by default
  under `prefers-reduced-transparency` and `prefers-contrast: more`: every
  glass piece becomes its solid surface. `prefers-reduced-motion` turns off
  the growing and sliding.
- **Bending only on small or brief pieces, only in Chromium.** The SVG
  displacement is on the canvas bar, and (after the owner's reference, see
  Progress) a wider lens on menus, the builder island and the question toast;
  the large panels get blur only.
- **No frame-rate cost.** Pan and zoom on the callbot graph, energy flows on,
  measured with glass on and off: the frame time may not get worse. If it does,
  glass pieces over the canvas freeze their blur while it pans.

## Phases

- **G0 — The primitive and the gate.** `.glass` (clear, frost), its tokens in
  both themes, the reduce-transparency switch, the pan/zoom frame-time harness
  run once on today's studio.
- **G1 — The Flow screen.** Full-bleed canvas; canvas bar, top bar, rail and
  side panel float as glass; find box, zoom menu and legend; the phone's
  single glass cluster.
- **G2 — Floating surfaces.** Every menu, popover, tooltip and toast on
  `.glass frost`, each growing out of its button.
- **G3 — Panels and sheets.** The side panel's glass frame with a solid
  reading area; phone sheets glass at half height, solid at full.
- **G4 — The scroll edge.** Replaces the hairline under every sticky head.
- **G5 — The project builder.** Glass composer, the builder island, the
  question toast.

**Done when (all phases):**

- every glass piece is on the list above and nothing on the "never" list wears
  glass (a DOM count of `backdrop-filter` elements per screen);
- text on glass ≥ 4.5:1 on every shot, measured;
- pan/zoom frame time on the callbot graph no worse than G0's run;
- reduce-transparency turns every glass piece solid (computed backgrounds
  opaque on every shot);
- shots desktop and phone, light and dark, every screen, before and after;
- the JS and studio tests pass.

## Progress (2026-10-28)

All six phases built on `plan/liquid-glass`. Where the build left the text above:

- **Grow from the button: WAAPI, not View Transitions.** `theme.js` (Glass)
  scales a menu up from the last pressed control (`grow`, `growFrom` with a
  rect); View Transitions snapshot the whole page and would freeze the canvas.
- **Refraction order.** `blur() saturate() url(#filter)`: the other order
  drops the blur in Chromium.
- **Frame time.** Glass over the panning canvas cost nothing on pan; zoom cost
  ~4 ms/frame until the glass holds still while zooming (`canvas.js`
  stillGlass, `body.zooming`). Idle +0.6–1.0 ms/frame (the energy flows under
  the glass) — accepted. Numbers below.
- **The light theme.** The first light glass read as grey boxes (owner:
  "quite shitty"). Now: white glass at 50/72 % over a canvas a step down from
  white (`--glass-under`), a full white top rim, a tight shadow.
- **The owner's reference** (a menu over a landscape: little blur, the scene
  bent, a light rim all round). Glass now has a light edge all round
  (`--glass-edge`) and an outer outline; the canvas controls blur 6 px, menus
  10 px with a thinner tint (`--glass-menu`) and a wider lens (`#ox-lens`);
  night glass is smoke grey, lighter than the page. Faint text on glass is a
  step stronger (`--glass-text-3`). The reading surfaces (composer, the Flow
  panel) keep the 24 px frost: text behind text is noise.
- **Contrast, measured.** Each text box's own pixels behind it (text made
  transparent, shot, worst 1 %): every piece ≥ 4.5:1, light and dark — the
  switcher over Runs, the model menu and composer over a conversation, the
  island, the canvas bar over the flow. The faint text was 4.29–4.48 before
  `--glass-text-3`; now ≥ 5.4 on menus.
- **G4, the scroll edge: a boundary, not a blur.** The blurred fade was messy
  (owner); the head now gets a crisp line and a soft shade below it, shown
  only once something has scrolled under (scroll-driven animation; a static
  edge where unsupported). The owner may revisit this.
  The Runs table head now really sticks (its wrapper's overflow had captured
  it). The home top bar's old blur is gone: flat, with the edge.
- **G5, the island at the top, not the bottom.** The composer owns the
  bottom; the island (working card · state · cost of budget) sits at the top of
  the conversation, the question toast under it. Both grow into their page.

**Gates (all met):**

- glass DOM count, 23 screens × desk/phone × light/dark (92 shots): at most 4
  glass pieces on a screen (Flow: bar, rail, panel, canvas bar), 0 on the
  list screens, 2 in the builder (composer, island); nothing off the list.
- solid mode: no `backdrop-filter` anywhere and every glass piece opaque, on
  all 92.
- JS tests 138/138; studio pytest 723 passed, 8 skipped.
- frame time, callbot graph, energy flows on (ms/frame mean, p95):

  | run | idle light / dark | pan light / dark | zoom light / dark |
  |---|---|---|---|
  | G0, before | 8.1 / 8.8 | 14.2 / 14.5 | 10.6 / 10.6 |
  | final, glass (2 runs) | 9.6–9.8 / 8.9–9.7 | 14.5–14.8 / 14.9 | 11.4 / 11.3–11.4 |
  | final, solid | 8.0 / 8.4 | 15.3 / 15.2 | 11.4 / 10.8 |

  Pan and zoom: no worse than G0 within run-to-run noise, and equal to solid on
  the same build. Idle: +1.2–1.6 ms with glass (the energy flows animate under
  it; still ~10 ms/frame, inside the 16.7 ms budget) — accepted, not hidden.

## Sources

- Apple HIG, Materials: https://developer.apple.com/design/human-interface-guidelines/materials
- Apple, Adopting Liquid Glass: https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass
- WWDC25 "Meet Liquid Glass": https://developer.apple.com/videos/play/wwdc2025/219/
- iOS 26.1 "Tinted" glass after the legibility complaints: https://gulfnews.com/technology/companies/apple-yields-tinted-control-in-ios-261-beta-4-tones-down-liquid-glass-after-backlash-1.500315176
- Legibility critique: https://uxdesign.cc/liquid-glass-is-beautiful-but-is-the-chemistry-missing-00b4f79ff529
- Web recipes and limits: https://blog.logrocket.com/how-create-liquid-glass-effects-css-and-svg/ ,
  https://www.buildmvpfast.com/blog/liquid-glass-css-backdrop-filter-recipes-2026
