/* operonx studio — pasted text, understood.
 *
 * A long paste (or a JSON one) becomes a card in the composer instead of
 * a wall in the box. This file decides what a paste is (JSON, code in some language, a
 * log or a traceback, or prose) and how a message carries it: as a fenced
 * block ahead of the typed words, so the model and the transcript both
 * see its shape. The same parser splits a message back into words and
 * blocks, for rendering the user's own message and for editing it.
 *
 * Pure data → data: runs under `node --test` (tests/js/paste.test.mjs);
 * assistant.js builds the cards and the bubbles from it.
 */

(function (global) {
  "use strict";

  const CARD_LINES = 12;        // a paste longer than this becomes a card
  const CARD_CHARS = 2000;
  const PRETTY_MAX = 64 * 1024; // JSON is pretty-printed up to this size

  const LABEL = {
    json: "JSON", jsonl: "JSON lines", python: "Python", javascript: "JavaScript", typescript: "TypeScript",
    sql: "SQL", yaml: "YAML", toml: "TOML", bash: "Shell", html: "HTML", diff: "Diff", log: "Log",
    traceback: "Traceback", markdown: "Markdown", text: "Text",
  };

  const tidy = (s) => String(s == null ? "" : s).replace(/\r\n?/g, "\n");
  const lineCount = (s) => (s ? s.split("\n").length : 0);
  const nonBlank = (s) => s.split("\n").filter((l) => l.trim());

  function isLong(text) {
    const t = tidy(text).replace(/\s+$/, "");
    return t.length > CARD_CHARS || lineCount(t) > CARD_LINES;
  }

  /* A paste that becomes a card: a long one, or JSON past a couple of
   * lines' worth (minified JSON is one line, and still a wall). */
  const JSON_CARD_CHARS = 200;
  function wantsCard(text) {
    if (isLong(text)) return true;
    const t = tidy(text).trim();
    return t.length >= JSON_CARD_CHARS && !!asJson(t);
  }

  /* ── what a paste is ─────────────────────────────────────────────── */

  function asJson(text) {
    const t = text.trim();
    if (/^[{[]/.test(t) && /[}\]]$/.test(t)) {
      let v;
      try { v = JSON.parse(t); } catch { v = undefined; }
      if (v !== undefined && v !== null && typeof v === "object") {
        const pretty = JSON.stringify(v, null, 2);
        const n = Array.isArray(v) ? v.length : Object.keys(v).length;
        const unit = Array.isArray(v) ? (n === 1 ? "item" : "items") : (n === 1 ? "key" : "keys");
        return {kind: "json", lang: "json", text: pretty.length <= PRETTY_MAX ? pretty : t, detail: `${n} ${unit}`};
      }
    }
    // JSON lines: every line an object
    const lines = nonBlank(t);
    if (lines.length >= 2 && lines.every((l) => /^\s*\{.*\}\s*$/.test(l))) {
      try { lines.forEach((l) => JSON.parse(l)); }
      catch { return null; }
      return {kind: "json", lang: "jsonl", text: t, detail: `${lines.length} records`};
    }
    return null;
  }

  function asTrace(text) {
    if (/^Traceback \(most recent call last\):/m.test(text)
        || (text.match(/^\s+File ".+", line \d+/gm) || []).length >= 2) {
      const last = nonBlank(text).pop() || "";
      return {kind: "log", lang: "traceback", detail: last.trim().slice(0, 80)};
    }
    if ((text.match(/^\s+at\s.+:\d+:\d+\)?\s*$/gm) || []).length >= 3) {
      return {kind: "log", lang: "traceback", detail: (nonBlank(text)[0] || "").trim().slice(0, 80)};
    }
    return null;
  }

  const STAMP = /^\s*\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|^\s*\[?\d{2}:\d{2}:\d{2}[.,]?\d*\]?\s|\b(DEBUG|INFO|WARN|WARNING|ERROR|CRITICAL|FATAL|TRACE)\b/;
  function asLog(text) {
    const lines = nonBlank(text);
    const hits = lines.filter((l) => STAMP.test(l)).length;
    return hits >= 3 && hits / lines.length >= 0.4 ? {kind: "log", lang: "log", detail: ""} : null;
  }

  // simple cues per language: a line counts once for a language
  const CUES = {
    python: [/^\s*(async\s+)?def\s+\w+\s*\(.*\)\s*(->\s*.+)?:\s*$/, /^\s*class\s+\w+(\(.*\))?:\s*$/,
      /^\s*(from\s+[\w.]+\s+)?import\s+[\w.]+/, /^\s*(if|elif|else|for|while|try|except|finally|with)\b.*:\s*$/,
      /^\s*@\w[\w.]*(\(.*\))?\s*$/, /\bself\.\w+/, /^\s*return\b/, /\bprint\(/, /^\s*#\s/],
    javascript: [/^\s*(const|let|var)\s+[\w{[]/, /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/, /=>\s*[{(]?/,
      /^\s*import\s.+\sfrom\s+['"]/, /;\s*$/, /\bconsole\.\w+\(/, /^\s*}\s*[);,]*\s*$/, /^\s*\/\//],
    typescript: [/^\s*(export\s+)?(interface|type|enum)\s+\w+/, /:\s*(string|number|boolean|void|unknown|any)\b/,
      /\bas\s+(const|string|number)\b/, /<\w+(\[\])?>\(/],
    sql: [/^\s*(select|insert\s+into|update|delete\s+from|create\s+(table|index|view)|alter\s+table|drop|with)\b/i,
      /^\s*(from|where|join|left\s+join|inner\s+join|group\s+by|order\s+by|having|limit|values|set)\b/i],
    bash: [/^\s*\$\s+\S/, /^#!.*\b(ba|z)?sh\b/,
      /^\s*(sudo|cd|export|echo|curl|git|docker|pip|uv|npm|npx|make|ls|cat|grep|kubectl|ssh|chmod|mkdir|rm)\s/,
      /\s(&&|\|\|)\s|\s\|\s\w/],
    html: [/^\s*<\/?[a-zA-Z][\w-]*(\s[^>]*)?\/?>/, /^\s*<!(doctype|--)/i],
    diff: [/^diff --git /, /^@@ .* @@/, /^(\+\+\+|---) \S/, /^[+-](?![+-])/],
  };
  const LOOSE = {
    yaml: [/^\s*[\w.-]+:(\s+\S.*)?$/, /^\s*-\s+[\w.-]+:(\s|$)/, /^---\s*$/, /^\s*#/],
    toml: [/^\s*\[\[?[\w.-]+\]\]?\s*$/, /^\s*[\w.-]+\s*=\s*\S/, /^\s*#/],
  };

  function score(lines, cues) {
    let n = 0;
    for (const l of lines) if (cues.some((re) => re.test(l))) n += 1;
    return n;
  }

  function codeLang(text) {
    const lines = nonBlank(text);
    if (!lines.length) return null;
    let best = null, bestN = 0;
    for (const [lang, cues] of Object.entries(CUES)) {
      const n = score(lines, cues);
      if (n > bestN) { best = lang; bestN = n; }
    }
    // a diff is decided by its headers, never by +/- lines alone
    if (best === "diff" && !/^(diff --git |@@ .* @@)/m.test(text)) {
      best = null; bestN = 0;
      for (const [lang, cues] of Object.entries(CUES)) {
        if (lang === "diff") continue;
        const n = score(lines, cues);
        if (n > bestN) { best = lang; bestN = n; }
      }
    }
    if (best && bestN >= 3 && bestN / lines.length >= 0.25) {
      if (best === "javascript" && score(lines, CUES.typescript) >= 2) return "typescript";
      return best;
    }
    if (best === "typescript" && bestN >= 2) return "typescript";
    // YAML and TOML look like prose's "Note: …" lines; they must dominate
    for (const [lang, cues] of Object.entries(LOOSE)) {
      const n = score(lines, cues);
      if (n >= 3 && n / lines.length >= 0.7) return lang;
    }
    return null;
  }

  /* What a paste is: {kind, lang, text, lines, chars, detail}. `text` is
   * what gets sent (JSON pretty-printed); `kind` is json, code, log or text. */
  function classify(raw) {
    const text = tidy(raw).replace(/^\n+/, "").replace(/\s+$/, "");
    const base = {kind: "text", lang: "text", text, detail: ""};
    const got = asJson(text) || asTrace(text) || asLog(text);
    let out;
    if (got) out = {...base, ...got};
    else {
      const lang = codeLang(text);
      if (lang) out = {...base, kind: "code", lang};
      else {
        const md = nonBlank(text).filter((l) => /^#{1,6}\s|^\s*[-*]\s+\S|^\s*\d+[.)]\s+\S/.test(l)).length;
        out = md >= 2 ? {...base, lang: "markdown"} : base;
      }
    }
    out.lines = lineCount(out.text);
    out.chars = out.text.length;
    return out;
  }

  const langLabel = (lang) => LABEL[lang] || (lang ? lang[0].toUpperCase() + lang.slice(1) : "Text");

  // "Pasted · 142 lines · JSON" (a file's card names the file instead)
  function label(block) {
    const n = block.lines != null ? block.lines : lineCount(block.text || "");
    return `${block.name || "Pasted"} · ${n} line${n === 1 ? "" : "s"} · ${langLabel(block.lang)}`;
  }

  /* ── how a message carries blocks ────────────────────────────────── */

  // a fence longer than any backtick run inside, so the body cannot close it
  function fence(body, lang, name) {
    let longest = 0;
    for (const m of String(body).matchAll(/^\s*(`{3,})/gm)) longest = Math.max(longest, m[1].length);
    const f = "`".repeat(Math.max(3, longest + 1));
    const info = [lang || "text", name || ""].filter(Boolean).join(" ");
    return `${f}${info}\n${body}\n${f}`;
  }

  // the blocks first, then the words: a long document ahead of the question
  function compose(text, blocks) {
    const parts = (blocks || []).map((b) => fence(b.text, b.lang, b.name));
    const words = tidy(text).trim();
    if (words) parts.push(words);
    return parts.join("\n\n");
  }

  /* A message as segments: {t: "text", text} and {t: "block", lang, name,
   * text}. An unclosed fence runs to the end (a streaming answer). */
  function split(message) {
    const lines = tidy(message).split("\n");
    const out = [];
    let buf = [];
    const flush = () => {
      const t = buf.join("\n");
      if (t.trim()) out.push({t: "text", text: t.replace(/^\n+|\s+$/g, "")});
      buf = [];
    };
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*(`{3,})([^`]*)$/.exec(lines[i]);
      if (!m) { buf.push(lines[i]); continue; }
      flush();
      const close = new RegExp(`^\\s*\`{${m[1].length},}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      const [lang, ...rest] = m[2].trim().split(/\s+/);
      out.push({t: "block", lang: lang || "", name: rest.join(" "), text: body.join("\n")});
    }
    flush();
    return out;
  }

  /* A long run of words that is really a paste (an old message sent before
   * cards): its leading words, then the block. Null when it is prose. */
  function loose(text) {
    if (!isLong(text)) return null;
    const lines = tidy(text).split("\n");
    for (let i = 0; i < Math.min(lines.length, 6); i += 1) {
      if (!/^\s*[{[]/.test(lines[i])) continue;
      const rest = lines.slice(i).join("\n");
      const j = asJson(rest);
      if (j) return {before: lines.slice(0, i).join("\n").trim(), block: {lang: j.lang, name: "", text: rest.trim()}};
    }
    const c = classify(text);
    return c.kind === "text" ? null : {before: "", block: {lang: c.lang, name: "", text: c.text}};
  }

  /* A sent message back into the composer: long blocks become cards
   * again, everything else is words. */
  function unpack(message) {
    const words = [];
    const blocks = [];
    for (const s of split(message)) {
      if (s.t === "block" && isLong(s.text)) {
        blocks.push({lang: s.lang || "text", name: s.name || "", text: s.text,
          lines: lineCount(s.text), chars: s.text.length, kind: kindOf(s.lang)});
      } else if (s.t === "block") words.push(fence(s.text, s.lang, s.name));
      else words.push(s.text);
    }
    return {text: words.join("\n\n"), blocks};
  }

  function kindOf(lang) {
    if (lang === "json" || lang === "jsonl") return "json";
    if (lang === "log" || lang === "traceback") return "log";
    if (!lang || lang === "text" || lang === "markdown") return "text";
    return "code";
  }

  /* One line for a title or a queue: the words, else what was pasted. */
  function gist(message) {
    const segs = split(message);
    const words = segs.filter((s) => s.t === "text").map((s) => s.text).join("\n").trim();
    if (words) return words;
    const b = segs.find((s) => s.t === "block");
    if (!b) return "";
    const n = lineCount(b.text);
    return `${b.name || "Pasted " + langLabel(b.lang || "text")} · ${n} line${n === 1 ? "" : "s"}`;
  }

  const api = {classify, isLong, wantsCard, label, langLabel, fence, compose, split, loose, unpack, gist, kindOf,
    LABEL, CARD_LINES, CARD_CHARS};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Paste = api;
})(typeof window !== "undefined" ? window : globalThis);
