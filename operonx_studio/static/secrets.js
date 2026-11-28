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
    const val = el("input", "cf-text");
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
  }

  async function show() {
    if (!box.firstChild) box.append(el("div", "note", "Loading secrets…"));
    try { draw(await api(`/api/p/${PID}/secrets`)); }
    catch (e) { box.textContent = ""; box.append(loadError(e, () => show())); }
  }

  registerPane("projectsettings", {el: box, show});
})();
