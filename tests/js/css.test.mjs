// The stylesheets parse: braces balance and every comment closes. A stray
// `}` silently swallows the rules after it (the dark theme's twins included).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../operonx_studio/static/", import.meta.url);
for (const name of readdirSync(dir).filter(f => f.endsWith(".css"))) {
  test(`${name}: braces balance, comments close`, () => {
    const css = readFileSync(new URL(name, dir), "utf8");
    let depth = 0, line = 1;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (ch === "\n") line++;
      if (ch === "/" && css[i + 1] === "*") {
        const end = css.indexOf("*/", i + 2);
        assert.ok(end > 0, `${name}:${line}: a comment never closes`);
        line += (css.slice(i, end).match(/\n/g) || []).length;
        i = end + 1;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") { depth--; assert.ok(depth >= 0, `${name}:${line}: a } with no {`); }
    }
    assert.equal(depth, 0, `${name}: ${depth} { never closed`);
  });
}
