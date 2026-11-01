---
title: One project, one execution model — the studio as a development workspace
status: in_progress
phases:
  - {id: T1, title: "A phase marked done is checked for how it was met: the plan's way, or the owner's call", status: done}
  - {id: T2, title: "\"I haven't checked\" in the last reply sends the turn back once: check it, or say why it can't be", status: done}
  - {id: T3, title: "on_base(command): any check run on the merge-base, not only failing tests", status: done}
  - {id: W0, title: "Audit: where plans, board, checklist, questions, steps, runs and git disagree, and why", status: done}
  - {id: W1, title: "Unified project execution model: card ↔ run ↔ steps ↔ evidence; board follows the assistant", status: in_progress}
  - {id: W2, title: "Terminal and Git: real sessions on the existing execution layer; git page linked to cards", status: open}
  - {id: W3, title: "Environments: execution providers (local, SSH), secrets never reach the model", status: open}
  - {id: W4, title: "Run, test, deploy: services, health, preview URL, staged deploy with approval for production", status: open}
rows: []
updated: 2026-11-01
---

# One project, one execution model (WORKSPACE_PLAN)

Two inputs, one plan:

- **What the assistant did on mr-finance PR #74** (2026-11-01): the turn checks of
  [TURN_HONESTY_PLAN](TURN_HONESTY_PLAN.md) caught two things, and two more went through (T1–T3).
- **The owner's brief**, kept word for word in [WORKSPACE_BRIEF.md](WORKSPACE_BRIEF.md): the board,
  plan, checklist and assistant show one state, and the studio gains a terminal, git, environments and
  deploys (W0–W4).

T1–T3 are small and come first. W0 is an audit, and only after it does W1 get its concrete steps:
the brief says not to assume what exists.

## T — what the PR #74 turn showed

The turn "continue FF5 toward < 20 flows" (10:04–10:48, 44 min, $6.65). Good: pulled first, one
commit per fold with the contract test after each, FF5 kept in progress, and both times the stop hook
sent it back it did what was asked (steps closed; `failing_on_base`: both failures fail on main too).

What went through:

| | seen | why it matters |
|---|---|---|
| T1 | "< 20" was met by folding `zone_flow` into `news_flow` (0c497bf) and `evaluation_flow` into `market_flow` (50f3380), while the plan's table — "One flow per feature" — gives zone (row 14) and evaluation (row 13) their own flows. FF6 marked done on that count. | A number stands for a design. Meeting it another way is the owner's call, and it was reported as done work. |
| T2 | "`brd check` reports 4 summary-row errors. I haven't checked whether they exist on main." — in the reply and again after "hello ?". | The turn knew a check was missing and ended anyway. S2 covers only pytest. |
| T3 | The same question as S2 ("is it on main too?") for a check that is not a test. | `failing_on_base` already extracts the merge-base; running another command there is one call. |

**T1.** The S1 reason (stophook.py) also asks: "was it met the way the plan says (its table, its
decisions)? A different way is the owner's call: say what you did and ask." Knowledge: a target number
stands for the plan's design.

**T2.** A new stop check: the last assistant text says it has not checked or verified something
("haven't checked", "not verified", "didn't run") → sent back once: run it, or say why it cannot run.

**T3.** `on_base(command, cwd, base?)` in basecheck.py: the command in the merge-base copy, its output
and exit status beside the branch's. `failing_on_base` stays as the test-shaped case.

Gates: stophook tests for T1/T2 on the PR #74 transcript (its last turn sent back for both);
`test_basecheck.py` for `on_base` on a real repo; a Sonnet turn with the hook.

**Done (2026-11-01).** On the PR #74 transcript the turn that marked FF6 done is sent back for T1 and T2,
and its last turn ("hello ?") for T2 (`test_the_pr74_turns_are_sent_back`). T2 matches first person only
("I haven't checked …"): "R12 is not verified" is a BRD status, not a check left undone.
`on_base(cwd, command)` runs the command here and in the merge-base copy and shows both exit statuses
(`test_a_command_runs_here_and_on_base`). A Sonnet turn told to end on "I haven't checked whether
notes.txt exists" was sent back once, ran `ls -l notes.txt`, and answered ($0.10). Studio suite: 656
passed, 5 skipped.

## W — the workspace (the brief)

The phases follow the brief's §14; each ends with tests, docs and its cards on the board.

**W0 — Audit.** For each of: projects, plans, board cards, task states, checklist and requirement
verification, questions, assistant sessions, steps cards and progress events, git, evidence — where it
is stored, who writes it, who reads it, and where two of them can disagree. Known pieces to start from
(to be confirmed, not assumed): the board in `.operonx/project` (operonx-project engine), plans on the
board (engine `plan` op, studio board_plan/auto-sync), the steps card, runhook/progress (live calls),
the stop hook, the Files page, the worktrees card. Output: the root causes, and W1's steps with gates.

**W0 — findings (2026-11-01).** Measured on mr-finance (read-only) and the studio:

