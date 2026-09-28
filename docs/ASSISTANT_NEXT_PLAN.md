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
| S1 | **operonx 1.9.0** | **Released 2026-09-28** (PR #59, merged as efd8b37; on PyPI, tag v1.9.0). Pins bumped: the studio `operonx>=1.9.0`, the callbot `feat/runs-by-origin` locked to 1.9.0. |
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
| 1 | **A1** Composer | e00ca94 | `scripts/perf/composer.py` 42/42 with `--live` (one Haiku turn); `live_assistant.py` 23/23; `flows.py` 21/21; layout audit 0 errors in 328 cases; 480 studio tests (3 skipped); 39 JS tests |
| 2 | **C1** Canvas | 660922d | layout audit 0 errors in 328 cases (with new checks for B4, B5 and B6); `flows.py` 21/21; 480 studio tests; B5 14/14 and B6 12/12 on desktop and phone; before and after screenshots; render and zoom measured below |
| 3 | **A2** Input and images | 1399806 | `scripts/perf/attachments.py` 20/20 with `--live` (an image described, regenerate resends it, a 200 KB paste); the probe below; 4 new server tests (484 studio tests); `composer.py` 35/35; `live_assistant.py` 23/23; `flows.py` 21/21 |
| 4 | **A3** Model and effort, **B3** project tool servers | 306f01f | `scripts/perf/models.py` 17/17 with `--live` (Haiku at low effort, then Sonnet: the footer and a divider say so; the project's `notes` server called); the MCP probe below; 5 new server tests (489 studio tests); `composer.py` 35/35; `attachments.py` 16/16; `live_assistant.py` 23/23; `flows.py` 21/21 |
| 5 | **A4** Usage | 0784444 | `scripts/perf/usage.py` 18/18 with `--live` (a Haiku turn: tokens in its footer, the card's numbers match the store, real plan limits "as of just now"); 2 new server tests (491 studio tests); `composer.py` 35/35; `attachments.py` 16/16; `models.py` 13/13; `live_assistant.py` 23/23; `flows.py` 21/21 |
| 6 | **A5** Sign-in | 2ba96e5 | `scripts/perf/signin.py` 14/14 (up to the sign-in link, then Cancel: plan §4); the CLI probes below; 3 new server tests against a fake CLI that signs in and out (494 studio tests); `composer.py`, `attachments.py`, `models.py`, `usage.py`; `live_assistant.py` 23/23; `flows.py` 21/21. **Still yours to do: one real sign-in** (paste the code once) |
| 7 | **N2, N4, N3** | see git log (`N2 N4 N3`) | bytes, revisit and first-open times before and after (below); the served bundles token-for-token identical to their sources (acorn); 7 new tests (500 studio tests); layout audit 0 errors in 328 cases; `flows.py` 21/21; `live_assistant.py` 23/23; every UI check above |
| 8 | **N1** Dark mode | see git log (`N1`) | the palette validator on the dark node kinds (all pairs: every check passes); WCAG contrast of every text token on every dark surface; layout audit in dark (`--dark`) 0 errors in 328 cases; every element's computed colours identical between the two generators, on 32 screens; 20 new tests (520 tests, 3 skipped); `flows.py` 21/21; `composer.py` 35/35; `attachments.py` 16/16; `models.py` 13/13; `usage.py` 15/15; `signin.py` 14/14; every screen in both themes, desktop and phone |
| 9 | **S1** operonx 1.9.0, **N5** a live voice session (automated part) | see git log (`N5`) | S1: PR #59 gates (below), published; the studio's 520 tests on the PyPI wheel; the callbot's 291 tests (the same 2 env-var failures before and after the bump). N5: six fake-microphone calls through the real STT/LLM/TTS; the call pill's paths; the Monitor's service view; 1 new server test (521 studio tests); 39 JS tests; `flows.py` |
| 10 | **B8** Replaying real sessions | see git log (`B8`) | a real HTTP request to a service with `replay=True`, its run replayed from the Runs page to changed code (desktop and phone); 10 new operonx tests, 2 new studio tests; the gates below |

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

**C1 notes.**
- **B2, the brain-cell look, is back.**
  - It is the canvas CSS from before R4 (`ac251bb^`): cells, beams with
    their glow and filament, glowing ports, and the cyan light-up on
    selection.
  - What R4 added for function stays: the run states, the measuring
    pass, and names that grow when zoomed out.
  - The run states now read as light on a cell: the op at work glows
    cyan, a finished one turns green, a failed one red. A wire's glow
    brightens with its core while data runs through it.
- **The sparks were the only real cost, and they are fixed.**
  - They asked the browser for lengths and points on every wire: 58 of
    the 224 ms a 302-op render took.
  - They are now computed in JS from the path data (`pathSampler`):
    3 ms. They match the browser within 0.18% on length and 0.6 px on
    position, on all 1,102 paths of three projects.
- **Measured before and after C1, same harness, same moment:**

  | Graph | render() | zoom frames, p50 / p95 |
  |---|---|---|
  | callbot (34 ops) | 47–51 → 54–59 ms | 16.7 / 17–21 → 16.7 / 17 ms |
  | educa agent (27 ops) | 35–40 → 41–44 ms | 16.7 / 17–18 → 17 / 29–34 ms |
  | synthetic (302 ops) | 133–141 → 170–188 ms (budget 200) | 16.7 / 17–18 → 19–20 / 23 ms settled (25–28 / 45 right after the page loads) |

  - **What that means on real graphs:** zooming stays at 60 fps at the
    median, and a continuous zoom drops about one frame in twenty. Every
    blurred shadow on a cell causes it (only a flat ring avoids it); it is
    the same trade the look had on `main`.
  - **Graphs of 120 cells or more** keep the membrane ring but drop the
    blurred shadows (`#world.big`). On the 302-op graph that took zoom
    frames from 26 to 19 ms at the median.
  - **Rejected:** dropping the shadows only during a zoom. Its first
    switch cost one 224 ms frame.
- **The callbot's render was already over budget.** It measured 47–51 ms
  against the 40 ms budget before C1: the graph has grown to 34 ops since
  R4 recorded 36–40 ms. C1 adds 5–7 ms. It isn't fixed here.
- **B4, rows without a wire.**
  - A route that is the loop's return now leaves its own row's dot on
    the right, where returns bow.
  - A route into END ties from its row: its dot is on the left, and the
    tie runs down a clear lane, along above END, and into END's top port.
    The lane steps outward past cards in its way, and the tie falls back
    to normal routing if none is clear.
  - The legend says so. The layout audit checks all of it, including the
    main graph's END ties, which it didn't see before.
- **B5, runs of other graphs.**
  - A run records its engine's name, not its graph's, so the graph is
    matched on evidence: whichever project graph's ops cover the ops the
    run executed.
  - If that graph isn't on screen, the canvas switches to it and a line
    says "Showing `score_call`, the graph this run ran (the canvas had
    `passthrough`)".
  - If no graph covers the run (for example a job's `params`), a note
    says so, lists the ops, and offers *Open as tree*, never a canvas of
    faded cards.
  - The audit's workflow case now picks a run whose graph is drawn.
- **B6, the phone landing.** A flow wider than the view lands with START
  in the middle, at the readable 70%. The audit checks START is in view
  on every fresh landing.
- **Fixed on the way:** the inspector's close × was drawn over its "Ask"
  button.
- **Added to the scratch `layout-edges` project:** a `looprow` graph,
  where the router's own route is the loop's return.

**A2 notes.**
- **The probe settled T1, with no fallback needed.** It ran on Haiku, for
  a few cents, with the CLI at 2.1.283:
  - with `--input-format stream-json`, one user message on stdin with an
    image block, then the words, was answered "A red circle and a blue
    square.";
  - `--resume --fork-session` still forked (a new session id), and the
    follow-up knew the circle was red;
  - a 205 KB message on stdin went through and was counted right. As an
    argument, 140 KB already failed to start.
- **Message turns now go in on stdin.** `/compact` and the title call
  stay arguments, being a word and a short prompt.
- **Attachments are images only** (PNG, JPEG, GIF, WebP):
  - the browser resizes each to a 1568 px long edge (a GIF or a small
    image is kept as it is, so it keeps its motion);
  - at most 8 a message, and 5 MB each;
  - they upload at send, before the turn names them;
  - on disk: `assistant-files/<conversation>/<sha256>.<ext>` beside the
    store, mode 0600, deleted with the conversation;
  - turns keep references in a new `attachments` column (an additive
    migration), so a retry sends the same images and an edit sends what
    it has now.
- **Before they are sent,** images live in memory with their
  conversation's draft. A reload drops them; the words and cards survive
  it.
- **Text files** (`.py .json .jsonl .csv .md .txt .log .yaml .toml .js
  .ts .sql .sh`, up to 2 MB) become cards named after the file, sent as a
  fenced block under that name. PDFs come later.
- **In the transcript,** one image keeps its own shape (up to 240 px);
  several sit as square tiles. A click shows one large.
- **The studio on :8766 was restarted** to load the new server code; the
  tunnel carried on.

**A3 and B3 notes.**
- **The probe** ran on 2026-09-28 with Claude Code 2.1.283, on tiny
  prompts with no tools:
  - `fable`, `opus` and `sonnet` resolve to `claude-fable-5-1`,
    `claude-opus-5-5` and `claude-sonnet-5`, each with a 1M window;
    `haiku` resolves to `claude-haiku-4-5-20251001`, with 200k.
  - No `--model` resolves to Opus 5.5.
  - Full ids work.
  - Every effort level is accepted on every model tried, including Haiku.
  - An unknown model fails with "There's an issue with the selected
    model (…)" (`unrecognized_model`).
- **The menu shows what the studio has seen, not guesses.** It starts
  from those resolutions and windows, then keeps what later turns report
  (the `meta` table), so "Default" names the model it resolved to last.
- **Fixed on the way:** the context window came from whichever model the
  result listed last, and every call also lists the CLI's helper model.
  It is now the turn's own model's window; a test covers it.
- **Defaults for a new conversation:**
  1. the project's `[studio.assistant] model / effort` (the plan's
     place);
  2. otherwise the studio's own default, which "Use for new
     conversations" sets (it lives in the store, so home conversations
     have one too);
  3. otherwise Claude Code's own.
- **A switch mid-conversation** shows as a divider before the first
  answer from the new model or effort, derived from the answers' own
  records; nothing extra is stored. If the conversation is already bigger
  than the new model's window, the menu warns and offers Compact first,
  and the switch happens once the compaction is done.
- **A model the account can't use** becomes an error card that names it,
  with "Use the default model" (the same message, retried on the
  default).
- **B3, a project's own tool servers.**
  - The servers in the project's `.mcp.json` join the studio's own in
    `--mcp-config`. A server named `studio` or with an odd name is
    skipped.
  - Their tools join `--allowedTools`, except in the read-only reach.
  - Measured: with `--strict-mcp-config`, as the studio runs, only
    `notes` loaded (`mcp__notes__ping`). Without it, the host's claude.ai
    connectors (Docs, Gmail, Drive, Calendar) loaded too.

**A4 notes.**
- **The raw event**, captured first on Claude Code 2.1.283:
  - `rate_limit_info` has `status`, `resetsAt`, `rateLimitType` and the
    overage fields;
  - `unifiedWindows.five_hour` and `.seven_day` each have `utilization`
    (0 to 1) and `resetsAt` (epoch seconds).
- **What is stored.** Each window's share used and reset time, the
  status and the window in force are kept on the conversation and,
  studio-wide, with the time they were heard (`meta.last_rate`). The
  plan's limits are the account's, so the newest reading wins everywhere.
- **Where readings arrive:** with every turn, on the project page's pulse
  (`assistant_rate`), and from `GET /api/assistant/usage`, which also
  carries the account (`claude auth status --json`, cached 30 s, never an
  id or a token).
- **The ring** is always in the toolbar: grey, amber from 80%, red from
  95%. Its card, which `/usage` also opens, shows:
  - context, tokens in, out and cached, and turns;
  - "≈ $ at API prices" (a hover says a subscription isn't billed per
    token);
  - Compact;
  - both plan windows with "resets 4:49 AM" or "Fri 4:49 AM", and "as
    of";
  - the account and its plan.
- **The nudge** starts at 80% of a plan window. At a limit (status
  `rejected`, or 100%), Send is held and says when it comes back.
- **Each answer's footer** carries its tokens.
- **Fixed on the way:** a menu wider than the room beside its button ran
  off the panel's edge (27 px on a 390 px phone). Menus are now kept
  inside.

**A5 notes.**
- **The CLI, probed** (2.1.283):
  - `claude auth login` over pipes prints "Opening browser to sign in…",
    then the link (`https://claude.com/cai/oauth/authorize?…`, redirecting
    to `platform.claude.com/oauth/code/callback`), then "Paste code here
    if prompted >", and waits;
  - a wrong code ends it with "Login failed: Request failed with status
    code 400" (exit code 1, no credentials written);
  - `auth status --json` answers in 0.5 s.
- **The studio's own sign-in lives in `~/.operonx/claude`**
  (`OPERONX_STUDIO_CLAUDE_HOME` overrides it). Every Claude process runs
  with `CLAUDE_CONFIG_DIR` pointed there once it is signed in (turns,
  titles, summaries, status); until then, the machine's login. This is
  checked at startup and after every sign-in and sign-out.
- **The flow:**
  - `POST /api/assistant/login` starts `claude auth login` there, with
    `BROWSER=true` so the server never opens a browser, and returns the
    link, which the page opens in a new tab;
  - `…/login/{id}/code` hands the pasted code to the CLI and returns its
    verdict, in its own words;
  - `DELETE` cancels;
  - one sign-in at a time, 10 minutes at most;
  - the code is written to the CLI and never kept or logged;
  - `POST /api/assistant/logout` signs out the studio's own sign-in,
    never this machine's.
- **The card** takes the box's place:
  1. Sign in with Claude (with Console and SSO below);
  2. paste the code;
  3. "Signed in as …".

  It opens by itself when there is no sign-in anywhere, or when a turn
  fails for want of one (401, "Please run /login", "Invalid API key", an
  expired token), and from the account block in the usage card and in
  Settings → Assistant. The block reads "Using this machine's login (…)"
  until the studio has its own.
- **Switching sign-ins:** a conversation remembers which sign-in its
  Claude session belongs to. After a switch, its next turn starts a fresh
  Claude session, seeded with a Haiku summary of what was said (or the
  last messages, if that fails). The transcript stays whole.
- **What this run left behind:** the cancelled sign-in left only the
  CLI's config file in `~/.operonx/claude` (no credentials), so the studio
  runs on this machine's login until you sign it in.

**N2, N4, N3 notes.**
- **N2, smaller scripts and styles.** `rjsmin` was measured and
  rejected: it collapsed spaces inside nested template literals
  (`` `nested  ${…}` ``, `` {"k": `v  v`} ``) while its output still
  parsed. So the plan's "parses" check would have shipped changed text.
  - **Scripts:** the studio's own `operonx_studio/minify.py` drops
    comments, indentation, trailing and repeated spaces and blank lines.
    It keeps every line break (so automatic semicolon insertion reads the
    same) and every literal byte for byte.
  - **Proof:** acorn tokenizes the served bundles and their sources
    identically (124,350 tokens on the project page, 38,901 on home),
    comparing type, value, raw text and the line breaks before each
    token. The same check flags rjsmin's change at token 1,438.
  - **Styles:** `rcssmin` (Apache-2.0, now a dependency). It kept
    `calc()`'s spaces and every string on this stylesheet's constructs.
  - `OPERONX_STUDIO_MINIFY=off` serves both readable.

  | Asset (gzipped, as served) | Before | After |
  |---|---|---|
  | project page scripts | 154.7 KB | 116.6 KB (−25%) |
  | home page scripts | 49.2 KB | 39.8 KB (−19%) |
  | stylesheet | 36.8 KB | 27.8 KB (−24%) |
- **N4, a revisited screen at once.** Measured first: Evals, Services,
  Jobs, Alerts, Review, Resources and Prompts already came back at once.
  Runs went blank, and Monitor, Settings and the Playground said
  "Loading…", on every revisit.
  - **How:** a revisit now lays a copy of the screen's last picture over
    it (inert) while the screen refreshes beneath, at its real size. The
    copy lifts once the fresh content has settled (6 s at most, or when
    you leave), and Runs rows it had not shown get a brief highlight.
  - **Checked:** each cover lifts, leaving mid-refresh lifts it, and the
    refreshed list works.

  | Revisit, at +700 ms a request (the tunnel's latency) | Before | After |
  |---|---|---|
  | Runs | 940 ms, blank | 146 ms |
  | Monitor | 784 ms, "Loading…" | 39 ms |
  | Settings | 744 ms, "Loading…" | 18 ms |
  | Playground | 741 ms, "Loading…" | 26 ms |
- **N3, the Playground's bridge started early.**
  - **Measured first:** a first open was the bridge starting, then its
    first `describe` loading the project's services, which took 2 of the
    callbot's 2.6 s; the next `describe` took 0.02 s.
  - **So the warm-up** (`POST …/play/warm`) starts the bridge and asks
    `describe`, without waiting. The page asks when the pointer or focus
    reaches the Playground (at most once a minute), and 3 s after
    opening a project with doors.
  - **At most two bridges stay up while idle:** the least recently used
    idle one stops. One with an open session never does, nor the one
    asked for.
  - **Fixed on the way:** an open during a warm-up now waits for it,
    instead of using a bridge that was not ready.
  - **Memory:** 40 MB (jobs demo), 42 MB (playground demo), 202 MB
    (callbot).

  | First open of the Playground | Cold (before) | Warmed by 8 s on the page | Pointer on Playground, click 0.6 s later |
  |---|---|---|---|
  | callbot | 2,882 ms | 83 ms | — |
  | jobs demo | 654 ms | 28 ms | 66 ms |
  | playground demo | 696 ms | 29 ms | 121 ms |

**N1 notes.**
- **The choice is System, Light or Dark,** in Settings (Appearance) and
  in the header's menu. It is kept per viewer (this browser), and the page
  wears it before its first paint. While it is System, the page follows
  the system when it switches.
- **How the dark is made.**
  - Every colour token has a hand-tuned dark value (`studio-dark.css`).
  - The ~300 colours written in place in `studio.css` get a generated
    dark twin (`operonx_studio/theme.py`), placed right after its rule
    with the same specificity, so the same rule wins in both themes.
  - The rules: neutrals flip their lightness; a pale wash keeps its hue
    (a warning's cream stays warm); a strong hue is lightened to read on
    dark; a mid-light fill inverts, so a hover still steps out; shadows
    deepen; an inline SVG's ink (the header's chevrons) turns light.
    Masks, keyframes and the tokens are left alone.
  - The Monitor's charts read the tokens and redraw on a switch.
- **Size: the dark adds 3.2 KB** (stylesheet 28.2 → 31.3 KB gzipped).
  - The first version appended all twins at the end. Holding the cascade
    that way meant re-stating 772 colour-free rules: +10.9 KB.
  - **Checked identical:** every element's computed colours under both
    versions, on 32 screens (desktop and phone): 0 differences. The same
    comparison sees light against dark on 568 of 568 boxes.
- **Contrast.** Every text token is at least 4.5:1 on every dark surface
  (the faintest, `--text-3`, is 4.81 on the highlight). Inks on fills are
  at least 5.97.
- **The node kinds, re-stepped for dark with the palette validator.**
  - The six kinds pass every check on all pairs: colour-blind ΔE ≥ 8.1,
    normal vision ≥ 15.1, lightness band, chroma and contrast. As text
    (the kind chip) each is at least 4.5:1.
  - The frontier is tight: the search found no set with more margin
    inside the families. Branch moved slightly redder (hue 61 → 48); it
    stays 9.1 from the error red, and errors always carry an icon and a
    label.
  - The default ("an op the studio has never seen") is the light grey of
    `--text-2`, at least 9.5 from every hue, colour-blind or not.
  - Serve is the brand's gold, not a kind: at least 11 from every kind.
- **Yours to decide: the light kinds fail the validator** (unchanged from
  before N1). Blue and violet are 1.2 apart for deuteranopes, and teal
  and green 5.3 for everyone. A passing light set exists only with an
  olive green and a brown branch, right at the floor. Kinds always carry
  an icon and a label, so this stays as it is until you say otherwise.
- **Fixed on the way, both themes:** number fields and fields written
  without a type (Review's labels, the alert form, the Playground's query
  keys) had the browser's own look; they now match the other fields. A
  component's own style still wins.
- **The layout audit takes `--dark`.**

**S1 and N5 notes.**
- **S1, operonx 1.9.0.** Before the PR: docs for runs, the playground
  bridge and evals (the tracing guide still showed classes V3 removed);
  CI's ruff 0.16 would have failed 14 files; `mongo` added to the extras
  smoke. Gates: 2241 tests on Python 3.10 with the Postgres store tests
  against a throwaway container, `mkdocs --strict`, the wheel's extras,
  all 18 examples building offline. You merged; Publish put it on PyPI.
- **N5, the automated part.** Chrome's fake microphone played a recorded
  caller ("anh bận lắm gọi lại sau đi", twice) into the callbot's `call`
  door, in `/home/thanglq/educa-reminder-agent` (the studio project with
  the telco codec). The call ran end to end: the greeting, the first turn
  understood (STT 171 ms, `llm_classify` → busy in 167 ms), re-prompts,
  the bot's hang-up at 52.6 s; 148 ops streamed live; the run recorded
  locally only, its trace readable in the studio.
  - **Setup:** the callbot's `.env` has no `STT_API_URL`/`STT_API_KEY`
    (it predates the http STT path), so the studio runs with only the
    `STT_*` keys of `.env_dev` exported. No file was changed.
- **Found and fixed on the way:**
  - **Leaving the Playground ended a voice call,** so the canvas could
    never be watched during one. The call now belongs to the page: it
    keeps going on other screens, a pill in the header shows it
    ("call 0:29 · End") and leads back to it, the toy picks the live call
    up again, and leaving the page hangs up (checked against a control:
    without the handler the session was still live after 43 s; with it,
    it ended in 4.8 s). On a phone the crumbs step aside for the pill.
    Checked: a whole call watched from the Flow, the cards lighting on
    every turn; back to the call mid-way; End from the Monitor.
  - **That exit also overflowed the stack:** `flush()` and `end()` called
    each other (the captured stack: `flush → end → flush …`). Gone with
    the change above; `end` now clears the session first.
  - **The Monitor hid playground sessions under their service:** with
    `call` chosen it said "No runs" and pointed to the Playground, whose
    sessions are `origin=playground`. A service's view now counts them,
    says how many ("Includes 14 playground sessions · Served runs only"),
    and pins its key ops first: `stt` p95 179 ms, `llm_classify` 230 ms,
    `synthesize` 21 ms.
- **Still yours:** the same call with headphones and your own voice
  (open the educa_reminder_agent project → Playground → call → Voice).

**B8 notes.**
- **What it does:** a service declared with `replay=True` keeps, on each
  run, what its client sent — the same script a playground session keeps.
  Its run's page then offers *Replay in the Playground*: the same request,
  sent to the current code.
- **Checked end to end:** the demo's `score` service, served for real,
  got `{"call_id": "123", …}`; its run carried exactly that JSON and the
  query. The code was then changed (`brief` → `short`); *Replay in the
  Playground* filled the payload and the new reply said `short`.
- **Text and JSON only:** audio and bytes are counted, never kept, and so
  is any message over 64 KB. A door whose JSON frames carry audio says so
  in its codec (`to_toy`). For the callbot's voice door it records nothing
  useful, which is why it stays off there.
- **Changed from §6.1: no separate 7-day limit.** A script lives on its run
  and goes when the run goes (services: 30 days by default, set in
  Settings). A shorter life for scripts alone would need an update the run
  store's contract does not have.
- **Ships in operonx 1.10.0** (you merge); the studio side works with any
  version and simply finds no scripts before it.
