/* operonx studio — recorded values in a run. Split from studio.js, same
 * bundle, same order. */

/* ── trace values ───────────────────────────────────────────────────
 * One renderer for an execution's values (io.js): an LLM call as its
 * conversation and reply, everything else as readable fields, and a
 * Formatted / JSON switch the panel remembers. */
function traceValue(v) { return IO.valueView(v); }

/* an execution's input and output cards; inputs that read a SCRATCH
 * cell wear the cell's name */
function valueZones(box, inputs, outputs, scratchKeyOf = {}, opts = {}) {
  const badges = {};
  for (const [k, cell] of Object.entries(scratchKeyOf))
    badges[k] = [`⌂ ${cell}`, "read from a SCRATCH cell — the cell's observed value at this step"];
  box.append(IO.panel(inputs, outputs, {
    ...opts, badges, mode: recall("ioMode", "pretty"), onMode: (m) => store("ioMode", m),
  }));
}

function executionsSection(n, execP) {
  const sec = el("section");
  sec.append(el("div", "stitle", "Executions"));
  const runinfo = state.run.ops[n.name];
  if (runinfo) {
    const avg = runinfo.runs ? runinfo.total_ms / runinfo.runs : 0;
    const stats = el("div", "srcline",
      `${runinfo.runs}× · avg ${avg.toFixed(1)} ms · max ${runinfo.max_ms.toFixed(1)} ms`
      + (runinfo.errors ? ` · ${runinfo.errors} err` : ""));
    if (runinfo.errors) stats.classList.add("bad");
    sec.append(stats);
  }
  const box = el("div", "execbox", "…");
  sec.append(box);
  execP.then(data => {
    box.textContent = "";
    if (!data.executions.length) {
      box.append(el("div", "note", "no records for this op in this run"));
      return;
    }
    if (data.total > data.showing) {
      box.append(el("div", "srcline", `${data.total} recorded · last ${data.showing} below`));
    }

    // A GraphOp's records belong to its members, but one PASS through
    // the container is one execution of the container — and members of
    // the same pass share their dispatch ctx. Group by it, so the list
    // reads as invocations of THIS node, with the member breakdown and
    // the boundary values inside each.
    let rows;
    if (n.graph) {
      const groups = new Map();
      data.executions.forEach((ex, i) => {
        const key = ex.ctx ? JSON.stringify(ex.ctx) : `solo-${i}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ex);
      });
      const inNames = (n.inputs || []).map(i => i.name);
      rows = [...groups.values()].map(members => {
        const bad = members.find(m => m.status !== "ok");
        const boundary = (names, dir) => {
          const found = {};
          for (const m of members) {
            const src = dir === "out" ? m.outputs : m.inputs;
            if (!src || typeof src !== "object") continue;
            for (const k of names) if (k in src) found[k] = src[k];
          }
          return found;
        };
        return {
          op: n.name,
          start_time: members[0] && members[0].start_time,
          duration_ms: members.reduce((s, m) => s + (m.duration_ms || 0), 0),
          status: bad ? bad.status : "ok",
          error: bad ? bad.error : null,
          outputs: boundary(n.outputs || [], "out"),
          inputs: boundary(inNames, "in"),
          members,
        };
      });
    } else {
      rows = data.executions;
    }

    const maxMs = Math.max(1, ...rows.map(ex => ex.duration_ms || 0));
    const table = el("div", "exectable");
    const detail = el("div", "execdetail");
    let active = null;

    // when anything failed, one checkbox cuts the list to the failures
    if (rows.some(ex => ex.status !== "ok")) {
      const bar = el("label", "followpin");
      const cb = el("input");
      cb.type = "checkbox";
      cb.onchange = () => table.classList.toggle("erronly", cb.checked);
      bar.append(cb, " errors only");
      box.append(bar);
    }

    const clock = (t) => {
      if (t == null) return "";
      const d = new Date(t * 1000);
      return d.toLocaleTimeString([], {hour12: false})
        + "." + String(d.getMilliseconds()).padStart(3, "0").slice(0, 1);
    };

    // which inputs are SCRATCH reads — the IR's bindings say so
    const scratchKeyOf = {};
    for (const inp of n.inputs || []) {
      if (inp.binding && inp.binding.kind === "scratch")
        scratchKeyOf[inp.name] = inp.binding.key || inp.name;
    }
    const show = (ex, row) => {
      if (active) active.classList.remove("active");
      active = row; row.classList.add("active");
      detail.textContent = "";
      if (ex.error) detail.append(el("div", "srcline bad", String(ex.error)));
      valueZones(detail, ex.inputs, ex.outputs, scratchKeyOf, {focus: n.show_keys || []});
      if (ex.members) {
        detail.append(el("div", "plabel", "members"));
        for (const m of ex.members) {
          const line = el("div", "srcline mono" + (m.status === "ok" ? "" : " bad"),
            `${m.op}  ${(m.duration_ms ?? 0).toFixed(1)}ms  ${m.status ?? "?"}`);
          detail.append(line);
        }
      }
    };

    rows.forEach((ex, i) => {
      const idx = n.graph ? i + 1 : data.total - data.showing + i + 1;
      const row = el("button", "exline" + (ex.status === "ok" ? "" : " bad"));
      row.append(el("span", "exn mono", `#${idx}`));
      row.append(el("span", "extime mono", clock(ex.start_time)));
      // every run wears its dispatch ctx — WHICH pass this was is half
      // of understanding a generator's fan
      row.append(el("span", "exop mono",
        ex.members ? `${ex.members.length} ops` : fmtCtx(ex.ctx)));
      row.title = ex.ctx ? `ctx ${fmtCtx(ex.ctx)}` : "";
      const bar = el("span", "exbar");
      bar.style.setProperty("--w", `${Math.max(2, 100 * (ex.duration_ms || 0) / maxMs)}%`);
      row.append(bar);
      row.append(el("span", "exms mono", `${(ex.duration_ms ?? 0).toFixed(1)}ms`));
      row.append(el("span", "exst", ex.status === "ok" ? "✓" : (ex.status ?? "?")));
      row.onclick = () => show(ex, row);
      table.append(row);
    });
    box.append(table, detail);
    show(rows[rows.length - 1], table.lastChild);
  }).catch(e => { box.textContent = e.message; });
  return sec;
}

function inspectServe(serve) {
  const panel = $("#inspector");
  panel.classList.add("open");
  // (on a phone the panel is a sheet that only a selection opens)
  if (MOBILE.matches || (panelWanted() && recall("sideTab", "assistant") !== "inspect")) showSide("inspect");
  panel.textContent = "";
  panel.append(el("h3", null, `serve · ${serve.kind}`));
  panel.append(el("div", "kind mono", serve.path || ""));
  if (serve.description) {
    const sec = el("section");
    sec.append(el("div", "stitle", "Description"));
    sec.append(el("div", "srcline", serve.description));
    panel.append(sec);
  }
  const sec = el("section");
  sec.append(el("div", "stitle", "Feeds"));
  for (const name of state.graph.entries || []) sec.append(el("span", "outchip mono", name));
  panel.append(sec);
}

/* ── traces ───────────────────────────────────────────────────────── */

