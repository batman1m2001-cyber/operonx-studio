# Assistant: the next improvements (plan)

Status: **plan only, 2026-09-27; nothing is built yet.** Branch
`feat/assistant-first`.

It covers five asks:
1. choosing the model, as in Claude Code;
2. seeing token, context and plan-limit usage;
3. signing in from the browser, as in the Claude Code VS Code extension;
4. a roomier input box;
5. rich input: code, JSON, images and files.

## 0. What exists today (inspected and measured, not assumed)

| Area | Today | Gap |
|---|---|---|
| Turns | `claude -p <message>`, streaming JSON out, every turn forked with `--resume --fork-session`, `--model` per conversation (`assistant.py` `_run`) | The message travels as **one command-line argument**; Linux caps one argument at 128 KiB (a 140 KB argument fails with "Argument list too long", measured). No `--effort` is passed. |
| Model | A footer pill and `/model`; the list is `opus`, `sonnet`, `haiku` and Default | `fable` is missing, there is no effort setting, and the pill sits under the box where few look |
| Usage | The server already stores the context used and the window, token totals, a cost figure, and **plan limits** from `rate_limit_event` (for example 26% of the 5-hour window, 48% of the 7-day) | The UI shows a context ring only above 50%, plus one line in the details popover. There are no reset times, the figures are only as fresh as the last turn, and the cost reads like a bill on a subscription |
| Sign-in | The CLI uses this machine's login (claude.ai, Max plan) | No UI. Measured: `claude auth status --json` reports the state. `CLAUDE_CONFIG_DIR` isolates credentials (a scratch directory showed signed out). `claude auth login` prints an authorize URL that redirects to `platform.claude.com/oauth/code/callback`, a page showing a code, then waits on stdin ("Paste code here"). |
| Input | A one-row box that grows to 35% of the viewport; about 370 px wide in the side panel | Plain text only. The user's message renders as plain text, so a pasted JSON shows as a wall. No paste handling, no images, no files. |

## 1. UX

### 1.1 The composer

- **One box with two zones:** the text on top, then a toolbar inside the
  box: `+` (attach), the model and effort pill, a spacer, the context
  ring, and Send (which becomes Stop). The row under the box goes away.
- **Height:**
  - it rests at two lines and grows with the text up to half the panel,
    then scrolls;
  - a handle on the top edge sets a height by hand, and it is
    remembered;
  - **⤢ Expand** opens a full-height editor over the transcript for long
    prompts; Esc returns and keeps the text.
- **Width:** the side panel keeps its drag bar and gets wider by default
  on large screens (420 px at 1440 px and up). Focus mode (Ctrl J)
  stays the roomy place.
- **Keys:**
  - Enter sends; Shift+Enter adds a new line;
  - ↑ in an empty box edits the last message;
  - Esc clears the box, or stops a running turn;
  - each conversation keeps its own draft.
- **Phone:** the sheet's box grows to 40% of the screen, and `+` offers
  photos and the camera.

### 1.2 Rich content

- **Pasting a long text** (over 12 lines or 2,000 characters) creates a
  card instead of flooding the box, for example "Pasted · 142 lines ·
  JSON". Clicking it previews it; it can be edited or removed.
  - It detects JSON (validated and pretty-printed, with a key count),
    code (Python, JS/TS, SQL, YAML, shell, from simple cues), logs and
    tracebacks, and plain text.
  - A short paste stays inline.
- **Images:**
  - they come in by paste, drag and drop onto the panel, or `+`;
  - thumbnails sit in a tray above the text; a click opens a larger
    view, and × removes one;
  - PNG, JPEG, GIF and WebP are accepted, resized in the browser to a
    1568 px long edge, at most 8 per message.
- **Text files** (`.py .json .csv .md .txt .log .yaml`) attach as cards.
  Each is sent as a fenced block under its file name. PDFs come later.
- **In the transcript,** the user's own message renders like the
  answers:
  - fenced blocks become code blocks with Copy;
  - JSON folds;
  - images show as thumbnails;
  - a long block is collapsed to 12 lines with "Show all".

### 1.3 Model and effort

