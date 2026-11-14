// What a container says it holds (static/agentsteps.js containerKind), and
// the walk a folded graph's agent list uses (CANVAS_REDESIGN_PLAN C3).
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { containerKind, agentsInside } = require("../../operonx_studio/static/agentsteps.js");

const op = (id, extra = {}) => ({id, name: id.split(".").pop(), kind: "FunctionOp", ...extra});
const agent = (id) => op(id, {kind: "AgentOp", op_type: "agent", agent: {model: "m"}});
const graph = (id, nodes) => op(id, {kind: "GraphOp", graph: {nodes}, subgraph_ops: nodes.length});

// meeting-prep-brd's shape: prepare › {email › agent, web › agent, notes}
const email = graph("prepare.email", [op("prepare.email.task"), agent("prepare.email.email"), op("prepare.email.run"), op("prepare.email.facts")]);
const web = graph("prepare.web", [agent("prepare.web.web"), op("prepare.web.out")]);
const prepare = graph("prepare", [email, web, op("prepare.notes")]);

test("an opened graph counts its agents at any depth and its own ops", () => {
  assert.equal(containerKind(email), "GraphOp · 1 agent · 4 ops");
  assert.equal(containerKind(prepare), "GraphOp · 2 agents · 3 ops");
});

test("a graph with no agent says only its ops; one op is singular", () => {
  assert.equal(containerKind(graph("g", [op("g.a")])), "GraphOp · 1 op");
});

test("the walk keys each agent by its path and does not open an agent", () => {
  const opened = {...agent("prepare.web.web"), graph: {nodes: [agent("turn0")]}};
  const g = {nodes: [email, {...web, graph: {nodes: [opened]}}]};
  assert.deepEqual(agentsInside(g, "root"), [
    {name: "email", key: "root/prepare.email/prepare.email.email"},
    {name: "web", key: "root/prepare.web/prepare.web.web"},
  ]);
});
