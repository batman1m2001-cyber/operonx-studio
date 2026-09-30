# Backlog — everything left, to done

Written 2026-09-29, after operonx 1.10.2. You said: clear it all. Each item
has a **done when** — a check that can be run, not a feeling. Decisions I
took are marked **Decided** with the reason; only what cannot be done
without you is marked **Yours**.

## 1. operonx — fix the catalogued findings (release 1.11.0)

The guide documents several bugs as "never do X". Fixing them is better
than documenting them. Every fix starts with a failing test that reproduces
the finding, and ends with that test passing and the full suite green.
Findings refer to `docs/design/OPEN_FINDINGS.md`.

| Group | Items | Done when |
|---|---|---|
| **O1 Branches and Refs** | S7 Ref-vs-Ref in `if_()` (compare to another Ref works) · S8 `_resolve` keyed by source and var · S9 `hasattr()` on a Ref raises for `_`-names · E2 a `.build()` branch with no match runs no target · E8 `START >> if_(...)` works (predicate op too) · **added** E9 `and`/`or`/`not` on a Ref raises (it silently used only one side) | each has a test; the guide's "never compare two Refs" and "always `.else_()`" rules become plain advice or go |
| **O2 Scheduler** | E1 one hard + two soft edges waits for the hard one · E3 `.parallel(max=N)` limits · E4 an op on a loop's exit arm runs once; ops after a loop run once · E6 an erroring back-edge source stops the loop · E7 `.collect()` behind a per-item op gathers the whole stream · C4 dead loop path removed · S2 `loop_iters` removed · S3 duplicate block removed · S4 comments match the per-edge design · S5 a late `fatal` is not dropped | a test per behaviour; loop and streaming suites green |
| **O3 Errors and state** | S1 an op that raises: **Decided** — a run still does not raise (one bad op must not kill a live call), but `run()` returns `"$errors"` and `handle.errors` names each failed op, the dead handlers go, and `execution-flow.md` says what happens · C1/S6 first and later calls resolve inputs the same way · C2 `stream()` raises a fatal error like `run()` · C3 `__interrupt__` is not in the payload | tests; the guide's "an op that raises" section shows `"$errors"` |
| **O4 Agent layer** | A1–A8 | a test per finding |
| **O5 Providers and harness** | P1–P7 (P1, P2 in `packages/operonx-code`) · **added** L1 `LLMOp` `user=` fails at build, not silently at run · L2 a Ref in `validators=` fails at build | a test per finding |
| **O6 MCP and heartbeat** | M1–M5 | a test per finding |
| **O7 Manifest** | E5 `operonx.toml` accepts `on_error = "record"` | a test |
| **O8 Docs** | `OPEN_FINDINGS.md` records each as fixed; the guide drops the rules the fixes made unnecessary; `CLAUDE.md`'s stale examples (`ask()`, `chat()`, `GraphOp.loop`) rewritten; `HANDOFF.md` (written for 1.3.0, still "read this first") brought to 1.11.0 | `tests/guide` green; no stale API names in `CLAUDE.md` |
| **O9 Release** | 1.11.0: PR, CI green | **Yours:** merge; then PyPI has 1.11.0 |

## 2. Callbot (`feat/runs-by-origin`)

| Item | Done when |
|---|---|
| **K1** Pin operonx 1.11.0 | 291 tests, the same 2 env-var failures as before; inline branches renamed `route_N` noted |
| **K2 (D1)** Capacity, re-measured on this build, locally (never the telco gateways): 5, 8, 10, 12 calls at once with `bench/run_ccu.py` | a table (per-turn time to first audio, p50/p95, lateness) in the callbot's docs, compared with 2026-08-28 |
| **K3 (D2)** Queues between ops | measured under K2's load first: if a queue grows without bound, bound it (in operonx if the queue is operonx's) with a test; if it does not, record the measurement and close |
| **K4 (D3)** Call store configuration | `call_store:` is a resource in `resources.yaml` like the others; `call/_store.py` reads it; tests green |
| **K5 (S3)** Merge request into `refactor/operonx-studio` | the pre-filled link is ready. **Yours:** click Create |
| **K6 (S4)** Into `staging` | a re-sync plan and a merge request prepared from K2's numbers. **Yours:** merging deploys a running environment; I do not merge it |

## 3. Studio

| Item | Done when |
|---|---|
| **T1 (S2)** Land the branches | `feat/assistant-first` pushed, one PR into `main` (each phase its own commit, reviewable one by one); pin raised to 1.11.0. **Yours:** merge |
| **T2** Light node-kind colours | **Decided:** keep. The only passing set is olive and brown at the floor; kinds already carry an icon and a label, so colour is never the only cue. Recorded in the plan |
| **T3 (B9)** The team version | its own plan (`docs/TEAM_PLAN.md`): per-user accounts, each with their own conversations and Claude sign-in, then viewer and editor roles; built phase by phase with the usual gates |

## 4. Only you

- **U1** A voice call with headphones: `educa_reminder_agent` → Playground → `call` → Voice.
- **U2** One real sign-in to the assistant.
- **U3 (S5)** A permanent address for the studio needs an account in your name (a Cloudflare named tunnel, or a paid localhost.run domain). Give me the account and I set it up.
- **U4** Merge the PRs and click the merge requests.

## 5. Order

O1–O8 run in parallel (disjoint files), then O9. K1–K4 follow the release;
T1 with them. T3 last. Progress is recorded in §6 as each item closes.

## 6. Progress

| Item | State | Evidence |
|---|---|---|
| O1–O6/O7 | in progress | six agents, one worktree each under `/home/thanglq/operonx-wt/`, branches `fix/o1…o6`, off operonx `main` 444aae3 |
| O8 `CLAUDE.md` | done | `release/1.11.0` cd729cb — no `chat()`/`ask()`/`GraphOp.loop`; wiring styles it shows re-run against 1.10.2 |
| K4 | done | callbot 838586b — `call_store:default` + `source:call_logs` in resources.yaml, same variable names; 295 tests pass |
| T3 plan | done | `docs/TEAM_PLAN.md` — six phases P1–P6, each with its gate; claims spot-checked against app.py, chat.py, assistant.py |
