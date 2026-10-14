/* operonx studio — an execution's input and output, read like a document.
 *
 * The inspector's value zones answered "what keys, what values". For an
 * LLM call that is the wrong question: the reader wants the CONVERSATION
 * that went to the model and the reply that came back. So:
 *
 *   - an LLM op's input is shown as chat messages, role by role. A
 *     `messages=` call recorded them; a `prompt=` call recorded only the
 *     template and its variables, so the messages are rendered here with
 *     the exact rule LLMOp uses (`str.format_map`, one pass) and marked
 *     as rendered. Variables that were not recorded stay as `{name}`
 *     chips — never guessed.
 *   - an LLM op's output is the assistant's reply: the text (JSON pretty
 *     printed), its tool calls, its thinking, and one line of facts —
 *     model, tokens, cost, why it stopped. Whatever else the op returned
 *     (a parsed `intent`) follows as fields.
 *   - every other value: strings as readable text (JSON in a string is
 *     pretty printed, fenced code is a code block, long text folds with
 *     its line count), dicts as labelled fields, media as players.
 *   - one switch per panel: Formatted, or the raw JSON as a tree.
 *
 * Split like values.js: the pure layer (format, repr, chatOf, replyOf,
 * parse helpers) runs under `node --test`; the DOM layer only in the page.
 */

