# Team version (T3 / B9)

Written 2026-09-29 against `feat/assistant-first` @ dd495ed. Every claim
about today's behaviour cites the code. **Decided** marks the calls I made;
**Yours** marks what needs the owner.

## 0. Summary

Today the studio has one shared login and one cookie derived from it. The
assistant has one Claude sign-in for the whole studio, and falls back to the
machine's own login. Conversations have no owner.

The plan builds six phases in this order:

- **P1:** real accounts with revocable sessions, and one access table that
  fails closed.
- **P2:** a Team page.
- **P3:** conversations belong to their owner.
- **P4:** one Claude sign-in per person, never falling back to another
  person's.
- **P5:** the viewer role in the UI, and a read-only assistant for viewers.
- **P6:** an activity log.

Editors are invited after P4, viewers after P5.

## 1. Today

### 1.1 The login

- **One user and password come from the environment.** They default to
  `root`/`123`. `OPERONX_STUDIO_AUTH=off` disables auth (app.py:647-664).
  The test suite runs with auth off (tests/conftest.py).
- **The cookie is the same for everyone and never changes.** `oxsession` is
  HMAC("session-v1") keyed by sha256(user:pass) (app.py:662-664). It is set
  httponly, SameSite=Lax, for 30 days (app.py:696-697), and survives
  restarts (test_auth.py:70-80).
  - Logout only deletes the browser's copy (app.py:700-706).
  - A copied cookie works until the password changes, so no one person can
    be revoked.
- **One middleware guards everything.** Everything except `/login`,
  `/api/login` and `/static*` needs the cookie: APIs answer 401 and pages
  redirect (app.py:666-679).
- **`/api/login` is not throttled** (app.py:685-698), although the studio
  sits on a public tunnel. The 12 `scripts/perf` scripts log in as
  root/123, so the live studio very likely still uses the default.
- **There is no notion of who is asking.** The review log records
  `(auth or {}).get("user") or "local"` (app.py:1837-1839).
- **The assistant's tool server logs in with the same cookie.**
  - `_studio_mcp` passes `auth["token"]` as `OPERONX_STUDIO_TOKEN`
    (app.py:2815-2825), and mcp.py sends it as `oxsession` (mcp.py:53-54).
  - The MCP config is on the `claude` command line (assistant.py:751-755),
    which any local user can read from `/proc`.

### 1.2 The assistant's Claude sign-in

- **One directory serves the whole studio.** `claude_home()` is
  `OPERONX_STUDIO_CLAUDE_HOME` or `~/.operonx/claude` (chat.py:186-188), and
  it is selected through `CLAUDE_CONFIG_DIR`.
- **The signed-in state is one module-level cache** (chat.py:191, 210-217).
  `account_key()` is `studio:<email>` or `machine` (chat.py:220-223).
- **`_spawn_env()` builds the environment for every Claude process**
  (chat.py:226-236).
  - It strips `CLAUDE*` but not `ANTHROPIC_*`.
  - It adds `CLAUDE_CONFIG_DIR` only when the studio's directory is signed
    in; otherwise the process runs on the machine's login.
  - Turns (assistant.py:771), summaries (972), titles (1075) and
    `auth status` (app.py:2953) all use it.
- **The sign-in flow** is in app.py:3002-3104.
  - It runs `claude auth login` with `CLAUDE_CONFIG_DIR` and `BROWSER=true`,
    reads the link from its output, and writes the pasted code to its stdin.
  - Only one login can run in the whole studio: starting one kills the
    others (app.py:3009-3010).
  - The account card is cached studio-wide for 30 s (app.py:2939-2967).
- **On this machine,** `~/.operonx/claude` has no credentials, so every turn
  runs on the machine's login (U2 is still open).
- **A conversation remembers its account** (`sessions.claude_home`,
  assistant.py:224, 1023-1026). A turn under a different account starts a
  fresh Claude session, seeded with a summary (assistant.py:677-682,
  733-737).
