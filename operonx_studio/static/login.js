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
    if (res.ok) { location.href = "/"; return; }
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
    if (res.ok) { location.href = "/"; return; }
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
