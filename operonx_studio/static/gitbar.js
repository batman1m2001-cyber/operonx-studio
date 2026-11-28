/* operonx studio — the bar's Pull and Push (PROJECT_SOURCE_PLAN S3).
 *
 * All the git the studio does. Pull brings the project's folder up to date
 * with its remote. Push sends what was edited here to one branch,
 * studio/<project>, never the default one; the team merges it with its own
 * tools. Both are always in the bar; a project with no remote has them
 * greyed, with the reason.
 */

"use strict";

(() => {
  const pull = $("#btn-pull"), push = $("#btn-push"), count = $("#push-count");
  if (!pull || !push) return;
  let busy = false;

  function paint(st) {
    const none = !st || !st.remote;
    const why = none ? "This project has no git remote" : st.error || "";
    pull.disabled = none || !!st.error;
    pull.title = why || `Bring this folder up to date with ${st.remote} · ${st.branch}`;
    const n = none ? 0 : st.edits;
    const waiting = n > 0 && !st.pushed;
    push.disabled = !waiting;
    push.classList.toggle("tinted", waiting);
    count.textContent = waiting ? String(n) : "";
    count.hidden = !waiting;
    push.title = why || (st.pushed ? `These edits are on ${st.push_branch}` : n
      ? `Send ${n} edited file${n === 1 ? "" : "s"} to ${st.push_branch}:\n${st.files.join("\n")}`
      : "Nothing was edited here");
  }

  async function refresh() {
    if (busy || document.hidden) return;
    try { paint(await api(`/api/p/${PID}/git`)); } catch { /* the next tick asks again */ }
  }

  async function run(button, path, said) {
    if (busy) return;
    busy = true; button.classList.add("working");
    try {
      const got = await api(`/api/p/${PID}/${path}`, {});
      paint(got.status);
      const [text, link] = said(got);
      toast(text, false, link ? {label: "Open merge request", run: () => window.open(link, "_blank", "noopener")} : undefined);
    } catch (e) { toast(e.message, true); }
    finally { busy = false; button.classList.remove("working"); }
  }

  pull.onclick = () => run(pull, "git/pull", (got) => [got.updated
    ? `Pulled ${got.commits} commit${got.commits === 1 ? "" : "s"}` : "Already up to date"]);
  push.onclick = () => run(push, "git/push", (got) => [`Pushed ${got.files} file${got.files === 1 ? "" : "s"} to ${got.branch}`, got.link]);

  refresh();
  setInterval(refresh, 20000);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);
})();
