# Studio: the pages operonx's platform work needs

Status: plan (2026-10-05). Follows operonx E7 (#93, review queues, online evals, score alerts)
and R2–R4 (live traces, journal, run queue).

## 1. What operonx has that Studio does not show

| operonx | Studio today |
|---|---|
| `[[queue]]` review queues (`operonx.app.evals.queues`): items, `review()` writes a human score, `queue_agreement` | the Review tab reads runs and writes its own `.operonx/reviews.jsonl`; operonx reads it only through `reviews_as_scores` / `migrate-reviews` |
| online evals write scores daily to the score store; alerts `score_mean:` / `score_fail_rate:` | experiments only — no trend of a production score over time |
| a durable webhook's run queue (`operonx.app.queue`): queued / running / failed rows, attempts, stops | nothing |
| live traces (R2): a run's trace while it runs | the Runs tab lists runs that ended |

## 2. Decisions

| # | Decision |
|---|---|
| S1 | Review: a queue picker beside the run picker lists the project's `[[queue]]`s. A queue's items open as the same conversation view; good/bad/labels go through `operonx.app.evals.queues.review(...)` (a `source="human"` score, the reviewer named). The run-based review stays for projects without queues. |
| S2 | Monitor: a **Scores** panel — per score name, the daily mean (line) and the share failing (bars below, its own axis — two charts, never one dual-axis), from the score store, with each `score_mean:` / `score_fail_rate:` alert threshold drawn as a rule. Built per the dataviz method (palette validated, hover, table view). |
| S3 | Services: a service with `queue=` shows its rows — counts by status, the oldest queued age, the running ones with attempts and worker, the failed ones with their error; a "retry" button re-queues a failed row (a new attempt, same run id). |
| S4 | Runs: runs whose trace is still open are listed first with a live dot and their elapsed time; opening one follows it (the trace view polls until it ends). |

## 3. Order

S3 (smallest, new data) → S1 → S2 → S4. Each: API test, then UI with desktop + phone screenshots.
