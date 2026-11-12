# Board

One card per task (LEAN_PROJECT_PLAN §5). The assistant moves the cards; edit a card's fields, not its state.

## PS · Every project up to the standard, by the assistant · open
plan: docs/PROJECT_STANDARD_PLAN.md · opened: 2026-10-23

### C7 · S1 The engine says what the standard is and where a project stands against it · done

### C8 · S2 The studio shows it and offers one action · done

### C9 · G1 Git per project — who commits · done

### C10 · S3 The assistant does it on clones; fix and retry until every project passes · done

### C11 · S4 The passing work lands in the real repos · doing

### C12 · S5 Live studio and the report · todo

## Backlog

## L · The assistant works the screen · closed
plan: docs/ALIVE_ASSISTANT_PLAN.md · opened: 2026-10-23 · closed: 2026-10-23

### C1 · L1 The hand — go · done

### C2 · L2 Project mode's targets · done

### C3 · L3 Project mode follows the assistant's work · done

### C4 · L4 The assistant points on purpose · done

### C5 · L5 The rest of the studio · done

### C6 · L6 Gate · done

## E · A long tool call shows its stages, its real progress and whether it is alive · closed
plan: docs/EXECUTION_PROGRESS_PLAN.md · opened: 2026-11-01 · closed: 2026-11-01

### C13 · E1 Every shell call observed: the hook wraps foreground and background calls, records the shell's pid · done

### C14 · E2 progress.py: one parser registry (tests, install, build, lint, fetch, docker, generic) → stages and counts · done

### C15 · E3 Stages of a chained command: a conservative top-level split, markers between the parts · done

### C16 · E4 The relay: liveness from /proc, coalesced progress events, background calls linked to their task, stop one call · done

### C17 · E5 The page: the running row's bar, counters, liveness and stages; the status line; node tests · done

### C18 · E6 Knowledge: separate stages, background past two minutes, never poll · done

### C19 · E7 Live gate: a Sonnet turn on the scratch studio, shots, overhead and gap measurements · done

## S · A turn ends on what it really did · closed
plan: docs/TURN_HONESTY_PLAN.md · opened: 2026-11-01 · closed: 2026-11-01

### C20 · S4 A call the studio's guard refused is guarded, not failed · done

### C21 · S1 Plan phases marked done are sent back once for their evidence (stophook.py) · done

### C22 · S2 failing_on_base: failing tests run on the base branch; a red last run is sent back until it is called · done

### C23 · S3 What the turn leaves: open steps (strip + hook), worktrees it made (card with Remove) · done

## W · One project, one execution model — the studio as a development workspace · closed
plan: docs/WORKSPACE_PLAN.md · opened: 2026-11-01 · closed: 2026-11-01

### C24 · T1 A phase marked done is checked for how it was met: the plan's way, or the owner's call · done

### C25 · T2 "I haven't checked" in the last reply sends the turn back once: check it, or say why it can't be · done

### C26 · T3 on_base(command): any check run on the merge-base, not only failing tests · done

### C27 · W0 Audit: where plans, board, checklist, questions, steps, runs and git disagree, and why · done

### C28 · W1 Unified project execution model: card ↔ run ↔ steps ↔ evidence; board follows the assistant · done

### C29 · W2 Terminal and Git: real sessions on the existing execution layer; git page linked to cards · done

### C30 · W3 Environments: execution providers (local, SSH), secrets never reach the model · done

### C31 · W4 Run, test, deploy: services, health, preview URL, staged deploy with approval for production · done
