/* operonx studio — Services: the application's listeners, running or not.
 *
 * One card per listener (a host and port, and the services bound to it —
 * what one process serves). Up or down is asked of the port itself, so a
 * listener started in a terminal shows as running too; the studio starts
 * one the way a developer would and stops only what it started. The
 * environment check (the variables the resource files need, by name)
 * sits on top, because a service that cannot start usually says so there.
 */

"use strict";

const ServicesView = (() => {
  const box = $("#services");
  let token = 0;
  let timer = null;
  const openLogs = new Set();

  async function show() {
    const mine = ++token;
    clearTimeout(timer);
    let got, env = null;
    try {
      [got, env] = await Promise.all([api(`/api/p/${PID}/services`), api(`/api/p/${PID}/env-health`).catch(() => null)]);
    } catch (err) { box.textContent = ""; box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Services"));
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = show;
    head.append(el("div", "spacer"), refresh);
    box.append(head);
    box.append(el("p", "panesub", "Each listener is one process: a port and the services bound to it. "
      + "Start one here to try it the way it runs in production; the Playground drives it without a port."));

    if (env) {
      const missing = Object.entries(env.env || {}).filter(([, x]) => x === "missing").map(([k]) => k);
      const line = el("div", "svcenv " + (missing.length ? "bad" : "ok"));
      line.append(el("b", null, "Environment"),
        el("span", null, missing.length ? ` — ${missing.length} variable${missing.length > 1 ? "s" : ""} the resources need ${missing.length > 1 ? "are" : "is"} not set: ${missing.join(", ")}`
                                         : " — every variable the resources need is set"));
      box.append(line);
    }

    if (!got.listeners.length) {
      box.append(paneNote("No services declared", "A service is a graph behind a door — HTTP, a WebSocket — that clients call.",
        "[[serve]]\nname  = \"api\"\ngraph = \"main:flow\"\nkind  = \"http\"\npath  = \"/run\"",
        {ask: {label: "Serve this graph", prompt: "Declare a service for this project's main graph so it can be called "
          + "over HTTP, then drive it once in the playground and show me what came back."}}));
      return;
    }
    let busy = false;
    for (const l of got.listeners) {
      const card = el("div", "svccard" + (l.running ? " up" : ""));
      const top = el("div", "svctop");
      const stateText = l.starting ? "starting…" : l.running ? "running" : l.exit_code != null ? `exited (${l.exit_code})` : "stopped";
      top.append(el("span", "status " + (l.running ? "s-ok" : l.exit_code ? "s-bad" : "s-idle"), stateText),
                 el("b", "mono svckey", l.key));
      if (l.running && l.health) {
        top.append(el("span", "svchealth " + (l.health.status < 400 ? "ok" : "bad"),
                      `GET /health ${l.health.status} · ${l.health.ms} ms`));
      }
      const acts = el("span", "svcacts");
      if (l.managed || (!l.running && !l.starting)) {
        const btn = el("button", (l.managed ? "" : "primary") + " needs-edit", l.managed ? "Stop" : "Start");
        btn.type = "button";
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await api(`/api/p/${PID}/services/${l.managed ? "stop" : "start"}`, {key: l.key});
            if (!l.managed) openLogs.add(l.key);
          } catch (err) { toast(err.message, true); }
          show();
        };
        acts.append(btn);
      } else if (l.running) {
        acts.append(el("span", "note", "started outside the studio"));
      }
      if (l.log) {
        const lb = el("button", "linkbtn", openLogs.has(l.key) ? "Hide log" : "Log");
        lb.type = "button";
        lb.onclick = () => { openLogs.has(l.key) ? openLogs.delete(l.key) : openLogs.add(l.key); show(); };
        acts.append(lb);
      }
      top.append(acts);
      card.append(top);

      const list = el("div", "svclist");
      for (const s of l.detail) {
        const row = el("div", "svcrow");
        const what = s.kind === "http" ? `http ${s.method || "POST"} ${s.path}` : s.kind === "asgi" ? `asgi ${s.path}` : `${s.kind} ${s.path || ""}`;
        const name = el("div", "svcname");
        name.append(el("b", null, s.name), el("span", "mono", what));
        if (s.workers > 1) name.append(el("span", "chip", `${s.workers} workers`));
        row.append(name);
        if (s.description) row.append(el("div", "svcdesc", s.description));
        const links = el("div", "svclinks");
        if (s.kind !== "asgi") {
          const play = el("button", "linkbtn needs-edit", "Playground");
          play.type = "button";
          play.onclick = () => { const k = `play:${PID}`; const pv = recall(k, {}); pv.service = s.name; store(k, pv); switchTab("playground"); };
          const mon = el("button", "linkbtn", "Monitor");
          mon.type = "button";
          mon.onclick = () => performUi("open_monitor", {target: `service:${s.name}`, days: 1});
          links.append(play, mon);
        }
        row.append(links);
        list.append(row);
      }
      card.append(list);
      if (l.log && openLogs.has(l.key)) {
        const pre = el("pre", "mono svclog", "…");
        card.append(pre);
        api(`/api/p/${PID}/services/log?key=${encodeURIComponent(l.key)}`).then((x) => {
          pre.textContent = x.log || "(nothing yet)";
          pre.scrollTop = pre.scrollHeight;
        }).catch(() => {});
      }
      if (l.starting || (l.managed && openLogs.has(l.key))) busy = true;
      box.append(card);
    }
    // while something is starting or a log is open, look again
    if (busy) timer = setTimeout(() => { if (!box.hidden) show(); }, 2000);
  }

  registerPane("services", {el: box, show});
  return {show};
})();
