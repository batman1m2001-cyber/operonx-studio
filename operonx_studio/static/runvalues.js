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

function inspectServe(serve) {
  const panel = $("#inspector");
  panel.classList.add("open");
  // (on a phone the panel is a sheet that only a selection opens)
  if (MOBILE.matches || (panelWanted() && recall("sideTab", "assistant") !== "inspect")) showSide("inspect");
  else if (!panelWanted()) peekSide("inspect");
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