- **Plan limits are tracked once for the whole studio**, as `last_rate`
  (assistant.py:942-944, app.py:3110-3115, 2502).

### 1.3 Conversations

- **Storage:**
  - Conversations live in `assistant.sqlite` beside `studio.json`
    (app.py:2843), in `~/.operonx/` (registry.py:26-27).
  - Images live in `assistant-files/<sid>/` (assistant.py:379-380).
- **Rows are keyed by id and scope, with no owner column**
  (assistant.py:209-226). `sessions()` filters only by scope, archived and
  text (assistant.py:338-357).
- **Every route trusts the id it is given:**
  - the list (app.py:2898-2904) and `_session_or_404` (3130-3132);
  - attachments (3210-3220);
  - turns by `tid` (3409-3430);
  - `/items/{seq}` (3302-3312), which does not even check that the session
    exists.
- **Other leaks:**
  - The home page embeds anyone's 6 newest conversations (app.py:753).
  - The pulse returns every turn ending in a project, with its title
    (app.py:2493; assistant.py:1036-1037).
  - Screen actions are queued per project (app.py:2416-2435, 2488-2511).
  - The default model and effort are one setting for the studio
    (app.py:3117-3128, 2883).
  - Home-scope turns run in the server's home directory (app.py:2855-2856).

### 1.4 Every route that changes something

There are 94 routes: 51 GET and 43 other. The last column is the level each
route gets in §2.2.

| Method, path | Handler (app.py) | Changes | Level |
|---|---|---|---|
| POST /api/login | login 685 | sets the cookie | open |
| GET /logout | logout 700 | clears the cookie | open |
| POST /api/open | open_project 801 | shared recents (studio.json) | edit |
| POST /api/forget | forget 814 | shared recents | edit |
| POST /api/new | new_project 821 | creates a directory, starts first-run jobs | edit |
| POST /api/p/{pid}/edit | project_edit 1042 | project source (dry run by default) | edit |
| POST /api/p/{pid}/trace/{run}/delete | trace_delete 1336 | deletes a run | edit |
| POST /api/p/{pid}/resources/price | resource_price 1443 | resources YAML when `apply` | edit |
| POST /api/p/{pid}/settings/retention/preview | retention_preview 1519 | nothing (counts) | read (READ_POSTS) |
| POST /api/p/{pid}/settings/retention | retention_save 1554 | operonx.toml, deletes runs | edit |
| POST /api/p/{pid}/jobs/{name}/run | job_start 1734 | starts a job process | edit |
| POST /api/p/{pid}/services/start, /stop | 1810, 1822 | starts or stops listeners | edit |
| POST /api/p/{pid}/review/run/{run} | review_save 1904 | review log | edit |
| POST /api/p/{pid}/review/run/{run}/dataset | review_to_dataset 1919 | dataset case | edit |
| POST /api/p/{pid}/prompts/save | prompt_save 2007 | project file when `apply` | edit |
| POST /api/p/{pid}/alerts | alerts_save 2163 | .operonx/alerts.json | edit |
| DELETE /api/p/{pid}/alerts/{name} | alerts_delete 2189 | same | edit |
| POST /api/p/{pid}/alerts/{name}/test | alerts_test 2198 | calls a webhook | edit |
| POST /api/p/{pid}/alerts/check | alerts_check 2212 | webhooks, alert state | edit |
| POST /api/p/{pid}/datasets/{name}/rows | dataset_add 2355 | appends cases | edit |
| POST /api/p/{pid}/ui/action | ui_action 2425 | queues a screen action | self |
| POST /api/p/{pid}/chat/undo | chat_undo 2513 | git checkout or unlink of project files | edit |
| POST /api/p/{pid}/play/warm | play_warm 2569 | starts the bridge (GET play/doors does too) | read (READ_POSTS) |
| POST /api/p/{pid}/play/open, simulate, send, end, rerun, restart | 2616–2781 | drive services, run ops (simulate spends LLM money) | edit |
| POST /api/assistant/sessions | assistant_new 2906 | own conversation | self |
| POST /api/assistant/login, …/login/{lid}/code, DELETE …/login/{lid}, POST …/logout | 3002, 3050, 3079, 3085 | own Claude sign-in | self |
| PUT /api/assistant/defaults | 3117 | default model and effort (per person from P3) | self |
| PATCH, DELETE /api/assistant/sessions/{sid} | 3156, 3222 | own conversation | self |
| POST /api/assistant/sessions/{sid}/attachments, /turns, /compact, /items/{seq} | 3183, 3232, 3285, 3302 | own conversation (turns run Claude) | self |
| POST /api/assistant/import | 3314 | own conversation | self |
| POST /api/assistant/turns/{tid}/stop | 3426 | own turn | self |

