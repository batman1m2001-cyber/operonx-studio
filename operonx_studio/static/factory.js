/* operonx studio — the Flow screen's project picture (SPATIAL_FACTORY_PLAN F3): the whole project as
 * one isometric model, behind the first row of the flows rail. Opening a flow from the rail, or from
 * its name on the picture, goes back to the 2D editor.
 *
 * The picture itself is factory3d.js, an ES module with three.js behind it; it is imported the first
 * time the picture is opened, so no other page of the studio pays for it. */

window.Factory = (() => {
  const host = document.getElementById("factory");
  let view = null, seen = null, loading = null;
  const on = () => document.body.classList.contains("factory-on");

  async function show() {
    if (!host) return;
    if (document.body.dataset.tab !== "flow") switchTab("flow");
    document.body.classList.add("factory-on");
    FlowRail.render();
    if (view && seen === state.ir) return view.resume();
    if (view) { view.dispose(); view = null; }
    host.textContent = "";
    host.append(el("p", "fx-note", "Building the picture…"));
    try {
      const [mod, stats] = await Promise.all([loading || (loading = import("/static/factory3d.js")),
        api(`/api/p/${PID}/flows/stats?days=7`).catch(() => null)]);
      if (!on()) return host.textContent = "";
      seen = state.ir;
      view = mod.mount(host, state.ir, stats, {onOpen: (name) => FlowRail.open(name)});
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

  return {show, hide, on};
})();
