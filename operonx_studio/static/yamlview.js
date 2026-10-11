/* operonx studio — a project YAML file, edited value by value
 * (docs/STUDIO_EXPERIENCE_PLAN.md §4, §6).
 *
 * An agent's prompts, a resource's settings: files the project already has.
 * The outline lists the file's entries (its keys two levels down, searchable);
 * the form shows one entry by what it holds — text, a number, a switch, a list
 * of items to add to or remove from, a nested mapping folded. Each change is
 * one edit (operonx_studio/yamldoc.py: set, append, remove, add, delete) seen
 * as a diff before it is written through safewrite; every other line of the
 * file — comments, quoting, order — stays as it is.
 */

const YamlView = (() => {
  const box = $("#yaml");
  let cur = null;   // {file, base, tree, sel: [path], q}

  const show_ = (p) => p.map(String).join(" › ");

  function post(op, path, extra, apply) {
    return api(`/api/p/${PID}/yaml`, {file: cur.file, op, path, ...extra, apply: !!apply, base: cur.base});
  }

  /* One edit: its diff, then Apply; the file reloads after. */
  async function change(slot, op, path, extra, okText) {
    slot.textContent = "";
    let got;
    try { got = await post(op, path, extra, false); }
    catch (e) { slot.append(el("div", "cf-msg bad", e.message)); return; }
    if (!got.changed) { slot.append(el("div", "cf-msg", "No change")); return; }
    const diff = el("div", "diffbox");
    for (const ln of got.diff.split("\n")) diff.append(el("div", ln.startsWith("+") && !ln.startsWith("+++") ? "add" : ln.startsWith("-") && !ln.startsWith("---") ? "del" : null, ln));
    const apply = el("button", "primary small needs-edit", "Apply");
    apply.type = "button";
    apply.onclick = async () => {
      // the write waits for the project to build again (safewrite): say so
      apply.disabled = true;
      apply.textContent = "Writing…";
      try {
        const done = await post(op, path, extra, true);
        wrote(done, okText);
        await reload();
      } catch (e) {
        apply.disabled = false;
        const fresh = refusal(e, slot);
        if (fresh) { cur.base = fresh; slot.append(apply); apply.textContent = "Apply to the file as it is now"; }
      }
    };
    const cancel = el("button", "small ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => { slot.textContent = ""; };
    const bar = el("div", "cf-bar");
    bar.append(apply, cancel);
    slot.append(diff, bar);
  }

  function nodeAt(path) {
    let n = cur.tree;
    for (const step of path) {
      if (!n) return null;
      if (n.kind === "map") { const hit = n.items.find(([k]) => String(k) === String(step)); n = hit ? hit[1] : null; }
      else if (n.kind === "list") n = n.items[Number(step)];
      else return null;
    }
    return n;
  }

  // ── a value, as what it is ──

  function scalarField(path, node) {
    const v = node.value;
    const row = el("div", "yv-scalar");
    let input;
    if (typeof v === "boolean") {
      input = el("input"); input.type = "checkbox"; input.checked = v; input.className = "cf-switch";
    } else if (typeof v === "number") {
      input = el("input"); input.type = "number"; input.step = "any"; input.value = String(v);
    } else {
      const s = v == null ? "" : String(v);
      const long = s.length > 70 || s.includes("\n");
      input = el(long ? "textarea" : "input", "cf-text");
      if (!long) input.type = "text";
      input.value = s;
      if (long) input.rows = Math.min(16, Math.max(3, s.split("\n").length + 1));
    }
    const slot = el("div", "cf-out");
    const bar = el("div", "cf-bar");
    const review = el("button", "small needs-edit", "Review");
    review.type = "button";
    bar.hidden = true;
    bar.append(review);
    const read = () => (input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value);
    input.addEventListener("input", () => { bar.hidden = false; });
    input.addEventListener("change", () => { bar.hidden = false; });
    review.onclick = () => change(slot, "set", path, {value: read()}, `${show_(path)} saved`);
    row.append(input, bar, slot);
    return row;
  }

  function listField(path, node) {
    const wrap = el("div", "yv-list");
    const scalars = node.items.every(i => i.kind === "scalar");
    if (!scalars) {
      node.items.forEach((child, i) => wrap.append(entry(path.concat(i), `${i + 1}`, child, 1)));
      return wrap;
    }
    const items = el("div", "yv-items");
    const slot = el("div", "cf-out");
    node.items.forEach((child, i) => {
      const it = el("div", "yv-item");
      it.append(el("span", "yv-item-v", String(child.value)));
      if (!node.flow) {
        const rm = el("button", "yv-rm needs-edit", "✕");
        rm.type = "button";
        rm.title = "Remove this item";
        rm.onclick = () => change(slot, "remove", path.concat(i), {}, `Removed from ${show_(path)}`);
        it.append(rm);
      }
      items.append(it);
    });
    const add = el("div", "yv-add");
    const inp = el("input", "cf-text");
    inp.type = "text";
    inp.placeholder = "Add an item";
    const go = el("button", "small needs-edit", "Add");
    go.type = "button";
    const doAdd = () => { if (inp.value.trim()) change(slot, "append", path, {value: inp.value.trim()}, `Added to ${show_(path)}`); };
    go.onclick = doAdd;
    inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") doAdd(); });
    add.append(inp, go);
    wrap.append(items, add, slot);
    return wrap;
  }

  /* An entry of a mapping (or a list): its key, then its value. */
  function entry(path, key, node, depth) {
    const row = el("div", "yv-entry");
    if (node.kind === "scalar") {
      row.append(el("div", "yv-key mono", key), scalarField(path, node));
    } else {
      const fold = el("details", "yv-fold");
      if (depth < 2) fold.open = true;
      const sum = el("summary");
      sum.append(el("span", "yv-key mono", key),
        el("span", "yv-count", node.kind === "list" ? `${node.items.length} items` : `${node.items.length} keys`));
      fold.append(sum);
      fold.append(node.kind === "list" ? listField(path, node) : mapField(path, node, depth + 1));
      row.append(fold);
    }
    return row;
  }

  function mapField(path, node, depth) {
    const wrap = el("div", "yv-map");
    for (const [k, child] of node.items) wrap.append(entry(path.concat(k), String(k), child, depth));
    if (!node.flow && node.items.length) wrap.append(addEntry(path, node));
    return wrap;
  }

  /* A new key: a value, or — when every entry is a mapping of the same
   * shape (intents: description + examples) — an entry shaped like them. */
  function addEntry(path, node) {
    const shapes = node.items.map(([, c]) => (c.kind === "map" ? c.items.map(([k, v]) => `${k}:${v.kind}`).join(",") : null));
    const alike = shapes.every(s => s && s === shapes[0]);
    const slot = el("div", "cf-out");
    const box2 = el("div", "yv-add");
    const key = el("input", "cf-text mono");
    key.type = "text";
    key.placeholder = alike ? "a new entry's key" : "new key";
    const val = el("input", "cf-text");
    val.type = "text";
    val.placeholder = "value";
    if (alike) val.hidden = true;
    const go = el("button", "small needs-edit", alike ? "Add an entry" : "Add");
    go.type = "button";
    go.onclick = () => {
      const k = key.value.trim();
      if (!k) return;
      let value = val.value;
      if (alike) {
        const proto = node.items[0][1];
        value = Object.fromEntries(proto.items.map(([pk, pv]) => [pk, pv.kind === "list" ? [] : pv.kind === "map" ? {} : ""]));
      }
      change(slot, "add", path, {key: k, value}, `Added ${k}`);
    };
    box2.append(key, val, go);
    const wrap = el("div", "yv-adder");
    wrap.append(box2, slot);
    return wrap;
  }

  // ── the screen ──

  function outline() {
    const nav = el("nav", "yv-outline");
    nav.setAttribute("aria-label", "Entries");
    const q = el("input", "rt-search");
    q.type = "search";
    q.placeholder = "Find an entry";
    q.value = cur.q || "";
    const list = el("div", "yv-nav");
    const paint = () => {
      list.textContent = "";
      const needle = q.value.trim().toLowerCase();
      const top = cur.tree.kind === "map" ? cur.tree.items : [];
      for (const [k, child] of top) {
        const kids = child.kind === "map" ? child.items : [];
        const keyHit = String(k).toLowerCase().includes(needle);
        const kidHits = kids.filter(([kk]) => !needle || keyHit || String(kk).toLowerCase().includes(needle));
        if (needle && !keyHit && !kidHits.length) continue;
        const b = el("button", "yv-nav-top" + (String(cur.sel[0]) === String(k) && cur.sel.length === 1 ? " on" : ""), String(k));
        b.type = "button";
        b.onclick = () => { cur.sel = [k]; render(); };
        list.append(b);
        if (kids.length && kids.length <= 400) {
          for (const [kk] of kidHits) {
            const c = el("button", "yv-nav-kid" + (String(cur.sel[0]) === String(k) && String(cur.sel[1]) === String(kk) ? " on" : ""), String(kk));
            c.type = "button";
            c.onclick = () => { cur.sel = [k, kk]; render(); };
            list.append(c);
          }
        }
      }
    };
    q.oninput = () => { cur.q = q.value; paint(); };
    paint();
    nav.append(q, list);
    return nav;
  }

  function render() {
    box.textContent = "";
    const page = el("div", "yv");
    const head = el("div", "yv-head");
    const back = Icons.button("back", "Resources", "small ghost", "Back to the resources");
    back.onclick = () => switchTab("resources");
    head.append(back, el("h2", "mono", cur.file));
    head.append(el("div", "note", "Each change is shown as a diff before it is written; the rest of the file stays as it is."));
    page.append(head);
    const body = el("div", "yv-body");
    body.append(outline());
    const form = el("section", "yv-form");
    const node = nodeAt(cur.sel);
    if (!node) form.append(el("div", "note", "Pick an entry on the left."));
    else {
      form.append(el("div", "yv-path mono", show_(cur.sel)));
      form.append(node.kind === "scalar" ? scalarField(cur.sel, node)
        : node.kind === "list" ? listField(cur.sel, node) : mapField(cur.sel, node, 1));
    }
    body.append(form);
    page.append(body);
    box.append(page);
    pushView();
  }

  async function reload() {
    const got = await api(`/api/p/${PID}/yaml?file=${encodeURIComponent(cur.file)}`);
    cur.base = got.base;
    cur.tree = got.tree;
    render();
  }

  async function show(opts) {
    const file = (opts && opts.file) || state.yamlFile;
    if (!file) { box.textContent = ""; box.append(el("div", "note", "No file picked.")); return; }
    state.yamlFile = file;
    box.textContent = "";
    box.append(el("div", "note", `Reading ${file}…`));
    try {
      const got = await api(`/api/p/${PID}/yaml?file=${encodeURIComponent(file)}`);
      const top = got.tree.kind === "map" && got.tree.items.length ? [got.tree.items[0][0]] : [];
      cur = {file, base: got.base, tree: got.tree, sel: cur && cur.file === file ? cur.sel : top, q: ""};
      render();
    } catch (e) {
      box.textContent = "";
      box.append(el("div", "note", e.message));
    }
  }

  /* Open a file in the editor (a resource's prompts, a settings file). */
  function open(file) {
    state.yamlFile = file;
    switchTab("yaml", {file});
  }

  registerPane("yaml", {el: box, show});
  return {show, open};
})();
