# Reading a step's input and output

**Status:** I1 and I2 done (2026-10-13).

## What is wrong

Open `agent_turn` in a callbot run (for example `demo-conv-2fe8ed`).
The step panel is about 1,500 px tall:

- Every field is a name line with its value on the line below. `intent` and `confirm` take two lines to say one word.
- Every nested object is fully open. `agent_state` shows 10 fields on the output, then the same 10 again on the input. `script_data` is open too.
- `response` appears twice: once as an output field, and again inside `result`, which repeats four outputs.
- Each empty field (`last_intent`, `channel_info_buffer`, `new_phone_number`, `extraction_data`) takes a line saying "empty string".
- Nothing says what the step changed. The question you ask of `agent_turn` is "what did the state go from and to?", and the panel makes you answer it by comparing two 10-line lists.
- The run's own output, at the top of the run page, shows `AgentState(current_state='FINISH', …)`, a Python repr, not fields.

All of this is in `IO.valueView` and `IO.fields` (`static/io.js`). They draw every object the same way: open, one field under another, nothing ranked or compared. The run-page header, the run page's step panel and the Workflow panel all use them, so one fix covers all three.

## The rules (Formatted mode; JSON mode is unchanged)

1. **One line per simple field.**
   - A number, a boolean, null, or a one-line string of at most 80 characters sits on the same row as its name. The name takes a column of about a third of the width.
   - Longer text keeps its own block under the name, with its existing clamp.
2. **Nested objects fold, with a preview.** A nested object or list that is not media, a chat, chips or a table is a fold row:
   ```
   ▸ agent_state   AgentState · current_state FINISH · should_hangup true · …
   ```
   - It is open from the start only when it is small: at most 4 fields, all simple.
   - What you open or close is remembered for the session by side and path, so stepping to the next run of the same op keeps your view.
3. **Empty fields collapse into one line.** `""`, null, `{}` and `[]` gather at the end of their list as `4 empty — last_intent · channel_info_buffer · …`, and a click shows them. `false` and `0` are values and stay.
4. **The output says what changed.** An output object that is also an input (state passed through) shows as a change, not a copy:
   ```
   ▸ agent_state   3 changed · current_state REMINDER → FINISH · should_hangup false → true · …
   ```
   - Opened, the changed fields come first, each showing the old value and the new one. The rest fold as `6 unchanged`.
   - If nothing changed, it says `unchanged`.
5. **Repeats fold.** An output object whose every field equals a top-level output of the same name, like `result` in `agent_turn`, is a closed, dim row: `same as response · intent · new_state · play_without_interrupt`.
6. **The op's show keys come first.** In the output, the fields the op declares as show keys are listed first and marked, because they are what the tree row already shows.

7. **Input, then Output, as Langfuse reads them.**
   - This is time order: what came in, then what came out.
   - Each card folds from its title and stays folded as you step from one execution to the next, and across reloads where storage allows. If you read only outputs, fold Input once.
   - No separate scroll pane per card. A scroll box inside the scrolling side panel traps the wheel, gives each half about 350 px on a laptop, and fails on a phone. Long text is already clamped behind "Show all".
8. **Langfuse's look.**
   - A plain "Input" or "Output" title over a plain table.
   - Nesting shows as indent inside that table, not as boxes inside boxes.
   - No coloured side bars.
   - In a narrow panel, a long value goes under its name, and names wrap only after an underscore.

## Phases

- **I1, the studio (`static/io.js`, `studio.css`, `runpage.js`).**
  - Rules 1–6.
  - Pure helpers, node-tested: `isEmpty`, `changes`, `repeats` and `preview`.
  - Screenshots on desktop (light and dark) and phone, of `agent_turn`, `transcribe`, an LLM step, and the run header.
- **I2, operonx (`telemetry/runs/model.py`).**
  - A run's input and output preview reads a dataclass or pydantic model as its fields (`fields_of`), not `repr()`.
  - Ships as a patch release. The callbot picks it up with its next bump.

## Out of scope

The JSON mode, the chat and LLM reply layout (already its own view), and the tree rows.
