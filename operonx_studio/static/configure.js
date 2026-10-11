/* operonx studio — an op's configuration, edited as what it is
 * (docs/STUDIO_EXPERIENCE_PLAN.md §4).
 *
 *   Settings      the call's literal arguments, one field per type (a switch,
 *                 a number, a choice, text, a prompt's parts, a list), and the
 *                 arguments it leaves at their default, folded
 *   How it runs   the op's own @op(...) keywords: show_keys, bound, transient
 *                 (the others are shown as the code has them)
 *   Resource      which resource it uses, among those of its category
 *
 * Nothing is written until the diff is seen: Review shows it, Apply writes it
 * through operonx_studio/safewrite.py (the file previewed, the change in
 * scope, the project still building), and the toast offers Undo. A value the
 * code computes (a Ref, a SCRATCH read, an expression) is wiring: shown, never
 * rewritten here.
 */

const Configure = (() => {
  // LLMOp's knobs that only a programmer sets; folded with the other defaults
  const QUIET = new Set(["messages", "tools", "tool_choice", "response_format", "stop", "logprobs",
    "top_logprobs", "n", "user", "seed", "frequency_penalty", "presence_penalty"]);

  /* What kind of field a value takes: from its declared type, else its value. */
  function kindOf(inp, value) {
    const t = inp.type || "any";
    if (t === "choice") return "choice";
    if (t === "bool" || typeof value === "boolean") return "bool";
    if (t === "int" || t === "float" || typeof value === "number") return "number";
    if (value && typeof value === "object" && !Array.isArray(value)
        && Object.values(value).every(v => typeof v === "string")) return "parts";
    if (Array.isArray(value) && value.every(v => typeof v === "string")) return "lines";
    if (t === "str" || typeof value === "string") return "text";
    if (t === "list" && value == null) return "lines";
    return "json";
  }

  /* One field: the control, and how to read the value back (or an error). */
  function control(inp, value, kind) {
    const wrap = el("div", "cf-control");
    let read;
    if (kind === "bool") {
      const c = el("input");
      c.type = "checkbox";
      c.checked = !!value;
      c.className = "cf-switch";
      wrap.append(c);
      read = () => ({value: c.checked});
    } else if (kind === "number") {
      const c = el("input");
      c.type = "number";
      c.step = inp.type === "int" ? "1" : "any";
      c.value = value == null ? "" : String(value);
      if (inp.default != null) c.placeholder = String(inp.default);
      wrap.append(c);
      read = () => {
        if (c.value.trim() === "") return {error: "a number"};
        const n = Number(c.value);
        if (!Number.isFinite(n)) return {error: "a number"};
        if (inp.type === "int" && !Number.isInteger(n)) return {error: "a whole number"};
        return {value: n};
      };
    } else if (kind === "choice") {
      const c = el("select");
      for (const ch of inp.choices || []) {
        const o = el("option", null, String(ch));
        o.value = JSON.stringify(ch);
        if (JSON.stringify(ch) === JSON.stringify(value)) o.selected = true;
        c.append(o);
      }
      wrap.append(c);
      read = () => ({value: JSON.parse(c.value)});
    } else if (kind === "parts") {
      const areas = [];
      for (const [k, v] of Object.entries(value || {})) {
        const lab = el("div", "cf-part mono", k);
        const a = el("textarea", "cf-text mono");
        a.value = v;
        a.rows = Math.min(14, Math.max(2, v.split("\n").length));
        areas.push([k, a]);
        wrap.append(lab, a);
      }
      read = () => ({value: Object.fromEntries(areas.map(([k, a]) => [k, a.value]))});
    } else if (kind === "lines") {
      const a = el("textarea", "cf-text mono");
      a.value = (value || []).join("\n");
      a.rows = Math.min(12, Math.max(2, (value || []).length + 1));
      a.placeholder = "one per line";
      wrap.append(a);
      read = () => ({value: a.value.split("\n").map(x => x.trim()).filter(Boolean)});
    } else if (kind === "text") {
      const long = typeof value === "string" && (value.length > 60 || value.includes("\n"));
      const c = el(long ? "textarea" : "input", "cf-text" + (long ? " mono" : ""));
      if (!long) c.type = "text";
      c.value = value == null ? "" : String(value);
      if (long) c.rows = Math.min(14, Math.max(3, c.value.split("\n").length));
      if (inp.default != null) c.placeholder = String(inp.default);
      wrap.append(c);
      read = () => (inp.required && !c.value ? {error: "required"} : {value: c.value});
    } else {
      const a = el("textarea", "cf-text mono");
      a.value = value === undefined ? "" : JSON.stringify(value, null, 2);
      a.rows = Math.min(10, Math.max(2, a.value.split("\n").length));
      wrap.append(a);
      read = () => { try { return {value: JSON.parse(a.value)}; } catch { return {error: "valid JSON"}; } };
    }
    return {wrap, read};
  }

  /* Every control in *box* named for a screen reader: the field, and the
   * part of it (a prompt's `system`) when there are several. */
  function labelled(box, name) {
    for (const c of box.querySelectorAll("input, textarea, select")) {
      const part = c.previousElementSibling && c.previousElementSibling.classList.contains("cf-part")
        ? ` ${c.previousElementSibling.textContent}` : "";
      if (!c.getAttribute("aria-label")) c.setAttribute("aria-label", name + part);
    }
    return box;
  }

  function diffBox(text) {
    const box = el("div", "diffbox");
    for (const ln of (text || "").split("\n")) {
      box.append(el("div", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : null, ln));
    }
    return box;
  }

  /* Review → the diff → Apply, for one change; `plan(apply, base)` posts it. */
  function reviewFlow(row, plan, okText) {
    const bar = el("div", "cf-bar");
    const review = el("button", "small needs-edit", "Review");
    review.type = "button";
    const msg = el("span", "cf-msg");
    const out = el("div", "cf-out");
    out.hidden = true;
    bar.append(review, msg);
    row.append(bar, out);
    // the button shows once the field has changed: an untouched form is quiet
    bar.hidden = true;
    const touched = (ev) => { if (!out.contains(ev.target)) bar.hidden = false; };
    row.addEventListener("input", touched);
    row.addEventListener("change", touched);
    review.onclick = async () => {
      msg.textContent = "";
      const p0 = plan(false);
      if (p0.error) { msg.textContent = `Needs ${p0.error}`; msg.className = "cf-msg bad"; return; }
      let got;
      try { got = await p0.run(); } catch (e) { msg.textContent = e.message; msg.className = "cf-msg bad"; return; }
      if (!got.changed) { msg.textContent = "No change"; msg.className = "cf-msg"; return; }
      out.textContent = "";
      out.append(diffBox(got.diff));
      const apply = el("button", "primary small needs-edit", "Apply");
      apply.type = "button";
      let base = got.base;
      apply.onclick = async () => {
        apply.disabled = true;
        apply.textContent = "Writing…";
        try {
          const done = await plan(true, base).run();
          wrote(done, okText);
          out.hidden = true;
        } catch (e) {
          apply.disabled = false;
          apply.textContent = "Apply";
          const fresh = refusal(e, out);
          out.append(apply);
          if (fresh) { base = fresh; apply.textContent = "Apply to the file as it is now"; } else apply.remove();
        }
      };
      out.append(apply);
      out.hidden = false;
    };
  }

  function field(n, inp, graphName) {
    const b = inp.binding || {};
    const isSet = b.kind === "literal";
    const value = isSet ? b.value : inp.default;
    const kind = kindOf(inp, value);
    const row = el("div", "cf-field");
    const head = el("div", "cf-head");
    head.append(el("span", "cf-name mono", inp.name));
    const hint = inp.type && inp.type !== "any" ? (inp.type === "choice" ? "one of" : inp.type) : kind;
    head.append(el("span", "cf-type", hint + (inp.required ? " · required" : "")));
    if (!isSet) head.append(el("span", "cf-default", inp.default != null ? "default" : "not set"));
    row.append(head);
    if (inp.description) row.append(el("div", "cf-desc", inp.description));
    const c = control(inp, value, kind);
    labelled(c.wrap, inp.name);
    row.append(c.wrap);
    reviewFlow(row, (apply, base) => {
      const got = c.read();
      if (got.error) return {error: got.error};
      return {run: () => api(`/api/p/${PID}/edit`, {
        graph: graphName, action: "set_param", op_name: n.name, param: inp.name, value: got.value,
        add: !isSet, dry_run: !apply, base,
      })};
    }, `${n.name}.${inp.name} saved`);
    return row;
  }

  function settings(n, graphName) {
    const sec = el("section", "cf-sec");
    sec.append(el("div", "stitle", "Settings"));
    const ins = n.inputs || [];
    const set = ins.filter(i => (i.binding || {}).kind === "literal");
    const unset = ins.filter(i => (i.binding || {}).kind === "unset");
    for (const inp of set) sec.append(field(n, inp, graphName));
    const wired = ins.filter(i => !["literal", "unset"].includes((i.binding || {}).kind));
    if (wired.length) {
      sec.append(el("div", "note cf-wired",
        `${wired.map(i => i.name).join(", ")} ${wired.length === 1 ? "comes" : "come"} from other ops or cells (see Ports): wiring, edited in the code.`));
    }
    const quiet = unset.filter(i => !QUIET.has(i.name));
    if (quiet.length || unset.length) {
      const more = el("details", "cf-more");
      more.append(el("summary", null, `${unset.length} left at their default`));
      for (const inp of [...quiet, ...unset.filter(i => QUIET.has(i.name))]) more.append(field(n, inp, graphName));
      sec.append(more);
    }
    if (!set.length && !unset.length) sec.append(el("div", "note", "Every input is wired: nothing to set here."));
    return sec;
  }

  function howItRuns(n, cfg) {
    const d = cfg.decorator;
    if (!d) return null;
    const sec = el("section", "cf-sec");
    sec.append(el("div", "stitle", "How it runs"));
    const post = (key, value) => (apply, base) => ({run: () => api(`/api/p/${PID}/op-decorator`, {
      file: d.file, func: d.func, key, value: value(), apply, base,
    })});
    // show_keys: which outputs a card and a run row show
    const sk = el("div", "cf-field");
    sk.append(el("div", "cf-head", ""));
    sk.firstChild.append(el("span", "cf-name mono", "show_keys"), el("span", "cf-type", "outputs a card and a run show"));
    const current = (d.kwargs.show_keys && d.kwargs.show_keys.value) || n.show_keys || [];
    const boxes = el("div", "cf-checks");
    const picks = [];
    for (const o of n.outputs || []) {
      const lab = el("label", "cf-check");
      const c = el("input");
      c.type = "checkbox";
      c.checked = current.includes(o);
      picks.push([o, c]);
      lab.append(c, el("span", "mono", o));
      boxes.append(lab);
    }
    sk.append(boxes);
    reviewFlow(sk, post("show_keys", () => picks.filter(([, c]) => c.checked).map(([o]) => o)), `${n.name}: show_keys saved`);
    sec.append(sk);
    // bound: where it runs
    const bd = el("div", "cf-field");
    const bh = el("div", "cf-head");
    bh.append(el("span", "cf-name mono", "bound"), el("span", "cf-type", "sync: inline · io: a task · cpu: a thread"));
    bd.append(bh);
    const sel = el("select");
    for (const v of ["sync", "io", "cpu"]) {
      const o = el("option", null, v);
      o.value = v;
      if ((d.kwargs.bound && d.kwargs.bound.value) === v || (!d.kwargs.bound && n.bound === v)) o.selected = true;
      sel.append(o);
    }
    sel.setAttribute("aria-label", "bound");
    bd.append(sel);
    reviewFlow(bd, post("bound", () => sel.value), `${n.name}: bound saved`);
    sec.append(bd);
    // transient: release per-item values when the item is done
    const tr = el("div", "cf-field");
    const th = el("div", "cf-head");
    th.append(el("span", "cf-name mono", "transient"), el("span", "cf-type", "release each item's values once it is done"));
    tr.append(th);
    const tc = el("input");
    tc.type = "checkbox";
    tc.className = "cf-switch";
    tc.checked = d.kwargs.transient ? !!d.kwargs.transient.value : !!n.transient;
    tc.setAttribute("aria-label", "transient");
    tr.append(tc);
    reviewFlow(tr, post("transient", () => tc.checked), `${n.name}: transient saved`);
    sec.append(tr);
    // the rest, as the code has them
    const rest = Object.entries(d.kwargs).filter(([k]) => !d.editable.includes(k));
    if (rest.length) {
      const facts = el("div", "facts compact");
      for (const [k, v] of rest) {
        const r = el("div", "factrow");
        r.append(el("div", "factkey mono", k), el("div", "factval mono", v.source));
        facts.append(r);
      }
      sec.append(facts);
      sec.append(el("div", "note", `In ${d.file}, on ${d.func}: edit these in the code.`));
    }
    return sec;
  }

  function resourcePick(n, cfg, graphName) {
    const r = cfg.resource;
    if (!r || !r.literal || (r.choices || []).length < 2) return null;
    const sec = el("section", "cf-sec");
    sec.append(el("div", "stitle", `Resource · ${r.category || ""}`));
    const row = el("div", "cf-field");
    const sel = el("select");
    sel.setAttribute("aria-label", `resource for ${n.name}`);
    for (const name of r.choices) {
      const o = el("option", null, name);
      o.value = name;
      if (name === r.current) o.selected = true;
      sel.append(o);
    }
    row.append(sel);
    reviewFlow(row, (apply, base) => ({run: () => api(`/api/p/${PID}/edit`, {
      graph: graphName, action: "set_resource", op_name: n.name, resource: sel.value, dry_run: !apply, base,
    })}), `${n.name}: resource saved`);
    sec.append(row);
    return sec;
  }

  /* The panel's Configure part for a selected op. */
  function section(it) {
    const n = it.node;
    const box = el("div", "cf");
    if (it.depth > 0) {
      box.append(el("div", "note", "An op of a nested graph: configure it in that graph's own view."));
      return box;
    }
    const graphName = state.graph.name;
    box.append(settings(n, graphName));
    const slot = el("div");
    box.append(slot);
    api(`/api/p/${PID}/op-config?graph=${encodeURIComponent(graphName)}&op=${encodeURIComponent(n.name)}`)
      .then(cfg => {
        const how = howItRuns(n, cfg);
        if (how) slot.append(how);
        const res = resourcePick(n, cfg, graphName);
        if (res) slot.append(res);
      })
      .catch(() => {});
    return box;
  }

  return {section, kindOf, review: reviewFlow, labelled};
})();

if (typeof module !== "undefined") module.exports = Configure;
