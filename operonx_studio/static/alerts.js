/* operonx studio — Alerts: a threshold per service or job, and a webhook.
 *
 * Each rule watches one service or job over a trailing window — error
 * rate, p95 (of runs, or of one op), cost per hour, or too few runs — and
 * posts to a webhook when it crosses, reminds while it stays over, and
 * says when it recovers. The studio checks every minute while it runs;
 * the number beside each rule is what it is right now.
 */

"use strict";

const AlertsView = (() => {
  const box = $("#alerts");
  let token = 0;
  let editing = null;   // the rule being edited (a copy), or {} for a new one

  const LABEL = {error_rate: "Error rate", p95_ms: "p95 duration", cost_per_hour: "Cost per hour", runs: "Runs (fewer than)"};
  const fmt = (metric, x) => x == null ? "—" : metric === "error_rate" ? `${(100 * x).toFixed(1)}%`
    : metric === "p95_ms" ? fmtMs(x) : metric === "cost_per_hour" ? `$${Number(x).toFixed(4)}/h` : String(x);

  async function show() {
    const mine = ++token;
    let got;
    try { got = await api(`/api/p/${PID}/alerts`); }
    catch (err) { box.textContent = ""; box.append(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Alerts"));
    const add = el("button", "primary", "New alert");
    add.type = "button";
    add.onclick = () => { editing = {}; show(); };
    const check = el("button", null, "Check now");
    check.type = "button";
    check.onclick = async () => {
      check.disabled = true;
      try { const r = await api(`/api/p/${PID}/alerts/check`, {}); toast(r.sent.length ? `Sent ${r.sent.length}` : "Nothing to send"); }
      catch (err) { toast(err.message, true); }
      show();
    };
    head.append(el("div", "spacer"), check, add);
    box.append(head);
    box.append(el("p", "panesub", "Checked every minute while the studio runs, from the runs it already records. "
      + "A rule posts when it crosses, reminds while it stays over, and says when it recovers."));

    if (editing) box.append(editor(editing, got.metrics));
    if (!got.alerts.length && !editing) {
      box.append(paneNote("No alerts yet", "Add one to hear about a service that starts failing, slows down, costs more, or goes quiet."));
      return;
    }
    for (const a of got.alerts) {
      const n = a.now || {};
      const judged = n.value != null;
      const card = el("div", "alcard" + (a.enabled ? "" : " off") + (n.firing ? " firing" : ""));
      const top = el("div", "altop");
      const state = !a.enabled ? ["paused", "s-idle"] : n.firing ? ["firing", "s-bad"] : judged ? ["ok", "s-ok"] : ["not judged", "s-idle"];
      top.append(el("span", `status ${state[1]}`, state[0]), el("b", null, a.name));
      const acts = el("span", "svcacts");
      const edit = el("button", "linkbtn", "Edit"); edit.type = "button";
      edit.onclick = () => { editing = {...a, webhook: ""}; show(); };
      const runs = el("button", "linkbtn", "Open the runs"); runs.type = "button";
      runs.onclick = () => {
        // the Runs screen, on this service or job
        RunsView.openFolder({kind: a.origin, name: a.target});
      };
      acts.append(edit, runs);
      if (a.webhook_set) {
        const t = el("button", "linkbtn", "Send a test"); t.type = "button";
        t.onclick = async () => {
          try { const r = await api(`/api/p/${PID}/alerts/${encodeURIComponent(a.name)}/test`, {}); toast(`The webhook answered ${r.status}`); }
          catch (err) { toast(err.message, true); }
        };
        acts.append(t);
      }
      const del = el("button", "linkbtn danger", "Delete"); del.type = "button";
      del.onclick = async () => {
        if (!confirm(`Delete the alert “${a.name}”?`)) return;
        await fetch(`/api/p/${PID}/alerts/${encodeURIComponent(a.name)}`, {method: "DELETE"});
        show();
      };
      acts.append(del);
      top.append(acts);
      card.append(top);
      const what = a.op ? `p95 of ${a.op}` : LABEL[a.metric];
      const rule = el("div", "alrule");
      rule.append(el("span", "mono", `${a.origin} ${a.target}`), el("span", null, ` · ${what} ${a.metric === "runs" ? "<" : ">"} `),
                  el("b", null, fmt(a.metric, a.threshold)), el("span", null, ` over ${a.window_min} min`));
      card.append(rule);
      const nowRow = el("div", "alnow");
      nowRow.append(el("span", "alval" + (n.firing ? " bad" : ""), fmt(a.metric, n.value)),
                    el("span", "note", judged ? ` now · ${n.runs} runs in the window${n.unpriced ? ` · ${n.unpriced} unpriced` : ""}` : ` — ${n.note || "not judged"}`));
      card.append(nowRow);
      const last = a.last;
      card.append(el("div", "note alsent", !a.webhook_set ? "No webhook — shown here only."
        : last && last.sent_at ? `Last sent ${fmtAgo(last.sent_at * 1000)} to ${a.webhook}` : `Sends to ${a.webhook}`));
      box.append(card);
    }
  }

  function editor(a, metrics) {
    const card = el("div", "alcard aledit");
    card.append(el("div", "stitle", a.name ? `Edit ${a.name}` : "New alert"));
    const grid = el("div", "condgrid");
    const field = (label, input) => { const f = el("label", "condfield"); f.append(el("span", null, label), input); grid.append(f); return input; };
    const inp = (value, attrs) => { const i = el("input", "mono"); Object.assign(i, attrs || {}); i.value = value ?? ""; return i; };
    const name = field("Name", inp(a.name, {placeholder: "call errors"}));
    if (a.name) name.readOnly = true;
    const target = el("select");
    const ir = state.ir || {};
    for (const s of (ir.services || []).filter(x => x.kind !== "asgi")) { const o = el("option", null, `service · ${s.name}`); o.value = `service:${s.name}`; target.append(o); }
    for (const j of (ir.jobs || [])) { const o = el("option", null, `${j.kind || "job"} · ${j.name}`); o.value = `${j.kind === "eval" ? "eval" : "job"}:${j.name}`; target.append(o); }
    if (a.origin) target.value = `${a.origin}:${a.target}`;
    field("Watches", target);
    const metric = el("select");
    for (const m of metrics) { const o = el("option", null, LABEL[m] || m); o.value = m; metric.append(o); }
    metric.value = a.metric || "error_rate";
    field("When", metric);
    const op = field("…of one op (p95 only)", inp(a.op || "", {placeholder: "all of the run"}));
    // thresholds are typed as people think of them: a percent, milliseconds, dollars an hour
    const shown = (m, x) => x == null ? "" : m === "error_rate" ? String(+(100 * x).toFixed(3)) : String(x);
    const threshold = field("Is over", inp(shown(a.metric || "error_rate", a.threshold), {type: "number", step: "any"}));
    const unit = () => ({error_rate: "%", p95_ms: "ms", cost_per_hour: "$ an hour", runs: "runs (fires under)"})[metric.value];
    const unitEl = el("span", "note", unit());
    threshold.parentNode.append(unitEl);
    metric.onchange = () => { unitEl.textContent = unit(); op.disabled = metric.value !== "p95_ms"; };
    op.disabled = metric.value !== "p95_ms";
    const win = field("Window (min)", inp(a.window_min ?? 15, {type: "number", min: 1}));
    const minRuns = field("Judge from (runs)", inp(a.min_runs ?? 5, {type: "number", min: 0}));
    const repeat = field("Remind every (min)", inp(a.repeat_min ?? 60, {type: "number", min: 1}));
    const hook = inp("", {placeholder: a.webhook_set ? "kept — type a new URL to change it" : "https://hooks.slack.com/services/…"});
    const hf = el("label", "condfield wide");
    hf.append(el("span", null, "Webhook (Slack, Teams, any relay)"), hook);
    grid.append(hf);
    card.append(grid);
    const err = el("div", "fielderr");
    const acts = el("div", "priceacts");
    const cancel = el("button", "linkbtn", "Cancel"); cancel.type = "button";
    cancel.onclick = () => { editing = null; show(); };
    const save = el("button", "primary", "Save"); save.type = "button";
    save.onclick = async () => {
      const [origin, tgt] = target.value.split(":");
      const t = Number(threshold.value);
      try {
        await api(`/api/p/${PID}/alerts`, {name: name.value.trim(), origin, target: tgt, metric: metric.value,
          op: metric.value === "p95_ms" ? op.value.trim() : "", threshold: metric.value === "error_rate" ? t / 100 : t,
          window_min: Number(win.value) || 15, min_runs: Number(minRuns.value) || 0, repeat_min: Number(repeat.value) || 60,
          webhook: hook.value.trim(), enabled: true});
        editing = null;
        show();
      } catch (e2) { err.textContent = e2.message; }
    };
    acts.append(cancel, save);
    card.append(err, acts);
    return card;
  }

  registerPane("alerts", {el: box, show});
  return {show};
})();
