/* operonx studio — the Flow screen's project picture (SPATIAL_FACTORY_PLAN F3): the whole project as
 * one isometric model, behind the first row of the flows rail. Opening a flow from the rail, or from
 * its name on the picture, goes back to the 2D editor.
 *
 * The picture itself is factory3d.js, an ES module with three.js behind it; it is imported the first
 * time the picture is opened, so no other page of the studio pays for it. */

window.Factory = (() => {
  const host = document.getElementById("factory");
  let view = null, seen = null, loading = null;
  let model = null, modelOf = null;                  // the factory model of the IR in hand, for placed()
  const on = () => document.body.classList.contains("factory-on");

  async function show() {
    if (!host) return;
    if (document.body.dataset.tab !== "flow") switchTab("flow");
    document.body.classList.add("factory-on");
    FlowRail.render();
    if (view && seen === state.ir) {                 // back on the picture: as it was left, with the latest numbers
      view.resume();
      const mine = view;
      api(`/api/p/${PID}/flows/stats?days=7`).then(st => { if (view === mine) mine.setStats(st); }).catch(() => {});
      return;
    }
    if (view) { view.dispose(); view = null; }
    host.textContent = "";
    host.append(el("p", "fx-note", "Building the picture…"));
    try {
      const [mod, stats] = await Promise.all([loading || (loading = import("/static/factory3d.js")),
        api(`/api/p/${PID}/flows/stats?days=7`).catch(() => null)]);
      if (!on()) { host.textContent = ""; return; }
      seen = state.ir;
      view = mod.mount(host, state.ir, stats, {onOpen(name, node) {          // a flow, and (from a shared block) the op that uses it
        FlowRail.open(name);
        if (node) requestAnimationFrame(() => { if (state.sel !== node && state.cardEls && state.cardEls.has(node)) select(node); });
      }, onRuns(door) {                                 // a job's page has its runs; a service's are in the Runs hub
        if (door.type === "job") { state.jobSel = door.name; switchTab("jobs"); }
        else RunsView.openFolder({kind: "service", name: door.name});
      }, onDoor(door) {                                 // a service's own row, on the Services screen
        switchTab("services");
        const until = Date.now() + 4000;
        (function seek() {
          const row = document.querySelector(`#services [data-service="${CSS.escape(door.name)}"]`);
          if (row) { row.scrollIntoView({block: "center"}); row.classList.add("fx-flash"); setTimeout(() => row.classList.remove("fx-flash"), 1600); }
          else if (Date.now() < until && document.body.dataset.tab === "services") requestAnimationFrame(seek);
        })();
      }});
    } catch (err) {
      loading = null;
      host.textContent = "";
      host.append(el("p", "fx-note", "The project picture needs WebGL, and this browser did not give it one. The flows are in the list beside it."));
    }
  }

  function hide() {
    if (!on()) return;
    document.body.classList.remove("factory-on");
    if (view) view.pause();
  }

  /* does a service ("s:name") or a job ("j:name") stand somewhere on the picture: behind a flow, or
   * among the doors of a graph the project does not list */
  function placed(id) {
    if (!state.ir || !window.FactoryModel) return false;
    if (modelOf !== state.ir) { try { model = FactoryModel.build(state.ir, null); } catch { model = null; } modelOf = state.ir; }
    const e = model && model.by.get(id), j = e && e.job && model.by.get(e.job);
    return !!(e && (e.flow || e.asks || (j && (j.flow || j.asks))));
  }

  /* open the picture at a thing: its cluster selected and brought to the middle */
  async function reveal(id) {
    await show();
    if (view && on()) view.reveal(id);
  }

  return {show, hide, on, placed, reveal};
})();
