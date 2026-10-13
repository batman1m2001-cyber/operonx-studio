# One control per job: merging what the studio shows twice

**Status:** 2026-10-13. P1 (M1, M2 with B1, M3) and P2 (M4, M5, M11, M12) done; P3 not started.

## Why

The GraphOp card shows its nested graph twice: the ▣ icon in its left band, and a `▣ 7 ▸` chip under its name that opens it. The chip costs the card a whole row, and on an agent's tool column it costs every graph tool that row.

An audit of every screen found the same pattern in eleven more places:
- a control that repeats one beside it;
- a label that states the default;
- two switches for one choice.

Each was checked in the code and on screenshots of the callbot, meeting-prep and meeting-prep-brd projects.

## Rules this plan applies

1. **One control per job.** When two controls do the same thing, the one on the object stays (the icon, the chip, the label) and the separate button goes.
2. **The default says nothing.** A label appears only when a value differs from the usual. *Allow* and *sync* are the usual.
3. **One switch per choice.** Views of the same thing sit in one segmented control, not in nested ones.
4. **The same word means one thing.** Two controls must not share a name for different jobs.

Nothing here removes a capability:
- every action keeps a click target and its keyboard shortcut;
- what a card stops saying is still in the inspector and the tooltip.

## The items

### Flow canvas — cards

**M1. A GraphOp opens from its icon.** *(the user's example)*
- **Now:**
  - the left icon band shows ▣;
  - a separate `▣ 7 ▸` button under the name opens the nested graph (`canvas.js`, `badge sub expand`).
- **Merge:**
  - the icon band is the toggle. It shows ▣, the op count small under it, and ▸ or ▾.
  - A click on the band opens or folds; a click elsewhere on the card still selects it. The double-click stays.
  - The band takes the button's focus, title and `aria-expanded`.
- **Gain:**
  - one row less on every graph card;
  - brd's tool cards are all graphs, so each one is about 40px shorter and the `email` agent's tool column about a quarter shorter.
- **Run views:** the count the chip shows in a run view moves to the band too (n.agentSteps, n.step).

**M2. An agent's tool card: one line, its policy only when it is not *allow*.** *(the user's ALLOW question; see Backlog B1 for the research)*
- **Now:** a second line on every tool reads `function ALLOW` or `@graph ALLOW`.
  - `function` / `@graph` repeats the icon band.
  - `ALLOW` is the default.
- **Merge:** the line goes.
  - *ask*: one small amber `ASK` mark after the name.
  - *deny*: the card is shown greyscale and faded, and so is its cable.
  - The inspector keeps the full sentence: "Runs when the model calls it." / "Waits for a human's approval…" / "Refused…".
- **Gain:** with M1, a graph tool becomes a one-line card.

**M3. The kind chip leaves the selected card.**
- **Now:** a selected card shows `FUNC` and `SYNC` chips (`nameChips`). The icon band already says FuncOp, and the inspector header says `FuncOp · sync`.
- **Merge:**
  - the kind chip goes;
  - the bound chip shows only when it is not `sync` (THREAD or TASK);
  - the generator mark stays.

### Flow canvas — toolbar

**M4. One zoom control.**
- **Now:** four buttons, `−` `91%` `+` and ⛶ fit.
- **Merge:** one `91% ▾` button.
  - Its menu: Zoom in (+), Zoom out (−), 100% (1), Fit (0).
  - All the shortcuts stay, and so do the wheel and pinch.
- **Gain:** three buttons fewer. Fit stays one keypress away.

**M5. The two "Live"s get different names.**
- **Now:** two controls are both called "Live":
  - the header's `● Live` means "the studio redraws when the project's code changes";
  - the canvas `Live` button means "replay each new run as it lands".
- **Merge:** the header's becomes a status dot on the project name in the breadcrumb.
  - It is green while code is being watched, and red with the error when extraction fails.
  - Its tooltip says what it watches.
  - The canvas button keeps the word "Live".
- **Gain:** a header item fewer, and "Live" means one thing.

### Run page

**M6. One view switch for a run.**
- **Now:** three nested switches.
  - The page's `Tree | Workflow` (top right).
  - Inside Tree: `Conversation | Tree | Timeline`. The word "Tree" appears twice.
  - Inside Workflow: the canvas's `Workflow | Data Flow`, a second "Workflow".
- **Merge:** one segmented control in the run header: `Conversation · Tree · Timeline · Workflow · Data Flow`.
  - Conversation shows only for runs that have a conversation, as now.
  - The URL keeps `view=` and gains `conversation`, `timeline` and `data`.
  - `D` still flips between Workflow and Data Flow.
- **Gain:** one decision instead of three, and no repeated words.

**M7. Replay carries its speed.**
- **Now:** two buttons, `▶ Replay` and `4×`.
- **Merge:** one split button, `▶ Replay 1× ▾`. The menu offers 1×, 2× and 4×, and the button remembers the last speed.

**M8. The key ops filter lives on the key ops.**
- **Now:**
  - the run header lists **KEY OPS** as chips with their timings;
  - the tree toolbar has a separate `Key ops` filter toggle.
