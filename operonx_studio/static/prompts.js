/* operonx studio — Prompts: an LLM op's prompt, tried on what really came in.
 *
 * Pick an LLM op; its recorded executions are the samples. An input with
 * the same value in every sample is the prompt — editable; one that varies
 * is each case's data. Try the edit on the samples you pick: each is the
 * op re-run in the current code with the edit (the playground bridge),
 * shown beside what it answered when recorded, with tokens and cost.
 * Save writes the text back where it lives when it lives there verbatim;
 * otherwise the assistant is asked to.
 */

"use strict";

const PromptsView = (() => {
  const box = $("#prompts");
  const K = `prompts:${PID}`;
  const v = Object.assign({op: ""}, recall(K, {}));
  let token = 0;
  const save = () => store(K, v);

  function llmOps() {
    const out = [];
    for (const g of (state.ir || {}).graphs || []) {
      (function walk(nodes) {
        for (const n of nodes || []) {
          if (/llm/i.test(n.kind || "")) out.push({name: n.name, graph: g.name, resource: Array.isArray(n.resource) ? n.resource.join(", ") : n.resource});
          if (n.graph) walk(n.graph.nodes);
        }
      })(g.nodes);
    }
    const seen = new Set();
    return out.filter(o => !seen.has(o.name) && seen.add(o.name));
  }

  const text = (x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2));
  const money = (x) => (x == null ? "unpriced" : `$${x < 0.01 ? x.toFixed(5) : x.toFixed(3)}`);
  const toks = (u) => (u ? `${u.prompt_tokens ?? "?"} → ${u.completion_tokens ?? "?"} tokens` : "");

  async function show() {
    const mine = ++token;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Prompts"));
    box.append(head);
    const ops = llmOps();
    if (!ops.length) {
      box.append(paneNote("No LLM ops here", "The workbench opens an LLMOp's prompt and tries edits on the inputs it really had. This project's graphs have none yet.",
        null, {ask: {label: "Add an LLM step", prompt: "Look at this project's flow and suggest one place an LLM step would "
          + "clearly help. Describe it first; if I agree, add it with an LLMOp and a prompt I can tune here."}}));
      return;
    }
    if (!ops.find(o => o.name === v.op)) v.op = ops[0].name;
    save();
    const grid = el("div", "pwgrid");
    const list = el("div", "pwlist");
    const main = el("div", "pwmain");
    grid.append(list, main);
    box.append(grid);
    for (const o of ops) {
      const b = el("button", "pwop" + (o.name === v.op ? " sel" : ""));
      b.type = "button";
      b.append(el("b", "mono", o.name), el("span", null, `${o.graph}${o.resource ? " · " + o.resource : ""}`));
      b.onclick = () => { v.op = o.name; save(); show(); };
      list.append(b);
    }
    main.append(el("div", "note", "Reading this op's recorded executions…"));
    let got;
    try { got = await api(`/api/p/${PID}/prompts/${encodeURIComponent(v.op)}/samples?limit=20`); }
    catch (err) { main.textContent = ""; main.append(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    main.textContent = "";
    if (!got.samples.length) {
      main.append(paneNote("Nothing recorded yet", `Run ${v.op} — a service call, a job, the Playground — and its inputs become the samples here.`));
      return;
    }

    // the prompt: every input that is the same in every sample
    const edits = {};
    const sec = el("section", "pwprompt");
    sec.append(el("div", "stitle", "The prompt — the same in every sample"));
    for (const [k, val] of Object.entries(got.constant)) {
      const f = el("label", "pwfield");
      f.append(el("span", "mono", k));
      // an object (a {system, user} template) always gets the room to read as JSON
      const long = (val !== null && typeof val === "object") || (typeof val !== "number" && text(val).length > 60);
      const inp = long ? el("textarea", "playjson pwtext") : el("input", "mono");
      inp.value = text(val);
      if (long) inp.style.height = `${Math.min(420, 40 + 18 * text(val).split("\n").length)}px`;
      const saveRow = el("div", "pwsave");
      inp.oninput = () => {
        edits[k] = inp.value;
        if (inp.value === text(val)) delete edits[k];
        f.classList.toggle("edited", k in edits);
        saveRow.hidden = !(k in edits) || typeof val !== "string";
      };
      saveRow.hidden = true;
      const sb = el("button", "linkbtn needs-edit", "Save this text where it lives…");
      sb.type = "button";
      sb.onclick = () => saveText(saveRow, v.op, k, val, inp.value);
      saveRow.append(sb);
      f.append(inp, saveRow);
      sec.append(f);
    }
    if (!Object.keys(got.constant).length) sec.append(el("div", "note", "Every input differs between samples — there is no fixed prompt to edit here."));
    main.append(sec);

    // the samples, and what the edit makes of them
    const ss = el("section");
    ss.append(el("div", "stitle", `Samples — ${got.samples.length} recorded, newest first`));
    const table = el("div", "pwsamples");
    const picks = new Set(got.samples.slice(0, 3).map((_, i) => i));
    const resEls = [];
    got.samples.forEach((smp, i) => {
      const row = el("div", "pwrow");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = picks.has(i);
      cb.setAttribute("aria-label", "Try the edit on this sample");
      cb.onchange = () => { cb.checked ? picks.add(i) : picks.delete(i); go.textContent = `Try it on ${picks.size}`; };
      const data = el("div", "pwdata");
      data.append(el("span", "note", `${smp.origin} · ${smp.name} · ${fmtAgo(smp.started * 1000)}`));
      for (const k of got.varying.slice(0, 2)) data.append(el("div", "mono pwvar", `${k}: ${text(smp.inputs[k]).slice(0, 220)}`));
      const pair = el("div", "rerunpair pwpair");
      const then = el("div");
      then.append(el("div", "stitle", `Then · ${fmtMs(smp.duration_ms || 0)} · ${toks(smp.usage)} · ${money(smp.cost_usd)}`),
                  el("pre", "mono" + (smp.status === "error" ? " bad" : ""), smp.status === "error" ? String(smp.error || "").trim().split("\n").pop() : text(smp.content ?? "")));
      const now = el("div", "pwnow");
      now.append(el("div", "stitle", "Now"), el("pre", "mono muted", "—"));
      pair.append(then, now);
      resEls.push(now);
      row.append(cb, data, pair);
      table.append(row);
    });
    const acts = el("div", "priceacts");
    const go = el("button", "primary needs-edit", `Try it on ${picks.size}`);
    go.type = "button";
    acts.append(go);
    ss.append(acts, table);
    main.append(ss);

    go.onclick = async () => {
      go.disabled = true;
      const jobs = [...picks].map(async (i) => {
        const smp = got.samples[i];
        const slot = resEls[i];
        slot.textContent = "";
        slot.append(el("div", "stitle", "Now · running…"));
        const inputs = {...smp.inputs};
        for (const [k, x] of Object.entries(edits)) {
          const orig = got.constant[k];
          inputs[k] = typeof orig === "string" ? x : (() => { try { return JSON.parse(x); } catch { return x; } })();
        }
        try {
          const r = await PlayView.rerun(smp.run, v.op, inputs);
          const out = r.outputs || {};
          slot.textContent = "";
          slot.append(el("div", "stitle", `Now · ${fmtMs(r.ms || 0)} · ${toks(out.usage)} · ${money(out.cost_usd)}`),
                      el("pre", "mono" + (r.status === "error" ? " bad" : ""), r.status === "error" ? r.error : text(out.content ?? "")));
        } catch (err) {
          slot.textContent = "";
          slot.append(el("div", "stitle", "Now"), el("pre", "mono bad", err.message));
        }
      });
      await Promise.all(jobs);
      go.disabled = false;
    };
  }

  async function saveText(slot, op, key, original, updated) {
    slot.querySelector(".diffbox")?.remove();
    slot.querySelector(".pwask")?.remove();
    let got;
    try { got = await api(`/api/p/${PID}/prompts/save`, {original, updated}); }
    catch (err) {
      const ask = el("div", "pwask");
      ask.append(el("span", "note", `${err.message}. `));
      const b = el("button", "linkbtn", "Ask the assistant to make this change");
      b.type = "button";
      b.onclick = () => window.oxAsk && window.oxAsk(
        `In op \`${op}\`, the prompt input \`${key}\` should change. It is built in code or YAML — find where and edit it.\n\n`
        + `Currently:\n\`\`\`\n${original}\n\`\`\`\n\nShould become:\n\`\`\`\n${updated}\n\`\`\``);
      ask.append(b);
      slot.append(ask);
      return;
    }
    const diff = el("div", "diffbox");
    for (const ln of got.diff.split("\n")) diff.append(el("span", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : "", ln + "\n"));
    const apply = el("button", "primary needs-edit", `Write ${got.file}`);
    apply.type = "button";
    apply.onclick = async () => {
      try { await api(`/api/p/${PID}/prompts/save`, {original, updated, apply: true}); toast(`Saved to ${got.file}`); show(); }
      catch (err) { toast(err.message, true); }
    };
    slot.append(diff, apply);
  }

  registerPane("prompts", {el: box, show});
  return {show};
})();
