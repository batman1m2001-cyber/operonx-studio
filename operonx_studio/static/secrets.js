/* operonx studio — Settings › Project: the project's secrets.
 *
 * A secret is a variable in the project's .env that a resource names as
 * ${VAR}. The studio keeps a copy outside the project, one file per
 * environment, so a project that is cloned again gets its .env back. An
 * environment is a named set of secrets; picking one puts it in the .env.
 * Names and set/missing only: a value is typed here and never shown again.
 */

"use strict";

(() => {
  const box = $("#projectsettings");
  // a note the home page left for this project (a clone that tracks .env files)
  try {
    const note = sessionStorage.getItem("ox-note");
    if (note) { sessionStorage.removeItem("ox-note"); setTimeout(() => toast(note, true), 800); }
  } catch { /* no session storage: no note */ }
  const WORD = {set: "Set", missing: "Missing", default: "Default used"};

  function row(item, redraw) {
    const r = el("div", "factrow secretrow");
    const state = el("div", "pill" + (item.status === "missing" ? " p-bad" : ""), WORD[item.status] || item.status);
    const val = el("input", "cf-text needs-edit");      // a viewer sees the names and set/missing, nothing to type in
    val.type = "password"; val.autocomplete = "off"; val.spellcheck = false;
    val.placeholder = item.status === "set" ? "A new value" : "A value";
    val.setAttribute("aria-label", `A value for ${item.name}`);
    const go = el("button", "small needs-edit", item.status === "set" ? "Replace" : "Set");
    go.type = "button";
    const save = async () => {
      if (!val.value) return;
      try { const got = await api(`/api/p/${PID}/env`, {var: item.name, value: val.value}); val.value = ""; wrote(got, `${item.name} set`); redraw(); }
      catch (e) { toast(e.message, true); }
    };
    go.onclick = save;
    val.onkeydown = (e) => { if (e.key === "Enter") save(); };
    r.append(el("div", "factkey mono", item.name), state, val, go);
    return r;
  }

  function draw(got) {
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Project"));
    box.append(head);
    const sec = el("section", "setsection");
    sec.append(el("h3", "setsectitle", "Secrets"));
    sec.append(el("p", "setintro",
      "The values behind ${VAR} in resources.yaml. They live in the project's .env, and the studio keeps a copy outside the project, one per environment."));

    const change = async (path, environment) => {
      try { draw(await api(`/api/p/${PID}/${path}`, {environment})); }
      catch (e) { toast(e.message, true); }
    };
    const pick = el("div", "secretenvs");
    pick.append(Theme.radios("Environment", got.environments.map((e) => [e.name, e.name]),
      () => got.current, (name) => { if (name !== got.current) change("secrets/use", name); }, new Set()));
    const add = el("button", "small needs-edit", "New environment");
    add.type = "button";
    add.onclick = () => {
      const name = el("input", "cf-text");
      name.placeholder = "staging"; name.setAttribute("aria-label", "The new environment's name");
      const ok = el("button", "small needs-edit", "Add");
      ok.type = "button";
      const send = () => { if (name.value.trim()) change("secrets/environment", name.value.trim()); };
      ok.onclick = send;
      name.onkeydown = (e) => { if (e.key === "Enter") send(); };
      add.replaceWith(name, ok);
      name.focus();
    };
    pick.append(add);
    sec.append(pick);

    if (got.needed.length) {
      const facts = el("div", "facts");
      for (const item of got.needed) facts.append(row(item, show));
      sec.append(facts);
    } else {
      sec.append(el("div", "note", "This project asks for no secrets: resources.yaml names no ${VAR}, and there is no .env.example."));
    }
    box.append(sec);
    if (isAdmin()) { const git = el("section", "setsection"); box.append(git); gitAccess(git); }
  }

  /* Git access: one token per git host, for every project of this studio (operonx_studio/gitsource.py).
   * Admins only. A token is typed here and never shown again; Test asks the host with the one it has. */
  function isAdmin() {
    const me = window.Account && Account.me();
    return !(me && me.user) || me.user.role === "admin";      // no accounts (a studio on a laptop): its one person
  }

  function gitRow(item, redraw) {
    const r = el("div", "factrow secretrow");
    const state = el("div", "pill" + (item.set ? "" : " p-bad"), item.set ? "Set" : "Missing");
    const host = item.host ? el("div", "factkey mono", item.host) : el("input", "cf-text githost");
    if (!item.host) { host.placeholder = "gitlab.example.com"; host.setAttribute("aria-label", "A git host"); host.spellcheck = false; }
    else if (item.projects.length) host.title = "Used by " + item.projects.join(", ");
    const val = el("input", "cf-text");
    val.type = "password"; val.autocomplete = "off"; val.spellcheck = false;
    val.placeholder = item.set ? "A new token" : "A token";
    val.setAttribute("aria-label", `A token for ${item.host || "the host"}`);
    const go = el("button", "small", item.set ? "Replace" : "Set");
    go.type = "button";
    const save = async () => {
      const name = item.host || host.value.trim();
      if (!name || !val.value) return;
      try { const got = await api("/api/admin/git-tokens", {host: name, token: val.value}); toast(`Token for ${name} set`); redraw(got); }
      catch (e) { toast(e.message, true); }
    };
    go.onclick = save;
    val.onkeydown = (e) => { if (e.key === "Enter") save(); };
    r.append(host, item.host ? state : el("div", "pill", "Other host"), val, go);
    if (item.host) {
      const test = el("button", "small", "Test");
      test.type = "button";
      test.disabled = !item.projects.length;
      test.title = item.projects.length ? `Ask ${item.host} with this token` : "No project comes from this host yet";
      test.onclick = async () => {
        test.disabled = true;
        try { const got = await api("/api/admin/git-tokens/test", {host: item.host}); toast(got.message, !got.ok); }
        catch (e) { toast(e.message, true); }
        test.disabled = false;
      };
      r.append(test);
      if (item.set) {
        const drop = el("button", "small", "Remove");
        drop.type = "button";
        drop.onclick = async () => {
          try { redraw(await api("/api/admin/git-tokens", {host: item.host, token: ""})); toast(`Token for ${item.host} removed`); }
          catch (e) { toast(e.message, true); }
        };
        r.append(drop);
      }
    }
    return r;
  }

  async function gitAccess(sec, got) {
    try { got = got || await api("/api/admin/git-tokens"); }
    catch (e) { sec.textContent = ""; sec.append(loadError(e, () => gitAccess(sec))); return; }
    sec.textContent = "";
    sec.append(el("h3", "setsectitle", "Git access"));
    sec.append(el("p", "setintro",
      "One token per git host, for every project of this studio: Add from git, Pull and Push use it. Admins only."));
    const facts = el("div", "facts");
    const redraw = (next) => gitAccess(sec, next);
    for (const item of got.hosts) facts.append(gitRow(item, redraw));
    facts.append(gitRow({host: "", set: false, projects: []}, redraw));
    sec.append(facts);
  }

  async function show() {
    if (!box.firstChild) box.append(el("div", "note", "Loading secrets…"));
    try { draw(await api(`/api/p/${PID}/secrets`)); }
    catch (e) { box.textContent = ""; box.append(loadError(e, () => show())); }
  }

  registerPane("projectsettings", {el: box, show});
})();