**GETs that need more than read access:**

- **`GET /api/fs` lists any directory on the machine** (app.py:880-904). It
  only serves the Open and New dialogs, so its level is edit.
- **Own-data GETs** are self, with an owner check:
  - `/api/assistant/sessions` (2898), `/sessions/{sid}` (3134),
    `/attachments/{aid}` (3210);
  - `/turns/{tid}` and `/stream` (3409, 3416);
  - `/account` (3106) and `/usage` (3110);
  - `/api/p/{pid}/ui/actions` (2507).
- **Open:** `/login`, `/static/{name}.css` (598), `/static/bundle/{stem}.js`
  (629).
- **Every other GET** is read.

**Two more facts:**

- **Extracting a project runs its code:** "anyone past the login who can
  write files can execute code" (chat.py:15-20).
- **`daemon.build_app` has an unauthenticated POST `/api/edit`**
  (daemon.py:361-431), but no entry point serves it (cli.py:40-50), so it is
  out of scope.

## 2. Design

### 2.1 Accounts and sign-in (P1 server, P2 UI)

- **Store.** A new `operonx_studio/users.py` defines `UserStore`, built the
  way ChatStore is (one connection behind a lock, WAL;
  assistant.py:276-298).
  - It lives in `<state>/users.sqlite`, mode 0600.
  - `<state>` is `OPERONX_STUDIO_STATE_DIR`, default `~/.operonx`, so the
    gates can run an isolated studio.
  - `users` holds: id (random hex), username (unique,
    `[a-z0-9][a-z0-9._-]{0,31}`), name, role (admin, editor or viewer), pw,
    must_change, disabled, machine_login, claude_home, claude_email,
    created, last_seen.
  - `web_sessions` holds: token_hash, user, created, last_seen, expires,
    label.
- **Passwords** use only the standard library.
  - Hashing is `hashlib.scrypt` (n=2^14, r=8, p=1, 16-byte salt, dklen 32),
    stored as `scrypt$n$r$p$salt$hash`.
  - Comparison uses `hmac.compare_digest`. An unknown username is checked
    against a dummy hash, so it takes the same time.
  - A password needs at least 8 characters and must differ from the
    username.
  - Temporary passwords come from `secrets.token_urlsafe(9)`.
- **Sessions.**
  - The cookie is a random `secrets.token_urlsafe(32)` under the same name,
    `oxsession`, because mcp.py relies on that name. Only its sha256 is
    stored.
  - A session lasts 30 days from its last use. `last_seen` is written at
    most once a minute.
  - Sessions end in three cases:
    - logout ends that one session;
    - changing your password ends your other sessions;
    - a reset, disable or delete ends all of that person's sessions.
  - Sessions survive restarts.
  - The cookie is httponly and SameSite=Lax, and also Secure when
    `X-Forwarded-Proto` is https.
  - A non-GET request whose Origin host differs from its Host gets 403.
- **Throttling** is kept in memory, per username and per client address.
  After 5 failures there is a 30 s lock, doubling up to 15 min.
