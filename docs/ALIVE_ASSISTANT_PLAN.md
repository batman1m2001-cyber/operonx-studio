---
title: The assistant works the screen
status: in_progress
phases:
  - {id: L1, title: The hand — go, point, press, status: open}
  - {id: L2, title: Project mode's targets, status: open}
  - {id: L3, title: Project mode follows the assistant's work, status: open}
  - {id: L4, title: The assistant points on purpose, status: open}
  - {id: L5, title: The rest of the studio, status: open}
  - {id: L6, title: Gate, status: open}
updated: 2026-10-23
---

# The assistant works the screen

**Status:** 2026-10-23, asked by the owner: "when I ask it to do something, it goes to the relevant page and
highlights, clicks, interacts with the relevant elements, so it feels like something works the UI for us …
for everything in operonx studio, Project mode first."

## 1. Today

- The assistant is Claude Code. Its tool calls reach the browser live: each one is an item with its `name` and
  `input` (the file an Edit touches, the command a Bash runs) when it starts, and its status when it ends
  (`assistant.py`, the turn's items).
- 16 MCP tools already move the screen through `s.show(kind, …)` → `/ui/action` → the pulse → `performUi`:
  `open_run`, `select_op`, `open_board`, `open_tab`, `open_monitor`, `open_eval`, `compare`, `open_jobs`.
  They switch the screen and say so in a toast. Nothing is pointed at, nothing is pressed, and the work done
  through Claude Code's own tools (Edit, Write, Bash) moves nothing at all.
- So in Project mode the owner asks "add a plan for CSV export", the assistant writes `docs/EXPORT_PLAN.md`,
  and the screen shows only a list of tool lines until the status column refreshes.

## 2. Decisions

**D1. One hand, three gestures.** A `Hand` module (`hand.js`) is the only thing that moves the screen for the
assistant:
- `go(where)`: switch to a screen or a Project-mode page, the way the user would;
- `point(target, words)`: scroll the element into view, glide a small cursor to it, ring it with a soft
  highlight and a short label (two or three words: "editing", "verified", "new"), and leave it lit until the
  next gesture or 4 s;
- `press(target)`: the cursor's click ripple on a real button the assistant's action stands for (an answer
  it sent, a Run it started). The press is a picture of what the assistant did through its tools; the hand
  never fires the button's handler, so nothing happens twice.

It respects `prefers-reduced-motion` (no glide, a ring only) and never covers what the user is typing.

**D2. Targets are named, not found.** Elements the hand can reach carry `data-ox-target`: `plan:<path>`,
`phase:<path>#<id>`, `row:<id>`, `q:<id>`, `commit:<sha>`, `status:<section>`, `setting:<name>`, and on the
other screens `op:<name>`, `run:<id>`, `job:<name>`, `eval:<name>`. A gesture names a target; if the page
is not drawn yet, the hand waits for it to appear (up to 3 s), then gives up quietly.

**D3. The screen follows the work, without the model doing anything.** A choreographer in the browser reads
the assistant's tool items as they start and end, and maps them to gestures:

| The assistant… | The screen |
|---|---|
| reads or edits `docs/*_PLAN.md` | Plans: the plan opens, ringed "reading" / "editing" |
| edits the checklist matrix | Checklist: the rows it changed, ringed |
| edits `open_questions.md` | Questions: the question, ringed |
| runs tests / `brd check` | the status column's Checklist, ringed "checking" |
| commits | Changes: the new commit, ringed "new" |
| calls `project_status` | the status column, each section lit in turn |
| answers through `board_act` | Questions: the option it chose, pressed |

At the turn's end the column refreshes, and what changed (a plan's phase, a row's status, a new commit) is
lit once: "what just happened". That comparison is of two status documents, not of the model's words.

**D4. The user stays in charge.** Following is on in Project mode and switched by a small "Follow" toggle by
the composer. The moment the user clicks, scrolls or types elsewhere, the hand stops for the rest of that turn
and a chip says "The assistant is working on Plans · show me".

**D5. The assistant can point on purpose.** A `studio_point` MCP tool (`target`, optional `words`) for the
answer itself: "Q-16 blocks BRIEF-RISK-04" points at both. The knowledge says when: once per answer, at the
thing the answer is about, never as decoration.

**D6. Everywhere, by the same hand.** The existing `performUi` kinds become hand gestures (go + point), and the
choreographer learns the other screens: an Edit to an op's file selects and rings that op on the canvas; a run
the assistant opens is pointed at in the Runs list; a job, an eval, a prompt likewise.

Rejected: the model driving the DOM (a browser tool); slow, costly, and it would really click. Rejected: a
recorded replay after the turn; the owner asked to see it happen.

## 3. Phases

| Phase | What | Gate |
|---|---|---|
| L1 | `hand.js`: go, point, press, the cursor and the ring, reduced motion, the user's interruption | JS unit tests for the target lookup and the stop-on-user rule; a screenshot of a ring |
| L2 | `data-ox-target` on Project mode's status column and pages | every Project-mode item kind has a target (a test over the rendered page) |
| L3 | The choreographer for Project mode (D3), "what just happened", the Follow toggle | JS tests: tool items → gestures; a recorded Playwright run of a scripted turn |
| L4 | `studio_point` MCP tool and its knowledge | studio test: the tool queues the gesture |
| L5 | `performUi` through the hand; targets and choreography on Flow, Runs, Jobs, Evals, Prompts, Monitor | JS tests per screen; screenshots |
| L6 | On a OneWealth clone, Sonnet in Project mode: "plan a CSV export of the wealth report" and "where are we?"; on tipcalc, a fix on an op | frames of the screen following each turn; every suite green; live studio restarted |
