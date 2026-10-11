// Every screen has an address (static/router.js): what is on screen ↔ the URL.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.location = {pathname: "/p/abc123/flow", search: ""};
const Router = require("../../operonx_studio/static/router.js");

const at = (href) => { const u = new URL(href, "http://x"); return {pathname: u.pathname, search: u.search}; };

test("a run's step is an address, and the address reads back", () => {
  const a = Router.addressOf({tab: "traces", run: "call-1", mode: "tree", exec_id: "g.stt#main.[audio_in:3]"});
  assert.equal(a.path, "/p/abc123/runs/call-1");
  const t = Router.parse(at(a.full));
  assert.deepEqual(t, {tab: "traces", run: "call-1", mode: "tree", step: "g.stt#main.[audio_in:3]", op: null, file: null});
});

test("the workflow view and a flow selection", () => {
  assert.equal(Router.addressOf({tab: "traces", run: "r", mode: "workflow"}).full, "/p/abc123/runs/r?view=workflow");
  assert.equal(Router.addressOf({tab: "flow", node: "synthesize"}).full, "/p/abc123/flow?op=synthesize");
  assert.equal(Router.parse(at("/p/abc123/flow?op=synthesize")).op, "synthesize");
});

test("a screen with nothing in it, and the old ?run= link", () => {
  assert.equal(Router.addressOf({tab: "monitor"}).full, "/p/abc123/monitor");
  assert.equal(Router.parse(at("/p/abc123")).tab, null);
  const old = Router.parse(at("/p/abc123?run=call-9"));
  assert.equal(old.run, "call-9");
});

test("a run id with a slash or a space survives", () => {
  const a = Router.addressOf({tab: "traces", run: "lf:a/b c", mode: "tree"});
  assert.equal(Router.parse(at(a.full)).run, "lf:a/b c");
});

test("a YAML file being edited is an address", () => {
  const a = Router.addressOf({tab: "yaml", file: "src/agents/x/prompts.yaml"});
  assert.equal(a.full, "/p/abc123/yaml?file=src%2Fagents%2Fx%2Fprompts.yaml");
  assert.equal(Router.parse(at(a.full)).file, "src/agents/x/prompts.yaml");
});
