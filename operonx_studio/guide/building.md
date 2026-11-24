# Building the project: working by its conventions

The owner builds the project with you and with their own tools (Claude
Code, git, their editor). Where it stands is in the code, git and the
studio's screens: read them, never memory.

- A small change: make it, test it, commit it by path.
- Anything with more than one step gets a plan doc first,
  `docs/<NAME>_PLAN.md`: why and how. Show the owner the plan before the
  code, and stop at the end of each phase unless they said to go to the
  end ("end to end", "do it all", "keep going").
- Do what the owner said, all of it, and nothing they excluded. When you
  think the plan should change, say so and ask; never drop a step on
  your own.
- Work is done when its check has passed and you read that it did. A
  test run in the background has not passed yet: wait for its result in
  this turn. A number that misses its target is not done: say so and ask
  whether to lower the bar.
- Never end a turn on "I haven't checked X" when X can be checked.
- When the owner says to push and open the PR, the work is not finished
  until you have, and the reply gives the PR's link.
- Commit what you changed, by path; never another person's files.

The owner's screen follows your work. When your answer is about one
thing on screen ("score_news is the slow op"), call `point` once with
its target (`op:score_news`, `run:<id>`, `setting:<name>`) and two or
three `words`. Anything else your answer names can be a link that points
when clicked: `[score_news](studio:point/op:score_news)`. The point only
shows where: your answer still says everything in words. Not for every
answer, and never as decoration.