- **Merge:**
  - the **KEY OPS** label in the header is the toggle, and it is underlined while the filter is on;
  - clicking a chip still selects that op;
  - the toolbar toggle goes.

**M9. Fold all / open all: one button.**
- **Now:** two icon buttons, *Fold every step* and *Open every step*.
- **Merge:** one toggle. It shows "fold all" when anything is open, else "open all".

**M10. The Errors filter shows only when something failed.**
- **Now:** an `Errors` chip sits disabled on every clean run.
- **Merge:** it is hidden when nothing failed. On a failed run it shows `Errors 3` as now.

### Header and side panel

**M11. Settings joins the screens.**
- **Now:** a gear in the header opens the project's Settings screen (retention and appearance). Every other screen is in the left rail.
- **Merge:** Settings becomes the last item in the rail, under OPERATE, and the header gear goes.
- **Gain:** a header icon fewer. Settings sits where the other screens are.

**M12. One way to close the side panel on desktop.**
- **Now:** the side panel can be closed three ways:
  - the header's panel toggle;
  - the panel's own `×`;
  - Esc.
- **Merge:** on desktop the `×` goes, and the header toggle and Esc remain. On a phone, where the panel covers the page, the `×` stays.

### Kept on purpose (looked at, not merged)

- **Settings › Appearance (System / Light / Dark) and the header's one-click theme toggle.** The toggle flips light and dark. *System* is a setting, chosen once.
- **The inspector's `Ask` and the Assistant tab.** `Ask` opens the assistant already holding this op as context: a shortcut, not a duplicate.
- **The Services screen's `Playground` / `Monitor` links on each service.** They go to different screens scoped to that service.

## Order

Each phase is one PR, verified on the callbot, meeting-prep and meeting-prep-brd projects. The checks:
- desktop and phone, light and dark;
- no card overlaps (the overlap check);
- the JS tests.

1. **P1, cards:** M1, M2 (with B1), M3. *Done.* The biggest space gain, on the canvas the user looks at most.
2. **P2, canvas toolbar and header:** M4, M5, M11, M12. *Done.* M12 turned out half-done already (the panel's × showed on a phone only); the × left on desktop was the docked assistant's, which switched to Inspect, so it goes in dock mode.
3. **P3, run page:** M6, M7, M8, M9, M10. M6 touches the router (the `view=` values); old links keep working (`view=tree` → Tree).

## Backlog

**B1. Tool policy: no ALLOW chip; *deny* greyed out; *ask* marked.** *(user, 2026-10-13: "why do we have to add ALLOW in each tool? can we just grey out the disabled one?")*

Research:
- **What it is.** The chip is a label, not a toggle. Clicking it does nothing. It shows `Agent.describe()`'s `policy` for the tool: `ToolPolicy.decide(name, meta)` in operonx-agents `tools/policy.py`.
- **Three values:**
  - `allow` runs it.
  - `ask` asks a human through dispatch's `approve`, and is refused when no one is there to ask.
  - `deny` refuses without asking anyone.
- **The default** (`DEFAULT_POLICY = ToolPolicy(default="allow", destructive="ask", readonly="allow")`) is *allow* for every tool except those declaring `destructive=True`, which *ask*. So most tools are *allow*, and *ask* is real for tools that write. A project's own `ToolPolicy(...)` starts from `default="ask"`, which makes *ask* the default there.
- **Where the policy is set:** in code (`Agent(policy=ToolPolicy(...))`). The studio only reads it. Making the card a switch would mean writing the policy back to the project's code, which is out of scope here.
- **The change (part of M2):**
  - `allow` shows nothing.
  - `ask` gets a small amber `ASK` mark after the tool's name.
  - `deny` shows the card greyscale and faded, with its cable grey, and its tooltip says "refused: the model may not call it".
  - The inspector keeps the full sentence for all three.
- **Files:** `canvas.js` (`toolLine` and the agent tool card in `opCard`; `drawAgentParts` marks a denied tool's cable), `studio.css` (`.atpolicy`, a `.tool-denied` card), `inspector.js` (unchanged).
- **Test data:** the scratch project gets an agent with `policy=ToolPolicy(rules={"x": "ask", "y": "deny"})`, so all three states render.

**B2. A double-click on an agent cell sometimes does not open it.** *(seen 2026-10-13 while testing, not yet diagnosed)*
- **What was seen:** in a scripted browser (Playwright `dblclick`), the scratch project's `three` agent stayed folded on a fresh page, while `one`, `a` and brd's `email` opened.
- **Workaround:** clicking a socket's place opens it reliably.
- **Likely cause, to confirm first:** the first click selects the card. In Workflow, selecting re-lays out the canvas round it (`select` → `renderKeeping`). So the card can be replaced or moved before the second click, and the `dblclick` never reaches the node that has the handler.
- **To check:**
  - Does it also happen by hand?
  - Does it happen to every card with `ondblclick`: nested graphs and agents?
