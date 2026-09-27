# Assistant: the next improvements (plan)

Status: **being built, in the order of §7.** Your decisions (2026-09-27)
are in §3 and §6; what has landed is in §8. Branch `feat/assistant-first`.

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

## 3. Decided: the assistant's Claude sign-in

Decided 2026-09-27. You chose the browser flow; where the sign-in lives
was left to me.

- **The flow is the VS Code extension's.**
  1. *Sign in with Claude* opens claude.ai's sign-in page in a new tab.
  2. You sign in there with your own account.
  3. The page then shows a code. You paste it back into the studio, and
     you're done.

  The code step is how the `claude` CLI completes a sign-in from a
  browser on another machine; it's the same in VS Code's remote mode.
- **The sign-in lives in the studio's own place,** `~/.operonx/claude`
  (`CLAUDE_CONFIG_DIR`). Signing in or out there never touches this
  machine's own Claude Code (your VS Code).
- **Until you sign in there,** the studio keeps using the machine's login
  and says so ("Using this machine's login (you@…)").
- **Switching accounts:** a Claude session can't be resumed under a
  different sign-in. So after a switch, the next turn starts a fresh
  Claude session seeded with a summary. The studio's transcript stays
  whole.
- **Later:** the team version (B9) moves this to one sign-in per studio
  user, without a redesign.

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
| **A5 Sign-in** | T6 and the account UI, as decided in §3 | Automated up to the URL, then cancel. The first full sign-in needs you to paste the code once. |

The full build order, with the backlog items folded in, is in §7.

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

### 6.1 Decided on 2026-09-27

B1 and B2 are your calls; B3 to B9 you left to me.

