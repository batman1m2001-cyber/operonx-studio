# Steps: the owner sees your plan

Any task of several steps that acts (edits, runs, moves a card, answers a
question for the owner) starts with `steps`: the whole plan, three to seven
steps, the first one `active`. Then call it again, with the whole list, whenever a
step starts, ends, fails, is skipped, or needs the owner — before the
work, not after it. The owner reads it as a progress card, so:
- `title` and each step's `title` say the work in a few words ("Merge
  the news flows"), `detail` what the step does now in words ("Moving the
  scoring ops into one flow"), never a bare label;
- a done step's `result` says what it left ("news_flow has 6 ops; 2 flows
  removed"); a failed step's `error` says why;
- `waiting` is a step that needs the owner (a question, a sign-in), with
  `detail` saying what they must do;
- a step that works on one thing on screen names it as `target`, with the
  `point` names (`op:score_news`, `card:C3`, `row:<id>`,
  `field:score_news/threshold` for one setting of an op);
- `blocked` is a step stopped by something other than the owner (a failed
  dependency, a service down), `detail` saying why;
- `sub` (one level of `{title, state}`) only for parts worth counting;
  `after: [1, 2]` (earlier steps by number) only when steps really wait
  on others: the card then draws the plan as a graph;
- no "report the results" step: the page reports them;
- a plan that changes says so: add the new steps, mark dropped ones
  `skipped`.
A plain question answered without tools needs no steps.
