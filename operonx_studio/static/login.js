// The sign-in page: the form, then — for a temporary or default password —
// the "choose your password" step (docs/TEAM_PLAN.md §2.1). The server
// says which step a reload lands on (#login-boot), so the form never
// flashes for someone already signed in.

const $ = (id) => document.getElementById(id);
let current = "";          // what was just typed, for the password step

function passwordStep(username) {
  $("step-signin").hidden = true;
  $("step-password").hidden = false;
  $("pw-who").textContent = username;
  $("pw-user").value = username;
  $("pw-new").focus();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return {res, data};
}

// where to go once signed in: the page that sent us here (a launch from
// `operonx studio` lands on its project), never another site
const NEXT = (() => {
  const n = new URLSearchParams(location.search).get("next") || "/";
  return n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/\\") ? n : "/";
})();

$("login-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const err = $("login-err");
  const btn = $("login-btn");
  err.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const username = $("login-user").value.trim();
    current = $("login-pass").value;
    const {res, data} = await post("/api/login", {username, password: current});
    if (res.ok && data.must_change) { passwordStep((data.user || {}).username || username); return; }
    if (res.ok) { location.href = NEXT; return; }
    err.textContent = data.error || "Sign-in failed.";
  } catch {
    err.textContent = "The studio did not answer — is it still running?";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
};

$("pw-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const err = $("pw-err");
  const btn = $("pw-btn");
  const next = $("pw-new").value;
  err.textContent = "";
  if (next.length < 8) { err.textContent = "A password needs at least 8 characters."; return; }
  if (next !== $("pw-again").value) { err.textContent = "The two passwords differ."; return; }
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const {res, data} = await post("/api/me/password", {current, new: next});
    if (res.ok) { location.href = NEXT; return; }
    if (res.status === 401) { location.reload(); return; }
    err.textContent = data.error || "That did not work.";
  } catch {
    err.textContent = "The studio did not answer — is it still running?";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save and continue";
  }
};

try {
  const boot = JSON.parse(($("login-boot") || {}).textContent || "{}");
  if (boot.step === "password") passwordStep(boot.username || "");
} catch { /* no boot data: the form */ }

// Sign in with Google: Google's device sign-in. The page shows Google's link
// and a code; the person signs in on Google and types the code there; this
// page asks the studio until Google says done. Shown only when the studio
// has the keys.
(async () => {
  let on = false;
  try { on = (await (await fetch("/api/login/google")).json()).enabled; } catch { on = false; }
  if (!on) return;
  $("google-wrap").hidden = false;
  let timer = null;
  const fail = (msg) => {
    clearTimeout(timer);
    $("google-step").hidden = true;
    $("google-err").textContent = msg;
    $("google-btn").disabled = false;
    $("google-btn").querySelector("span").textContent = "Sign in with Google";
  };
  $("google-btn").onclick = async () => {
    // a tab opened inside the click: one opened after the request is a popup
    const tab = window.open("", "_blank");
    $("google-err").textContent = "";
    $("google-btn").disabled = true;
    $("google-btn").querySelector("span").textContent = "Asking Google…";
    const {res, data} = await post("/api/login/google/start", {});
    if (!res.ok) { if (tab) tab.close(); fail(data.error || "Google sign-in did not start"); return; }
    $("google-url").href = data.url;
    $("google-url").textContent = data.url.replace(/^https?:\/\/(www\.)?/, "");
    $("google-code").textContent = data.code;
    $("google-step").hidden = false;
    $("google-btn").querySelector("span").textContent = "Signing in with Google…";
    if (tab && !tab.closed) { try { tab.location.href = data.url; } catch { /* opened elsewhere */ } }
    let wait = (data.interval || 5) * 1000;
    const poll = async () => {
      const got = await post("/api/login/google/poll", {id: data.id});
      if (got.res.ok && got.data.ok) { location.href = NEXT; return; }
      if (!got.res.ok) { fail(got.data.error || "Google sign-in failed"); return; }
      if (got.data.interval) wait = got.data.interval * 1000;
      timer = setTimeout(poll, wait);
    };
    timer = setTimeout(poll, wait);
  };
  $("google-code").onclick = async () => {
    try { await navigator.clipboard.writeText($("google-code").textContent); $("google-wait").textContent = "Code copied. Waiting for Google…"; }
    catch { /* select it by hand */ }
  };
})();

