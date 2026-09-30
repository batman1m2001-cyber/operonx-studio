/* operonx studio — the Team page (admins): who can use the studio, add
 * someone (a password shown once), change a role, reset a password,
 * disable, delete (docs/TEAM_PLAN.md §2.1, P2). The server holds every
 * rule; the page shows the same rules before anyone hits them — your own
 * row, and the last active admin, cannot lose their access. */

"use strict";

(() => {
  const mk = Account.el;
  const ROLES = [["admin", "Admin"], ["editor", "Editor"], ["viewer", "Viewer"]];
  const HINT = {
    admin: "People, and everything an editor does.",
    editor: "Changes projects and runs code on this machine — only for people you would give a shell.",
    viewer: "Looks, changes nothing.",
  };
  const list = document.getElementById("team");
  let people = [];

  const ago = (epoch) => {
    if (!epoch) return "never signed in";
    const s = Date.now() / 1000 - epoch;
    if (s < 90) return "active just now";
    if (s < 5400) return `active ${Math.round(s / 60)}m ago`;
    if (s < 129600) return `active ${Math.round(s / 3600)}h ago`;
    return `active ${Math.round(s / 86400)}d ago`;
  };

  async function load() {
    try {
      people = (await Account.call("GET", "/api/admin/users")).users;
    } catch (e) {
      list.textContent = "";
      list.append(mk("div", "nomatch", e.message));
      return;
    }
    draw();
  }

  function draw() {
    const meId = Account.me().user.id;
    const activeAdmins = people.filter((p) => p.role === "admin" && !p.disabled).length;
    list.textContent = "";
    for (const p of people) {
      const self = p.id === meId;
      const lastAdmin = p.role === "admin" && !p.disabled && activeAdmins <= 1;
      const locked = self || lastAdmin;
      const why = self ? "You can't change your own access" : lastAdmin ? "The last active admin keeps their access" : "";
      const row = mk("div", "projrow teamrow" + (p.disabled ? " off" : ""));
      row.dataset.user = p.username;
      row.append(Account.avatar(p));
      const main = mk("div", "projmain");
      const top = mk("div", "projtop");
      top.append(mk("span", "name", p.name || p.username));
      if (self) top.append(mk("span", "tag", "You"));
      if (p.disabled) top.append(mk("span", "tag off", "Disabled"));
      else if (p.must_change) top.append(mk("span", "tag wait", "Password to choose"));
      main.append(top);
      const bits = [p.username, ago(p.last_seen)];
      if (p.sessions) bits.push(`${p.sessions} session${p.sessions > 1 ? "s" : ""}`);
      main.append(mk("div", "sig", bits.join(" · ")));
      // the Claude account their assistant runs under, as last seen: never a token (§2.4)
      main.append(mk("div", "sig claude", p.claude_email ? `Claude: ${p.claude_email}`
        : p.machine_login ? "Claude: this machine's login" : "Claude: not signed in yet"));
      if (lastAdmin) main.append(mk("div", "sig guard", "The last active admin: can't be demoted, disabled or deleted"));
      row.append(main);

      const role = mk("select", "rolepick");
      role.setAttribute("aria-label", `Role of ${p.name || p.username}`);
      for (const [v, label] of ROLES) {
        const o = mk("option", null, label);
        o.value = v;
        o.selected = v === p.role;
        role.append(o);
      }
      role.disabled = locked;
      if (why) role.title = why;
      role.onchange = () => setRole(p, role);
      row.append(role);

      const more = mk("button", "iconbtn more");
      more.type = "button";
      more.setAttribute("aria-label", `More for ${p.name || p.username}`);
      more.setAttribute("aria-haspopup", "menu");
      more.append(Icons.svg("more"));
      more.onclick = (ev) => { ev.stopPropagation(); rowMenu(p, more, {self, lastAdmin, why}); };
      row.append(more);
      list.append(row);
    }
  }

  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener("pointerdown", (ev) => { if (openMenu && !openMenu.contains(ev.target)) closeMenu(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeMenu(); });

  function rowMenu(p, anchor, {self, lastAdmin, why}) {
    closeMenu();
    const pop = mk("div", "popover rowmenu");
    pop.setAttribute("role", "menu");
    const item = (icon, label, fn, off, cls) => {
      const it = mk("button", "menuitem" + (cls ? " " + cls : ""));
      it.type = "button";
      it.setAttribute("role", "menuitem");
      it.append(Icons.svg(icon), mk("span", null, label));
      it.disabled = !!off;
      if (off && why) it.title = why;
      it.onclick = () => { closeMenu(); fn(); };
      pop.append(it);
    };
    item("refresh", "Reset password", () => reset(p), self);
    item(p.disabled ? "check" : "stop", p.disabled ? "Enable" : "Disable", () => toggle(p), self || (lastAdmin && !p.disabled));
    item("trash", "Delete…", () => remove(p), self || lastAdmin, "danger");
    if (self || lastAdmin) pop.append(mk("p", "rowmenu-why", why));
    const r = anchor.getBoundingClientRect();
    pop.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
    document.body.append(pop);
    // below the button, or above it when the screen ends first (a phone's last row)
    const h = pop.getBoundingClientRect().height;
    const below = r.bottom + 4 + h <= window.innerHeight || r.top - 4 - h < 0;
    pop.style.top = `${(below ? r.bottom + 4 : r.top - 4 - h) + window.scrollY}px`;
    openMenu = pop;
  }

  async function setRole(p, select) {
    const role = select.value;
    try {
      const got = await Account.call("PATCH", `/api/admin/users/${p.id}`, {role});
      const stopped = got.stopped_turns ? `; ${got.stopped_turns} running assistant turn${got.stopped_turns > 1 ? "s" : ""} stopped` : "";
      Account.toast(`${p.name || p.username} is now ${role === "admin" ? "an admin" : role === "editor" ? "an editor" : "a viewer"}${stopped}`);
    } catch (e) { Account.toast(e.message, true); }
    load();
  }

  async function toggle(p) {
    try {
      await Account.call("PATCH", `/api/admin/users/${p.id}`, {disabled: !p.disabled});
      Account.toast(p.disabled ? `${p.name || p.username} can sign in again` : `${p.name || p.username} is signed out and can't sign in`);
    } catch (e) { Account.toast(e.message, true); }
    load();
  }

  function remove(p) {
    Account.sheet(`Delete ${p.name || p.username}?`, (box, close) => {
      box.append(mk("p", "modalhint", "Their sessions end, their running assistant turns stop, and their own Claude "
                                    + "sign-in on this studio is signed out and removed. This can't be undone."));
      const foot = mk("div", "foot");
      const cancel = mk("button", "ghost", "Cancel");
      cancel.type = "button";
      cancel.onclick = close;
      const del = mk("button", "primary danger-fill", "Delete");
      del.type = "button";
      del.onclick = async () => {
        del.disabled = true;
        try {
          await Account.call("DELETE", `/api/admin/users/${p.id}`);
          close();
          Account.toast(`${p.name || p.username} deleted`);
        } catch (e) { Account.toast(e.message, true); del.disabled = false; return; }
        load();
      };
      foot.append(cancel, del);
      box.append(foot);
    });
  }

  async function reset(p) {
    try {
      const got = await Account.call("POST", `/api/admin/users/${p.id}/password`);
      passwordCard(got.user, got.password, "reset");
    } catch (e) { Account.toast(e.message, true); }
    load();
  }

  /* a password shown once: the only time the studio ever has it in the clear */
  function passwordCard(u, password, why) {
    const name = u.name || u.username;
    Account.sheet(why === "reset" ? `New password for ${name}` : `${name} is on the team`, (box, close) => {
      box.append(mk("p", "modalhint", `Give ${name} this password to sign in as ${u.username}. It is shown only now; `
                                    + "they choose their own at their first sign-in."));
      const row = mk("div", "pwcard");
      const out = mk("input", "mono pwvalue");
      out.type = "text";
      out.readOnly = true;
      out.value = password;
      out.setAttribute("aria-label", "Temporary password");
      out.id = "pw-once";
      const copy = mk("button", "pwcopy");
      copy.type = "button";
      copy.append(Icons.svg("copy"), mk("span", null, "Copy"));
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(password); }
        catch { out.select(); document.execCommand && document.execCommand("copy"); }
        copy.lastChild.textContent = "Copied";
        copy.classList.add("done");
      };
      row.append(out, copy);
      box.append(row);
      if (why !== "reset") {
        box.append(mk("p", "note", `They sign in at ${location.origin}/login.`));
      } else {
        box.append(mk("p", "note", "Every session they had has ended."));
      }
      const foot = mk("div", "foot");
      const done = mk("button", "primary", "Done");
      done.type = "button";
      done.onclick = close;
      foot.append(done);
      box.append(foot);
      out.onfocus = () => out.select();
    });
  }

  function add() {
    Account.sheet("Add a person", (box, close) => {
      const form = mk("form");
      form.noValidate = true;
      const user = Account.input("text", "off");
      user.autocapitalize = "none";
      user.spellcheck = false;
      user.placeholder = "ann";
      const name = Account.input("text", "off");
      name.placeholder = "Ann Lee";
      const role = mk("select");
      for (const [v, label] of ROLES) {
        const o = mk("option", null, label);
        o.value = v;
        o.selected = v === "editor";
        role.append(o);
      }
      const hint = mk("p", "fieldhint", HINT.editor);
      role.onchange = () => { hint.textContent = HINT[role.value]; };
      const roleField = Account.field("Role", role);
      roleField.append(hint);
      const err = mk("div", "err");
      err.setAttribute("role", "alert");
      const foot = mk("div", "foot");
      const cancel = mk("button", "ghost", "Cancel");
      cancel.type = "button";
      cancel.onclick = close;
      const save = mk("button", "primary", "Add");
      save.type = "submit";
      foot.append(cancel, save);
      form.append(Account.field("Username", user, "Lowercase letters, digits, . _ or - — what they sign in with."),
                  Account.field("Name", name), roleField, err, foot);
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        err.textContent = "";
        save.disabled = true;
        try {
          const got = await Account.call("POST", "/api/admin/users",
                                         {username: user.value.trim().toLowerCase(), name: name.value.trim(), role: role.value});
          close();
          passwordCard(got.user, got.password, "add");
          load();
        } catch (e) { err.textContent = e.message; }
        save.disabled = false;
      };
      box.append(form);
    });
  }

  document.getElementById("btn-add").onclick = add;
  load();

  /* ── Activity (docs/TEAM_PLAN.md §2.6): every change and refusal, by
   * person and project. The rows say what was acted on, never a secret. */
  const WHAT = {
    "POST /api/login": "Signed in",
    "POST /api/me/password": "Changed their password",
    "POST /api/open": "Opened a project",
    "POST /api/forget": "Removed a project from the list",
    "POST /api/new": "Created a project",
    "POST /api/p/{pid}/edit": "Edited the flow",
    "POST /api/p/{pid}/trace/{run}/delete": "Deleted a run",
    "POST /api/p/{pid}/resources/price": "Set a price",
    "POST /api/p/{pid}/settings/retention": "Changed retention",
    "POST /api/p/{pid}/jobs/{name}/run": "Ran a job",
    "POST /api/p/{pid}/services/start": "Started a service",
    "POST /api/p/{pid}/services/stop": "Stopped a service",
    "POST /api/p/{pid}/review/run/{run}": "Reviewed a run",
    "POST /api/p/{pid}/review/run/{run}/dataset": "Added a run to a dataset",
    "POST /api/p/{pid}/prompts/save": "Saved a prompt",
    "POST /api/p/{pid}/alerts": "Saved an alert",
    "DELETE /api/p/{pid}/alerts/{name}": "Deleted an alert",
    "POST /api/p/{pid}/alerts/{name}/test": "Tested an alert",
    "POST /api/p/{pid}/alerts/check": "Checked alerts",
    "POST /api/p/{pid}/datasets/{name}/rows": "Added dataset cases",
    "POST /api/p/{pid}/chat/undo": "Undid the assistant's changes",
    "POST /api/p/{pid}/play/open": "Opened the playground",
    "POST /api/p/{pid}/play/simulate": "Simulated a conversation",
    "POST /api/p/{pid}/play/send": "Sent to the playground",
    "POST /api/p/{pid}/play/end": "Ended a playground session",
    "POST /api/p/{pid}/play/rerun": "Re-ran an op",
    "POST /api/p/{pid}/play/restart": "Restarted the playground",
    "POST /api/assistant/login": "Started a Claude sign-in",
    "POST /api/assistant/login/{lid}/code": "Finished a Claude sign-in",
    "POST /api/assistant/logout": "Signed out of Claude",
    "POST /api/admin/users": "Added a person",
    "PATCH /api/admin/users/{uid}": "Changed a person",
    "POST /api/admin/users/{uid}/password": "Reset a password",
    "DELETE /api/admin/users/{uid}": "Deleted a person",
    "EDIT assistant:changes": "The assistant changed files",
    "CLI cli:reset-password": "Password reset from the command line",
  };
  const views = {people: document.getElementById("view-people"), activity: document.getElementById("view-activity")};
  const actList = document.getElementById("activity");
  const fUser = document.getElementById("act-user");
  const fPid = document.getElementById("act-pid");
  const more = document.getElementById("act-more");
  let lastId = 0;
  let filled = false;

  for (const b of document.querySelectorAll(".teamtabs button")) {
    b.onclick = () => {
      for (const o of document.querySelectorAll(".teamtabs button")) {
        const on = o === b;
        o.classList.toggle("on", on);
        o.setAttribute("aria-selected", String(on));
      }
      for (const [k, v] of Object.entries(views)) v.hidden = k !== b.dataset.view;
      document.getElementById("btn-add").hidden = b.dataset.view !== "people";
      if (b.dataset.view === "activity") showActivity();
      try { history.replaceState(null, "", b.dataset.view === "activity" ? "#activity" : location.pathname); } catch { /* fine */ }
    };
  }

  function when(at) {
    const d = new Date(at * 1000);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})
      : d.toLocaleDateString([], {month: "short", day: "numeric"}) + " " + d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  }

  function describe(r) {
    const bits = [];
    const d = r.detail || {};
    for (const [k, v] of Object.entries(r.params || {})) if (k !== "pid" && k !== "uid") bits.push(`${k} ${v}`);
    for (const [k, v] of Object.entries(d)) {
      if (k === "files") bits.push(`${v.length} file${v.length === 1 ? "" : "s"}: ${v.slice(0, 3).join(", ")}${v.length > 3 ? "…" : ""}`);
      else if (!(r.route === "/api/login" && k === "username")) bits.push(`${k} ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    return bits.join(" · ");
  }

  async function fillFilters() {
    if (filled) return;
    filled = true;
    for (const p of people) {
      const o = Account.el("option", null, p.name || p.username);
      o.value = p.id;
      fUser.append(o);
    }
    try {
      const projects = (await Account.call("GET", "/api/projects")).projects;
      for (const p of projects) {
        const o = Account.el("option", null, p.name);
        o.value = p.id;
        fPid.append(o);
      }
    } catch { /* the filter stays at every project */ }
  }

  async function showActivity(older) {
    await fillFilters();
    if (!older) { actList.textContent = ""; lastId = 0; }
    const q = new URLSearchParams({limit: "100"});
    if (fUser.value) q.set("user", fUser.value);
    if (fPid.value) q.set("pid", fPid.value);
    if (older && lastId) q.set("before", String(lastId));
    let rows;
    try { rows = (await Account.call("GET", `/api/admin/activity?${q}`)).rows; }
    catch (e) { actList.append(Account.el("div", "nomatch", e.message)); return; }
    if (!older && !rows.length) actList.append(Account.el("div", "nomatch", "Nothing recorded yet."));
    for (const r of rows) {
      const row = Account.el("div", "actrow" + (r.status >= 400 ? " bad" : ""));
      const who = Account.el("div", "actwho");
      // a failed sign-in may name no one: say what was typed
      const typed = (r.detail || {}).username;
      who.append(Account.avatar({name: r.username || typed || "?"}),
                 Account.el("span", "actname", r.username || (typed ? `“${typed}”` : "someone")));
      if (r.via !== "web") who.append(Account.el("span", "tag via", r.via === "assistant" ? "assistant" : r.via));
      const what = Account.el("div", "actwhat");
      let label = WHAT[`${r.method} ${r.route}`] || `${r.method} ${r.route}`;
      if (r.route === "/api/login" && r.status !== 200) {
        label = r.status === 403 ? "Could not sign in: the account is disabled"
          : r.username ? "Sign-in failed: wrong password" : "Sign-in failed: no such person";
      }
      what.append(Account.el("span", "actlabel", label));
      if (r.route === "/api/login") { /* the label says it */ }
      else if (r.status === 403) what.append(Account.el("span", "tag off", "refused"));
      else if (r.status >= 400) what.append(Account.el("span", "tag wait", `failed ${r.status}`));
      const sub = [r.project, describe(r)].filter(Boolean).join(" · ");
      if (sub) what.append(Account.el("div", "actsub", sub));
      row.append(Account.el("div", "actwhen", when(r.at)), who, what);
      actList.append(row);
    }
    if (rows.length) lastId = rows[rows.length - 1].id;
    more.hidden = rows.length < 100;
  }
  fUser.onchange = () => showActivity();
  fPid.onchange = () => showActivity();
  more.onclick = () => showActivity(true);
  if (location.hash === "#activity") document.querySelector('.teamtabs [data-view="activity"]').click();
})();
