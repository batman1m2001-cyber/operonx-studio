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
  const SHA = /^[0-9a-f]{64}$/;    // a content-addressed blob ($media)

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function looksPayload(s) {
    return s.length >= PAYLOAD_MIN && B64ISH.test(s.slice(0, 512));
  }

  const PCM = /^audio\/(l8|l16|l24|pcm|raw|x-raw)$/i;
  function declaredMime(mime, rate, channels) {
    if (!mime) return null;
    const base = mime.split(";")[0].trim();
    if (!PCM.test(base) || /;\s*rate=/i.test(mime) || !(Number.isInteger(rate) && rate > 0)) return mime;
    const ch = Number.isInteger(channels) && channels > 0 ? channels : 1;
    return `${mime};rate=${rate};channels=${ch}`;
  }

  function marker(v) {
    // the trace consumer's own tokens for things it chose not to inline
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("$unserializable" in v) return { t: "unser", text: String(v.$unserializable) };
      if ("$media" in v || "$media_ref" in v) {
        const ref = v.$media ?? v.$media_ref;
        const size = v.bytes ?? v.size;
        const out = { t: "media", text: String(ref), size: size ? fmtBytes(size) : null };
        if ("$media" in v && SHA.test(String(v.$media))) {
          // a blob in the store's media directory: /media/<sha> serves it
          const mime = typeof v.mime === "string" ? v.mime : "";
          out.sha = v.$media;
          out.mime = mime || null;
          // what the server is told the blob is: raw PCM has no header, so
          // its rate rides along (operonx keeps it beside the mime)
          out.declared = declaredMime(mime, v.sample_rate, v.channels);
          out.kind = mime.startsWith("audio/") ? "audio"
            : mime.startsWith("image/") && mime !== "image/svg+xml" ? "image" : null;
          if (typeof v.duration_s === "number")
            out.duration = `${Number(v.duration_s.toFixed(v.duration_s < 10 ? 2 : 1))} s`;
        }
        return out;
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

  /* A key in the tree copies its path when clicked: `.a.b[0]` (jq's form). */
  function keyEl(text, path) {
    const k = elx("span", "vkey mono", text);
    k.title = `Copy the path ${path}`;
    k.setAttribute("role", "button");
    k.tabIndex = 0;
    const copy = (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      try { navigator.clipboard.writeText(path); k.classList.add("copied"); }
      catch { /* no clipboard */ }
      setTimeout(() => k.classList.remove("copied"), 900);
    };
    k.onclick = copy;
    k.onkeydown = (ev) => { if (ev.key === "Enter") copy(ev); };
    return k;
  }

  const pathKey = (path, k) => (/^[A-Za-z_][\w]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

  function assemble(s, open, path) {
    path = path || "";
    switch (s.t) {
      case "token": return elx("span", `vt vt-${s.cls}`, s.text);
      case "str": return elx("span", "vt vt-str", `"${s.text}"`);
      case "unser": return elx("span", "vt vt-marker", `⊘ ${s.text}`);
      case "media": {
        if (!s.sha) return elx("span", "vt vt-marker",
          `▮ media${s.size ? ` · ${s.size}` : ""} · ${s.text.split("/").pop()}`);
        const tok = elx("span", "vt vt-marker",
          `▮ ${s.mime || "media"}${s.duration ? ` · ${s.duration}` : ""}${s.size ? ` · ${s.size}` : ""}`);
        tok.title = `sha256 ${s.sha}`;
        const url = api.mediaUrl ? api.mediaUrl(s.sha, s.declared) : null;
        if (!url || !s.kind) return tok;
        const box = elx("div", "vmedia");
        if (s.kind === "audio") {
          const a = elx("audio");
          a.controls = true;
          a.preload = "metadata";
          a.src = url;
          a.setAttribute("aria-label", `Recorded audio, ${s.mime}${s.duration ? `, ${s.duration}` : ""}`);
          box.append(a);
          box.append(waveform(url, a));
        } else {
          const link = elx("a");
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener";
          const img = elx("img");
          img.loading = "lazy";
          img.src = url;
          img.alt = `Recorded image, ${s.mime}`;
          link.append(img);
          box.append(link);
        }
        box.append(tok);
        return box;
      }
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
          row.append(keyEl(String(i), `${path}[${i}]`));
          row.append(assemble(c, false, `${path}[${i}]`));
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
          row.append(keyEl(k, pathKey(path, k)));
          row.append(assemble(c, false, pathKey(path, k)));
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

  /* The audio's shape, as peaks: fetched and decoded only once it is on
   * screen; a click on it plays from there. Nothing when the browser cannot
   * decode it (the player still plays what it can). */
  const PEAKS = 140;
  function peaksOf(samples, n) {
    const out = new Array(n).fill(0);
    const per = Math.max(1, Math.floor(samples.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * per, end = Math.min(samples.length, j + per); j < end; j++) {
        const x = Math.abs(samples[j]);
        if (x > m) m = x;
      }
      out[i] = m;
    }
    const top = Math.max(1e-6, ...out);
    return out.map((x) => x / top);
  }

  function waveform(url, audio) {
    const c = elx("canvas", "vwave");
    c.width = PEAKS * 3; c.height = 36;
    c.setAttribute("aria-hidden", "true");
    const draw = async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ac = new Ctx();
        const decoded = await ac.decodeAudioData(buf);
        ac.close && ac.close();
        const peaks = peaksOf(decoded.getChannelData(0), PEAKS);
        const g = c.getContext("2d");
        const ink = getComputedStyle(c).color || "#7b9ec8";
        g.fillStyle = ink;
        peaks.forEach((p, i) => {
          const hgt = Math.max(1.5, p * (c.height - 4));
          g.fillRect(i * 3, (c.height - hgt) / 2, 2, hgt);
        });
        c.classList.add("on");
      } catch { c.remove(); }
    };
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((seen) => {
        if (seen.some((e) => e.isIntersecting)) { io.disconnect(); draw(); }
      });
      requestAnimationFrame(() => io.observe(c));
    } else draw();
    c.onclick = (ev) => {
      const r = c.getBoundingClientRect();
      if (audio.duration) { audio.currentTime = audio.duration * (ev.clientX - r.left) / r.width; audio.play(); }
    };
    return c;
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

  /* One line for a card: the value cut to `max` characters, never a
   * payload. Built on spec() so every type rule lives in one place;
   * the server's bounded shapes ({$len}, {$keys}) print as sizes. */
  function brief(v, max) {
    max = max || 40;
    const cut = (s) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("$len" in v) return `[${v.$len}]`;
      if ("$keys" in v) return `{${v.$keys.slice(0, 3).join(", ")}${v.$keys.length > 3 ? ", …" : ""}}`;
      if ("$type" in v) return `<${v.$type}>`;
    }
    const s = spec(v);
    switch (s.t) {
      case "token": return s.cls === "null" ? "∅" : s.text;
      case "str": return cut(JSON.stringify(s.text));
      case "longstr": return cut(JSON.stringify(s.head));
      case "payload": return `payload · ${s.size}`;
      case "media": return s.size ? `media · ${s.size}` : "media";
      case "unser": return "…";
      case "arr": return `[${s.count}]`;
      case "obj": return `{${s.children.slice(0, 3).map((c) => c[0]).join(", ")}${s.count > 3 ? ", …" : ""}}`;
      default: return "…";
    }
  }

  /* A media marker on its own — the token, and a player or the image
   * when the blob can be fetched — for renderers other than render(). */
  function media(v) {
    const s = spec(v);
    return s.t === "media" ? assemble(s) : null;
  }

  // mediaUrl(sha, mime) → where the page fetches a blob; set by the page
  // (studio.js), null under node where nothing is fetched
  const api = { spec, render, media, fmtBytes, looksPayload, brief, peaksOf, mediaUrl: null };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Values = api;
})(typeof window !== "undefined" ? window : globalThis);
