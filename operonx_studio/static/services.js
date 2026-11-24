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
  const page = $("#services");
  let box = page;                    // where the listeners are drawn: the Services screen, or a box handed to showIn (the picture's side panel)
  const seen = () => (box === page ? !box.hidden : box.isConnected);
  let token = 0;
  let timer = null;
  const openLogs = new Set();

  const redraw = () => show(true);               // drawn again where it stands
  function showIn(into) { box = into || page; return show(true); }
  async function show(keep) {
    if (keep !== true) box = page;                 // the tab asks: the screen is the box again
    const mine = ++token;
    clearTimeout(timer);
    const again = redraw;
    let got, env = null, queues = {queues: []};
    try {
      [got, env, queues] = await Promise.all([api(`/api/p/${PID}/services`), api(`/api/p/${PID}/env-health`).catch(() => null),
        api(`/api/p/${PID}/services/queues`).catch(() => ({queues: []}))]);
    } catch (err) { box.textContent = ""; box.append(loadError(err, again)); return; }
    if (mine !== token) return;
    box.textContent = "";
    const head = el("div", "panehead");
    head.append(el("h2", null, "Services"), paneAbout("Each listener is one process: a port and the services bound to it. "
      + "Start one here to try it the way it runs in production; Play (on the Flow) drives it without a port."));
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = again;
    head.append(el("div", "spacer"), refresh);
    box.append(head);

    if (env) {
      const note = envNotice(env.env);
      if (note) box.append(note);
    }

    const queued = (queues.queues || []).length ? queueSection(queues.queues) : null;
    const moving = (queues.queues || []).some((q) => q.counts && (q.counts.running || q.counts.queued));
    if (!got.listeners.length && queued) {
      box.append(queued);
      if (moving) timer = setTimeout(() => { if (seen()) again(); }, 2000);
      return;
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
                      `GET ${l.health.path || "/health"} ${l.health.status} · ${l.health.ms} ms`));
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
          redraw();
        };
        acts.append(btn);
      } else if (l.running) {
        acts.append(el("span", "note", "started outside the studio"));
      }
      if (l.log) {
        const lb = el("button", "linkbtn", openLogs.has(l.key) ? "Hide log" : "Log");
        lb.type = "button";
        lb.onclick = () => { openLogs.has(l.key) ? openLogs.delete(l.key) : openLogs.add(l.key); redraw(); };
        acts.append(lb);
      }
      top.append(acts);
      card.append(top);

      const list = el("div", "svclist");
      for (const s of l.detail) {
        const row = el("div", "svcrow");
        const what = s.kind === "http" ? `http ${s.method || "POST"} ${s.path}` : s.kind === "asgi" ? `asgi ${s.path}` : `${s.kind} ${s.path || ""}`;
        row.dataset.service = s.name;
        const name = el("div", "svcname");
        name.append(el("b", null, s.name), el("span", "mono", what));
        if (s.workers > 1) name.append(el("span", "chip", `${s.workers} workers`));
        row.append(name);
        if (s.description) row.append(el("div", "svcdesc", s.description));
        const links = el("div", "svclinks");
        if (window.Factory && Factory.placed(`s:${s.name}`)) {      // where it stands on the project picture (factory.js)
          const pic = el("button", "linkbtn", "Picture");
          pic.type = "button";
          pic.title = "Where this service stands on the project picture";
          pic.onclick = () => Factory.reveal(`s:${s.name}`);
          links.append(pic);
        }
        if (s.kind !== "asgi") {
          const play = el("button", "linkbtn needs-edit", "Play");
          play.type = "button";
          play.onclick = () => PlayView.openOn(s.name);
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
    if (queued) {
      box.append(queued);
      if (moving) busy = true;
    }
    // while something is starting, a log is open or a queue moves, look again
    if (busy) timer = setTimeout(() => { if (seen()) again(); }, 2000);
  }

  const ago = (s) => s == null ? "" : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

  // A durable service's run queue (`queue=`): what waits, runs, failed.
  function queueSection(list) {
    const sec = el("section", "rqsec");
    sec.append(el("h3", null, "Run queues"),
      el("p", "panesub", "Services declared with queue= keep each event in a queue before answering; "
        + "any replica runs it. A run whose worker died is run again under the same id."));
    for (const q of list) {
      const card = el("div", "svccard rqcard");
      const top = el("div", "svctop");
      top.append(el("b", "mono svckey", q.service), el("span", "mono rqwhere", q.where || ""));
      card.append(top);
      if (q.error) { card.append(el("div", "rqerr", q.error)); sec.append(card); continue; }
      const c = q.counts || {};
      const stats = el("div", "rqstats");
      const stat = (label, n, cls) => { const x = el("div", "rqstat " + (cls || "")); x.append(el("b", null, String(n || 0)), el("span", null, label)); return x; };
      stats.append(stat("queued", c.queued), stat("running", c.running, c.running ? "run" : ""),
        stat("done", c.done, "ok"), stat("failed", c.failed, c.failed ? "bad" : ""),
        stat("stopped", (c.stopped || 0) + (c.discarded || 0)));
      if (c.oldest_queued_s != null) stats.append(el("span", "note", `oldest waiting ${ago(c.oldest_queued_s)}`));
      card.append(stats);
      const table = (title, rows, withRetry) => {
        if (!rows || !rows.length) return;
        card.append(el("div", "rqhead", title));
        const t = el("table", "rqtable");
        const hr = el("tr");
        for (const h of ["run", "thread", "attempt", withRetry ? "error" : "worker", "age", ""]) hr.append(el("th", null, h));
        t.append(hr);
        for (const r of rows) {
          const tr = el("tr");
          const id = el("td", "mono"); id.title = r.payload; id.textContent = r.id.slice(0, 12);
          tr.append(id, el("td", "mono", r.thread_id || "—"), el("td", null, `${r.attempts}/${r.max_attempts}`),
            el("td", withRetry ? "rqerrcell" : "mono", withRetry ? (r.error || r.status) : (r.worker || "—")),
            el("td", null, ago(r.age_s)));
          const act = el("td");
          if (withRetry) {
            const b = el("button", "linkbtn needs-edit", "Retry");
            b.type = "button";
            b.onclick = async () => {
              b.disabled = true;
              try { await api(`/api/p/${PID}/services/queues/requeue`, {service: q.service, id: r.id}); toast(`run ${r.id.slice(0, 12)} is queued again`); }
              catch (err) { toast(err.message, true); }
              redraw();
            };
            act.append(b);
          }
          tr.append(act);
          t.append(tr);
        }
        const wrap = el("div", "rqscroll"); wrap.append(t); card.append(wrap);
      };
      table("Running", q.running, false);
      table("Waiting", q.queued, false);
      table("Failed or stopped", q.ended_badly, true);
      sec.append(card);
    }
    return sec;
  }

  registerPane("services", {el: page, show: () => show()});
  return {show: () => show(), showIn};
})();

/* Open app ↗ in the top bar (LEAN_PRODUCT_PLAN P3): the project's running `operonx serve` at /, in a new
 * tab — never an iframe. It is always there; greyed with why when there is nothing to open. */
(function appButton() {
  const a = document.getElementById("btn-app");
  if (!a || typeof PID === "undefined") return;
  const local = (h) => !h || ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(h);
  async function refresh() {
    let app = null;
    try { app = (await api(`/api/p/${PID}/services`)).app; } catch { /* said below */ }
    const why = !app ? "The studio could not ask for the project's services"
      : !app.web ? "No web/ in this project"
      : !app.port ? "No service of this project listens on a port"
      : !app.running ? `Not running: start ${app.key} from the Picture's listeners line` : "";
    if (why) { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); a.title = why; return; }
    a.href = `http://${local(app.host) ? location.hostname : app.host}:${app.port}/`;
    a.removeAttribute("aria-disabled"); a.title = `The project's app, ${app.key}, in a new tab`;
  }
  a.addEventListener("click", (ev) => { if (a.getAttribute("aria-disabled") === "true") ev.preventDefault(); });
  a.addEventListener("mouseenter", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
})();
