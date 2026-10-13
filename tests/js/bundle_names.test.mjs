// The project page's scripts share one global scope (one bundle, in
// project.html's order): a top-level function defined twice is silently
// replaced by the later one. `resourceDetail` was — the Resource Hub's
// (body, cat, r, hub) took the place of the canvas's (all, name) lookup,
// and drawing an LLM op's card threw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STATIC = new URL("../../operonx_studio/static/", import.meta.url);

test("no top-level function is defined twice across the project bundle", () => {
  const html = readFileSync(new URL("project.html", STATIC), "utf8");
  const files = [...html.matchAll(/<script src="\/static\/([\w.-]+\.js)"/g)].map((m) => m[1]);
  assert.ok(files.length > 10, "the bundle's files are read from project.html");
  const where = new Map();
  const twice = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, STATIC), "utf8");
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      if (where.has(m[1])) twice.push(`${m[1]}: ${where.get(m[1])} and ${f}`);
      else where.set(m[1], f);
    }
  }
  assert.deepEqual(twice, []);
});
