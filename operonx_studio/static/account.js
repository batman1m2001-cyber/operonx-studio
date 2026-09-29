/* operonx studio — who is signed in: the account menu in every page's
 * header (name, role, change password, Team, sign out), and the small
 * sheet and toast the Team page builds on (docs/TEAM_PLAN.md P2).
 *
 * The page carries who is signed in (#me-boot, app.py _page), so the
 * menu draws with the page. One closure: this file joins every page's
 * bundle, whose other scripts own the short global names. */

"use strict";

const Account = (() => {
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const ROLE = {admin: "Admin", editor: "Editor", viewer: "Viewer"};

  let me = null;
  try {
    const node = document.getElementById("me-boot");
    if (node) me = JSON.parse(node.textContent);
  } catch { me = null; }

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(path, {method, headers: {"content-type": "application/json"},
                               body: body === undefined ? undefined : JSON.stringify(body)});
    } catch { throw new Error("The studio did not answer — check the connection"); }
    if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /* one shared voice for feedback (studio.css #toast) */
  let timer = null;
  function toast(text, bad) {
    let t = document.getElementById("toast");
    if (!t) { t = mk("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.append(t); }
    t.textContent = text;
    t.classList.toggle("bad", !!bad);
    t.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove("show"), bad ? 4000 : 2400);
  }

  /* a sheet over the page: a dialog on a desktop, the bottom of a phone */
  function sheet(title, build) {
    const back = mk("div", "modal-back");
    const box = mk("div", "modal sheet");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", title);
    const head = mk("div", "modalhead");
    head.append(mk("h2", null, title));
    const x = mk("button", "iconbtn");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.title = "Close";
    if (window.Icons) x.append(Icons.svg("x"));
    head.append(x);
    box.append(head);
    back.append(box);
    const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    x.onclick = close;
    back.onclick = (ev) => { if (ev.target === back) close(); };
    build(box, close);
    document.body.append(back);
    const first = box.querySelector("input:not([hidden]):not([readonly]), select, button.primary");
    if (first) first.focus();
    return close;
  }

  function field(label, input, hint) {
    const f = mk("div", "field");
    const l = mk("label", null, label);
    if (!input.id) input.id = "f-" + Math.random().toString(36).slice(2, 8);
    l.htmlFor = input.id;
    f.append(l, input);
    if (hint) f.append(mk("p", "fieldhint", hint));
    return f;
  }

  function input(type, autocomplete) {
    const i = mk("input");
    i.type = type;
    if (autocomplete) i.autocomplete = autocomplete;
    return i;
  }

  function changePassword() {
    sheet("Change password", (box, close) => {
      const form = mk("form");
      form.noValidate = true;
      const user = input("text", "username");
      user.hidden = true; user.readOnly = true; user.value = me.user.username;
      const cur = input("password", "current-password");
      const neu = input("password", "new-password");
      const again = input("password", "new-password");
      const err = mk("div", "err");
      err.setAttribute("role", "alert");
      const foot = mk("div", "foot");
      const cancel = mk("button", "ghost", "Cancel");
      cancel.type = "button";
      cancel.onclick = close;
      const save = mk("button", "primary", "Change password");
      save.type = "submit";
      foot.append(cancel, save);
      form.append(user, field("Current password", cur),
                  field("New password", neu, "At least 8 characters, and not your username."),
                  field("New password, again", again), err, foot);
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        err.textContent = "";
        if (neu.value !== again.value) { err.textContent = "The two passwords differ."; return; }
        save.disabled = true;
        try {
          const got = await call("POST", "/api/me/password", {current: cur.value, new: neu.value});
          close();
          const n = got.ended_sessions || 0;
          toast(n ? `Password changed — signed out of ${n} other session${n > 1 ? "s" : ""}` : "Password changed");
        } catch (e) { err.textContent = e.message; }
        save.disabled = false;
      };
      box.append(form);
    });
  }

  async function signOut() {
    try { await call("POST", "/api/logout"); } catch { /* signed out either way */ }
    location.href = "/login";
  }

  function initial(u) {
    return ((u.name || u.username || "?").trim()[0] || "?").toUpperCase();
  }

  function avatar(u, cls) {
    const a = mk("span", "avatar" + (cls ? " " + cls : ""), initial(u));
    a.setAttribute("aria-hidden", "true");
    return a;
  }

  function menu() {
    const wrap = mk("span", "acct-wrap");
    const u = me.user;
    const b = mk("button", "acctbtn");
    b.type = "button";
    b.id = "btn-account";
    b.setAttribute("aria-haspopup", "menu");
    b.setAttribute("aria-expanded", "false");
    b.title = `${u.name || u.username} · ${ROLE[u.role] || u.role}`;
    b.setAttribute("aria-label", `Account: ${u.name || u.username}`);
    b.append(avatar(u), mk("span", "acctname", u.name || u.username));
    const pop = mk("div", "popover acctmenu");
    pop.setAttribute("role", "menu");
    pop.hidden = true;
    const head = mk("div", "accthead");
    const who = mk("div", "acctwho");
    who.append(mk("div", "acctfull", u.name || u.username),
               mk("div", "acctsub", `${u.username} · ${ROLE[u.role] || u.role}`));
    head.append(avatar(u, "big"), who);
    pop.append(head);
    const item = (icon, label, fn, cls) => {
      const it = mk("button", "menuitem" + (cls ? " " + cls : ""));
      it.type = "button";
      it.setAttribute("role", "menuitem");
      if (window.Icons) it.append(Icons.svg(icon));
      it.append(mk("span", null, label));
      it.onclick = () => { pop.hidden = true; b.setAttribute("aria-expanded", "false"); fn(); };
      pop.append(it);
      return it;
    };
    if (!me.auth) pop.append(mk("p", "acctnote", "Sign-in is off on this studio: everyone is its admin."));
    if (me.auth) item("settings", "Change password", changePassword);
    if (u.role === "admin" && location.pathname !== "/team") item("sessions", "Team", () => { location.href = "/team"; });
    if (me.auth) item("logout", "Sign out", signOut, "acctout");
    b.onclick = (ev) => {
      ev.stopPropagation();
      pop.hidden = !pop.hidden;
      b.setAttribute("aria-expanded", String(!pop.hidden));
    };
    document.addEventListener("pointerdown", (ev) => { if (!wrap.contains(ev.target)) { pop.hidden = true; b.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { pop.hidden = true; b.setAttribute("aria-expanded", "false"); } });
    wrap.append(b, pop);
    return wrap;
  }

  const slot = document.getElementById("accountslot");
  if (slot && me && me.user) slot.replaceWith(menu());

  return {me: () => me, call, toast, sheet, field, input, avatar, ROLE, el: mk};
})();
