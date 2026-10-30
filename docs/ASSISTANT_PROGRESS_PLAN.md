# The assistant's steps, on screen (ASSISTANT_PROGRESS_PLAN)

Status: planned 2026-10-30, not started. Estimate ~2.5 h for P1–P5.

## What the owner saw (observed on m33, 2026-10-30)

A board question to the assistant showed "Thinking… 13 s" and a folded
"Used the studio 2× · 3 steps" row. The hand did go to the board and ring
F1, but nothing said what the assistant was doing, what was done, or what
was left. The assistant never planned: in 91 tool calls over the m33
sessions there was no step list (Claude Code's `-p` mode has no
TodoWrite in 2.1.312), so the page had nothing to draw a progress from.

## Design

**D1 · `steps`, a studio tool.** The assistant posts its plan and every
change to it: `{title, steps: [{title, state, detail?, target?}]}`, the
whole list each time (as TodoWrite does). States: `pending`, `active`,
`done`, `failed`, `skipped`, `waiting` (needs the owner). At most one
`active`. The server checks it and answers with one line ("step 2 of 5:
…"). It changes nothing, so every reach may use it (read-only too). The
item carries the list as data (`plan`), not clipped JSON text.

**D2 · knowledge.** A task of three or more actions starts with `steps`:
the whole plan, the first step active. Then one call when a step starts,
ends, fails, is skipped, or needs the owner. A step that works on a part
of the screen names it as `target` (the hand's names: `card:F1`, `q:Q-3`,
`plan:…`, `op:…`, `run:…`). A question answered from a read or two has no
steps. The reply does not repeat the list.

**D3 · the progress card.** At the head of the turn's reply, drawn from
the turn's latest `steps` item, and held at the top of the conversation
while the turn runs:
- head: the title, a chip (Working · Done · Failed · Needs you ·
  Stopped), "3 of 5 done", the bar;
- a vertical timeline, one block per step: pending (hollow dot), active
  (spinner, lit block), done (check, its time), failed (cross, open with
  its detail), skipped (struck through), waiting (amber "Needs you");
- the active block says where the studio is ("On the board · F1", the
  hand's current target) and the tool call running now;
- each block opens to its detail and the tool calls made while it was
  active (a tool belongs to the step active when it started);
- the `steps` calls themselves leave the activity list (they are the card).

**D4 · in step with the screen.** A step that becomes active with a
`target` sends the hand there (`Choreo.focus(before, after)`: the screen
to go to, then the ring with the step's words). The hand tells the page
what it rings (`oxhandpoint`), so the active block names it. Board cards
become targets (`card:<id>`) and `board_card` rings the card it reads.

**D5 · motion, kept quiet.** A block changes state with one short
transition (≈200 ms: the dot fills, the bar grows, the next block lights);
the card follows the hand's existing glide and ring, nothing new moves on
its own. Reduced motion: states change without transition. The user's own
click still stops the hand for the turn (hand.js D4); the card keeps
updating.

**D6 · what the owner can always tell.** Now: the active block. Where: its
"in the studio" line. Done and left: the counts and the bar. Needs you:
the amber chip on the card and the block, also when the turn waits on a
board question or an approval. Failed: the block opens itself with the
error.

## Phases

| | What | Est. |
|---|---|---|
| P1 | `steps` tool (mcp.py, read reach in chat.py), the `plan` field and label in assistant.py, tests | 30 min |
| P2 | knowledge.md section (D2); one live turn checks the model uses it unasked | 20 min |
| P3 | the progress card (assistant.js, studio.css + dark), `steps` rows out of the activity list, tools grouped under steps, reload rebuilds it | 60 min |
| P4 | sync: `Choreo.focus`, `oxhandpoint` from hand.js, `card:<id>` targets in board.js, `board_card` choreo, node tests | 30 min |
| P5 | live gate on the scratch studio: a Sonnet turn that plans, shots at 1440 and 390 wide, mid-turn and done | 20 min |

## Gates

- node tests: `Choreo.focus` (a newly active step with a target → go +
  point; the same active step → nothing; no target → nothing),
  `board_card` → `card:<id>`.
- python: `steps` validates (unknown state, two active, empty), answers
  with the active step, is in the read-only reach; the item carries `plan`.
- live, on the scratch m33 studio: a real Sonnet turn that plans, shot
  at desktop and phone width while it runs and when it ends.

## Out of scope

The two layout faults seen on the same screens (the milestone island over
the first message; the reply running under the composer) are noted for
their own fix.
