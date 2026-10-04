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
      if (!arr) row.append(h("span", "jn-key", JSON.stringify(k)), h("span", "jn-punc", ": "));
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
  function valueView(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return h("span", "ionull", "null");
    if (typeof v === "boolean" || typeof v === "number") return h("span", "ioscalar mono", String(v));
    if (typeof v === "string") return textView(v, { lines: depth ? 10 : 18 });
    if (typeof v === "object" && !Array.isArray(v)) {
      if ("$unserializable" in v) return h("span", "iotoken", `not recorded · ${v.$unserializable}`);
      if ("$media" in v || "$media_ref" in v) return mediaView(v);
    }
    if (Array.isArray(v) && v.length && v.every(isMessage)) return chatList(v.map((m) => ({ ...m })));
    if (depth >= 3) return jsonView(v, 1);
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
    return fields(entries.slice(0, 200), depth, entries.length > 200 ? entries.length - 200 : 0);
  }

  function fields(entries, depth, more, badges) {
    const box = h("div", "iofields" + (depth ? " nested" : ""));
    for (const [k, x] of entries) {
      const row = h("div", "iofield");
      const name = h("div", "iofname mono", k);
      if (badges && badges[k]) {
        const b = h("span", "iobadge", badges[k][0]);
        b.title = badges[k][1] || "";
        name.append(b);
      }
      row.append(name, valueView(x, depth + 1));
      box.append(row);
    }
    if (more) box.append(h("div", "ioempty", `+ ${more} more`));
    return box;
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

  function card(label, cls, raw, body, meta) {
    const c = h("section", `iocard ${cls}`);
    const head = h("div", "iocardhead");
    head.append(h("span", "iocardlabel", label));
    if (meta) head.append(h("span", "iocardmeta", meta));
    head.append(copyBtn(() => raw, "Copy JSON"));
    c.append(head, body);
    return c;
  }

  function inputBody(inputs, mode, badges) {
    if (mode === "json") return jsonView(inputs, 2);
    const chat = chatOf(inputs);
    if (!chat) {
      const entries = Object.entries(inputs || {});
      return entries.length ? fields(entries, 0, 0, badges) : h("div", "ioempty", "none recorded");
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
    if (used.length) fold(`Variables · ${used.length}`, fields(used, 0, 0, badges));
    if (chat.template) fold("Prompt template", jsonView(chat.template, 2));
    const extra = Object.entries(chat.extra);
    if (extra.length) fold(`Other inputs · ${extra.length}`, fields(extra, 0, 0, badges));
    return box;
  }

  function outputBody(outputs, mode) {
    if (mode === "json") return jsonView(outputs, 2);
    const r = replyOf(outputs);
    if (!r) {
      const entries = Object.entries(outputs || {}).filter(([k]) => k !== "_" || true);
      if (entries.length === 1 && entries[0][0] === "_") return valueView(entries[0][1]);
      return entries.length ? fields(entries, 0, 0) : h("div", "ioempty", "none recorded");
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
    const rest = Object.entries(r.rest);
    if (rest.length) {
      box.append(h("div", "iosub", "Parsed"));
      box.append(fields(rest, 0, 0));
    }
    return box;
  }

  function sizeOf(v) {
    try { return JSON.stringify(v).length; } catch { return 0; }
  }

  /* The whole thing: a Formatted / JSON switch, then the input and
   * output cards. opts: {outputsFirst, badges: {key: [label, title]},
   * hide: [output keys], mode, onMode} */
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
      const outCard = card("Output", "ioout", outputs, outputBody((mode === "json" ? outputs : outs) || {}, mode),
        outputs ? fmtSize(sizeOf(outputs)) : null);
      // a conversation reads top-down, its reply last; elsewhere the
      // answer comes first
      if (opts.outputsFirst && !isChat) cards.append(outCard, inCard);
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
                lineCount, panel, valueView, jsonView, textView };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.IO = api;
})(typeof window !== "undefined" ? window : globalThis);
