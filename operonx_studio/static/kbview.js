/* operonx studio — knowledge: the pure layer the Knowledge pages draw from.
 *
 * Every fact on the Knowledge pages is the knowledge base's own (operonx-kb's
 * admin API, operonx-kb/1): which text a citation quotes, where on which page
 * its boxes are, which sentences no verified citation supports. This file only
 * shapes those facts for drawing: a normalised box as a position on the page
 * image, an answer cut into sentences and [n] markers, a canonical text cut
 * into chunk bands, a filter form read into a KBFilter, an eval case's body.
 *
 * Split like experiments.js: this layer runs under `node --test`; knowledge.js
 * draws.
 */

(function (global) {
  "use strict";

  /* ── boxes on a page ──────────────────────────────────────────────── */

  // a Region's bbox is (x0, y0, x1, y1) in [0, 1], origin top-left: the
  // overlay sits on the image in percentages, so it scales with the image
  function boxStyle(bbox) {
    const [x0, y0, x1, y1] = bbox.map(Number);
    const pc = (v) => `${(100 * v).toFixed(3)}%`;
    return {left: pc(x0), top: pc(y0), width: pc(Math.max(0, x1 - x0)), height: pc(Math.max(0, y1 - y0))};
  }

  /* the boxes of `regions` ({page_no, bbox}) on page `page` */
  function boxesOn(regions, page) {
    return (regions || []).filter(r => r.page_no === page).map(r => r.bbox);
  }

  /* the pages `regions` touch, in order, each once */
  function pagesOf(regions) {
    return [...new Set((regions || []).map(r => r.page_no))].sort((a, b) => a - b);
  }

  /* where a citation opens: its version, the page of its first box (none for
   * a source without pages — the viewer shows the text there), its span */
  function citationTarget(c) {
    const first = (c.regions || [])[0];
    return {version: c.version_id, page: first ? first.page_no : null, span: c.span, regions: c.regions || []};
  }

  // the element kinds, by family: one colour per family on the page
  const KIND_FAMILY = {
    title: "head", heading: "head", paragraph: "text", footnote: "text", kv: "text",
    list: "list", list_item: "list", table: "table", figure: "figure", caption: "figure",
    code: "code", formula: "code", page_header: "furniture", page_footer: "furniture",
  };
  function kindFamily(kind) { return KIND_FAMILY[kind] || "text"; }

  /* ── an answer: sentences and markers ─────────────────────────────── */

  const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

  /* `text` cut for drawing: each sentence (the KB's own spans) with its
   * [n] markers as their own parts, flagged when no verified citation
   * supports it; text between sentences as plain parts */
  function answerParts(text, sentences, unsupported) {
    const flagged = new Set(unsupported || []);
    const out = [];
    let at = 0;
    const pieces = (from, to) => {
      const parts = [];
      const chunk = text.slice(from, to);
      let last = 0;
      for (const m of chunk.matchAll(MARKER)) {
        if (m.index > last) parts.push({text: chunk.slice(last, m.index)});
        parts.push({markers: m[1].split(/\s*,\s*/).map(Number), text: m[0]});
        last = m.index + m[0].length;
      }
      if (last < chunk.length) parts.push({text: chunk.slice(last)});
      return parts;
    };
    (sentences || []).forEach(([s, e], i) => {
      if (s > at) out.push({gap: true, parts: pieces(at, s)});
      out.push({sentence: i, unsupported: flagged.has(i), parts: pieces(s, e)});
      at = e;
    });
    if (at < text.length) out.push({gap: true, parts: pieces(at, text.length)});
    return out;
  }

  /* marker number -> its verified citations, in the order given */
  function citationsByMarker(citations) {
    const out = new Map();
    for (const c of citations || []) {
      if (!out.has(c.marker)) out.set(c.marker, []);
      out.get(c.marker).push(c);
    }
    return out;
  }

  /* ── a canonical text in bands ────────────────────────────────────── */

  /* `text` cut where chunks begin and end and where `marks` (spans to
   * highlight: a citation, the chunk picked) begin and end; each band says
   * which chunk holds it and whether it is marked */
  function textBands(text, chunks, marks) {
    const cuts = new Set([0, text.length]);
    const owner = [];
    for (const c of chunks || []) for (const [s, e] of c.spans) { cuts.add(s); cuts.add(e); owner.push([s, e, c.chunk_id]); }
    for (const [s, e] of marks || []) { cuts.add(s); cuts.add(e); }
    const at = [...cuts].filter(x => x >= 0 && x <= text.length).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i + 1 < at.length; i++) {
      const [s, e] = [at[i], at[i + 1]];
      if (s === e) continue;
      const own = owner.find(([a, b]) => a <= s && e <= b);
      out.push({start: s, end: e, text: text.slice(s, e), chunk: own ? own[2] : null,
                mark: (marks || []).some(([a, b]) => a <= s && e <= b)});
    }
    return out;
  }

  /* ── a query ──────────────────────────────────────────────────────── */

  function words(text) {
    return [...new Set(String(text || "").split(/[,\n]/).map(s => s.trim()).filter(Boolean))];
  }

  /* the filter builder's fields as a KBFilter dict: tags, MIME types and the
   * collection's declared filterable fields, each value cast to its type */
  function filterOf(form, filterable) {
    const out = {};
    const tags = words(form.tags);
    if (tags.length) out.tags_any = tags;
    const mimes = words(form.mime);
    if (mimes.length) out.mime_in = mimes;
    const fields = {};
    for (const [name, type] of Object.entries(filterable || {})) {
      const raw = String((form.fields || {})[name] ?? "").trim();
      if (!raw) continue;
      if (type === "int" || type === "float") {
        const n = Number(raw);
        if (!Number.isFinite(n) || (type === "int" && !Number.isInteger(n))) return {error: `${name} is a${type === "int" ? " whole" : ""} number`};
        fields[name] = n;
      } else if (type === "bool") {
        if (!/^(true|false)$/i.test(raw)) return {error: `${name} is true or false`};
        fields[name] = /^true$/i.test(raw);
      } else if (type === "keyword[]") {
        fields[name] = words(raw);
      } else fields[name] = raw;
    }
    if (Object.keys(fields).length) out.fields = fields;
    return {filter: Object.keys(out).length ? out : null};
  }

  /* the request the playground sends */
  function queryBody(form, filterable) {
    const query = String(form.query || "").trim();
    if (!query) return {error: "Ask something first"};
    const f = filterOf(form, filterable);
    if (f.error) return {error: f.error};
    const modes = (form.modes || []).filter(Boolean);
    if (!modes.length && !form.answer) return {error: "Pick at least one retrieval mode, or ask for an answer"};
    const body = {query, modes, k: Number(form.k) || 8, answer: !!form.answer, rerank: !!form.rerank};
    if (form.mode) body.mode = form.mode;
    if (f.filter) body.filter = f.filter;
    return {body};
  }

  /* the body of POST /collections/{c}/eval-case: the question, the verified
   * citations it rests on, and the answer only when someone vouches for it */
  function caseBody(query, answer, opts) {
    const citations = ((answer && answer.citations) || []).map(c => ({key: c.key, quote: c.quote, pages: c.pages}));
    if (!citations.length) return {error: "Only an answer with a verified citation can become a case: its quotes are the labels"};
    const body = {query, citations};
    if (opts && opts.keepAnswer && answer.text) body.answer = answer.text.replace(MARKER, "").replace(/\s+([.,;:!?])/g, "$1").trim();
    if (opts && opts.k) body.k = opts.k;
    return {body};
  }

  /* ── numbers ──────────────────────────────────────────────────────── */

  function score(x) {
    if (x == null || !Number.isFinite(x)) return "—";
    const a = Math.abs(x);
    return a >= 100 ? x.toFixed(0) : a >= 1 ? x.toFixed(2) : x.toFixed(3);
  }

  function pagesText(pages) {
    const p = pages || [];
    if (!p.length) return "";
    if (p.length === 1) return `p. ${p[0]}`;
    const contiguous = p.every((v, i) => i === 0 || v === p[i - 1] + 1);
    return contiguous ? `pp. ${p[0]}–${p[p.length - 1]}` : `pp. ${p.join(", ")}`;
  }

  const api = {boxStyle, boxesOn, pagesOf, citationTarget, kindFamily, answerParts, citationsByMarker,
               textBands, filterOf, queryBody, caseBody, score, pagesText};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.KX = api;
})(typeof window !== "undefined" ? window : globalThis);
