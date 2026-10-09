/* A router's condition, as a tree to draw: which clauses, joined how.
 *
 * operonx writes a route's condition as Python reads it —
 * `(intent == 'reschedule' or retries >= 3) and confidence > 0.5` — with
 * brackets wherever the grouping needs them (since operonx 1.17.9). This
 * reads it back: `and` binds tighter than `or` (and `&` than `|`), a
 * bracket groups, and a bracket right after a name is a call, part of its
 * clause. Quoted text is never split. A run of one operator is one node:
 * `a and b and c` is {op: "&", kids: [a, b, c]}.
 *
 *   parse("a > 1 and (b or c)") → {op: "&", kids: [{text: "a > 1"},
 *                                   {op: "|", kids: [{text: "b"}, {text: "c"}]}]}
 *
 * Pure: tested in node (tests/js/condtree.test.mjs). */
(function (global) {
  "use strict";

  const WORD = {and: "&", or: "|"};

  function tokens(s) {
    const out = [];
    let buf = "", depth = 0, q = null;
    const flush = () => { if (buf.trim()) out.push({t: "atom", v: buf.trim()}); buf = ""; };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { buf += c; if (c === "\\" && i + 1 < s.length) buf += s[++i]; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; buf += c; continue; }
      if (depth) { buf += c; if (c === "(") depth++; else if (c === ")") depth--; continue; }
      if (c === "(" && buf.trim()) { buf += c; depth = 1; continue; }   // a call
      if (c === "(" || c === ")") { flush(); out.push({t: c}); continue; }
      if (c === "&" || c === "|") { flush(); out.push({t: c}); continue; }
      // `and` / `or` as words, between clauses
      const m = /^(and|or)(?=[\s(])/.exec(s.slice(i));
      if (m && (!buf || /\s$/.test(buf))) { flush(); out.push({t: WORD[m[1]]}); i += m[1].length - 1; continue; }
      buf += c;
    }
    flush();
    return out;
  }

  function parse(s) {
    const toks = tokens(String(s == null ? "" : s));
    let i = 0;
    const join = (op, next) => () => {
      const kids = [next()];
      while (toks[i] && toks[i].t === op) { i++; kids.push(next()); }
      return kids.length > 1 ? {op, kids} : kids[0];
    };
    const factor = () => {
      const tk = toks[i++];
      if (!tk) return {text: "?"};
      if (tk.t === "(") {
        const e = expr();
        if (toks[i] && toks[i].t === ")") i++;
        return e;
      }
      if (tk.t === "atom") return {text: tk.v};
      return factor();   // a stray operator: skip it
    };
    const term = join("&", factor);
    const expr = join("|", term);
    const tree = toks.length ? expr() : {text: String(s == null ? "" : s)};
    const flat = (n) => n.op
      ? {op: n.op, kids: n.kids.map(flat).flatMap(k => (k.op === n.op ? k.kids : [k]))}
      : n;
    return flat(tree);
  }

  /* How many bracket levels deep: 0 for one clause. */
  function depth(n) { return n.op ? 1 + Math.max(...n.kids.map(depth)) : 0; }

  /* The clauses, left to right. */
  function leaves(n, out = []) { if (n.op) n.kids.forEach(k => leaves(k, out)); else out.push(n); return out; }

  const api = {parse, depth, leaves};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.CondTree = api;
})(typeof window !== "undefined" ? window : globalThis);