| | what disagrees | evidence | root cause |
|---|---|---|---|
| R1 | Board m33 says "2 of 7 done, FF1 open"; FEATURE_FLOWS_PLAN.md says 5 of 7, FF5 in progress | m33's cards last written 2026-11-01 02:13; the doc changed at 16:16 and 17:47 | the board follows a plan only after an `Edit`/`Write` of it (app.py `_plan_sync`) or a `board_plan` call; the PR #74 session changed the doc 4× with `python3 -`/`sed -i` in a worktree and never called `board_plan` |
| R2 | a phase card reads done because the doc says so | `_PHASE_CARD` in the engine's `_plan`: status word → card state | no run, test or evidence stands behind a mirrored card; the stop hook (S1/T1) is the only check, and only in chat |
| R3 | the board card, the turn and its `steps` card are three records with no link | engine `cards` · studio `turns` · studio `items` (kind steps) | nothing says which card a turn works; the Board cannot light it, the card cannot list its turns |
| R4 | evidence stays in the chat | testreport facts, `failing_on_base`/`on_base` output, commit messages | nothing carries a turn's evidence to its card |
| R5 | questions live in three places | engine `interactions` (engine milestones only) · `requirements/open_questions.md` · the assistant's last line ("Do you want me to plan D3 next?") | a plan worked in chat has no question record |
| R6 | a plan's board files are committed on the main checkout's branch | `d9303f1 board: m33 from docs/FEATURE_FLOWS_PLAN.md` is on mr-finance **main** (the live :8030 checkout) while the plan is on `refactor/feature-flows-2` | the engine's `_commit_one` commits in `project.repo`, whatever branch it has out |
| R7 | a plan the engine cannot read is dropped without a word | this plan's own `pending` was not a phase status (`open`), so `plan` answered invalid | `_plan_sync` ignores the answer (`except: pass`, `ok: false` unread) |

The studio repo itself has no board (`docs/brd`, `.operonx/project`): this plan's status lives in its doc.

**W1 — Unified project execution model** (brief §1–4, the most important part):

Steps, from W0 (each closes a root cause, reuses what exists, no new store):
- **W1.1** (R1, R7) The board follows the doc however it changed: at a turn's end, every plan the board
  mirrors is read from the checkout and the project's worktrees, and synced when its text differs from
  what was mirrored; also the Bash-edited ones. A refused sync is a note in the turn ("the board could not
  read docs/X_PLAN.md: …"), not silence.
- **W1.2** (R6) A plan's sync writes the store and never commits on the main checkout (engine `plan` with
  `commit: false`; the board files are written only where the plan lives).
- **W1.3** (R3) A turn names its card: `steps` takes `card` (`<plan path>#<phase id>` or `<milestone>/<card>`);
  the turn row keeps it; the Board lights that card while the turn runs and the card lists its turns.
- **W1.4** (R2, R4) A card's evidence is its turns' facts (test runs, `failing_on_base`, `on_base`, commits);
  a phase marked done with no green run behind it shows "marked done · no evidence", apart from verified.
- **W1.5** (R5) Open questions in one list: engine interactions, open_questions.md, and a turn that ended
  waiting on the owner, on the overview and on its card.

Gates: a scratch repo where a plan is changed by `sed` in a worktree is in line on the board at the turn's
end with no commit on the main checkout; a turn with `card` shows on that card with its test run; the
studio suite; screenshots of the Board card and the overview.

The brief's goals for W1:
- one hierarchy, adapted to what exists: project → plan → card → run → steps, logs, tests, git, evidence;
- a card the assistant creates is on the board at once; a run names its card; starting moves the card,
  the run's real result moves it again; a failed run never reads done; "built", "tests pass",
  "reviewed" and "criteria verified" stay separate;
- found work becomes a card (or a follow-up linked to one), not a line in chat; dependencies kept;
- a step inside a run is not a card;
- the page: overview (active plan and card, counts, open questions and requirements, recent runs), an
  execution graph from the same data, a card's detail (criteria, dependencies, runs, terminals, git,
  tests, evidence), and the assistant panel aware of the selected card, with the card it works on lit.

**W2 — Terminal and Git** (§5–6): real PTY sessions with tabs and splits, built on the execution layer
the assistant's calls already use (no second process manager); the assistant can open and use them and
tie them to a card. Git: status, branches, remotes, fetch/pull/push, staged and unstaged with line
diffs, history and graph, branch/commit/merge/rebase, conflicts, PRs — linked to cards and runs, with
the existing guards and commit identity, and nothing uncommitted ever dropped without a confirmation.

**W3 — Environments** (§7–8): one provider interface (local, SSH; containers later). SSH profiles with
host-key checks, a connection test, remote terminals, checkout, logs and processes. Secrets stored
apart, never shown to the model or in logs; per-environment permissions; production asks more.

**W4 — Run, test, deploy** (§9–10): services with start/stop/restart, ports, env, status, logs, health
and a preview URL; a light pipeline git → build → test → run → validate → deploy per environment,
observable stage by stage, its evidence on the card; production needs approval, keeps history and a
rollback where it can.

Constraints from the brief (§15) hold throughout: reuse before adding, no duplicate models, no fake
states, no polling or model calls that are not needed, long runs supported, user data kept.

## Materials

Screenshots the owner gave as references (2026-11-01):

| | what to take from it |
|---|---|
| [terminals-ai-clis.jpg](img/workspace/terminals-ai-clis.jpg) | Terminal (W2): project tabs with a session count, a split grid of live sessions, a side rail of sessions with *Working*/*Idle* and age, a run/build bar per service. |
| [git-graph.jpg](img/workspace/git-graph.jpg) | Git (W2): branch lanes beside commit rows, local/remote/PRs on the left, unstaged/staged and the commit box on the right. |
| [environments-services.jpg](img/workspace/environments-services.jpg) | Environments and runtime (W3–W4): services with a status chip (running, deploying, error), a side panel with build progress, nodes and a live log with *Back to Live*. |
| [deploy-pipeline.jpg](img/workspace/deploy-pipeline.jpg) | Deploy (W4) and the execution graph (W1): stages as columns left to right, each with its duration and a check, the running one open. |

![terminals](img/workspace/terminals-ai-clis.jpg)
![git](img/workspace/git-graph.jpg)
![environments](img/workspace/environments-services.jpg)
![deploy](img/workspace/deploy-pipeline.jpg)