- **Migrating today's login.** On the first start with an empty users table:
  - An admin is created from `OPERONX_STUDIO_USER`/`PASS` (default root/123).
  - That admin gets `machine_login=1`, and `claude_home` set to today's
    `claude_home()`, so today's sign-in directory and its resumable Claude
    sessions stay theirs.
  - `must_change` is set when the password is `123`.
  - The environment variables are read only on this first start, and the
    log says so.
  - The old cookie stops working, so everyone signs in once.
  - With `OPERONX_STUDIO_AUTH=off`, every request acts as the first admin,
    or as a built-in `local` admin when there are no users. The test suite
    runs unchanged.
- **API.**
  - For yourself: `GET /api/me`, `POST /api/me/password`, `POST /api/logout`.
  - For admins: `GET` and `POST /api/admin/users`;
    `PATCH /api/admin/users/{uid}` (name, role, disabled);
    `POST …/{uid}/password` (a temporary password, shown once);
    `DELETE …/{uid}`.
  - Nobody changes their own role, or disables or deletes themselves.
  - The last active admin can't be demoted, disabled or deleted.
  - Demoting or disabling someone ends their sessions and stops their
    running turns.
  - Deleting someone also deletes their conversations and their Claude
    directory, after running `claude auth logout` in it.
- **`must_change`.** Until the password is changed, the middleware allows
  only `/api/me`, `/api/me/password`, `/api/logout` and the login page. The
  login page gains a "Choose your password" step.
- **Recovery.** `operonx-studio --reset-password NAME` prints a temporary
  password.
- **Agent token** (P1, because the shared token goes away).
  - `_studio_mcp` issues an in-memory token for the requesting user, valid
    for one turn.
  - The token is revoked when the turn ends, or after `CHAT_MAX_MIN` + 5
    min.
  - The middleware accepts it as `oxsession` and marks the request as coming
    from the assistant.
  - The MCP config moves from the command line to a 0600 file under
    `<state>/run/`, deleted when the turn ends.
- **`_reviewer()`** returns the username.

### 2.2 Authorization: one table that fails closed (P1)

- **The table.** `operonx_studio/access.py` defines
  `ACCESS[(method, route.path)]` → `open | self | read | edit | admin`, with
  one entry per route.
  - viewer = read, editor = edit, admin = admin.
  - self means any signed-in person, acting on their own things.
  - `READ_POSTS` lists the non-GET routes at read level, each with its
    reason.
- **Enforcement.** One global dependency,
  `FastAPI(dependencies=[Depends(authorize)])` at app.py:519.
  - FastAPI's `APIRoute.matches` sets `request.scope["route"]` (checked
    against the installed fastapi 0.135.3), so the dependency sees the route
    FastAPI chose.
  - A route missing from the table answers 403 "no access rule", and
    startup logs every unclassified route.
  - Authentication stays in the middleware (app.py:666), which now resolves
    `request.state.user`.
- **Ownership.** `_session_or_404(sid, me)` (app.py:3130), plus
  `_turn_or_404` and `_login_or_404`. Someone else's object gives 404, not
  403.
- **Why a table:**
  - a dependency added to each route can be forgotten silently;
  - "GET is read, everything else is edit" would open the next sensitive GET
    (such as `/api/fs`) to viewers;
  - the table documents access, and P6 reads it to decide what to record.

### 2.3 Conversations per person (P3)

- **Owner column.** `sessions.owner` is added the additive way
  (assistant.py:294-298), with an index on (owner, scope, archived,
  updated).
- **Existing conversations.** At startup, sessions whose owner is NULL or
  `local` go to the first admin.
- **Owner is required.**
  - `create_session(owner=)` and `sessions(owner=)` require it, and import
    sets it.
  - `Turn.owner` is added, and `relay.finished` entries carry the owner.
  - The pulse's `chat_ended` (app.py:2493) and the home boot data
    (app.py:753) are filtered by owner.
