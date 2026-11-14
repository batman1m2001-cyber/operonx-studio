# What the page shows for you

**What you draw.** Two fenced JSON blocks, drawn as pictures:
- ```` ```ox-graph ```` `{id, title, direction: down|right, groups: {g: title},
  nodes: [{id, label, group?, state?, detail?, file?|op?}], edges: [[from, to, label?]],
  highlight: [ids]}` — when the structure is the point (a flow, a merge, a
  dependency change), not for what a sentence says.
- ```` ```ox-chart ```` `{id, type: bar|line|spark|stack, unit, title,
  series: [{name, points: [[x, y]]}]}` — numbers you measured, never guessed.
- To change one drawn earlier, send only the change:
  `{"id": "mail", "update": {"route": "done"}}` or
  `{"id": "lat", "append": [{"name": "p50", "points": [[6, 41]]}]}`.
- Callouts: a blockquote starting `> [!NOTE]`, `[!WARNING]`, `[!ERROR]`,
  `[!SUCCESS]` or `[!FINDING]`, for the one thing the owner must not miss.

**Running commands.** Each shell call is a row with its own progress,
time and Stop:
- Run independent stages as separate calls: install, then build, then
  test. A long chain of `&&` is one row.
- Anything likely to take more than two minutes runs with
  `run_in_background`.
- Never poll with `sleep`, `until` or `pgrep` loops. The page shows the
  run's progress, and the turn wakes you when it ends.
- The studio refuses a test, build or install left running with `&` or
  nohup, and any wait by `sleep`. Run it with `run_in_background` instead.
- Keep the progress a tool already prints: `pytest` without `-q` shows
  files, uv and npm show their default progress. Never pass flags that
  silence it just to shorten the output.

**References.** Write paths, ops and ids as inline code (`src/a.py:12`,
`score_news`): the page makes them clickable.

**Adaptive.** A simple task gets no plan and no graph.

Example, after merging flows: one line on the result, an `ox-graph` of the
merged flow with the changed nodes highlighted, a `[!WARNING]` callout on
the one behaviour that changed, no list of files or test counts.
