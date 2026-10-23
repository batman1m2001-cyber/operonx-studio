---
title: Every project up to the standard, by the assistant
status: in_progress
phases:
  - {id: S1, title: The engine says what the standard is and where a project stands against it, status: open}
  - {id: S2, title: The studio shows it and offers one action, status: open}
  - {id: G1, title: Git per project — who commits, what the assistant may do, enforced, status: open}
  - {id: S3, title: The assistant does it on clones; fix and retry until every project passes, status: open}
  - {id: S4, title: The passing work lands in the real repos, status: open}
  - {id: S5, title: Live studio and the report, status: open}
updated: 2026-10-23
---

# Every project up to the standard, by the assistant

**Status:** 2026-10-23, asked by the owner: "refactor all projects in the studio to have the standard BRD, plans …
through our assistant, which also verifies our assistant. Load it in the studio to see the outcome; if it is not
good, fix the assistant and retry."

## 1. Today (measured 2026-10-23)

The engine's guide already defines the standard; nothing reports it, and no project meets all of it.

| Project | `brd check` | Plans without a status block | `practices.toml` |
|---|---|---|---|
| mr-finance (OneWealth) | 4 errors | 20 | none |
| qc-snatcher | 0 | 2 | none |
| meeting-prep-operonx | 0 | 0 | none |
| meeting-prep-brd | 0 | 0 | none |
| educa-reminder-agent (callbot) | 0 | 4 | none |
| tipcalc | 0 | 0 | yes |

OneWealth's 4 errors are not a checker bug: its summary table names its own sets ("BRD numbered (BR, FR, NFR)")
and the engine reads such sets from `docs/brd/brd.toml` `[[groups]]`. That file is in neither the guide nor the
assistant's knowledge, so no assistant could have known.

## 2. Decisions

**D1. The standard is the engine's, four items, read-only and fast.**
1. `brd`: `docs/brd` with requirements and the checklist matrix;
2. `check`: `brd check` reports no error;
3. `plans`: every `docs/*_PLAN.md` has a valid status block;
4. `practices`: `docs/brd/practices.toml` exists and validates.

The status document gains `standard`: one entry per item with `ok`, a sentence, and what fixes it. `text()`
gains one line. Nothing in it runs a test: the status stays a read.

**D2. Practices describe the project as it is.** The assistant writes what is true today: the test command the
project really uses as a `[done]` check (it must pass now), `[tdd] mode = "acceptance"`, architecture rules only
when the code already keeps them (`operonx-project arch` passes). Never an aspiration that fails on day one.

**D3. One action, one fixed prompt.** In Project mode, when an item is missing: one quiet line on Now
("2 of 4 for the standard"), and on Settings the four items with "Bring it up to the standard". The prompt is
the studio's, not typed by the owner, so every project gets the same instructions and a retry is the same test.
The knowledge says how: groups in `brd.toml` matching the project's own summary table; plan blocks set from the
plan's text and the git log; requirement meaning never rewritten; only `docs/` and `practices.toml` touched;
`brd check` and the `[done]` checks run before the commit; one commit by path on the current branch.

**D4. The assistant is judged by a scorecard, not by its words.** Per project, after the turn:
- `standard` all four ok (the engine's own reading);
- `brd check` 0 errors; `operonx-project practices` valid; every `[done]` check passes;
- the diff touches only `docs/` (and nothing under `src/`, `tests/`, code);
- no matrix row changed its status without a cited test that passes;
- a commit exists; the reply says what it did in a few lines;
- frames of Now, Plans and Settings in the studio.

A miss is a defect of the assistant (knowledge, prompt, a tool, the engine's report), fixed there, then a fresh
clone and the same action again. Each round is recorded in §4.

**D5. Clones first, then the real repos from the passing run.** Each run is on a fresh local clone in the
scratchpad, through a scratch studio (Sonnet), never the live one. The passing commit is fetched into the real
repo and merged on its working branch: mr-finance `main` (docs only; the live app does not read them),
educa-reminder-agent `refactor/operonx-studio` (that branch only), meeting-prep-projects `main`, qc-snatcher
`main`, tipcalc `main`. The owner's untracked files are never added.

**D6. Git per project, enforced in git, not in words** (asked by the owner the same day). Measured: the assistant
has free Bash and this machine's `gh` is signed in as batman1m2001-cyber, so only one sentence of knowledge kept
it from pushing; mr-finance has no git identity and the gate's assistant committed as the owner by copying an
email from the log; the callbot is on GitLab with no API token. So each project gets, in Project mode Settings:
- **Commit as**: a name and email, written to the repo's own git config by the owner's action;
- **Remote**: read from the repo, with the account it pushes as (the machine's `gh`, or "the machine's git
  credentials" for another host);
- **The assistant may**: off · commit · push branches · open PRs · merge PRs (a ladder; default: commit);
- **Protected branches**: never pushed to by the assistant (default: the remote's default branch, `production`).

The policy lives in the studio's state (`<state>/git/<pid>.json`): it is this studio's rule for its assistant,
not the project's. It is enforced for the assistant's processes only, however a command is spelled:
`GIT_CONFIG_*` in the assistant's environment points `core.hooksPath` at the studio's hooks, which check the
policy (commit: the level and the author is the "commit as" identity; push: the level and no protected ref) and
then run the repo's own hooks; a `gh` guard first on the assistant's PATH checks `pr create` and `pr merge`
against the level. A refusal says why ("main is protected in this project: push a branch"). Viewers get no git.
This replaces the "separate git tools" first described to the owner: tools could be bypassed by spelling the
command differently; hooks cannot.

## 3. Phases

| Phase | What | Gate |
|---|---|---|
| S1 | Operon: `status()["standard"]`, the text line, the guide's "The standard" with `brd.toml` groups; core release | tests for each item, ok and missing; the six projects read as in §1 |
| S2 | Studio: the line on Now, the four items on Settings, the action, the knowledge section, `project_status` text | studio tests; desktop and phone screenshots |
| G1 | Studio: the policy store and API, Settings rows, the hooks and the `gh` guard in the assistant's environment, the knowledge | tests: each level allows and refuses what it should through real `git` and a fake `gh`; a commit as anyone else is refused |
| S3 | The loop: each project's clone, the action, the scorecard; fix the assistant, retry | all six score every line of D4 |
| S4 | On the real repos, the assistant itself, under each project's git policy: commit, push a branch, open a PR (GitHub); I merge per D5 | `standard` 4/4 on every real repo |
| S5 | Live studio restarted, memory, the report | the six projects in the live studio, 4/4 |

## 4. Rounds

(filled as the loop runs)