- **Screen actions** are keyed by (pid, user), and the agent token supplies
  the user.
- **Per-person defaults** are stored in meta as `defaults:<uid>`; the admin
  inherits today's `defaults`.
- **Admins can't read other people's conversations.**
- **Two assistants in one project.** The snapshot diff can't separate them
  (chat.py:121-155), so a changes card says so when its turn overlapped
  someone else's in the same scope.
- **Load cap.** `OPERONX_STUDIO_CHAT_MAX_TURNS` limits running turns across
  the studio (default 6). Beyond it the answer is 429 "the studio is busy".

### 2.4 Claude sign-in per person (P4)

- **Directory.** The user's `claude_home`, or `<state>/users/<uid>/claude`
  (0700).
- **chat.py works per directory.**
  - `_homes[path]` replaces `_home` (chat.py:191).
  - The helpers become `home_signed_in(home)`, `account_key(user)` and
    `_spawn_env(user)`.
  - `CLAUDE_CONFIG_DIR` is always the user's directory. The one exception is
    a `machine_login` user whose own directory isn't signed in, which only
    the owner can be.
  - For everyone else, `ANTHROPIC_*` is stripped as well as `CLAUDE*`.
- **Not signed in.** The relay emits the existing `auth` error item without
  starting a process (assistant.py:827 opens the card), which reads "Sign in
  with your own Claude account".
- **Everything else is per person too.**
  - Summaries and titles use the turn's environment (assistant.py:972,
    1075).
  - `logins` entries carry their owner. One login runs per person, and code
    and cancel check the owner.
  - The `_account` cache is per user.
  - `last_rate:<account key>` serves `/usage` and the pulse.
  - The Team page shows each person's last known Claude email, never a
    token.

### 2.5 Roles in the UI (P5); the server already refuses from P1

- **The page knows the role before it renders.** `_page()` (app.py:587-594)
  serves `<body data-role>` and a small JSON user block, so edit controls
  never flash.
  - One CSS rule hides `.needs-edit` for viewers.
  - Editable fields are disabled, with a hint.
  - The header shows a "View only" pill.
- **A 403 shows a toast,** "View only — ask an admin for editor access". It
  is raised from the `api` helpers (studio.js:96, home.js:15,
  assistant.js:75) and from the raw fetches (alerts.js:78, play.js:890).
- **Controls to mark:**
  - home.js:116, 287, 330;
  - studio.js:2490, 2505, 2947, 2958, 4876;
  - runs.js:244, settings.js:96, services.js:71;
  - review.js:144, 165 and prompts.js:171, 189;
  - alerts.js:37, 70, 78, 144, and evals.js:299;
  - play.js: opening, sending, simulating, rerunning, restarting and adding
    to a dataset;
  - assistant.js:806, 1979 (Undo).
- **A role change while a page is open** reloads the page: the pulse carries
  the role.
- **A viewer's assistant** is limited in five ways:
  - It always has read reach, whatever `OPERONX_STUDIO_CHAT_MODE` says
    (chat.py:88-92, 76-77).
  - `--disallowedTools` denies Read, Grep and Glob on the state directory,
    `~/.claude` and `**/.env*`.
  - It gets no project MCP servers (none passed at app.py:3280).
  - Home-scope turns run in the viewer's own empty directory.
  - The agent token carries the viewer's role, so the studio refuses its
    mutating tools anyway.

### 2.6 Activity log (P6)

- **The `audit` table** lives in `users.sqlite` and records: at, user, via
  (web, assistant or cli), method, route, pid, path params, status and
  detail.
  - `detail` keeps only these body keys: name, key, action, graph, resource,
    apply, dry_run, dataset, service, op, template, path.
  - It never records password, code, webhook, rows, inputs or message.
