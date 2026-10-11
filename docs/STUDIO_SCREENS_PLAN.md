# Studio screens — review and plan (2026-10-11)

Every screen in the menu, opened on the callbot (`educa_reminder_agent`), on
desktop (1500 px) and phone (390 px), light theme. What follows is what was
wrong or missing, with the evidence, and what each phase changes. The Flow
canvas keeps its theme and layout: nothing found there is worth the risk of
touching a finished design.

## What was found

| Screen | Finding | Evidence |
|---|---|---|
| Playground | A voice call shows only what the bot said. What the caller said (the STT transcript) is not shown, so a misheard word is invisible while testing. | A fake-microphone call: STT heard `anh bận lắm gọi lại sau đi`, the log showed only the bot's lines. |
| Playground | No choice of microphone or output: a headset plugged in next to a webcam mic is not selectable; the browser default is used. | `getUserMedia({audio: {...}})` with no `deviceId`; output always `audioCtx.destination`. |
| Playground | No sign of how fast the bot answered. | — |
| Playground | A variable `resources.yaml` needs that is not set is found only when the call fails. | The callbot's `.env` has no `STT_API_KEY`; the call failed at once (fixed in #50 to say so). |
| Services, Resources | `${STT_VERSION:}` — a variable with an empty default — is reported as not set. | Services banner: "not set: REDIS_CLUSTER_NODES, STT_VERSION". |
| Monitor | A 7-day chart labels its axis with times only (`22:53 10:53 22:53`), no days. | Screenshot. |
| Monitor | "+1 more (hover a line)" is drawn over the plot, across the newest bar. | Screenshot, both charts. |
| Review | A call reads with every line two or three times: the greeting from `greet` and again from `choose_reply`; the caller's words from `stt`, `answer` and `transcript`. | Screenshot of `play-234c7935`. |
| Runs | The output column shows raw JSON (`{"agent_state":"AgentState(current_state…`) while the input column shows `key value` pairs. | Screenshot. |
| Prompts | Lists only LLM ops (`llm_classify`). The callbot's real prompts — each agent's `prompts.yaml` — are not reachable from here. | Screenshot. |
| Header (phone) | The project and graph pickers shrink to `e… ⌄ / w… ⌄`. | Phone screenshots. |
| Resources | Title, description and the search box crowd one row; the description runs under the title with no gap. | Screenshot. |

## Phases

**S1 — Playground, a real call.**
- The caller's words in the log, as they are heard: a line per STT transcript
  (from the session's `ops` events), on the right, in time order with the
  bot's lines.
- How fast it answered: the time from the caller's last transcript to the
  bot's next audio, on the bot's line.
- Microphone and output pickers (`enumerateDevices`; output through
  `AudioContext.setSinkId` where the browser has it), remembered per browser.
- Before a call: the variables the service's resources need that are not set,
  named (never their values), with the file to put them in.

**S2 — Correct numbers and words.**
- A `${VAR:default}` with an empty default is not "not set".
- Monitor: day labels when the range is over a day; the "+N more" note moves
  out of the plot.
- Review: consecutive lines with the same text on the same side are one line
  naming every op that produced it.
- Runs: the output column reads like the input column.

**S3 — Reach and fit.**
- Prompts: the agents' prompt files listed under the LLM ops; one click opens
  the file in the YAML editor.
- Header on a phone: the pickers keep a readable name (the graph picker
  hides; the project name gets the room).
- Resources: the header on two rows — title and actions, then the
  description.

**S4 — A run read as a conversation, for any product that has one.**
- The rule (`review.conversation`) reads the user's side from what came in
  through the ingress door (text items; audio frames are skipped), as it
  reads the bot's side from what went out through the egress door; a
  `transcript` output and a playground script still count. Lines the same
  on the same side, one after another, are one line naming every op.
- The run page gets a third view, **Conversation**, beside Tree and
  Workflow — offered only when the run has at least one line on each side
  (a callbot call, a chatbot session: yes; a batch job: no). Each line
  opens its step in the tree; a bot line says how long after the user's
  words it came.
- Nothing is declared per project. A service whose message is buried in a
  bigger payload would name the field; not built until one needs it.

Each phase: screenshots desktop and phone, the JS and studio tests, merged on
its own.

## Progress

| Phase | State | Evidence |
|---|---|---|
| S1 | done | operonx 1.22.1 (#148: ops events carry `said`, `at`). A fake-microphone call to the callbot: the caller's words shown as heard (`anh bận lắm gọi lại sau đi`), the bot's next line timed from them, the call hung up. `${VAR:}` no longer reported missing (both of the callbot's false alarms gone); the IR cache is keyed on the extractor's source, so a studio update re-extracts. |
| S2 | done | Monitor: a 7-day chart's axis reads `Oct 4 23:25 · Oct 6 17:25 …` (was `22:53 10:53 22:53`); version labels and "+N more" on a row above the plot, never on the bars. Runs: the output column reads a record field by field and a chat history as its last words — the callbot's rows say how each call ended (`“Dạ do đường truyền không tốt…” (8 messages)`) instead of `{"agent_state":"AgentState(…`. Review's repeated lines: done in S4. |
| S3 | — | — |
| S4 | done | The rule reads the user's side from the ingress door (what the op it fed received — the door is transient), merges repeated lines, drops the user's words echoed as a "reply" and marker words (`[Silent]`). Callbot call `load-b122-8cd5dc59`: 4 lines (was 8+), each naming its ops. A chatbot project (`chatdemo`, not the callbot): user/bot lines from its doors, each linked to its step. Run page: **Conversation · Tree · Timeline**, offered only when both sides exist; a line opens its step beside it; desktop and phone, light and dark. |