- **The pill in the toolbar** reads, for example, "Opus 5.5 · High". Its
  menu has:
  - **Default**, marked recommended, showing the model it resolves to;
  - **Fable, Opus, Sonnet and Haiku**, each with a one-line "good for"
    and its context size;
  - **Effort:** Low, Medium, High, Extra high, Max, or Default;
  - a **"Use for new conversations"** checkbox, which sets the studio's
    default.
- **Commands:** `/model <name>` and `/effort <level>`.
- **Switching mid-conversation** is allowed; a thin divider records it
  ("Switched to Sonnet 5 · High"). If the conversation is already larger
  than the new model's window, the menu warns and offers to compact
  first.
- **Each answer's footer** names the model and effort that wrote it.
- **A model the account can't use** produces an error that says so and
  offers Default.

### 1.4 Usage

- **The context ring is always in the toolbar.** It is grey below 80%,
  amber from 80%, and red from 95% with a Compact action. Hovering or
  tapping it opens the usage card.
- **The usage card** (the ring, or `/usage`):
  - *This conversation:* the context bar (for example 25k of 1M,
    2.5%); tokens in, out and cached; the number of turns; and an
    "≈ $0.16 at API prices" line, worded so that a subscription never
    reads it as a bill.
  - *Plan limits:* bars for the 5-hour session ("26% used · resets
    3:40 PM") and the week ("48% · resets Mon 09:00"), with "as of
    4 min ago".
  - *Account:* the email and plan (Claude Max), with Switch account and
    Sign out.
- **Nudges:**
  - from 80% of a plan window, an amber line above the box ("82% of this
    5-hour session used · resets 3:40 PM");
  - at a limit, Send is disabled and shows the reset time.
- **Each answer's footer** gains its token count.

### 1.5 Signing in

- **The account** appears in the usage card and in Settings → Assistant.
- **When signed out,** or when a turn fails with an authentication
  error, the composer is replaced by a card: **Sign in with Claude**
  (subscription), with smaller links for *Console account (API
  billing)* and *SSO*.
- **The flow:**
  1. The user clicks Sign in; the studio starts the login.
  2. The sign-in page opens in a new tab.
  3. The card becomes step 2, "Paste the code shown after signing in",
     with a field and Continue.
  4. The card confirms "Signed in as you@… · Claude Max", and the
     composer returns.
- **Cancel** stops the login, which also times out after 10 minutes.
- **Sign out** asks for confirmation.

## 2. Technical

- **T1: the message goes in on stdin.** Turns use `--input-format
  stream-json` and write one user message (content blocks: images,
  then the text), then close stdin.
  - This removes the 128 KiB limit and is how images get in.
  - The title call stays on arguments; it is small.
  - *Probe first* (phase A2, a Haiku turn with an image, about $0.01):
    image blocks are accepted, and `--resume` still forks.
  - *Fallback:* save the image under the project's `.operonx/` and
    reference its path; Claude's Read tool opens images.
- **T2: attachments.**
  - *Upload:* `POST /api/assistant/sessions/{sid}/attachments` (base64
    JSON, at most 5 MB after resizing) → `{id, name, mime, size, w, h}`.
  - *Storage:* `~/.operonx/assistant/files/<sid>/<sha256>.<ext>`, mode
    0600, deleted with the conversation.
  - *In a turn:* the turn body lists attachment ids, and the user item
    stores references, not bytes.
  - *Serving:* `GET …/attachments/{id}`, behind the login wall.
  - Edit, retry and regenerate send the same references again.
- **T3: pasted blocks** are handled in the browser. They are sent as
  fenced Markdown in the text (```` ```json … ``` ````), so the model and
  the history both see them.
- **T4: models.**
  - `GET /api/assistant/models` returns the list (id, label, "good for",
    window) and the effort levels.
  - Conversations get an `effort` column (an additive migration).
  - Turns pass `--effort`.
  - The studio default lives in `[studio.assistant] model, effort`.
  - Validation: known aliases, or full ids matching `^claude-`. The
    model actually used is read from the stream's `init` event.
- **T5: usage.**
  - Keep the current parsing. Also store each window's reset time and
    status from `rate_limit_event`; capture one raw event in A4 to pin
    the field names.
  - The account is shared, so a studio-wide `last_rate` with its time is
    returned with conversations and on the pulse, and
    `GET /api/assistant/usage` returns `{rate, account, as_of}`.
  - `turn_end` gains tokens.
- **T6: signing in.**
  - `GET /api/assistant/account` wraps `claude auth status --json`,
    cached for 30 s.
  - `POST /api/assistant/login {method}` runs `claude auth login
    [--console|--sso]` with a stdin pipe, reads the URL from its
    output, and returns `{login_id, url}`.
  - `POST …/login/{id}/code` writes the code and a newline to stdin,
    waits up to 60 s, then re-reads the status.
  - `DELETE` cancels; `POST /api/assistant/logout` signs out.
  - Only one login runs at a time. The code is never logged, and the
    studio never reads the token (the CLI stores it with mode 0600).
  - Every Claude process, turns and titles alike, gets the chosen config
    directory (§3).
  - A turn failing with 401, "Please run /login" or "Invalid API key"
    becomes an `auth` error item, which brings up the sign-in card.

## 3. Decision needed: where the assistant's Claude sign-in lives

This is a security and infrastructure choice, so it's yours.

- **A (recommended): the studio's own sign-in** in `~/.operonx/claude`,
  through `CLAUDE_CONFIG_DIR`.
  - Signing in or out in the studio never touches this machine's own
    Claude Code (your VS Code).
  - Until someone signs in there, the studio keeps using the machine's
    login and says so ("Using this machine's login (you@…)").
  - *Cost:* a Claude session can't be resumed under a different sign-in.
    After a switch, the next turn starts a fresh Claude session seeded
    with a summary of the transcript. The studio's own transcript stays
    complete either way.
- **B: share the machine's `~/.claude`.** This is the simplest. But
  *Sign out* in the studio signs out VS Code and every `claude` on the
  server.
- **C: one sign-in per studio user.** This is right once the studio has
  several users; today it has one (root). A moves to C without
  redesign.

## 4. Phases

Each phase ships with:
- tests: offline, against the fake `claude` that replays streams;
- Playwright checks in `live_assistant.py`;
- desktop and phone screenshots;
- a few live Haiku turns.

| Phase | Contents | Checks added |
|---|---|---|
| **A1 Composer** | Box with toolbar, growth, handle, Expand, drafts, paste cards (JSON and code detection), user messages rendered as rich text | Paste JSON → card → sent fenced → rendered folded; a 30-line prompt stays comfortable; phone sheet |
| **A2 Input and images** | T1 (probe first), T2, the image tray, paste and drop, file cards | A 200 KB paste goes through (fails today); an image turn gets a description; retry keeps the attachments |
| **A3 Model and effort** | T4, the menu, `/effort`, the switch divider, the window warning | Switch mid-conversation: the next turn's `init` shows the new model; effort reaches the CLI |
| **A4 Usage** | The ring always shown, the usage card, reset times, nudges, tokens per answer | Values match the stored usage; the nudge appears at a forced 85% |
| **A5 Sign-in** | T6 and the account UI, after the §3 decision | Automated up to the URL, then cancel. The first full sign-in needs you to paste the code once. |

Suggested order: A1, A2, A3, A4, A5. A1 is what you feel most. A5
waits on §3.

## 5. Risks

- **Image blocks on stdin are not yet verified.** The A2 probe decides,
  with a fallback ready.
- **Reset-time field names are not yet verified.** A4 captures a raw
  event first.
- **Effort levels may not apply to every model.** The menu disables what
  the CLI rejects.
- **`fable` may not be available on every plan.** The error mapping
  covers it.
- **The sign-in can't be fully automated,** because it finishes on
  Anthropic's page. Tests stop at the URL, and one manual sign-in
  validates the rest.

## 6. Backlog: open problems to discuss

Collected on 2026-09-27 from:
- the earlier plans: `PLATFORM_PLAN.md` §9 and §14, `REFACTOR_PHASE2.md`
  §12, and `LAYOUT_HOTFIX_PLAN.md` §6.2;
- your messages in this session;
- the branches as they stand.

Nothing here is decided. Each item needs your call. Where I lean one
way, it says so.

### 6.1 Decisions waiting on you

| # | Problem | Options, and my lean |
|---|---|---|
| B1 | **Where the assistant's Claude sign-in lives** (§3 above) | *Its own sign-in* (lean), *shared with this machine*, or *one per studio user* |
| B2 | **The canvas look.** Phase 2 replaced the organic "brain cell" canvas you had chosen with plain, precise cards, and removed the always-on glow. The phase-2 brief asked for no glow. | Keep the precise cards (lean), or bring the cells back. The old look can be restored. |
| B3 | **The assistant loads only the studio's own tools.** This skips your personal connectors (Gmail, Drive, Calendar), which is intended. But it *also skips tool servers a project declares for itself*. In return, each answer starts about 1.3 s sooner. | Keep this, but let a project's own servers through (lean); or switch it off (`OPERONX_STUDIO_CHAT_STRICT_MCP=off`) |
| B4 | **Decision rows without a wire.** A row whose route loops back, or exits the graph, shows its port dot with no wire from it; the loop return leaves from the card's side instead. | Draw the loop return from its own row (lean), hide the dot, or leave it |
| B5 | **A run of a graph that isn't on the canvas.** For example, a job's `params` graph: its Workflow view paints the *current* graph with every card faded, which misleads. | Say so and offer the Tree view (lean), or draw the run's own graph when the studio knows it |
| B6 | **Phone landing view.** The flow opens at 70%, centred, with its sides cut off (the "readable over whole" rule). | Keep it (lean), or fit the whole flow on phones |
| B7 | **Where playground runs are recorded.** They go only to the service's local stores unless a session asks for `remote: true`, so a test never reaches production Langfuse. This was decided in P8 and flagged for you. | Confirm (lean), or record everywhere |
| B8 | **Production runs can't be replayed.** Only playground runs can: production traffic flows through ports operonx deliberately never records (audio frames). | Opt-in recording of incoming items per service. This has storage and privacy weight (call audio), so it's yours to decide. |
| B9 | **When to build the shared-team version.** The studio is personal-first: one login, no per-user conversations or sign-ins, no permissions. | Decide when teams are real. It relates to B1's third option. |

### 6.2 Not done: go or no-go

| # | Item | Status |
|---|---|---|
| N1 | Dark mode | The colour tokens are ready; no dark theme is defined or checked |
| N2 | Minifying the scripts | Parked: it saves about 0.25 s once per update and needs a new dependency |
| N3 | Prewarming the playground bridge | Parked: it costs a project interpreter per open page; the screen says it is starting instead |
| N4 | Showing a revisited screen's last data at once | Deferred until after one-hop loads, then measure whether the wait is still felt |
| N5 | A live callbot voice session through the playground | Never run. It drives the shared STT/LLM/TTS and the Redis TTS cache from the callbot's `.env`. The callbot's environment needs operonx 1.9 first. |

### 6.3 Shipping: waiting on you

| # | Item | State |
|---|---|---|
| S1 | **operonx 1.9.0** | Branch `feat/runs-records` (8a0ea7d on top; `main` is at 1.8.1). After release, bump the pins in the studio and the callbot. |
| S2 | **Landing the studio work** | `feat/assistant-first` stacks on `feat/platform` on `redesign/ui`; none are pushed. The studio's `main` is 1d9c773. One PR, or one per phase? |
| S3 | **Callbot `feat/runs-by-origin`** | 4 commits (runs by origin, key ops, the playground codec) on top of the pushed `refactor/operonx-studio` (ee83947), not pushed |
| S4 | **Callbot refactor into `staging`** for a real deploy | You asked on 2026-09-18 and said not yet. `staging` has moved since (2b85dc4) and needs a re-sync plan. `staging` is never touched without you. |
| S5 | **A permanent tunnel** | A Cloudflare account for a named tunnel, or a localhost.run key. The quick-tunnel URL changes on every restart. |

### 6.4 Before a real callbot deploy (last measured; may be out of date)

| # | Problem | Note |
|---|---|---|
| D1 | **Capacity** | Fine at the 5-call target, with headroom to about 8, and collapsing at 10 or more (1.7 s late at 10 calls, 3.5 s at 12). Measured on 2026-08-28, *before* the application-layer refactor; re-measure on the current build. |
| D2 | **Queues between ops are unbounded** | The old channel capped at 4,000 items and counted drops; today a queue grows silently under overload |
| D3 | **Call store configuration** | `call/_store.py` reads its settings from the environment. Candidate: make it a `call_store:` resource like the others. |
