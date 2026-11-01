---
title: A turn ends on what it really did
status: done
phases:
  - {id: S4, title: "A call the studio's guard refused is guarded, not failed", status: done}
  - {id: S1, title: "Plan phases marked done are sent back once for their evidence (stophook.py)", status: done}
  - {id: S2, title: "failing_on_base: failing tests run on the base branch; a red last run is sent back until it is called", status: done}
  - {id: S3, title: "What the turn leaves: open steps (strip + hook), worktrees it made (card with Remove)", status: done}
rows: []
updated: 2026-11-01
---

# A turn ends on what it really did (TURN_HONESTY_PLAN)

The owner's run of mr-finance PR #74 in the studio chat (2026-11-01) did good
work and still ended on four untrue lines, each found only by reading the
whole turn:

- FF5 and the plan were marked `done` at 24 flows against "< 20";
- two failing tests were called "pre-existing" with nothing that showed it
  (they were, on main 87ed546 — but the turn never checked);
- the steps card still had three steps open;
- six worktrees `ff/a`–`ff/f` were left on disk;
- and the rows the studio's own guard refused showed red, as failures.

## What changes

**S4 — guarded is not failed.** A call refused by the studio's hooks
("Refused by the studio: …") is its own state: grey, a `guarded` chip, no
error line, and counted apart on the outcome strip.

**S1–S3 — the Stop hook** (`operonx_studio/stophook.py`, in each turn's
`--settings` beside runhook.py; `OPERONX_STUDIO_TURN_CHECKS=off` turns it
off). Before the turn ends it reads the turn's transcript and, **once**,
sends the model back when the turn:

| | found by | asked |
|---|---|---|
| S1 | an Edit/Write/shell edit of a `*PLAN*.md` that sets a phase or the plan `done` | quote the evidence per phase, or set it back to `in_progress` and ask |
| S2 | the last pytest summary has failures and no `failing_on_base` came after it | call it before calling anything pre-existing |
| S3 | the last `steps` card has steps `pending` or `active` | finish, skip with a reason, or mark waiting/blocked |

The page shows a note when this happens. Replayed on the PR #74 transcript,
its last turn is sent back for all three.

**S2 — `failing_on_base(tests, cwd, base?)`**, a studio tool
(`basecheck.py`): the merge-base with origin's default branch, extracted with
`git archive` into `~/.operonx/base-checks/` (cached per commit, pruned after
two days; the repo's worktree list is not touched), the ids run there with the
project's `.venv` Python. Each id: *fails on base too*, *passes on base: NEW
failure*, or *not on base (a new test)*.

**S3 — worktrees.** The turn's snapshot records `git worktree list`; a
worktree the turn added (not a card's, under the engine's root) becomes a
card with a Remove button per worktree: `git worktree remove` without
`--force` (a dirty one is kept, and the card says git's reason), then
`git branch -d` (an unmerged branch is kept). Edit access only.

**Knowledge.** A phase that misses its number is not done; "pre-existing"
needs `failing_on_base`; when the studio sends you back, answer it.

## Gates

- `tests/studio/test_stophook.py` (15), `test_basecheck.py` (4, a real
  repo: each verdict), `test_turn_leftovers.py` (hooks in settings, worktree
  find/remove with git's checks, the note); `tests/js/tools.test.mjs`
  (guarded, open steps). Full suites green.
- Live: `claude -p --settings` with the hook, Sonnet: the stop was blocked
  once, the model got the reason, the turn then ended.
