# Chrome surfaces — one card, one divider (2026-10-12)

The open item of `STUDIO_EXPERIENCE_PLAN.md` §11: "`border:` under 60". Opened
again on the callbot with five fresh calls, every screen at desktop (1500 px)
and phone (390 px), light and dark, plus a DOM count of what is drawn.

## What was found

| Finding | Evidence |
|---|---|
| 207 drawn `border` declarations in `studio.css`. 45 are the Flow canvas's art (node cards, ports, the branch patch panel, dataflow cards, loop zones). That is its visual language, and it stays. The other 162 are chrome. | `borders.py` over the stylesheet. |
| Three card treatments for the same job. A tint card on the run page (`.rt-io`: `surface-2`, no edge). A shadow card in Resources (`.rh-cat`: `surface`, `sh-1`). A bordered card everywhere else (Monitor, Services, Playground, Review, Jobs, the exec panel's fold boxes). | Screenshots. |
| In dark, Resources' shadow cards disappear: a black shadow on a near-black page. | `dark_desk_resources.png`: the categories read as one list. |
| On screen, the chrome is already mostly calm. 188 four-sided boxes across 60 shots (about 3 a screen), 2 nested in another box (Monitor's table, inside its card). The 162 declarations are mostly components drawn rarely: the assistant, experiments, knowledge, team. | DOM count (`boxes.js`): every visible element with four drawn sides, outside the canvas and form controls. |
| Small labels wear an edge and a tint at once: `pchip`, `iochip`, `ax-chip`, `viewpill`, `callpill`, the run page's `.seg`. The newer `.pill` uses the tint alone. | CSS. |
| Inner blocks inside a card draw their own edge: code, JSON, a message, a tool call, a metric, a diff. | CSS. |

## The system

- **Card:** `surface-2` tint, `r-md`/`r-lg` radius, no edge, no shadow: the run page's card. It reads in both themes. A card on a tinted parent uses `surface` instead.
- **Inner block** (code, JSON, a message inside a card): one step off the card's tint (`surface` on a `surface-2` card), no edge.
- **Floating** (popover, menu, tooltip, dialog): unchanged. A shadow in light, the edge in dark (`--float-edge`), declared once.
- **Rows** in a list or table: a soft hairline between rows, declared once for every list.
- **Labels and chips:** tint only.
- **Kept, because they do a job:**
  - inputs, buttons and `kbd` (an edge says "you can type or press here");
  - the app frame (top bar, rail, side panel);
  - accent bars (an error, a role note, a prompt, a quote, nested fields);
  - dashed placeholders (empty states, drop zones);
  - spinners.
- **The canvas:** untouched.

## Phases

**B1 — The screens people use.** Home, Runs and the run page with its exec panel, Monitor, Review, Services, Jobs, Alerts, Playground, Evals, Prompts, Resources. The shared card, divider and chip rules land here; each screen's own rules shrink to layout.

**B2 — The rest.** The assistant panel (`ax-*`), Experiments (`xp*`), Knowledge (`kb*`), Team, Account, Settings.

**Done when (both phases together):**
- chrome `border` declarations under 60, with the canvas's own counted apart and unchanged;
- the DOM count shows no box nested in a box on any shot, and fewer boxes overall;
- in dark, every card differs from the page it sits on (the computed backgrounds differ);
- screenshots at desktop and phone, light and dark, for each screen;
- the JS and studio tests pass.

## Progress

| Phase | State | Evidence |
|---|---|---|
| B1 | done | One card on every main screen: a tint (`--card`), never an edge; blocks inside it take `--well`, one step off. Selection is a 2 px accent ring on the accent tint (Evals, Prompts, templates); a firing alert or the branch row last taken carries an inset bar. Chips are tint only. The Resources shadow cards became tint cards, so they read in dark. DOM count over 60 shots: boxes 188 → 58, nested 2 → 0. Declarations 207 → 160. Desktop and phone, light and dark, every screen; JS 118/118, studio 473 passed. |
| B2 | done | The assistant (table, JSON, steps, changes and error cards, suggestions, chips, composer pastes), Experiments (cards, the reason box, the case drill, repeats, compare groups, datasets), Knowledge and Team on the same card and well. Floating surfaces declare their edge once; the hairline between rows is one rule per side for every list and table. Found on the way: the inline-code rule painted every line of a fenced code block light on its dark background, so assistant code was unreadable (`.ax-text pre code` resets it). **Gates, against pre-B1 `main` with the same harness:** chrome `border` declarations 162 → 56 (the canvas's 44 counted apart, unchanged); boxes 196 → 62 on the main screens, 128 → 30 on the assistant and Team, 102 → 24 on Evals; boxes in a box 2 → 0, 20 → 0, 42 → 0; cards whose background equals the surface under them 20 → 0 (the Resources cards in dark). 104 shots, desktop and phone, light and dark; JS 118/118, studio suite. |