| # | Question | Decision |
|---|---|---|
| B1 | Where the sign-in lives | See §3: the studio's own, with the browser flow you described |
| B2 | The canvas look | **Bring the brain-cell look back** (your taste). Measured on `main` (callbot): it runs *no* animation at rest, and idle frames hold 16.8 ms p95. Its costs are about 5 SVG elements per wire (glow, core, filament and sparks) and 98 blurred or shadowed elements, which weigh on very big graphs. Its 101 ms render was mostly the old unbatched layout step, which is fixed and stays fixed. The restore keeps every layout fix, and motion only while something runs. |
| B3 | Tool servers | **Let a project's own servers in.** A turn's tool config becomes the studio's server plus the servers in the project's `.mcp.json`. `--strict-mcp-config` stays on, so your personal connectors stay out. |
| B4 | Decision rows without a wire | **The loop return leaves from its own row's dot**, and an exit route's tie to END leaves from its row too |
| B5 | A run of a graph that isn't on the canvas | **If it's one of the project's graphs,** the canvas switches to it and says so. **If the studio doesn't draw that graph,** a note says "This run's graph (`params`) isn't drawn here", with *Open as tree*. |
| B6 | Phone landing view | **Keep the readable 70%**, but land on the flow's START (its entry) rather than its middle |
| B7 | Where playground runs are recorded | **Confirmed:** local only. A session opts in with `remote: true`. |
| B8 | Replaying production runs | **Opt-in per service, for text and JSON doors only.** Audio and other media are never stored. Retention is 7 days, and it's off by default. It needs an operonx change (a door records its incoming items when its service opts in), so it ships with an operonx release. |
| B9 | The shared-team version | **Not now.** It comes next after this plan ships, or as soon as a second person needs access. Its first step is per-user accounts with their own conversations and their own Claude sign-in (B1's third option); then viewer and editor roles. |

### 6.2 Not done: all approved

You approved all five on 2026-09-27.

| # | Item | How |
|---|---|---|
| N1 | Dark mode | A System, Light or Dark choice (in Settings and the header menu), remembered per viewer. Every colour token gets a dark value, the canvas included (the brain-cell palette, wires, door frames, live states). Contrast is checked with the palette validator. Every screen is screenshotted in both themes, and the layout audit runs in dark too. It comes after B2, so it darkens the final look. |
| N2 | Shrinking the scripts (minifying: comments, spaces and line breaks removed before sending; same behaviour, fewer bytes) | At bundle time, with `rjsmin` and `rcssmin`: small pure-Python packages, no node. Measured on the real bundle: JS 129 → 93 KB gzipped (−36 KB), CSS 31 → 24 KB (−6 KB), in 12 ms once at startup, and the minified bundle parses. `OPERONX_STUDIO_MINIFY=off` serves it readable for debugging. Licences to confirm (Apache-2.0 expected). |
| N3 | Starting the playground bridge early | Start a project's bridge on intent: the pointer or focus on Playground, or a project with doors after 3 s idle. One bridge per project, at most 2 warm at once, stopped after 15 idle minutes (already the case). Measure the first open (1.3–3.6 s cold today) and each bridge's memory. |
| N4 | A revisited screen's last data at once | Each screen keeps its last data for the life of the page. A revisit paints it at once, refreshes it in place, and quietly marks what changed. Measure revisit time before and after. |
| N5 | A live callbot voice session | After S1 (the callbot needs operonx 1.9), recorded locally only (B7). First with Chrome's fake microphone playing a call recording (automated), then you, with headphones. Check the ops lighting up on the canvas, the Monitor's latency and the run's trace. It uses the shared STT/LLM/TTS from the callbot's `.env`, and never the telco gateways (9922 production, 9926 staging). |

### 6.3 Shipping: still to discuss

| # | Item | State |
|---|---|---|
| S1 | **operonx 1.9.0** | Branch `feat/runs-records` (8a0ea7d on top; `main` is at 1.8.1). After release, bump the pins in the studio and the callbot. |
| S2 | **Landing the studio work** | `feat/assistant-first` stacks on `feat/platform` on `redesign/ui`; none are pushed. The studio's `main` is 1d9c773. One PR, or one per phase? |
| S3 | **Callbot `feat/runs-by-origin`** | 4 commits (runs by origin, key ops, the playground codec) on top of the pushed `refactor/operonx-studio` (ee83947), not pushed |
| S4 | **Callbot refactor into `staging`** for a real deploy | You asked on 2026-09-18 and said not yet. `staging` has moved since (2b85dc4) and needs a re-sync plan. `staging` is never touched without you. |
| S5 | **A permanent tunnel** | A Cloudflare account for a named tunnel, or a localhost.run key. The quick-tunnel URL changes on every restart. |

### 6.4 Before a real callbot deploy: still to discuss (last measured; may be out of date)

| # | Problem | Note |
|---|---|---|
| D1 | **Capacity** | Fine at the 5-call target, with headroom to about 8, and collapsing at 10 or more (1.7 s late at 10 calls, 3.5 s at 12). Measured on 2026-08-28, *before* the application-layer refactor; re-measure on the current build. |
| D2 | **Queues between ops are unbounded** | The old channel capped at 4,000 items and counted drops; today a queue grows silently under overload |
| D3 | **Call store configuration** | `call/_store.py` reads its settings from the environment. Candidate: make it a `call_store:` resource like the others. |

## 7. Build order

Every phase is committed separately. Each is checked with:
- the studio's tests;
- `flows.py` (and `live_assistant.py` for the assistant phases);
- the layout audit (`scripts/perf/layout_audit.py`, 0 errors) for
  anything that touches the canvas;
- desktop and phone screenshots.

| # | Phase | Contents | Extra gate |
|---|---|---|---|
| 1 | **A1** Composer | §1.1 and paste cards | A 30-line prompt, pasted JSON, the phone sheet |
| 2 | **C1** Canvas | B2 brain-cell look, B4 loops from their row, B5 runs of other graphs, B6 phone landing | Before and after screenshots; the 302-op graph within its render budget |
| 3 | **A2** Input and images | T1 (probe first), T2, image tray, file cards | A 200 KB paste; an image turn |
| 4 | **A3** Model and effort | T4, the menu, `/effort`; also B3, a project's own tool servers | The next turn's `init` shows the new model; a project's server is loaded, and personal connectors are not |
| 5 | **A4** Usage | The ring, the usage card, reset times, nudges | Values match the stored usage |
| 6 | **A5** Sign-in | T6, as decided in §3 | Automated up to the sign-in URL; then one real sign-in by you |
| 7 | **N2, N4, N3** | Minify, last data at once, early bridge start | Bytes and times measured before and after |
| 8 | **N1** Dark mode | Both themes on every screen | The palette validator; the layout audit in dark |
| 9 | **S1 → N5, B8** | Release operonx 1.9.0 (you merge), then the live voice session and opt-in replay recording | A real spoken turn; a replayed production JSON session |

The order:
- **A1 first,** because the input box is what you feel most.
- **The canvas look before dark mode,** because dark mode themes the
  final look.
- **Sign-in after the other assistant work,** because the studio keeps
  working on this machine's login meanwhile.
- **The operonx release gates the voice session and replay recording.**

Still to discuss after this: shipping S2–S5 (§6.3) and the callbot's
pre-deploy risks D1–D3 (§6.4). B9 comes after this plan.

## 8. Progress

| # | Phase | Commit | Checked with |
|---|---|---|---|
| 1 | **A1** Composer | see git log (`assistant A1`) | `scripts/perf/composer.py` 42/42 with `--live` (one Haiku turn); `live_assistant.py` 23/23; `flows.py` 21/21; layout audit 0 errors in 328 cases; 480 studio tests (3 skipped); 39 JS tests |

**A1 notes.**
- **A JSON paste becomes a card from 200 characters, even on one line.**
  This goes beyond the plan's rule of 12 lines or 2,000 characters.
  Minified JSON is a single line, so under that rule the wall you pointed
  at stayed inline.
- **Old messages render too.** A message sent before cards existed, with
  a JSON wall under a question, now shows the question and then the tree.
- **The title skips the paste.** It comes from the words; a message that
  is only a paste is named after it ("Pasted JSON · 142 lines"). The
  naming call sees the words plus one line per block.
- **Fixed on the way:**
  - editing and resending an earlier message used to leave its text in
    the box;
  - a click on the side panel's drag bar used to store a width of 340 px.