- **What gets recorded:**
  - The middleware writes a row after every response to an edit or admin
    route, and after every 403.
  - Logins, and Claude sign-in and sign-out, are recorded too.
  - The assistant's file edits are recorded when its turn ends, from its
    changes item (assistant.py:809-815).
- **Where it shows:** an Activity tab on the Team page, filtered by person
  and project. Rows are kept 180 days.

## 3. Phases and gates

**Every phase ships with:**

- offline tests, using the fake `claude`;
- Playwright scripts in `scripts/perf`, run against an isolated studio
  (`OPERONX_STUDIO_STATE_DIR` in a scratch directory, port 8766);
- screenshots at desktop 1440×900 and phone 390×844, light and dark;
- `layout_audit.py` with 0 errors;
- a few live Haiku turns wherever the assistant is involved.

The route guard is in P1 because P1 creates the admin-only routes, and every
later phase adds routes the enumeration test must already catch.

| Phase | Contents | Done when |
|---|---|---|
| **P1 Accounts (server)** | §2.1 and §2.2, the agent token, the login-page password step, `--reset-password`, the state-dir variable; the perf scripts log in through `OX_STUDIO_USER`/`PASS` | test_auth.py (rewritten), test_users.py and test_access.py pass: every route classified, nothing stale, only read POSTs in READ_POSTS; admin routes give 401 to anonymous and 403 to editor and viewer; a cookie replayed after logout gets 401; throttling works; migration sends root/123 to the password step and refuses the old cookie; a real turn's MCP tools still work (`flows.py`); login screenshots taken; all 12 perf scripts pass |
| **P2 Team page** | `/team` (admin): list, add (one-time password card with copy), role, reset, disable, delete; an account menu in the home and project headers (name, role, change password, Team, sign out) | `team.py`: the admin adds a person; a second browser context signs in and changes the password; the admin disables them, and that context's next request goes to /login; the last-admin guards show; screenshots of the Team page, add sheet, password card and account menu |
| **P3 Own conversations** | §2.3 | Two people in one client, switching cookies: B's list omits A's, and every self route with {sid}, {tid}, {aid} or {seq} gives B a 404; pulse, home boot and screen actions are filtered; an old store is adopted by the admin; the overlap note and the 429 cap work; in the browser, two contexts in one project each see only their own |
| **P4 Own Claude sign-in** | §2.4 | The fake CLI logs its config directory and whether `ANTHROPIC_API_KEY` is present; B's turns, titles and summaries run in B's directory; B not signed in gets the auth item and no process starts; only the owner falls back to the machine login; B's login doesn't cancel A's; account and usage are per person; `signin.py` covers two people. **Then invite editors.** |
| **P5 Viewer** | §2.5 | For every edit or admin route in the table, a viewer gets 403 before the handler runs (checks: `/api/new` creates no directory, the run survives, retention is unchanged), and editors pass; the viewer's turn command line shows read reach, the deny rules and no project servers; a tour of every screen finds no visible `.needs-edit`, and a forced POST shows the toast; live probe: a viewer's assistant asked to read another person's `.credentials.json`, `assistant.sqlite` and a `.env` refuses all three. **Then invite viewers.** |
| **P6 Activity** | §2.6 | test_audit.py: one row per mutation, with who and via; no secrets (grep the database for the test webhook and password); pruning works; Activity screenshots |

## 4. Decisions and risks

