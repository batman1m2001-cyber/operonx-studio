/* operonx studio — the value renderer.
 *
 * One renderer for every recorded value the inspector shows. The rules
 * exist to spend panel space on facts:
 *   - scalars inline, colored by type
 *   - long strings clamped behind an expander that names their size
 *   - base64/payload-looking strings shown as a size token, never dumped
 *   - dicts and arrays as collapsible trees, devtools-style
 *   - consumer markers ($media, $unserializable) as styled tokens
 *
 * Split in two layers on purpose: spec() is pure data → data and runs
 * under `node --test`; render() assembles DOM from a spec and only runs
 * in the browser.
 */

(function (global) {
  "use strict";

  const STR_INLINE = 100;      // chars; longer strings clamp
  const PAYLOAD_MIN = 1024;    // chars; base64-ish beyond this is a token
  const ARR_PREVIEW = 3;
  const MAX_CHILDREN = 100;
  const MAX_DEPTH = 8;

  const B64ISH = /^[A-Za-z0-9+/=\s]+$/;

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function looksPayload(s) {
    return s.length >= PAYLOAD_MIN && B64ISH.test(s.slice(0, 512));
  }

  function marker(v) {
    // the trace consumer's own tokens for things it chose not to inline
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("$unserializable" in v) return { t: "unser", text: String(v.$unserializable) };
      if ("$media" in v || "$media_ref" in v) {
        const ref = v.$media ?? v.$media_ref;
        const size = v.bytes ?? v.size;
        return { t: "media", text: String(ref), size: size ? fmtBytes(size) : null };
      }
    }
    return null;
  }

  function spec(v, opts, depth) {
    opts = opts || {};
    depth = depth || 0;
    if (depth > MAX_DEPTH) return { t: "token", cls: "null", text: "…deep" };
    if (v === null || v === undefined) return { t: "token", cls: "null", text: "null" };
    if (typeof v === "boolean") return { t: "token", cls: "bool", text: String(v) };
    if (typeof v === "number") {
      return { t: "token", cls: "num",
               text: Number.isInteger(v) ? String(v) : v.toPrecision(6).replace(/\.?0+$/, "") };
    }
    if (typeof v === "string") {
      if (looksPayload(v)) return { t: "payload", size: fmtBytes(v.length), full: v };
      if (v.length <= STR_INLINE) return { t: "str", text: v };
      return { t: "longstr", head: v.slice(0, 160), full: v, size: fmtBytes(v.length) };
    }
    if (Array.isArray(v)) {
      const children = v.slice(0, MAX_CHILDREN).map((x) => spec(x, opts, depth + 1));
      const scalars = children.every((c) => ["token", "str"].includes(c.t));
      return {
        t: "arr", count: v.length,
        preview: scalars ? children.slice(0, ARR_PREVIEW) : null,
        children, more: v.length > MAX_CHILDREN ? v.length - MAX_CHILDREN : 0,
      };
    }
    if (typeof v === "object") {
      const mk = marker(v);
      if (mk) return mk;
      let keys = Object.keys(v);
      const priority = opts.priority || [];
      keys = [...priority.filter((k) => keys.includes(k)),
              ...keys.filter((k) => !priority.includes(k))];
      const children = keys.slice(0, MAX_CHILDREN)
        .map((k) => [k, spec(v[k], {}, depth + 1)]);
      return { t: "obj", count: keys.length, children,
               more: keys.length > MAX_CHILDREN ? keys.length - MAX_CHILDREN : 0 };
    }
    return { t: "token", cls: "null", text: String(v) };
  }

  /* ── DOM assembly (browser only) ─────────────────────────────────── */

  function elx(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function assemble(s, open) {
    switch (s.t) {
      case "token": return elx("span", `vt vt-${s.cls}`, s.text);
      case "str": return elx("span", "vt vt-str", `"${s.text}"`);
      case "unser": return elx("span", "vt vt-marker", `⊘ ${s.text}`);
      case "media": return elx("span", "vt vt-marker",
        `▮ media${s.size ? ` · ${s.size}` : ""} · ${s.text.split("/").pop()}`);
      case "payload": {
        const d = elx("details", "vfold");
        d.append(elx("summary", "vt vt-marker", `▮ ${s.size} payload`));
        const pre = elx("pre", "vlong mono", s.full.slice(0, 4000)
          + (s.full.length > 4000 ? `\n…(+${fmtBytes(s.full.length - 4000)})` : ""));
        d.append(pre);
        return d;
      }
      case "longstr": {
        const d = elx("details", "vfold");
        d.append(elx("summary", "vt vt-str vclamp", `"${s.head}…" ▸ ${s.size}`));
        d.append(elx("pre", "vlong mono", s.full));
        return d;
      }
      case "arr": {
        const d = elx("details", "vfold");
        const sum = elx("summary");
        sum.append(elx("span", "vt vt-count", `[${s.count}]`));
        if (s.preview) {
          sum.append(" ");
          const bits = s.preview.map((p) => p.t === "str" ? `"${p.text}"` : p.text);
          sum.append(elx("span", "vpreview mono",
            bits.join(", ") + (s.count > s.preview.length ? ", …" : "")));
        }
        d.append(sum);
        const box = elx("div", "vrows");
        s.children.forEach((c, i) => {
          const row = elx("div", "vrow");
          row.append(elx("span", "vkey mono", String(i)));
          row.append(assemble(c));
          box.append(row);
        });
        if (s.more) box.append(elx("div", "vkey mono", `…+${s.more} items`));
        d.append(box);
        if (open) d.open = true;
        return d;
      }
      case "obj": {
        const d = elx("details", "vfold");
        const sum = elx("summary");
        sum.append(elx("span", "vt vt-count", `{${s.count}}`));
        sum.append(" ");
        sum.append(elx("span", "vpreview mono",
          s.children.slice(0, 4).map(([k]) => k).join(" · ")
          + (s.count > 4 ? " · …" : "")));
        d.append(sum);
        const box = elx("div", "vrows");
        for (const [k, c] of s.children) {
          const row = elx("div", "vrow");
          row.append(elx("span", "vkey mono", k));
          row.append(assemble(c));
          box.append(row);
        }
        if (s.more) box.append(elx("div", "vkey mono", `…+${s.more} keys`));
        d.append(box);
        if (open) d.open = true;
        return d;
      }
    }
    return elx("span", "vt", "?");
  }

  function copyButton(v) {
    const b = elx("button", "vcopy", "⧉");
    b.title = "Copy as JSON";
    b.onclick = (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      try { navigator.clipboard.writeText(text); b.textContent = "✓"; }
      catch { b.textContent = "✗"; }
      setTimeout(() => { b.textContent = "⧉"; }, 900);
    };
    return b;
  }

  function render(v, opts) {
    opts = opts || {};
    const wrap = elx("div", "vwrap");
    wrap.append(assemble(spec(v, opts), !!opts.open));
    wrap.append(copyButton(v));
    return wrap;
  }

  const api = { spec, render, fmtBytes, looksPayload };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Values = api;
})(typeof window !== "undefined" ? window : globalThis);
