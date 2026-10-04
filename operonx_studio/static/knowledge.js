/* operonx studio — Knowledge: a project's knowledge bases, read and asked.
 *
 * A knowledge base built with operonx-kb serves an admin app (operonx-kb/1)
 * as one of the project's asgi services; the studio finds it by asking
 * (knowledge.py) and reads it through its own proxy. The tab appears once a
 * service has answered. Three pages, each one or two requests:
 *
 *   - a collection's documents: counts, the spec in a line, a filterable table;
 *   - a document: its pages with the boxes the parser drew — elements coloured
 *     by kind, chunks as outlines — or, for a source without pages, its
 *     canonical text in chunk bands; beside it the chunk inspector (the text
 *     and what was embedded, where it is indexed, its neighbours);
 *   - Ask: one query listed per retrieval mode side by side, and an answer
 *     whose [n] markers open the cited page with the cited boxes lit. Every
 *     run opens in Runs; a good answer becomes an eval case.
 *
 * What a citation quotes, and where, is the knowledge base's: kbview.js (KX)
 * only shapes it for drawing.
 */

"use strict";

const KnowledgeView = (() => {
  const box = $("#knowledge");
  const tabBtn = document.querySelector('.tabs button[data-tab="knowledge"]');
  const K = `knowledge:${PID}`;
  const v = Object.assign({service: "", collection: "", view: "docs", q: "", status: "", dpage: 1,
                           doc: "", version: "", page: 1, chunk: "", layer: "both", from: ""}, recall(K, {}));
  let services = [];
  let token = 0;
  let lastAsk = null;      // the playground's last result: kept while a citation is open
  let form = null;         // the playground's fields, kept across pages
  let lit = null;          // the citation the viewer lights {version, page, span, regions, marker}
  let seeker = null;

  const save = () => store(K, v);
  const go = (patch) => { Object.assign(v, patch); save(); show(); };
  const kb = (path) => `/api/p/${PID}/kb/${encodeURIComponent(v.service)}/${path}`;
  const enc = encodeURIComponent;
  const openRun = (run) => performUi("open_run", {run, quiet: true});

  function traceBtn(run, label) {
    const b = Icons.button("list", label || "Open trace", "linkbtn kbtrace", "Open this run in Runs");
    b.onclick = () => openRun(run);
    return b;
  }

  function chipOf(text, cls) { return el("span", `chip ${cls || ""}`, text); }

  /* ── which knowledge bases there are ──────────────────────────────── */

  // asked on load, and again every 30 s until one answers: the tab appears
  // when a knowledge-base service has said what it is
  async function discover() {
    try { services = (await api(`/api/p/${PID}/knowledge`)).services || []; }
    catch { services = []; }
    if (tabBtn) tabBtn.hidden = !services.length;
    clearTimeout(seeker);
    if (!services.length) seeker = setTimeout(discover, 30000);
    return services;
  }

  /* ── the pane ─────────────────────────────────────────────────────── */

  // aria-busy while a page is being drawn: assistive tech, and anyone
  // waiting on the screen, knows when what shows is the whole of it
  async function show(opts) {
    const mine = ++token;
    box.setAttribute("aria-busy", "true");
    try { await render(mine, opts); }
    finally { if (mine === token) box.setAttribute("aria-busy", "false"); }
  }

  async function render(mine, opts) {
    if (opts && opts.view) Object.assign(v, opts);
    await discover();
    if (mine !== token) return;
    box.textContent = "";
    const head = el("div", "panehead kbhead");
    head.append(el("h2", null, "Knowledge"));
    box.append(head);
    if (!services.length) {
      box.append(paneNote("No knowledge base here",
        "A knowledge base built with operonx-kb serves an admin app; once it is running, its collections, documents and a place to ask them show here.",
        'import operonx\nfrom operonx.app import Service, asgi\nfrom operonx_kb.admin import kb_admin_app\n\noperonx.bootstrap()   # the project\'s resources.yaml\nService("kb_admin", asgi("/kb", port=8021),\n        app=kb_admin_app(llm="gpt-4o-mini"))'));
      return;
    }
    if (!services.find(s => s.name === v.service)) v.service = (services.find(s => s.kb && s.running) || services[0]).name;
    const svc = services.find(s => s.name === v.service);
    if (services.length > 1) {
      const pick = el("select", "xpselect");
      pick.setAttribute("aria-label", "Knowledge base");
      for (const s of services) { const o = el("option", null, `${s.name}${s.running ? "" : " (stopped)"}`); o.value = s.name; o.selected = s.name === v.service; pick.append(o); }
      pick.onchange = () => go({service: pick.value, collection: "", view: "docs"});
      head.append(pick);
    }
    const refresh = Icons.button("refresh", undefined, "", "Refresh");
    refresh.onclick = () => show();
    head.append(el("div", "spacer"), refresh);

    if (!svc.running) {
      box.append(paneNote(`${svc.name} is not running`, "Start the service that serves this knowledge base to read it here.", null,
        {actions: [{label: "Open Services", icon: "server", run: () => switchTab("services")}]}));
      return;
    }
    if (!svc.kb) {
      box.append(el("div", "errbox", `${svc.name}: ${svc.error || "it does not answer as a knowledge base"}`));
      return;
    }
    let cols;
    try { cols = (await api(kb("collections"))).collections; }
    catch (err) { box.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    if (!cols.length) {
      box.append(paneNote("No collections yet", `${svc.name} answers, but holds no collection. Create one and add documents (operonx-kb create, operonx-kb add).`));
      return;
    }
    if (!cols.find(c => c.id === v.collection)) v.collection = cols[0].id;
    const col = cols.find(c => c.id === v.collection);
    save();

    const sub = v.view === "doc";
    const grid = el("div", "evgrid kbgrid" + (sub ? " sub" : ""));
    const side = el("div", "evside");
    const main = el("div", "evmain kbmain");
    grid.append(side, main);
    box.append(grid);
    sideList(side, cols, svc);
    if (v.view === "doc" && v.doc) return showDoc(main, col, mine);
    const modes = el("span", "tlmodes kbviews");
    for (const [key, label] of [["docs", "Documents"], ["ask", "Ask"]]) {
      const b = el("button", v.view === key ? "on" : "", label);
      b.type = "button";
      b.onclick = () => go({view: key});
      modes.append(b);
    }
    const top = el("div", "xptop");
    const title = el("div", "xptitle");
    title.append(el("h3", null, col.id), el("div", "evsub", specLine(col)));
    top.append(title, modes);
    main.append(top);
    if (v.view === "ask") return showAsk(main, col, svc);
    return showDocs(main, col, mine);
  }

  function specLine(col) {
    const s = col.spec || {};
    const parts = [`${s.chunker.kind} chunks ≤ ${s.chunker.max_tokens} tokens`];
    if (s.dense) parts.push(`dense ${s.dense.embedder} → ${s.dense.store}`);
    if (s.lexical) parts.push(`lexical ${s.lexical.analyzer.kind}${s.lexical.analyzer.fold_diacritics ? "+fold" : ""}`);
    if (s.language) parts.push(s.language);
    return parts.join(" · ");
  }

  function sideList(side, cols, svc) {
    side.append(el("div", "stitle", "Collections"));
    for (const c of cols) {
      const card = el("button", "evcard" + (c.id === v.collection ? " sel" : ""));
      card.type = "button";
      const top = el("div", "evcard-top");
      top.append(el("span", "evname", c.id));
      card.append(top);
      card.append(el("div", "evsub", `${c.documents} document${c.documents === 1 ? "" : "s"} · ${c.chunks} chunks`));
      const chips = el("div", "kbchips");
      for (const m of c.modes) chips.append(chipOf(m, m === c.default_mode ? "kbdefault" : ""));
      card.append(chips);
      card.onclick = () => go({collection: c.id, view: v.view === "doc" ? "docs" : v.view, dpage: 1});
      side.append(card);
    }
    side.append(el("div", "evsub kbsvc", `${svc.name} · ${svc.path} · ${svc.answer ? "answers" : "search only"}${svc.rerank ? " · rerank" : ""}`));
  }

  /* ── a collection's documents ─────────────────────────────────────── */

  async function showDocs(main, col, mine) {
    const facts = el("div", "evfacts");
    for (const [n, label] of [[col.active, "active"], [col.documents - col.active, "pending"], [col.deleted, "deleted"], [col.chunks, "chunks"]]) {
      const f = el("span");
      f.append(el("b", null, String(n)), ` ${label}`);
      facts.append(f);
    }
    const check = el("button", "small ghost", "Check health");
    check.type = "button";
    const health = el("div", "kbhealth");
    check.onclick = async () => {
      check.disabled = true;
      health.textContent = "Checking every span, chunk and index entry…";
      try {
        const h = await api(kb(`collections/${enc(col.id)}/health`));
        health.className = "kbhealth " + (h.ok ? "ok" : "bad");
        health.textContent = h.ok
          ? `Healthy: ${h.documents} documents, ${h.elements} elements, ${h.chunks} chunks, ${h.index_entries} dense and ${h.lexical_entries} lexical index entries agree with the catalog.`
          : `${h.problems.length} problem${h.problems.length === 1 ? "" : "s"}: ${h.problems.slice(0, 5).join(" · ")}`;
      } catch (err) { health.className = "kbhealth bad"; health.textContent = err.message; }
      check.disabled = false;
    };
    facts.append(check);
    main.append(facts, health);

    const bar = el("div", "kbbar");
    const q = el("input", "kbsearch");
    q.type = "search";
    q.placeholder = "Find a document by key or title…";
    q.value = v.q;
    q.setAttribute("aria-label", "Find a document");
    let typing = null;
    q.oninput = () => { clearTimeout(typing); typing = setTimeout(() => go({q: q.value, dpage: 1}), 300); };
    const st = el("span", "tlmodes");
    for (const [key, label] of [["", "Active"], ["pending", "Pending"], ["deleted", "Deleted"]]) {
      const b = el("button", v.status === key ? "on" : "", label);
      b.type = "button";
      b.onclick = () => go({status: key, dpage: 1});
      st.append(b);
    }
    bar.append(q, st);
    main.append(bar);
    if (v.q) setTimeout(() => { q.focus(); q.setSelectionRange(q.value.length, q.value.length); });

    let got;
    const qs = new URLSearchParams({page: String(v.dpage), size: "50"});
    if (v.q) qs.set("q", v.q);
    if (v.status) qs.set("status", v.status);
    try { got = await api(kb(`collections/${enc(col.id)}/documents?${qs}`)); }
    catch (err) { main.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    if (!got.documents.length) {
      main.append(el("div", "note", v.q ? `No document matches “${v.q}”.` : "No documents here."));
      return;
    }
    const table = el("div", "xptable kbdocs");
    const hdr = el("div", "xprow xprow-h");
    ["Document", "Type", "Pages", "Chunks", "Added", "Status"].forEach(t => hdr.append(el("span", null, t)));
    table.append(hdr);
    for (const d of got.documents) {
      const row = el("div", "xprow click");
      row.tabIndex = 0;
      const name = el("span", "xpname");
      name.append(el("b", null, d.title || d.key));
      if (d.title) name.append(el("span", "evsub mono", d.key));
      row.append(name, el("span", "evsub", mimeLabel(d.mime)),
                 el("span", "kbnum", d.stats.pages ? String(d.stats.pages) : "—"),
                 el("span", "kbnum", d.stats.chunks != null ? String(d.stats.chunks) : "—"),
                 el("span", "evsub", fmtAgo(d.created_at)));
      const s = el("span", null);
      s.append(chipOf(d.status, d.status === "active" ? "cok" : d.status === "deleted" ? "cbad" : "cwarn"));
      row.append(s);
      row.onclick = () => d.active_version_id || d.status === "deleted"
        ? go({view: "doc", doc: d.id, version: d.active_version_id || "", page: 1, chunk: "", from: "docs"})
        : toast("This document has no committed version yet", true);
      row.onkeydown = (e) => { if (e.key === "Enter") row.onclick(); };
      table.append(row);
    }
    main.append(table);
    const pages = Math.ceil(got.total / got.size);
    if (pages > 1) {
      const pager = el("div", "kbpager");
      const prev = Icons.button("back", undefined, "small", "Previous page");
      prev.disabled = v.dpage <= 1;
      prev.onclick = () => go({dpage: v.dpage - 1});
      const next = Icons.button("right", undefined, "small", "Next page");
      next.disabled = v.dpage >= pages;
      next.onclick = () => go({dpage: v.dpage + 1});
      const from = (got.page - 1) * got.size + 1;
      pager.append(prev, el("span", "evsub", `${from}–${from + got.documents.length - 1} of ${got.total}`), next);
      main.append(pager);
    }
  }

  function mimeLabel(mime) {
    const known = {"application/pdf": "PDF", "text/html": "HTML", "text/markdown": "Markdown", "text/plain": "Text",
                   "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
                   "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
                   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel"};
    return known[mime] || mime;
  }

  /* ── a document: pages with boxes, or text in bands ───────────────── */

  const trees = new Map();   // version -> element tree (fetched when an element is opened)

  async function showDoc(main, col, mine) {
    const back = Icons.button("back", v.from === "ask" && lastAsk ? "Back to the answer" : `${col.id} documents`, "small ghost kbback");
    back.onclick = () => { if (v.from !== "ask") lit = null; go({view: v.from === "ask" ? "ask" : "docs", chunk: ""}); };
    main.append(back);
    let doc, ver;
    try {
      doc = await api(kb(`documents/${enc(v.doc)}`));
      if (!v.version) v.version = doc.active_version_id || (doc.versions[0] || {}).id || "";
      ver = await api(kb(`versions/${enc(v.version)}`));
    } catch (err) { main.append(loadError(err, () => show())); return; }
    if (mine !== token) return;

    const top = el("div", "xptop");
    const title = el("div", "xptitle");
    title.append(el("h3", null, doc.title || doc.key));
    const sub = el("div", "evfacts");
    sub.append(el("span", "mono", doc.key),
               el("span", null, [mimeLabel(doc.mime), ver.pages.length ? `${ver.pages.length} pages` : "no pages",
                                 `${ver.stats.elements} elements`, `${ver.stats.chunks} chunks`].join(" · ")));
    title.append(sub);
    top.append(title);
    if (doc.versions.length > 1) {
      const pick = el("select", "xpselect");
      pick.setAttribute("aria-label", "Version");
      for (const x of doc.versions) {
        const o = el("option", null, `v${x.ordinal + 1} · ${x.status}${x.id === doc.active_version_id ? " (active)" : ""} · ${fmtAgo(x.created_at)}`);
        o.value = x.id; o.selected = x.id === v.version;
        pick.append(o);
      }
      pick.onchange = () => go({version: pick.value, page: 1, chunk: ""});
      top.append(pick);
    }
    main.append(top);
    if (doc.status === "deleted") main.append(el("div", "xpstore warn", "This document is deleted: search no longer finds it."));

    const view = el("div", "kbview" + (v.chunk ? " picked" : ""));
    const stage = el("div", "kbstage");
    const side = el("aside", "kbinspect");
    view.append(stage, side);
    main.append(view);
    const lightHere = lit && lit.version === ver.id ? lit : null;
    if (ver.pages.length) await drawPage(stage, side, ver, lightHere, mine);
    else await drawText(stage, side, ver, lightHere, mine);
  }

  async function drawPage(stage, side, ver, light, mine) {
    const total = ver.pages.length;
    v.page = Math.min(Math.max(1, v.page || 1), total);
    const bar = el("div", "kbpagebar");
    const prev = Icons.button("back", undefined, "small", "Previous page");
    prev.disabled = v.page <= 1;
    prev.onclick = () => go({page: v.page - 1});
    const next = Icons.button("right", undefined, "small", "Next page");
    next.disabled = v.page >= total;
    next.onclick = () => go({page: v.page + 1});
    const at = el("span", "kbpageno", `Page ${v.page} / ${total}`);
    const layers = el("span", "tlmodes kblayers");
    for (const [key, label] of [["both", "Both"], ["elements", "Elements"], ["chunks", "Chunks"]]) {
      const b = el("button", v.layer === key ? "on" : "", label);
      b.type = "button";
      b.onclick = () => { v.layer = key; save(); frame.dataset.layer = key; for (const x of layers.children) x.classList.toggle("on", x === b); };
      layers.append(b);
    }
    bar.append(prev, at, next, layers);
    if (light) {
      const pages = KX.pagesOf(light.regions);
      const cite = el("span", "kblitnote", `[${light.marker}] cited on ${KX.pagesText(pages)}`);
      bar.append(cite);
    }
    stage.append(bar);

    const frame = el("div", "kbpage");
    frame.dataset.layer = v.layer;
    frame.dataset.page = String(v.page);
    const p = ver.pages[v.page - 1];
    frame.style.aspectRatio = `${p.width} / ${p.height}`;
    const img = el("img", "kbimg");
    img.alt = `Page ${v.page}`;
    img.src = kb(`versions/${enc(ver.id)}/pages/${v.page}/image?scale=2`);
    img.onerror = () => { frame.classList.add("noimg"); frame.append(el("div", "kbnoimg", "The page image did not load; the boxes are still where the text is.")); };
    const over = el("div", "kbover");
    frame.append(img, over);
    stage.append(frame);

    let page;
    try { page = await api(kb(`versions/${enc(ver.id)}/pages/${v.page}`)); }
    catch (err) { stage.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    const chunkEls = new Map();
    for (const e of page.elements) {
      for (const b of e.boxes) {
        const d = el("div", `kbbox kbel fam-${KX.kindFamily(e.kind)}`);
        Object.assign(d.style, KX.boxStyle(b));
        d.title = `${e.kind}: ${e.preview}`;
        d.onclick = (ev) => { ev.stopPropagation(); openElement(side, ver, e); };
        over.append(d);
      }
    }
    for (const c of page.chunks) {
      for (const b of c.boxes) {
        const d = el("div", "kbbox kbchunk" + (c.chunk_id === v.chunk ? " sel" : ""));
        Object.assign(d.style, KX.boxStyle(b));
        d.dataset.chunk = c.chunk_id;
        d.title = `chunk #${c.ordinal + 1}`;
        d.onclick = (ev) => { ev.stopPropagation(); pickChunk(c.chunk_id); };
        over.append(d);
        if (!chunkEls.has(c.chunk_id)) chunkEls.set(c.chunk_id, []);
        chunkEls.get(c.chunk_id).push(d);
      }
    }
    if (light) {
      for (const b of KX.boxesOn(light.regions, v.page)) {
        const d = el("div", "kbbox kbcite");
        Object.assign(d.style, KX.boxStyle(b));
        d.title = `cited by [${light.marker}]: ${light.quote}`;
        over.append(d);
      }
      const firstBox = over.querySelector(".kbcite");
      if (firstBox) requestAnimationFrame(() => firstBox.scrollIntoView({block: "center", behavior: "smooth"}));
    }

    function pickChunk(id) {
      v.chunk = v.chunk === id ? "" : id;
      save();
      for (const [cid, els] of chunkEls) for (const d of els) d.classList.toggle("sel", cid === v.chunk);
      side.parentElement.classList.toggle("picked", !!v.chunk);
      inspect(side, ver);
    }
    inspect(side, ver);
  }

  async function drawText(stage, side, ver, light, mine) {
    let got;
    try { got = await api(kb(`versions/${enc(ver.id)}/text`)); }
    catch (err) { stage.append(loadError(err, () => show())); return; }
    if (mine !== token) return;
    const picked = ver.chunks.find(c => c.chunk_id === v.chunk);
    const marks = light ? [light.span] : picked ? picked.spans : [];
    const order = new Map(ver.chunks.map((c, i) => [c.chunk_id, i]));
    stage.append(el("div", "kbtextnote evsub", light
      ? `[${light.marker}] cites the highlighted text — this source has no pages, so its canonical text is shown`
      : "This source has no pages: its canonical text, in its chunks. Click a chunk to inspect it."));
    const text = el("div", "kbtext");
    for (const b of KX.textBands(got.text, ver.chunks, marks)) {
      const s = el("span", b.chunk ? `kbband ${order.get(b.chunk) % 2 ? "odd" : "even"}` : "kbband none", b.text);
      if (b.chunk && b.chunk === v.chunk) s.classList.add("sel");
      if (b.mark) s.classList.add(light ? "lit" : "mark");
      if (b.chunk) s.onclick = () => go({chunk: v.chunk === b.chunk ? "" : b.chunk});
      text.append(s);
    }
    stage.append(text);
    const first = text.querySelector(".lit, .mark");
    if (first) requestAnimationFrame(() => first.scrollIntoView({block: "center", behavior: "smooth"}));
    inspect(side, ver);
  }

  async function openElement(side, ver, e) {
    side.parentElement.classList.add("picked");
    side.textContent = "";
    side.append(el("div", "stitle", e.kind.replace("_", " ")));
    let tree = trees.get(ver.id);
    if (!tree) {
      try { tree = (await api(kb(`versions/${enc(ver.id)}/tree`))).elements; trees.set(ver.id, tree); }
      catch (err) { side.append(el("div", "errbox", err.message)); return; }
    }
    const full = tree.find(x => x.id === e.id) || e;
    const facts = el("div", "evfacts");
    facts.append(chipOf(e.layer), full.span ? `span ${full.span[0]}–${full.span[1]}` : "furniture: not in the text");
    side.append(facts, el("div", "kbquote", full.text || e.preview));
    const holders = ver.chunks.filter(c => full.span && c.spans.some(([s, t]) => s < full.span[1] && full.span[0] < t));
    if (holders.length) {
      side.append(el("div", "stitle", "In chunk"));
      for (const c of holders) {
        const b = el("button", "linkbtn", `#${c.ordinal + 1} · ${c.token_count} tokens`);
        b.onclick = () => go({chunk: c.chunk_id});
        side.append(b);
      }
    }
    side.append(el("div", "evsub mono kbid", e.id));
  }

  /* ── the chunk inspector ──────────────────────────────────────────── */

  async function inspect(side, ver) {
    side.textContent = "";
    if (!v.chunk) return chunkList(side, ver);
    const mine = token;
    let c;
    try { c = await api(kb(`chunks/${enc(v.chunk)}?version=${enc(ver.id)}`)); }
    catch (err) { side.append(el("div", "errbox", err.message)); return; }
    if (mine !== token) return;
    side.textContent = "";
    const head = el("div", "kbinsphead");
    head.append(el("b", null, `Chunk #${c.ordinal + 1}`), chipOf(c.kind), chipOf(`${c.token_count} tokens`));
    const close = Icons.button("x", undefined, "", "Close the chunk");
    close.onclick = () => go({chunk: ""});
    head.append(el("span", "spacer"), close);
    side.append(head);
    if (c.heading_path.length) side.append(el("div", "kbpath", c.heading_path.join(" › ")));

    side.append(el("div", "stitle", "Text"), el("div", "kbquote", c.text));
    const dense = c.indexes.find(x => x.kind === "dense");
    const embedded = dense ? dense.embedded_as : c.embed_text;
    const emb = el("div", "kbquote kbemb");
    const at = embedded.indexOf(c.embed_text);
    if (at > 0) emb.append(el("span", "kbtemplate", embedded.slice(0, at)));
    if (c.context_prefix) emb.append(el("mark", "kbprefix", c.context_prefix));
    emb.append(c.embed_text.slice(c.context_prefix.length));
    const et = el("div", "stitle", "Embedded as");
    et.title = "What the embedder read: the index template, then the heading context (highlighted), then the text";
    side.append(et, emb);

    side.append(el("div", "stitle", "Indexed"));
    for (const x of c.indexes) {
      const row = el("div", "kbindex" + (x.key == null ? " missing" : ""));
      row.append(el("b", null, x.kind), el("span", "mono evsub", `${x.store}${x.collection ? "/" + x.collection : ""}`),
                 el("span", "mono", x.key == null ? "not in this index" : `key ${x.key}`));
      side.append(row);
    }
    if (!c.indexes.length) side.append(el("div", "note", "The collection declares no index."));

    if (c.pages.length) {
      side.append(el("div", "stitle", "On pages"));
      const pages = el("div", "kbchips");
      for (const n of c.pages) {
        const b = el("button", "chip kbpagechip" + (n === v.page ? " on" : ""), String(n));
        b.type = "button";
        b.onclick = () => go({page: n});
        pages.append(b);
      }
      side.append(pages);
    }
    const nav = el("div", "kbnav");
    for (const [key, label, icon] of [["previous", "Previous", "back"], ["next", "Next", "right"]]) {
      const id = c.neighbours[key];
      const b = Icons.button(icon, label, "small");
      b.disabled = !id;
      b.onclick = () => {
        const target = ver.chunks.find(x => x.chunk_id === id);
        go({chunk: id, page: target && target.pages.length ? target.pages[0] : v.page});
      };
      nav.append(b);
    }
    side.append(nav, el("div", "evsub mono kbid", c.id));
  }

  function chunkList(side, ver) {
    side.append(el("div", "stitle", `${ver.chunks.length} chunks`));
    const list = el("div", "kbchunks");
    const here = ver.pages.length ? ver.chunks.filter(c => c.pages.includes(v.page)) : ver.chunks;
    if (ver.pages.length) side.append(el("div", "evsub", `${here.length} on page ${v.page} — click one, or (in Chunks) its outline on the page`));
    for (const c of here) {
      const b = el("button", "kbchunkrow");
      b.type = "button";
      const top = el("span", "kbchunktop");
      top.append(el("b", null, `#${c.ordinal + 1}`), el("span", "evsub", `${c.token_count} tokens${c.pages.length ? " · " + KX.pagesText(c.pages) : ""}`));
      b.append(top);
      if (c.heading_path.length) b.append(el("span", "kbpath", c.heading_path.join(" › ")));
      b.append(el("span", "kbprev", c.preview));
      b.onclick = () => go({chunk: c.chunk_id});
      list.append(b);
    }
    side.append(list);
  }

  /* ── Ask: searches side by side, an answer with citations ─────────── */

  function showAsk(main, col, svc) {
    form = form && form.collection === col.id ? form
      : {collection: col.id, query: "", modes: [col.default_mode], k: 8, answer: svc.answer, rerank: false, tags: "", mime: "", fields: {}};
    const card = el("form", "xpcard kbask");
    const q = el("textarea", "kbq");
    q.rows = 2;
    q.placeholder = "Ask the collection something…";
    q.value = form.query;
    q.setAttribute("aria-label", "Question");
    q.oninput = () => { form.query = q.value; };
    q.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); card.requestSubmit(); } };
    card.append(q);

    const opts = el("div", "kbopts");
    const modes = el("span", "kbmodes");
    modes.append(el("span", "evsub", "Search"));
    for (const m of col.modes) {
      const lab = el("label", "kbcheck");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = form.modes.includes(m);
      cb.onchange = () => { form.modes = col.modes.filter(x => x === m ? cb.checked : form.modes.includes(x)); };
      lab.append(cb, m);
      modes.append(lab);
    }
    opts.append(modes);
    const flag = (name, label, title, enabled) => {
      const lab = el("label", "kbcheck");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = !!form[name] && enabled;
      cb.disabled = !enabled;
      cb.onchange = () => { form[name] = cb.checked; };
      lab.title = title;
      lab.append(cb, label);
      return lab;
    };
    opts.append(flag("answer", "Answer", svc.answer ? `Answer from the ${col.default_mode} search, with verified citations` : "This knowledge base was served without an answer model (kb_admin_app(llm=…))", svc.answer),
                flag("rerank", "Rerank", svc.rerank ? "Also rerank the default search, and answer from it" : "This knowledge base was served without a reranker", svc.rerank));
    const k = el("input", "kbk");
    k.type = "number"; k.min = "1"; k.max = "50"; k.value = String(form.k);
    k.setAttribute("aria-label", "Hits per search");
    k.oninput = () => { form.k = Number(k.value); };
    const kl = el("label", "kbcheck");
    kl.append("k", k);
    opts.append(kl);
    card.append(opts);

    const fold = el("details", "kbfilter");
    const filterCount = [form.tags, form.mime, ...Object.values(form.fields)].filter(x => String(x || "").trim()).length;
    fold.open = filterCount > 0;
    fold.append(el("summary", null, filterCount ? `Filter (${filterCount})` : "Filter"));
    const grid = el("div", "kbfgrid");
    const field = (label, value, set, placeholder) => {
      const l = el("label", "xpfl");
      const i = el("input");
      i.value = value || ""; i.placeholder = placeholder || "";
      i.oninput = () => set(i.value);
      l.append(label, i);
      grid.append(l);
    };
    field("Tags — any of", form.tags, (x) => { form.tags = x; }, "hr, policy");
    field("Types (MIME)", form.mime, (x) => { form.mime = x; }, "application/pdf");
    for (const [name, type] of Object.entries(col.filterable || {}))
      field(`${name} (${type})`, form.fields[name], (x) => { form.fields[name] = x; });
    fold.append(grid);
    card.append(fold);

    const err = el("div", "errbox");
    err.hidden = true;
    const acts = el("div", "kbacts");
    const ask = el("button", "primary needs-edit", "Ask");
    ask.type = "submit";
    acts.append(ask, el("span", "evsub", "Ctrl+Enter"));
    card.append(err, acts);
    main.append(card);
    const out = el("div", "kbresults");
    main.append(out);
    if (lastAsk && lastAsk.collection === col.id) drawResults(out, lastAsk, col);

    card.onsubmit = async (e) => {
      e.preventDefault();
      const got = KX.queryBody({...form, modes: form.modes, answer: form.answer && svc.answer, rerank: form.rerank && svc.rerank},
                               col.filterable);
      err.hidden = true;
      if (got.error) { err.textContent = got.error; err.hidden = false; return; }
      ask.disabled = true;
      out.textContent = "";
      out.append(el("div", "note kbwait", got.body.answer ? "Searching and answering…" : "Searching…"));
      try {
        lastAsk = await api(kb(`collections/${enc(col.id)}/query`), got.body);
        lit = null;
        drawResults(out, lastAsk, col);
      } catch (x) {
        out.textContent = "";
        const box2 = el("div", "errbox");
        box2.append(el("div", "errhead", "The query failed"), el("div", "note", x.message));
        if (x.data && x.data.trace_id) box2.append(traceBtn(x.data.trace_id, "Open the failed run"));
        out.append(box2);
      }
      ask.disabled = false;
    };
  }

  function drawResults(out, res, col) {
    out.textContent = "";
    if (res.answer) out.append(answerCard(res, col));
    if (res.searches.length) {
      const cols = el("div", "kbcols");
      for (const s of res.searches) cols.append(hitColumn(s));
      out.append(cols);
    }
  }

  function answerCard(res, col) {
    const a = res.answer;
    const card = el("div", "xpcard kbanswer");
    const head = el("div", "xpcardhead");
    const st = a.stats || {};
    head.append(el("span", "stitle", "Answer"),
                el("span", "evsub", `${a.mode}${a.reranked ? " + rerank" : ""} · ${st.verified || 0} of ${st.citations || 0} citations verified`
                  + (st.unsupported ? ` · ${st.unsupported} unsupported sentence${st.unsupported === 1 ? "" : "s"}` : "")));
    head.append(traceBtn(a.trace_id));
    card.append(head);
    const by = KX.citationsByMarker(a.citations);
    const text = el("p", "kbatext");
    for (const part of KX.answerParts(a.text, a.sentences, a.unsupported_sentences)) {
      const s = el("span", part.unsupported ? "kbunsup" : "");
      if (part.unsupported) s.title = "No verified citation supports this sentence";
      for (const x of part.parts) {
        if (!x.markers) { s.append(x.text); continue; }
        const m = el("span", "kbmarks");
        for (const n of x.markers) {
          const b = el("button", "kbmark", String(n));
          b.type = "button";
          const cs = by.get(n) || [];
          b.title = cs.length ? `${cs[0].title || cs[0].key} · ${KX.pagesText(cs[0].pages) || "text"} — open the cited ${cs[0].pages.length ? "page" : "text"}` : `source ${n}`;
          b.disabled = !cs.length;
          b.dataset.marker = String(n);
          b.onclick = () => cs.length && openCitation(cs[0]);
          m.append(b);
        }
        s.append(m);
      }
      text.append(s);
    }
    card.append(text);

    if (a.citations.length) {
      const list = el("div", "kbcites");
      for (const c of a.citations) {
        const row = el("button", "kbcite-row");
        row.type = "button";
        row.dataset.marker = String(c.marker);
        const top = el("span", "kbcite-top");
        top.append(el("span", "kbmark static", String(c.marker)), el("b", null, c.title || c.key),
                   el("span", "evsub", KX.pagesText(c.pages) || "no pages"));
        if (c.tolerated && c.tolerated.length) {
          const t = chipOf("tolerated", "cwarn");
          t.title = `The quote matched only after allowing: ${c.tolerated.join(", ")}. Shown is the source's own text.`;
          top.append(t);
        }
        row.append(top, el("span", "kbquote small", c.quote));
        row.onclick = () => openCitation(c);
        list.append(row);
      }
      card.append(list);
    }
    if (a.dropped && a.dropped.length) {
      const d = el("details", "kbdropped");
      d.append(el("summary", null, `${a.dropped.length} citation${a.dropped.length === 1 ? "" : "s"} dropped — the quote is not in the source, so it is not shown as one`));
      for (const x of a.dropped) {
        const r = el("div", "kbdrop");
        const q = x.citation && typeof x.citation === "object" ? x.citation.quote : x.citation;
        r.append(el("span", "evsub", x.reason), el("span", "kbquote small", String(q || "")));
        d.append(r);
      }
      card.append(d);
    }
    card.append(caseForm(res, col));
    return card;
  }

  function hitColumn(s) {
    const c = el("div", "kbcol");
    const head = el("div", "kbcolhead");
    head.append(el("b", null, s.mode), s.reranked ? chipOf("reranked", "kbdefault") : "",
                el("span", "evsub", `${s.hits.length} hit${s.hits.length === 1 ? "" : "s"}`), traceBtn(s.trace_id, "Trace"));
    c.append(head);
    if (!s.hits.length) c.append(el("div", "note", "Nothing found."));
    for (const h of s.hits) {
      const b = el("button", "kbhit");
      b.type = "button";
      const top = el("span", "kbhittop");
      top.append(el("span", "kbrank", String(h.rank)), el("b", null, h.title || h.key),
                 el("span", "evsub", KX.pagesText(h.pages)), el("span", "kbscore mono", KX.score(h.score)));
      b.title = Object.entries(h.scores || {}).map(([k, x]) => `${k} ${KX.score(x)}`).join(" · ");
      b.append(top);
      if (h.heading_path && h.heading_path.length) b.append(el("span", "kbpath", h.heading_path.join(" › ")));
      b.append(el("span", "kbprev", h.text));
      b.onclick = () => { lit = null; go({view: "doc", doc: h.document_id, version: h.version_id, page: (h.pages || [])[0] || 1, chunk: h.chunk_id, from: "ask"}); };
      c.append(b);
    }
    return c;
  }

  function openCitation(c) {
    const t = KX.citationTarget(c);
    lit = {...t, marker: c.marker, quote: c.quote};
    go({view: "doc", doc: c.document_id, version: t.version, page: t.page || 1, chunk: "", from: "ask"});
  }

  /* ── an answer becomes an eval case ───────────────────────────────── */

  function caseForm(res, col) {
    const f = el("form", "kbcase needs-edit");
    f.append(el("span", "stitle", "Save as eval case"));
    const name = el("input", "kbds");
    name.value = recall(`${K}:dataset`, `${col.id}_cases`);
    name.setAttribute("aria-label", "Dataset");
    name.setAttribute("list", "kbdsl");
    const dl = el("datalist");
    dl.id = "kbdsl";
    api(`/api/p/${PID}/datasets`).then((x) => {
      for (const d of x.datasets || []) { const o = el("option"); o.value = d.name; dl.append(o); }
    }).catch(() => {});
    const keep = el("label", "kbcheck");
    const kb2 = el("input");
    kb2.type = "checkbox";
    keep.title = "Only when the answer is right: it becomes the case's expected answer";
    keep.append(kb2, "The answer is right — keep it as expected");
    const btn = el("button", "", "Save case");
    btn.type = "submit";
    const msg = el("span", "evsub");
    f.append(name, dl, keep, btn, msg);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const ds = name.value.trim();
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(ds)) { msg.textContent = "A dataset name is letters, digits, _ . -"; return; }
      const got = KX.caseBody(res.query, res.answer, {keepAnswer: kb2.checked, k: res.k});
      if (got.error) { msg.textContent = got.error; return; }
      btn.disabled = true;
      try {
        const {row} = await api(kb(`collections/${enc(col.id)}/eval-case`), got.body);
        const saved = await api(`/api/p/${PID}/datasets/${enc(ds)}/rows`, {rows: [row]});
        store(`${K}:dataset`, ds);
        msg.textContent = saved.added.length ? `Saved ${row.id} to ${ds} — commit datasets/${ds}.jsonl to share it`
                                             : `${ds} already holds this question (${row.id})`;
      } catch (x) { msg.textContent = x.message; }
      btn.disabled = false;
    };
    return f;
  }

  discover();
  registerPane("knowledge", {el: box, show});
  return {show, discover};
})();