| # | Decided |
|---|---|
| D1 | SQLite plus standard-library scrypt. No passlib, argon2 or bcrypt dependency. |
| D2 | Sessions are random, revocable and hashed at rest. The cost: everyone signs in once after P1. |
| D3 | Today's login becomes the first admin, keeping its sign-in directory and the machine login. The default password must be changed at first sign-in. |
| D4 | Auth off stays, for trusted networks and the test suite; everyone is then the first admin. |
| D5 | One central access table, closed by default, enumerated by a test (§2.2). |
| D6 | Projects are shared by the whole team, and roles apply studio-wide. Per-project roles only if asked. |
| D7 | Conversations are private to their owner. Admins manage people but don't read conversations. |
| D8 | The machine login is the owner's only: a Claude consumer login is personal, and its plan limits would be shared. |
| D9 | **Editors are trusted with the machine.** An editor can run code through edits, jobs, services, and Bash when the assistant has full reach. So an editor can read anything the studio's OS user can, including other people's Claude credentials. Per-person sign-in prevents accidental sharing, not a hostile editor. Give editor only to people you'd give a shell to; the Team page says so. Sandboxing Bash, or one OS user per person, is a later item. |
| D10 | Viewers get the assistant, with their own sign-in and read reach plus deny rules, checked live in P5. If the probe leaks, viewers get only the studio's read tools. |
| D11 | Viewers can't review, add dataset cases, use the playground, rerun or run jobs, since each changes shared state or runs code. A "reviewer" level is cheap to add later. |
| D12 | The agent token lasts one turn and carries the turn owner's role. Its config goes in a 0600 file, not on the command line. |
| D13 | Two assistants in one project are allowed, and overlapping turns are flagged. |
| D14 | At most 6 running turns across the studio; 429 beyond that. |
| D15 | Logins are throttled, the cookie is Secure over https, and non-GET requests get an Origin check. |
| D16 | Role changes apply within 5 s (the user cache). A demoted person's running turns are stopped. |
| D17 | Someone locked out uses the CLI reset. |
| D18 | The unserved `daemon.build_app` is left as it is. |

**Yours**

- **Y1:** the first people (username, name, role). I recommend you stay the
  only admin.
- **Y2:** after P1 is deployed, sign in once and choose the admin password.
  root/123 stops being accepted.
- **Y3:** after P4, one teammate signs in with their own Claude account
  once, as in U2.

## 5. Test strategy

- **Match the existing suite:** pytest with `pytestmark = pytest.mark.unit`,
  and `TestClient(build_studio_app(Recents(state_file=tmp_path/…)))`.
- **Auth stays off by default** (conftest). Team tests turn it on with
  `monkeypatch.delenv("OPERONX_STUDIO_AUTH")`.
- **Several people share one `with TestClient(app)`**, switching
  `client.cookies`. Turns are asyncio tasks tied to that client's loop, so
  two clients would break them.
- **Helpers:**
  - `_signin(client, user, pw)` returns a token;
  - `_person(client, admin_tok, name, role)` creates someone through the
    admin API.
- **The fake CLI** (test_assistant.py:40-93) also logs whether
  `ANTHROPIC_API_KEY` is present, and its `--disallowedTools` argument.
- **Route enumeration** fills path parameters from samples (`pid` is the
  opened project, `seq` is 1, the others are "x") and sends `json={}`.

## 6. Files per phase

- **P1 (~9):**
  - new: users.py, access.py, test_users.py, test_access.py;
  - changed: app.py, registry.py, cli.py, static/login.html,
    tests/studio/test_auth.py;
  - plus the perf login helper.
- **P2 (8):**
  - new: static/team.html, team.js, account.js, scripts/perf/team.py;
  - changed: home.html, project.html, studio.css, app.py.
- **P3 (4):** assistant.py, app.py, test_assistant.py, test_hands.py.
- **P4 (8):** chat.py, assistant.py, app.py, assistant.js, team.js,
  test_assistant.py, test_chat.py, perf/signin.py.
- **P5 (~19, mostly one-line markers):**
  - access.py, chat.py, app.py, studio.css;
  - studio.js, home.js, assistant.js, runs.js, settings.js, services.js,
    review.js, prompts.js, alerts.js, evals.js, play.js, account.js;
  - test_access.py, test_chat.py, perf/team.py.
- **P6 (7):** users.py (the audit table), app.py, assistant.py, team.js,
  team.html, studio.css, the new test_audit.py.
