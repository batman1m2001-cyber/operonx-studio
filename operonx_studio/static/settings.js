/* operonx studio — Settings: where a project's runs are kept, and for how long.
 *
 * Retention is per origin, in days or "keep forever", saved to the
 * project's operonx.toml ([studio.retention]) so a team server applies
 * the same policy. Before anything is saved, the page shows what the
 * policy would delete — runs and disk — and saving asks once more when
 * that is not nothing.
 */

"use strict";

(() => {
  const ORIGINS = [
    ["service", "Services", "Calls and requests your services answered"],
    ["job", "Jobs", "One run per item, for every job run"],
    ["eval", "Evals", "Runs made while evaluating a dataset"],
    ["playground", "Playground", "Sessions you ran from the studio"],
    ["adhoc", "Ad hoc", "Tests, scripts, anything untagged"],
  ];

  const box = $("#settings");
  let current = null;       // the loaded settings
  let previewTimer = null;

  const fmtBytes = (n) => {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  };

  function policyFromForm() {
    const out = {};
    for (const [origin] of ORIGINS) {
      const row = box.querySelector(`[data-origin="${origin}"]`);
      if (!row) continue;
      const forever = row.querySelector("input[type=checkbox]").checked;
      const days = row.querySelector("input[type=number]").value;
      out[origin] = forever ? "forever" : Number(days);
    }
    return out;
  }

  function invalid(policy) {
    for (const [origin, v] of Object.entries(policy)) {
      if (v !== "forever" && (!Number.isFinite(v) || v < 0)) return origin;
    }
    return null;
  }

  async function preview(given) {
    // a viewer saves nothing, so there is nothing to preview
    if (window.Account && Account.viewOnly) return;
    const out = $("#retention-preview");
    const save = $("#retention-save");
    const policy = policyFromForm();
    const bad = invalid(policy);
    if (bad) {
      out.textContent = `${ORIGINS.find(o => o[0] === bad)[1]}: days must be 0 or more.`;
      out.className = "setnote bad";
      save.disabled = true;
      return;
    }
    save.disabled = false;
    out.className = "setnote";
    out.textContent = "Checking what this would delete…";
    try {
      const p = given || (await api(`/api/p/${PID}/settings/retention/preview`, {retention: policy})).preview;
      let runs = 0, bytes = 0;
      for (const [origin, v] of Object.entries(p)) {
        runs += v.runs; bytes += v.bytes;
        const hint = box.querySelector(`[data-origin="${origin}"] .sethint`);
        if (hint) hint.textContent = v.runs ? `${v.runs} run${v.runs > 1 ? "s" : ""} older than this` : "";
      }
      out.textContent = runs
        ? `Saving deletes ${runs} run${runs > 1 ? "s" : ""}${bytes ? ` (${fmtBytes(bytes)})` : ""} now, and keeps the policy from then on.`
        : "Saving deletes nothing now.";
      out.dataset.runs = String(runs);
    } catch (e) {
      out.textContent = e.message;
      out.className = "setnote bad";
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 250);
  }

  async function save() {
    const policy = policyFromForm();
    if (invalid(policy)) return;
    const n = Number($("#retention-preview").dataset.runs || 0);
    if (n && !window.confirm(`Delete ${n} run${n > 1 ? "s" : ""} now and save this policy?`)) return;
    const btn = $("#retention-save");
    btn.disabled = true;
    try {
      const r = await api(`/api/p/${PID}/settings/retention`, {retention: policy});
      const gone = Object.values(r.deleted || {}).reduce((a, b) => a + b, 0);
      toast(gone ? `Saved — ${gone} run${gone > 1 ? "s" : ""} deleted` : "Saved");
      await show();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  }

  function retentionRow(origin, label, help, value) {
    const row = el("div", "setrow");
    row.dataset.origin = origin;
    const text = el("div", "setlabel");
    text.append(el("div", "setname", label), el("div", "sethelp", help));
    const ctl = el("div", "setctl");
    const days = el("input");
    days.type = "number";
    days.min = "0";
    days.step = "1";
    days.inputMode = "numeric";
    days.className = "setdays";
    days.value = value == null ? "30" : String(value);
    days.disabled = value == null;
    days.setAttribute("aria-label", `${label}: days to keep`);
    const unit = el("span", "setunit", "days");
    const forever = el("label", "setforever");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = value == null;
    forever.append(cb, "Keep forever");
    cb.onchange = () => { days.disabled = cb.checked; schedulePreview(); };
    days.oninput = schedulePreview;
    ctl.append(days, unit, forever);
    row.append(text, ctl, el("div", "sethint"));
    return row;
  }

  function factRow(label, value, mono) {
    const row = el("div", "factrow");
    row.append(el("div", "factkey", label), el("div", "factval" + (mono ? " mono" : ""), value));
    return row;
  }

  async function show() {
    box.textContent = "";
    box.append(el("div", "note", "Loading settings…"));
    try { current = await api(`/api/p/${PID}/settings`); }
    catch (e) { box.textContent = ""; box.append(loadError(e, () => show())); return; }
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Settings"));
    box.append(head);

    const runs = el("section", "setsection");
    runs.append(el("h3", "setsectitle", "Runs"));
    const facts = el("div", "facts");
    const info = current.store_info || {};
    facts.append(factRow("Stored in", info.label || current.store, true));
    if (info.why) facts.append(factRow("Chosen by", info.why));
    facts.append(factRow("Backend", `${current.backend}${current.writable ? "" : " (read-only)"}`));
    facts.append(factRow("Runs kept", current.runs == null ? "—" : String(current.runs)));
    facts.append(factRow("Langfuse", info.remote || current.langfuse || "Not connected",
      !!(info.remote || current.langfuse)));
    for (const sk of info.skipped || [])
      facts.append(factRow("Not read", `${sk.sink} — ${sk.reason}`));
    runs.append(facts);
    if (current.store_error) runs.append(el("div", "errbox setstoreerr", current.store_error));
    box.append(runs);

    const ret = el("section", "setsection");
    ret.append(el("h3", "setsectitle", "Retention"));
    ret.append(el("p", "setintro",
      "How long each kind of run is kept. Older runs are deleted when the studio opens the project, then once a day. Saved in operonx.toml, so a shared studio keeps the same policy."));
    const form = el("div", "setform");
    for (const [origin, label, help] of ORIGINS) form.append(retentionRow(origin, label, help, current.retention[origin]));
    ret.append(form);
    const foot = el("div", "setfoot");
    const note = el("div", "setnote");
    note.id = "retention-preview";
    const btn = el("button", "primary needs-edit", "Save");
    btn.id = "retention-save";
    if (window.Account && Account.viewOnly) {
      Account.readonly(...form.querySelectorAll("input, select"));
      foot.classList.add("viewonly");
      note.textContent = Account.VIEW_ONLY;
    }
    btn.type = "button";
    btn.onclick = save;
    foot.append(note, btn);
    ret.append(foot);
    if (current.swept_at) {
      const gone = Object.values(current.last_sweep || {}).reduce((a, b) => a + b, 0);
      ret.append(el("p", "setintro",
        `Last applied ${fmtAgo(current.swept_at * 1000)} — ${gone ? `${gone} run${gone > 1 ? "s" : ""} deleted` : "nothing to delete"}.`));
    }
    box.append(ret);

    // how the studio looks, in this browser
    const look = el("section", "setsection");
    look.append(el("h3", "setsectitle", "Appearance"));
    look.append(el("p", "setintro", "Light, dark, or as this device's system says. Kept in this browser."));
    look.append(Theme.picker());
    box.append(look);

    // the Claude account the assistant works as (assistant.js draws it)
    const asst = el("section", "setsection");
    asst.append(el("h3", "setsectitle", "Assistant"));
    asst.append(el("p", "setintro",
      "The Claude account the assistant works as. The studio keeps its own sign-in, apart from this machine's Claude Code."));
    const slot = el("div", "setaccount");
    asst.append(slot);
    box.append(asst);
    if (window.oxAccountBlock) window.oxAccountBlock().then((b) => slot.append(b)).catch(() => {});
    preview(current.preview);
  }

  registerPane("settings", {el: box, show});
  $("#btn-settings").onclick = () => switchTab(state.tab === "settings" ? "flow" : "settings");
})();