(function (global) {
  "use strict";

  // LLMOp's knobs (operonx/providers/ops/llm.py _LLM_PARAM_KEYS): never
  // template variables
  const KNOBS = ["prompt", "messages", "temperature", "max_tokens", "tools", "tool_choice",
    "response_format", "top_p", "stop", "frequency_penalty", "presence_penalty", "seed",
    "logprobs", "top_logprobs", "n", "user"];
  const KNOB = new Set(KNOBS);
  const ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);

  /* ── Python's str() and repr() of a JSON value ─────────────────────── */

  function pyQuote(s) {
    const q = s.includes("'") && !s.includes('"') ? '"' : "'";
    let out = q;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (ch === q) out += "\\" + q;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
      else out += ch;
    }
    return out + q;
  }

  function pyNum(v) {
    if (Number.isInteger(v)) return String(v);
    if (!Number.isFinite(v)) return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
    return String(v).replace(/e\+?/, "e+").replace("e+-", "e-");
  }

  // `approx` collects why the text may differ from what Python printed
  function pyRepr(v, approx) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return pyNum(v);
    if (typeof v === "string") return pyQuote(v);
    if (Array.isArray(v)) return "[" + v.map((x) => pyRepr(x, approx)).join(", ") + "]";
    if (typeof v === "object") {
      if ("$unserializable" in v) {
        if (approx) approx.add(`a ${v.$unserializable} was not recorded`);
        return `<${v.$unserializable}>`;
      }
      if ("$media" in v) {
        if (approx) approx.add("media are shown as tokens");
        return `<media ${v.mime || ""}>`.replace(" >", ">");
      }
      return "{" + Object.entries(v).map(([k, x]) => `${pyQuote(k)}: ${pyRepr(x, approx)}`).join(", ") + "}";
    }
    return String(v);
  }

  function pyStr(v, approx) {
    if (typeof v === "string") return v;
    return pyRepr(v, approx);
  }

  /* ── str.format_map, one pass, on recorded variables ──────────────────
   * Returns {parts: [{t: "text"|"var"|"missing", text, name}], text,
   * missing: [names], approx: [reasons]}. A field the recording cannot
   * answer stays visible as its own placeholder. */
  function pyFormat(tpl, vars) {
    const parts = [];
    const missing = [];
    const approx = new Set();
    const push = (t, text, name) => {
      const last = parts[parts.length - 1];
      if (t === "text" && last && last.t === "text") last.text += text;
      else parts.push(name ? { t, text, name } : { t, text });
    };
    let i = 0;
    while (i < tpl.length) {
      const ch = tpl[i];
      if (ch === "{" && tpl[i + 1] === "{") { push("text", "{"); i += 2; continue; }
      if (ch === "}" && tpl[i + 1] === "}") { push("text", "}"); i += 2; continue; }
      if (ch !== "{") { push("text", ch); i += 1; continue; }
      // a replacement field: {name(.attr|[key])*(!conv)?(:spec)?}
      let depth = 1, j = i + 1;
      while (j < tpl.length && depth) {
        if (tpl[j] === "{") depth++;
        else if (tpl[j] === "}") depth--;
        j++;
      }
      if (depth) { push("text", tpl.slice(i)); approx.add("an unclosed { in the template"); break; }
      const field = tpl.slice(i + 1, j - 1);
      const m = /^([^.[!:]*)((?:\.[^.[!:]+|\[[^\]]*\])*)(?:!([rsa]))?(?::(.*))?$/s.exec(field);
      const raw = `{${field}}`;
      if (!m || !m[1]) { push("missing", raw, field); missing.push(field); i = j; continue; }
      const name = m[1];
      if (!(name in vars)) { push("missing", raw, name); missing.push(name); i = j; continue; }
      let val = vars[name], ok = true;
      for (const step of m[2].match(/\.[^.[]+|\[[^\]]*\]/g) || []) {
        const key = step[0] === "." ? step.slice(1) : step.slice(1, -1);
        if (val && typeof val === "object" && key in val) val = val[/^\d+$/.test(key) && Array.isArray(val) ? Number(key) : key];
        else { ok = false; break; }
      }
      if (!ok || (val && typeof val === "object" && "$unserializable" in val)) {
        push("missing", raw, name); missing.push(name); i = j; continue;
      }
      if (m[4]) approx.add(`format spec :${m[4]} not applied`);
      const text = m[3] === "r" || m[3] === "a" ? pyRepr(val, approx) : pyStr(val, approx);
      push("var", text, name);
      i = j;
    }
    return { parts, text: parts.map((p) => p.text).join(""), missing, approx: [...approx] };
  }

  function templateVars(inputs) {
    const vars = {};
    for (const [k, v] of Object.entries(inputs || {})) if (!KNOB.has(k)) vars[k] = v;
    return vars;
  }

  function isMessage(m) {
    return m && typeof m === "object" && !Array.isArray(m) && typeof m.role === "string"
      && (ROLES.has(m.role) || "content" in m);
  }

  /* An LLM call's conversation, or null when the input is not one.
   * {messages, source: "recorded"|"rendered", missing, approx, used,
   *  template, knobs, extra} — `used` are the variables the template
   * consumed, `extra` the inputs that are neither knob nor variable.
   *
   * Recorded messages win. operonx records the request it sent
   * (`messages`) beside the template and its variables, so the template
   * is kept for its fold and only read for which variables it used; an
   * older trace has the template alone and is rendered here. */
  function chatOf(inputs) {
    if (!inputs || typeof inputs !== "object") return null;
    const knobs = {};
    for (const k of KNOBS) if (k in inputs && k !== "prompt" && k !== "messages") knobs[k] = inputs[k];
    const tpl = inputs.prompt;
    const isTpl = typeof tpl === "string"
      || (tpl && typeof tpl === "object" && !Array.isArray(tpl) && ("system" in tpl || "user" in tpl)
          && Object.values(tpl).every((x) => typeof x === "string"));
    const vars = templateVars(inputs);
    const msgs = inputs.messages;
    if (Array.isArray(msgs) && msgs.length && msgs.every(isMessage)) {
      const names = new Set();
      if (isTpl) {
        for (const s of typeof tpl === "string" ? [tpl] : Object.values(tpl))
          for (const p of pyFormat(s, vars).parts) if (p.t === "var") names.add(p.name);
      }
      const used = {}, extra = {};
      for (const [k, v] of Object.entries(vars)) (names.has(k) ? used : extra)[k] = v;
      return { messages: msgs, source: "recorded", missing: [], approx: [], used,
               template: isTpl ? tpl : null, knobs, extra };
    }
    if (!isTpl) return null;
    const used = new Set();
    const missing = new Set();
    const approx = new Set();
    const render = (role, s) => {
      const f = pyFormat(s, vars);
      for (const p of f.parts) if (p.t === "var") used.add(p.name);
      f.missing.forEach((x) => missing.add(x));
      f.approx.forEach((x) => approx.add(x));
      return { role, content: f.text, parts: f.parts };
    };
    const messages = typeof tpl === "string" ? [render("user", tpl)]
      : [..."system" in tpl ? [render("system", tpl.system)] : [], ..."user" in tpl ? [render("user", tpl.user)] : []];
    const usedVars = {}, extra = {};
    for (const [k, v] of Object.entries(vars)) (used.has(k) ? usedVars : extra)[k] = v;
    return { messages, source: "rendered", missing: [...missing], approx: [...approx],
             used: usedVars, template: tpl, knobs, extra };
  }

  /* An LLM call's reply, or null. LLMOp's outputs: role, content,
   * tool_calls, finish_reason, model_used, usage, cost_usd, extras —
   * plus whatever the op parsed out (`rest`). */
  const REPLY_KEYS = new Set(["role", "content", "tool_calls", "finish_reason", "model_used",
    "model_requested", "usage", "cost_usd", "extras", "error"]);
  function replyOf(outputs) {
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
    const looks = outputs.role === "assistant" || ("content" in outputs && ("usage" in outputs || "finish_reason" in outputs));
    if (!looks) return null;
    const ex = outputs.extras && typeof outputs.extras === "object" ? outputs.extras : {};
    const rest = {};
    for (const [k, v] of Object.entries(outputs)) {
      if (REPLY_KEYS.has(k) || k.startsWith("_")) continue;
      rest[k] = v;
    }
    return {
      content: outputs.content,
      tool_calls: Array.isArray(outputs.tool_calls) ? outputs.tool_calls : [],
      finish_reason: outputs.finish_reason || null,
      model: outputs.model_used || null,
      requested: outputs.model_requested || null,
      usage: outputs.usage && typeof outputs.usage === "object" ? outputs.usage : null,
      cost: typeof outputs.cost_usd === "number" ? outputs.cost_usd : null,
      priced: "cost_usd" in outputs,
      thinking: ex.thinking_content || null,
      refusal: ex.refusal || null,
      error: outputs.error || null,
      rest,
    };
  }

  /* One tool call, whatever shape it came in: {id, name, args}.
   * OpenAI: {id, function: {name, arguments: "<JSON text>"}}; operonx's
   * agents: {id, name, args: {...}}; Anthropic: {id, name, input: {...}}.
   * Arguments that are not JSON stay text; none at all is null. */
  function toolCallOf(tc) {
    const t = tc && typeof tc === "object" ? tc : {};
    const fn = t.function && typeof t.function === "object" ? t.function : {};
    let args = "arguments" in fn ? fn.arguments
      : "args" in t ? t.args : "input" in t ? t.input : "arguments" in t ? t.arguments : null;
    if (typeof args === "string") { const p = jsonish(args); if (p !== undefined) args = p; }
    return { id: t.id || null, name: fn.name || t.name || null, args: args === undefined ? null : args };
  }

  /* A string that is really JSON (a model's structured reply, a payload
   * someone stringified), unwrapped from a ```json fence if it wore one. */
  function jsonish(s) {
    if (typeof s !== "string") return undefined;
    let t = s.trim();
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
    if (fence) t = fence[1].trim();
    if (!(t.startsWith("{") && t.endsWith("}")) && !(t.startsWith("[") && t.endsWith("]"))) return undefined;
    if (t.length > 2_000_000) return undefined;
    try {
      const v = JSON.parse(t);
      return v && typeof v === "object" ? v : undefined;
    } catch { return undefined; }
  }

  /* Text split at its ``` fences: [{t: "text"|"code", text, lang}]. */
  function segments(s) {
    const out = [];
    const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
    let at = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > at) out.push({ t: "text", text: s.slice(at, m.index) });
      out.push({ t: "code", lang: m[1] || "", text: m[2].replace(/\n$/, "") });
      at = re.lastIndex;
    }
    if (at < s.length) out.push({ t: "text", text: s.slice(at) });
    return out;
  }

  // OpenAI content: a string, or blocks [{type: "text"|"image_url"|…}]
  function contentParts(content) {
    if (content === null || content === undefined) return [];
    if (typeof content === "string") return [{ t: "text", text: content }];
    if (!Array.isArray(content)) return [{ t: "value", value: content }];
    return content.map((b) => {
      if (b && typeof b === "object") {
        if (b.type === "text" && typeof b.text === "string") return { t: "text", text: b.text };
        if ("$media" in b) return { t: "media", value: b };
        if (b.type === "image_url") {
          const u = b.image_url && typeof b.image_url === "object" ? b.image_url.url : b.image_url;
          if (u && typeof u === "object" && "$media" in u) return { t: "media", value: u };
          return { t: "image", url: typeof u === "string" ? u : "" };
        }
        if (b.type === "input_audio" && b.input_audio && typeof b.input_audio === "object" && "$media" in b.input_audio)
          return { t: "media", value: b.input_audio };
      }
      return { t: "value", value: b };
    });
  }

  /* What a message's body shows. An assistant turn that only calls
   * tools has empty content ("" or null) — nothing to show above the
   * calls. Without calls, empty content is shown: a reply that said
   * nothing is worth seeing. */
  function messageParts(m) {
    const calls = Array.isArray(m && m.tool_calls) && m.tool_calls.length > 0;
    if (calls && (m.content === "" || m.content === null || m.content === undefined)) return [];
    return contentParts(m ? m.content : null);
  }

  function lineCount(s) {
    let n = 1;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  }

  /* ── what a field list leads with, folds and compares ──────────────── */

  const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v)
    && !("$media" in v) && !("$media_ref" in v) && !("$unserializable" in v);

  // nothing to read: "", null, {} and [] — false and 0 are values
  function isEmpty(v) {
    if (v === null || v === undefined || v === "") return true;
    if (Array.isArray(v)) return v.length === 0;
    return isPlain(v) && Object.keys(v).length === 0;
  }

  // a value that fits on its name's line
  function isSimple(v) {
    if (v === null || v === undefined || typeof v === "boolean" || typeof v === "number") return true;
    if (typeof v === "string") return v.length <= 80 && !v.includes("\n") && jsonish(v) === undefined;
    if (Array.isArray(v)) return v.length > 0 && v.every((x) => x === null || ["number", "boolean"].includes(typeof x)
      || (typeof x === "string" && x.length < 40)) && JSON.stringify(v).length <= 80;
    return false;
  }

  const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

  /* The fields an object changed between its input and its output: the
   * changed ones (new, gone or different) and the rest, in the output's
   * order with any dropped key last. `$type` is the object's name, not a
   * field. */
  function changes(before, after) {
    const changed = [], unchanged = [];
    const keys = [...new Set([...Object.keys(after || {}), ...Object.keys(before || {})])].filter((k) => k !== "$type");
    for (const k of keys) (sameValue((before || {})[k], (after || {})[k]) ? unchanged : changed).push(k);
    return { changed, unchanged };
  }

  /* An object whose every field repeats a sibling of the same name (an
   * op's `result` beside the outputs it bundles): those names, else null. */
  function repeats(obj, siblings, selfKey) {
    if (!isPlain(obj) || !siblings) return null;
    const ks = Object.keys(obj).filter((k) => k !== "$type");
    if (ks.length < 2) return null;
    for (const k of ks) {
      if (k === selfKey || !(k in siblings) || !sameValue(obj[k], siblings[k])) return null;
    }
    return ks;
  }

  // a value in a few characters, for a one-line preview
  function brief(v, max) {
    max = max || 32;
    if (v === undefined) return "—";
    if (v === null) return "null";
    if (typeof v === "string") {
      if (v === "") return '""';
      const one = v.replace(/\s+/g, " ").trim();
      return one.length > max ? one.slice(0, max - 1) + "…" : one;
    }
    if (typeof v !== "object") return String(v);
    if ("$media" in v || "$media_ref" in v) return `[${v.mime || "media"}]`;
    if (Array.isArray(v)) return v.length ? `[${v.length}]` : "[]";
    const n = Object.keys(v).filter((k) => k !== "$type").length;
    return v.$type ? String(v.$type) : n ? `{${n}}` : "{}";
  }

  /* An object or list in one line: its type and count, then its first
   * fields that say something (empty ones skipped). */
  function preview(v, width) {
    width = width || 140;
    const parts = [];
    if (Array.isArray(v)) {
      parts.push(`${v.length} ${v.length === 1 ? "item" : "items"}`);
      if (v.length && v.every(isMessage)) {
        const last = v[v.length - 1];
        const text = typeof last.content === "string" ? last.content : "";
        parts[0] = `${v.length} ${v.length === 1 ? "message" : "messages"}`;
        parts.push(`last ${last.role || "message"}: ${brief(text, 60)}`);
      } else if (v.length) parts.push(brief(v[0], 48));
      return parts.join(" · ");
    }
    const keys = Object.keys(v).filter((k) => k !== "$type");
    parts.push(v.$type ? String(v.$type) : `${keys.length} ${keys.length === 1 ? "field" : "fields"}`);
    let len = parts[0].length;
    for (const k of keys) {
      if (isEmpty(v[k])) continue;
      const s = `${k} ${brief(v[k])}`;
      if (len + s.length > width) { parts.push("…"); break; }
      parts.push(s);
      len += s.length + 3;
    }
    return parts.join(" · ");
  }

  /* An object passed through an op, said as its change: "3 changed ·
   * current_state REMINDER → FINISH · …", or "unchanged". */
  function changeSummary(before, after, width) {
    width = width || 140;
    const { changed } = changes(before, after);
    if (!changed.length) return "unchanged";
    const parts = [`${changed.length} changed`];
    let len = parts[0].length;
    for (const k of changed) {
      const s = `${k} ${brief(before[k], 18)} → ${brief(after[k], 24)}`;
      if (len + s.length > width) { parts.push("…"); break; }
      parts.push(s);
      len += s.length + 3;
    }
    return parts.join(" · ");
  }

  /* ── DOM (browser only) ─────────────────────────────────────────────── */

  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  const fmtSize = (n) => (n < 1024 ? `${n} chars` : n < 1048576 ? `${(n / 1024).toFixed(1)}k chars` : `${(n / 1048576).toFixed(1)}M chars`);
  const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

  function copyBtn(get, label) {
    const b = h("button", "iocopy", label || "Copy");
    b.type = "button";
    b.title = "Copy to the clipboard";
    b.onclick = (ev) => {
      ev.stopPropagation();
      const v = get();
      const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      Promise.resolve().then(() => navigator.clipboard.writeText(text))
        .then(() => { b.textContent = "Copied"; }, () => { b.textContent = "Can't copy"; })
        .finally(() => setTimeout(() => { b.textContent = label || "Copy"; }, 1100));
    };
    return b;
  }

  /* text that can be long: clamped to `lines` with a fade and a button
   * naming what is hidden; the button opens it in place */
  function clampBox(node, text, lines) {
    const n = lineCount(text);
    if (n <= lines + 2 && text.length <= lines * 160) return node;
    const box = h("div", "ioclamp");
    box.style.setProperty("--lines", String(lines));
    box.append(node);
    const more = h("button", "iomore", `Show all · ${n} lines · ${fmtSize(text.length)}`);
    more.type = "button";
    more.onclick = () => {
      const open = box.classList.toggle("open");
      more.textContent = open ? "Show less" : `Show all · ${n} lines · ${fmtSize(text.length)}`;
    };
    const wrap = h("div", "ioclampwrap");
    wrap.append(box, more);
    return wrap;
  }

  /* JSON, pretty and coloured, as a tree whose objects fold. Spans, not
   * <details>: a fold must sit inline after its key, with its comma */
  function jsonNode(v, depth, openDepth, comma) {
    const tail = comma ? h("span", "jn-punc", ",") : null;
    const leaf = (n) => { if (tail) { const w = h("span"); w.append(n, tail); return w; } return n; };
    if (v === null || v === undefined) return leaf(h("span", "jn-null", "null"));
    if (typeof v === "boolean") return leaf(h("span", "jn-bool", String(v)));
    if (typeof v === "number") return leaf(h("span", "jn-num", String(v)));
    if (typeof v === "string") {
      const s = JSON.stringify(v);
      if (s.length <= 400) return leaf(h("span", "jn-str", s));
      const w = h("span", "jn-str");
      w.append(s.slice(0, 200) + "…\" ");
      const more = h("button", "jn-more", `+${fmtSize(v.length - 200)}`);
      more.type = "button";
      more.onclick = () => { w.textContent = s; };
      w.append(more);
      return leaf(w);
    }
    const arr = Array.isArray(v);
    const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
    const [o, c] = arr ? ["[", "]"] : ["{", "}"];
    if (!entries.length) return leaf(h("span", "jn-punc", o + c));
    const node = h("span", "jn" + (depth < openDepth ? " open" : ""));
    const tog = h("button", "jn-tog", o);
    tog.type = "button";
    tog.setAttribute("aria-expanded", String(depth < openDepth));
    const fold = h("span", "jn-fold", ` ${entries.length} ${arr ? (entries.length === 1 ? "item" : "items") : (entries.length === 1 ? "key" : "keys")} ${c}`);
    tog.onclick = () => {
      const open = node.classList.toggle("open");
      tog.setAttribute("aria-expanded", String(open));
    };
    fold.onclick = tog.onclick;
    const body = h("div", "jn-body");
    entries.forEach(([k, x], i) => {
      const row = h("div", "jn-row");
      row.dataset.k = String(k);
      if (arr) row.dataset.arr = "1";
      if (!arr) {
        const key = h("span", "jn-key", JSON.stringify(k));
        copiesPath(key);
        row.append(key, h("span", "jn-punc", ": "));
      }
      row.append(jsonNode(x, depth + 1, openDepth, i < entries.length - 1));
      body.append(row);
    });
    const close = h("span", "jn-punc jn-close", c);
    node.append(tog, fold, body, close);
    if (tail) node.append(tail);
    return node;
  }

  function jsonView(v, openDepth) {
    const box = h("div", "iojson mono");
    box.append(jsonNode(v, 0, openDepth === undefined ? 3 : openDepth));
    return box;
  }

  /* a string, read as what it is: JSON, code, or prose */
  function textView(s, opts) {
    opts = opts || {};
    if (s === "") return h("span", "ioempty", "empty string");
    const parsed = jsonish(s);
    if (parsed !== undefined) {
      const box = h("div", "iotext-json");
      box.append(jsonView(parsed, 4));
      return box;
    }
    const segs = segments(s);
    const box = h("div", "iotext");
    for (const g of segs) {
      if (g.t === "code") {
        const pre = h("pre", "iocode mono");
        if (g.lang) pre.dataset.lang = g.lang;
        pre.textContent = g.text;
        box.append(pre);
      } else box.append(document.createTextNode(g.text));
    }
    return clampBox(box, s, opts.lines || 18);
  }

  /* a template's rendered text: variables marked, unrecorded ones chips */
  function partsView(parts, text, lines) {
    const box = h("div", "iotext");
    for (const p of parts) {
      if (p.t === "text") box.append(document.createTextNode(p.text));
      else if (p.t === "var" && p.text.length > 160) box.append(document.createTextNode(p.text));
      else if (p.t === "var") {
        const s = h("span", "iovar", p.text);
        s.title = `{${p.name}}`;
        box.append(s);
      } else {
        const s = h("span", "iomissing", p.text);
        s.title = `{${p.name}} was not recorded — the model saw its value, the trace did not keep it`;
        box.append(s);
      }
    }
    return clampBox(box, text, lines);
  }

  function mediaView(v) {
    const m = global.Values && global.Values.media ? global.Values.media(v) : null;
    return m || h("span", "iotoken", `media ${v.mime || ""}`.trim());
  }

  /* any value, formatted: scalars plain, strings as text, dicts as
   * labelled fields, arrays as numbered fields */
  function valueView(v, depth, ctx) {
    depth = depth || 0;
    ctx = ctx || { path: "" };
    if (v === null || v === undefined) return h("span", "ionull", "null");
    if (typeof v === "boolean" || typeof v === "number") return h("span", "ioscalar mono", String(v));
    if (typeof v === "string") return textView(v, { lines: depth ? 10 : 18 });
    if (typeof v === "object" && !Array.isArray(v)) {
      if ("$unserializable" in v) return h("span", "iotoken", `not recorded · ${v.$unserializable}`);
      if ("$media" in v || "$media_ref" in v) return mediaView(v);
    }
    if (Array.isArray(v) && v.length && v.every(isMessage)) return chatList(v.map((m) => ({ ...m })));
    if (depth >= 6) return jsonView(v, 1);
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
    if (!entries.length) return h("span", "ioempty", Array.isArray(v) ? "empty list" : "empty object");
    if (Array.isArray(v) && v.every((x) => x === null || ["number", "boolean"].includes(typeof x)
        || (typeof x === "string" && x.length < 40)) && JSON.stringify(v).length < 160)
      return h("span", "ioscalar mono", JSON.stringify(v));
    // a list of short words (labels, enum values): chips that wrap
    if (Array.isArray(v) && v.length <= 300 && v.every((x) => typeof x === "string" && x.length <= 80 && !x.includes("\n"))) {
      const box = h("div", "iochips");
      for (const x of v) box.append(h("span", "iochip mono", x));
      return box;
    }
    // a list of flat records with the same few fields: a table
    const cols = tableOf(v);
    if (cols) return tableView(v, cols);
    // a record's name is its fold's preview; inside, it is noise
    const shown = isPlain(v) && v.$type && depth > 0 ? entries.filter(([k]) => k !== "$type") : entries;
    return fieldList(shown.slice(0, 200), { ...ctx, depth, more: shown.length > 200 ? shown.length - 200 : 0,
      arr: Array.isArray(v) });
  }

  /* The columns of a list that reads best as a table — 2 to 200 records,
   * every value a scalar, at most 8 fields between them — else null. */
  function tableOf(v) {
    if (!Array.isArray(v) || v.length < 2 || v.length > 200) return null;
    const cols = [];
    for (const row of v) {
      if (!row || typeof row !== "object" || Array.isArray(row) || "$media" in row) return null;
      for (const [k, x] of Object.entries(row)) {
        if (x !== null && typeof x === "object") return null;
        if (!cols.includes(k)) cols.push(k);
      }
    }
    return cols.length && cols.length <= 8 ? cols : null;
  }

  function tableView(v, cols) {
    const wrap = h("div", "iotablewrap");
    const t = h("table", "iotable");
    const hr = h("tr");
    for (const c of cols) hr.append(h("th", "mono", c));
    const head = h("thead"); head.append(hr); t.append(head);
    const body = h("tbody");
    for (const row of v) {
      const tr = h("tr");
      for (const c of cols) {
        const x = row[c];
        tr.append(h("td", typeof x === "string" ? "" : "mono num", x === undefined ? "" : x === null ? "null" : String(x)));
      }
      body.append(tr);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }

  /* A key copies its path when clicked: `.audio.mime`, `.messages[2].content`
   * — built from the keys above it (each carries its own in `data-k`). */
  function pathOf(keyEl) {
    const parts = [];
    for (let n = keyEl.closest("[data-k]"); n; n = n.parentElement && n.parentElement.closest("[data-k]")) {
      const k = n.dataset.k;
      parts.unshift(/^\d+$/.test(k) && n.dataset.arr === "1" ? `[${k}]` : /^[A-Za-z_]\w*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);
    }
    return parts.join("") || ".";
  }

  function copiesPath(keyEl) {
    keyEl.setAttribute("role", "button");
    keyEl.tabIndex = 0;
    keyEl.classList.add("copypath");
    const copy = (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      const path = pathOf(keyEl);
      Promise.resolve().then(() => navigator.clipboard.writeText(path))
        .then(() => { keyEl.classList.add("copied"); keyEl.title = `Copied ${path}`; }, () => {})
        .finally(() => setTimeout(() => keyEl.classList.remove("copied"), 900));
    };
    keyEl.onclick = copy;
    keyEl.onkeydown = (ev) => { if (ev.key === "Enter") copy(ev); };
    keyEl.onmouseenter = () => { keyEl.title = `Copy the path ${pathOf(keyEl)}`; };
  }

  /* What the reader opened or closed, by side and path, for the session:
   * stepping to the op's next run keeps the same things open. */
  const OPEN = new Map();
  const openKey = (ctx, path) => `${ctx.side || "v"}${path}`;

  // a nested value that folds behind a one-line preview
  function foldable(v, depth) {
    if (!v || typeof v !== "object" || isSimple(v) || isEmpty(v)) return false;
    if (!Array.isArray(v) && !isPlain(v)) return false;
    // a top-level conversation is read, not peeked at
    if (Array.isArray(v) && v.every(isMessage)) return depth > 0;
    return true;
  }

  // small enough to be open from the start: a few one-line fields
  const small = (v) => isPlain(v) && Object.keys(v).filter((k) => k !== "$type").length <= 4
    && Object.entries(v).every(([k, x]) => k === "$type" || isSimple(x));

  /* A field that folds: its name and a preview on one line, its value
   * drawn on first open. `body` makes the value; `open` is the default. */
  function foldRow(row, name, summary, body, open, ctx, path, openSummary) {
    row.classList.add("iofoldrow");
    const key = openKey(ctx, path);
    let isOpen = OPEN.has(key) ? OPEN.get(key) : !!open;
    const head = h("div", "iofhead");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const sum = h("span", "iofsum", summary);
    sum.title = summary;
    head.append(name, sum);
    const slot = h("div", "iofbody");
    let drawn = false;
    const paint = () => {
      row.classList.toggle("open", isOpen);
      head.setAttribute("aria-expanded", String(isOpen));
      // open, the rows below say it: the line keeps only its count
      sum.textContent = isOpen && openSummary ? openSummary : summary;
      if (isOpen && !drawn) { slot.append(body()); drawn = true; }
    };
    const flip = (ev) => {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      isOpen = !isOpen;
      OPEN.set(key, isOpen);
      paint();
    };
    head.onclick = flip;
    head.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") flip(ev); };
    row.append(head, slot);
    paint();
    return row;
  }

  // a field's name, free to wrap after its underscores and nowhere else
  function keyName(k) {
    const name = h("div", "iofname mono");
    String(k).split(/(?<=_)/).forEach((part, i) => {
      if (i) name.append(document.createElement("wbr"));
      name.append(part);
    });
    return name;
  }

  function nameOf(k, ctx) {
    const name = keyName(k);
    if (ctx.focus && ctx.focus.includes(k)) {
      name.classList.add("focus");
      name.title = "One of the op's show keys — what its row in the steps shows";
    }
    if (ctx.badges && ctx.badges[k]) {
      const b = h("span", "iobadge", ctx.badges[k][0]);
      b.title = ctx.badges[k][1] || "";
      name.append(b);
    }
    return name;
  }

  /* One field. A value that fits sits beside its name; an object folds
   * behind a preview; an output object that was also an input reads as
   * its change; one that repeats its siblings folds away. */
  function fieldRow(k, x, ctx) {
    const depth = ctx.depth || 0;
    const path = `${ctx.path || ""}.${k}`;
    const row = h("div", "iofield");
    row.dataset.k = String(k);
    row.style.setProperty("--d", String(depth));
    if (ctx.arr) row.dataset.arr = "1";
    const name = nameOf(k, ctx);
    const inner = { ...ctx, depth: depth + 1, path, focus: null, badges: null, before: null, siblings: null, arr: false };
    const was = ctx.before && ctx.before[k];
    if (isPlain(x) && isPlain(was)) {
      row.classList.add("iochange");
      const { changed } = changes(was, x);
      if (!changed.length) row.classList.add("same");
      return foldRow(row, name, changeSummary(was, x), () => changeView(was, x, inner), false, ctx, path,
        changed.length ? `${changed.length} changed` : "unchanged");
    }
    const rep = ctx.siblings && repeats(x, ctx.siblings, k);
    if (rep) {
      row.classList.add("repeat");
      return foldRow(row, name, `same as ${rep.join(" · ")}`, () => valueView(x, depth + 1, inner), false, ctx, path);
    }
    if (foldable(x, depth)) {
      return foldRow(row, name, preview(x), () => valueView(x, depth + 1, inner), small(x), ctx, path, preview(x).split(" · ")[0]);
    }
    // JSON sent as text (a prompt's variables, a payload) folds like the object it is
    const parsed = typeof x === "string" ? jsonish(x) : undefined;
    if (parsed && !isEmpty(parsed)) {
      return foldRow(row, name, `${preview(parsed)} · as text`, () => valueView(x, depth + 1, inner), small(parsed), ctx, path);
    }
    copiesPath(name);
    // beside its name; or, when it needs the room (a conversation, a
    // table, a player), under it
    const wide = (Array.isArray(x) && x.length && x.every(isMessage)) || tableOf(x)
      || (x && typeof x === "object" && ("$media" in x || "$media_ref" in x));
    row.classList.add(isSimple(x) || isEmpty(x) ? "inline" : wide ? "block" : "wide");
    row.append(name, valueView(x, depth + 1, inner));
    return row;
  }

  /* A list of fields: the op's show keys first, the ones with nothing to
   * read gathered into one line at the end. */
  function fieldList(entries, ctx) {
    const depth = ctx.depth || 0;
    const box = h("div", "iofields" + (depth ? " nested" : ""));
    let list = entries;
    if (ctx.focus && ctx.focus.length) {
      const f = ctx.focus;
      list = [...entries.filter(([k]) => f.includes(k)), ...entries.filter(([k]) => !f.includes(k))];
    }
    const blank = ctx.arr || list.length < 3 ? [] : list.filter(([k, x]) => isEmpty(x) && !(ctx.before && k in ctx.before));
    const keep = blank.length >= 2 ? list.filter((e) => !blank.includes(e)) : list;
    for (const [k, x] of keep) box.append(fieldRow(k, x, ctx));
    if (blank.length >= 2) box.append(hiddenRows(`${blank.length} empty`, blank.map(([k]) => k).join(" · "),
      () => blank.map(([k, x]) => fieldRow(k, x, ctx)), ctx, `${ctx.path || ""}#empty`));
    if (ctx.more) box.append(h("div", "ioempty", `+ ${ctx.more} more`));
    return box;
  }

  // rows kept behind one quiet line ("4 empty — a · b", "6 unchanged")
  function hiddenRows(label, names, rows, ctx, path) {
    const wrap = h("div", "iohidden");
    wrap.style.setProperty("--d", String(ctx.depth || 0));
    const btn = h("button", "iohidbtn");
    btn.type = "button";
    btn.append(h("span", "iohidlabel", label));
    if (names) {
      const n = h("span", "iohidnames", names);
      n.title = names;
      btn.append(n);
    }
    const slot = h("div", "iofields nested");
    const key = openKey(ctx, path);
    let open = !!OPEN.get(key), drawn = false;
    const paint = () => {
      wrap.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
      if (open && !drawn) { for (const r of rows()) slot.append(r); drawn = true; }
    };
    btn.onclick = () => { open = !open; OPEN.set(key, open); paint(); };
    wrap.append(btn, slot);
    paint();
    return wrap;
  }

  /* An object's change: the changed fields first, each old → new, the
   * rest behind "N unchanged". */
  function changeView(before, after, ctx) {
    const { changed, unchanged } = changes(before, after);
    const box = h("div", "iofields nested");
    for (const k of changed) {
      const row = h("div", "iofield changed");
      row.dataset.k = k;
      row.style.setProperty("--d", String(ctx.depth || 0));
      const name = keyName(k);
      copiesPath(name);
      const a = before[k], b = after[k];
      if ((isSimple(a) || isEmpty(a)) && (isSimple(b) || isEmpty(b))) {
        row.classList.add("inline");
        const val = h("div", "iodelta");
        val.append(h("span", "ioold mono", a === undefined ? "—" : a === "" ? '""' : typeof a === "string" ? a : JSON.stringify(a)),
          h("span", "ioarrow", "→"),
          b === undefined ? h("span", "ioempty", "removed") : valueView(b, (ctx.depth || 0) + 1, { ...ctx, path: `${ctx.path}.${k}` }));
        row.append(name, val);
      } else {
        row.classList.add("wide");
        const val = h("div");
        val.append(h("div", "iowas", `was ${a === undefined ? "absent" : isPlain(a) || Array.isArray(a) ? preview(a, 80) : brief(a, 80)}`),
          valueView(b, (ctx.depth || 0) + 1, { ...ctx, path: `${ctx.path}.${k}` }));
        row.append(name, val);
      }
      box.append(row);
    }
    if (unchanged.length) {
      const rows = () => unchanged.map((k) => fieldRow(k, after[k], { ...ctx, depth: ctx.depth }));
      if (!changed.length) for (const r of rows()) box.append(r);
      else box.append(hiddenRows(`${unchanged.length} unchanged`, unchanged.join(" · "), rows, ctx, `${ctx.path}#same`));
    }
    return box;
  }

  // the old call shape, kept for the chat folds
  function fields(entries, depth, more, badges, arr) {
    return fieldList(entries, { depth, more, badges, arr, path: "" });
  }

  const ROLE_LABEL = { system: "System", developer: "Developer", user: "User", assistant: "Assistant",
    tool: "Tool", function: "Function" };

  function toolCallView(tc) {
    const call = toolCallOf(tc);
    const card = h("div", "iotool");
    const head = h("div", "iotoolhead");
    head.append(h("span", "iotoolname mono", `${call.name || "tool"}()`));
    if (call.id) { const id = h("span", "iotoolid mono", call.id); id.title = call.id; head.append(id); }
    card.append(head);
    const args = call.args;
    if (args === null) card.append(h("span", "ioempty", "no arguments"));
    else card.append(typeof args === "string" ? textView(args, { lines: 10 }) : jsonView(args, 3));
    return card;
  }

  function messageView(m, i) {
    const role = m.role || "message";
    const box = h("div", `iomsg role-${ROLE.has(role) ? role : "other"}`);
    const head = h("div", "iomsghead");
    head.append(h("span", "iorole", ROLE_LABEL[role] || role));
    if (m.name) head.append(h("span", "iomsgname mono", m.name));
    if (m.tool_call_id) {
      const id = h("span", "iomsgname iomsgid mono", `↩ ${m.tool_call_id}`);
      id.title = m.tool_call_id;
      head.append(id);
    }
    const text = typeof m.content === "string" ? m.content : null;
    if (text) head.append(h("span", "iomsgsize", fmtSize(text.length)));
    head.append(copyBtn(() => m.content));
    box.append(head);
    const body = h("div", "iomsgbody");
    const lines = role === "system" ? 8 : 18;
    if (m.parts && text !== null && m.parts.some((p) => p.t !== "text")) body.append(partsView(m.parts, text, lines));
    else {
      const parts = messageParts(m);
      if (!parts.length && !(m.tool_calls || []).length) body.append(h("span", "ioempty", "no content"));
      for (const p of parts) {
        if (p.t === "text") body.append(textView(p.text, { lines }));
        else if (p.t === "media") body.append(mediaView(p.value));
        else if (p.t === "image") {
          if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(p.url) || /^https:\/\//i.test(p.url)) {
            const img = h("img", "ioimg");
            img.loading = "lazy";
            img.alt = "Image sent to the model";
            img.src = p.url;
            body.append(img);
          } else body.append(h("span", "iotoken", "image"));
        } else body.append(valueView(p.value, 1));
      }
    }
    for (const tc of m.tool_calls || []) body.append(toolCallView(tc));
    box.append(body);
    box.dataset.i = String(i);
    return box;
  }
  const ROLE = new Set(Object.keys(ROLE_LABEL));

  function chatList(messages) {
    const list = h("div", "iochat");
    messages.forEach((m, i) => list.append(messageView(m, i)));
    return list;
  }

  function factsLine(r) {
    const line = h("div", "iofacts");
    const add = (k, v, cls) => {
      if (v === null || v === undefined || v === "") return;
      const f = h("span", "iofact" + (cls ? " " + cls : ""));
      f.append(h("span", "iofk", k), h("span", "iofv mono", v));
      line.append(f);
    };
    if (r.model) add("Model", r.model + (r.requested && r.requested !== r.model ? ` (asked ${r.requested})` : ""),
        r.requested && r.requested !== r.model ? "warn" : "");
    const u = r.usage || {};
    if (u.prompt_tokens != null || u.completion_tokens != null) {
      add("Tokens", `${compact(u.prompt_tokens || 0)} in → ${compact(u.completion_tokens || 0)} out`
        + (u.cached_tokens ? ` · ${compact(u.cached_tokens)} cached` : "")
        + (u.reasoning_tokens ? ` · ${compact(u.reasoning_tokens)} reasoning` : ""));
    }
    if (r.priced) add("Cost", r.cost == null ? "unpriced" : r.cost === 0 ? "$0" : r.cost < 0.01 ? `$${r.cost.toFixed(5)}` : `$${r.cost.toFixed(3)}`);
    if (r.finish_reason) add("Stop", r.finish_reason, ["length", "content_filter"].includes(r.finish_reason) ? "warn" : "");
    return line.childNodes.length ? line : null;
  }

  /* ── the cards ──────────────────────────────────────────────────────── */

  /* A card folds from its title, and stays folded as you step from one
   * execution to the next (and across reloads, where storage allows). */
  const FOLDED = new Map();
  const foldedKey = (cls) => `ox:iofold:${cls}`;
  function isFolded(cls) {
    if (FOLDED.has(cls)) return FOLDED.get(cls);
    try { return global.localStorage && global.localStorage.getItem(foldedKey(cls)) === "1"; } catch { return false; }
  }
  function setFolded(cls, on) {
    FOLDED.set(cls, on);
    try { global.localStorage && global.localStorage.setItem(foldedKey(cls), on ? "1" : "0"); } catch { /* private window */ }
  }

  function card(label, cls, raw, body, meta) {
    const c = h("section", `iocard ${cls}`);
    const head = h("div", "iocardhead");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.title = `Fold or open the ${label.toLowerCase()}`;
    head.append(h("span", "iocardlabel", label));
    if (meta) head.append(h("span", "iocardmeta", meta));
    head.append(copyBtn(() => raw, "Copy JSON"));
    const paint = () => {
      const on = isFolded(cls);
      c.classList.toggle("folded", on);
      head.setAttribute("aria-expanded", String(!on));
    };
    const flip = (ev) => { ev.preventDefault(); setFolded(cls, !isFolded(cls)); paint(); };
    head.onclick = flip;
    head.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") flip(ev); };
    c.append(head, body);
    paint();
    return c;
  }

  function inputBody(inputs, mode, badges) {
    if (mode === "json") return jsonView(inputs, 2);
    const chat = chatOf(inputs);
    const side = { side: "in", path: "", depth: 0, badges };
    if (!chat) {
      const entries = Object.entries(inputs || {});
      return entries.length ? fieldList(entries, side) : h("div", "ioempty", "none recorded");
    }
    const box = h("div", "iobody");
    if (chat.source === "rendered") {
      const note = h("div", "ionote");
      note.append("Rendered from the prompt template and its recorded variables");
      if (chat.missing.length) {
        note.classList.add("warn");
        note.append(` — ${chat.missing.length} not recorded: `, h("span", "mono", chat.missing.map((x) => `{${x}}`).join(" ")));
      }
      if (chat.approx.length) note.title = `May differ from what was sent: ${chat.approx.join("; ")}`;
      box.append(note);
    }
    box.append(chatList(chat.messages));
    const knobs = Object.entries(chat.knobs);
    if (knobs.length) {
      const line = h("div", "iofacts");
      for (const [k, v] of knobs) {
        const f = h("span", "iofact");
        f.append(h("span", "iofk", k), h("span", "iofv mono", typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v)));
        line.append(f);
      }
      box.append(line);
    }
    const fold = (title, content, open) => {
      const d = h("details", "iofold");
      d.open = !!open;
      d.append(h("summary", null, title), content);
      box.append(d);
    };
    const used = Object.entries(chat.used);
    if (used.length) fold(`Variables · ${used.length}`, fieldList(used, side));
    if (chat.template) fold("Prompt template", jsonView(chat.template, 2));
    const extra = Object.entries(chat.extra);
    if (extra.length) fold(`Other inputs · ${extra.length}`, fieldList(extra, side));
    return box;
  }

  /* opts: {focus: the op's show keys, before: its inputs — an output
   * object that was also an input reads as its change} */
  function outputBody(outputs, mode, opts) {
    if (mode === "json") return jsonView(outputs, 2);
    opts = opts || {};
    const r = replyOf(outputs);
    const side = { side: "out", path: "", depth: 0 };
    if (!r) {
      const entries = Object.entries(outputs || {});
      if (entries.length === 1 && entries[0][0] === "_") return valueView(entries[0][1], 0, side);
      const before = isPlain(opts.before) ? opts.before : null;
      return entries.length ? fieldList(entries, { ...side, focus: opts.focus, before, siblings: outputs })
        : h("div", "ioempty", "none recorded");
    }
    const box = h("div", "iobody");
    if (r.error) box.append(h("div", "ionote bad", String(r.error)));
    if (r.refusal) box.append(h("div", "ionote warn", `Refused: ${r.refusal}`));
    if (r.thinking) {
      const d = h("details", "iofold");
      d.append(h("summary", null, `Thinking · ${fmtSize(String(r.thinking).length)}`), textView(String(r.thinking), { lines: 30 }));
      box.append(d);
    }
    box.append(chatList([{ role: "assistant", content: r.content, tool_calls: r.tool_calls }]));
    const facts = factsLine(r);
    if (facts) box.append(facts);
    // what only repeats the reply (`full_content`) waits behind one line
    const said = (x) => typeof x === "string" && typeof r.content === "string" && x.trim() === r.content.trim();
    const rest = Object.entries(r.rest).filter(([, x]) => !said(x));
    const again = Object.entries(r.rest).filter(([, x]) => said(x));
    if (rest.length || again.length) {
      box.append(h("div", "iosub", "Parsed"));
      if (rest.length) box.append(fieldList(rest, side));
      if (again.length) box.append(hiddenRows("same as the reply", again.map(([k]) => k).join(" · "),
        () => again.map(([k, x]) => fieldRow(k, x, side)), side, "#said"));
    }
    return box;
  }

  function sizeOf(v) {
    try { return JSON.stringify(v).length; } catch { return 0; }
  }

  /* The whole thing: a Formatted / JSON switch, then the input and
   * output cards. opts: {outputsFirst, badges: {key: [label, title]},
   * hide: [output keys], focus: [the op's show keys], mode, onMode} */
  function panel(inputs, outputs, opts) {
    opts = opts || {};
    const outs = outputs && typeof outputs === "object" && !Array.isArray(outputs) ? { ...outputs } : outputs;
    for (const k of opts.hide || []) if (outs && typeof outs === "object") delete outs[k];
    const wrap = h("div", "iopanel");
    const bar = h("div", "iobar");
    const seg = h("div", "ioseg");
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-label", "How values are shown");
    let mode = opts.mode === "json" ? "json" : "pretty";
    const cards = h("div", "iocards");
    const draw = () => {
      cards.textContent = "";
      const isChat = !!chatOf(inputs);
      const inCard = card("Input", "ioin", inputs, inputBody(inputs || {}, mode, opts.badges),
        inputs ? `${Object.keys(inputs).length} fields · ${fmtSize(sizeOf(inputs))}` : null);
      const outCard = card("Output", "ioout", outputs, outputBody((mode === "json" ? outputs : outs) || {}, mode,
        { focus: opts.focus, before: inputs }),
        outputs ? fmtSize(sizeOf(outputs)) : null);
      // in time order, as Langfuse reads: what came in, then what came out
      // (a caller can still ask for the answer first)
      // one side only: a caller that puts something between them (Inspect:
      // Input, then the op's settings, then Output)
      if (opts.only === "in") cards.append(inCard);
      else if (opts.only === "out") cards.append(outCard);
      else if (opts.outputsFirst && !isChat) cards.append(outCard, inCard);
      else cards.append(inCard, outCard);
    };
    for (const [key, label] of [["pretty", "Formatted"], ["json", "JSON"]]) {
      const b = h("button", key === mode ? "on" : "", label);
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(key === mode));
      b.onclick = () => {
        mode = key;
        for (const x of seg.children) {
          x.classList.toggle("on", x === b);
          x.setAttribute("aria-checked", String(x === b));
        }
        if (opts.onMode) opts.onMode(mode);
        draw();
      };
      seg.append(b);
    }
    bar.append(seg);
    if (opts.tools) for (const t of opts.tools) bar.append(t);
    wrap.append(bar, cards);
    draw();
    return wrap;
  }

  const api = { KNOBS, pyRepr, pyStr, pyFormat, chatOf, replyOf, toolCallOf, messageParts, jsonish, segments, contentParts,
                lineCount, panel, valueView, jsonView, textView, tableOf,
                isEmpty, isSimple, changes, repeats, brief, preview, changeSummary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.IO = api;
})(typeof window !== "undefined" ? window : globalThis);
