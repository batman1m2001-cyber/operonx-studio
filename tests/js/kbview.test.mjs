// The Knowledge pages' pure layer: shaping only — every fact (a quote's span,
// its page and boxes, which sentences are unsupported) is the knowledge base's.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const K = require("../../operonx_studio/static/kbview.js");

test("a normalised box sits on the page image in percentages", () => {
  assert.deepEqual(K.boxStyle([0.1, 0.25, 0.6, 0.3]),
    { left: "10.000%", top: "25.000%", width: "50.000%", height: "5.000%" });
  // a degenerate box is drawn empty, never with a negative size
  assert.equal(K.boxStyle([0.5, 0.5, 0.4, 0.4]).width, "0.000%");
});

test("a citation opens on the page of its first box, with every box it has", () => {
  const regions = [{ page_no: 3, bbox: [0.1, 0.8, 0.9, 0.95] }, { page_no: 4, bbox: [0.1, 0.05, 0.9, 0.2] },
                   { page_no: 3, bbox: [0.5, 0.1, 0.9, 0.2] }];
  const c = { version_id: "ver_1", span: [10, 40], regions };
  assert.deepEqual(K.citationTarget(c), { version: "ver_1", page: 3, span: [10, 40], regions });
  assert.deepEqual(K.boxesOn(regions, 3), [[0.1, 0.8, 0.9, 0.95], [0.5, 0.1, 0.9, 0.2]]);
  assert.deepEqual(K.pagesOf(regions), [3, 4]);
  // a source without pages (HTML, Markdown) opens on its text
  assert.equal(K.citationTarget({ version_id: "v", span: [0, 4], regions: [] }).page, null);
});

test("an answer is cut into its sentences and markers, unsupported ones flagged", () => {
  const text = "Leave is twelve days [1]. It is booked online [1, 2]. Ask HR.";
  const sentences = [[0, 25], [26, 53], [54, 61]];
  const parts = K.answerParts(text, sentences, [2]);
  assert.equal(parts.length, 5);   // three sentences, two spaces between them
  const [first, , second, , third] = parts;
  assert.deepEqual(first.parts, [{ text: "Leave is twelve days " }, { markers: [1], text: "[1]" }, { text: "." }]);
  assert.deepEqual(second.parts[1], { markers: [1, 2], text: "[1, 2]" });
  assert.equal(first.unsupported, false);
  assert.equal(third.unsupported, true);
  assert.deepEqual(third.parts, [{ text: "Ask HR." }]);
  // the drawn text is the answer, character for character
  assert.equal(parts.flatMap(p => p.parts.map(x => x.text)).join(""), text);
});

test("citations are grouped by the marker that names them", () => {
  const by = K.citationsByMarker([{ marker: 2, quote: "a" }, { marker: 1, quote: "b" }, { marker: 2, quote: "c" }]);
  assert.deepEqual([...by.keys()], [2, 1]);
  assert.deepEqual(by.get(2).map(c => c.quote), ["a", "c"]);
});

test("a canonical text in chunk bands, a citation's span marked", () => {
  const text = "# Leave\n\nTwelve days a year.\n\nBook it online.";
  const chunks = [{ chunk_id: "a", spans: [[2, 7], [9, 28]] }, { chunk_id: "b", spans: [[30, 45]] }];
  const bands = K.textBands(text, chunks, [[9, 15]]);
  assert.equal(bands.map(b => b.text).join(""), text);
  const marked = bands.filter(b => b.mark);
  assert.deepEqual(marked.map(b => [b.text, b.chunk]), [["Twelve", "a"]]);
  assert.deepEqual(bands.find(b => b.text === "Book it online.").chunk, "b");
  assert.equal(bands[0].chunk, null);   // "# " is markup: no chunk holds it
});

test("the filter builder reads into a KBFilter, typed by the collection's fields", () => {
  const filterable = { dept: "keyword", year: "int", score: "float", public: "bool", teams: "keyword[]" };
  assert.deepEqual(K.filterOf({ tags: "hr, policy, hr", mime: "", fields: {} }, filterable),
    { filter: { tags_any: ["hr", "policy"] } });
  assert.deepEqual(K.filterOf({ fields: { dept: "sales", year: "2024", public: "TRUE", teams: "a, b" } }, filterable),
    { filter: { fields: { dept: "sales", year: 2024, public: true, teams: ["a", "b"] } } });
  assert.deepEqual(K.filterOf({ fields: { year: "20.5" } }, filterable), { error: "year is a whole number" });
  assert.deepEqual(K.filterOf({ fields: { public: "yes" } }, filterable), { error: "public is true or false" });
  assert.deepEqual(K.filterOf({}, filterable), { filter: null });
  // a field the collection does not declare is not read
  assert.deepEqual(K.filterOf({ fields: { room: "a" } }, filterable), { filter: null });
});

test("a query body: the question, the modes, the answer, the filter", () => {
  assert.deepEqual(K.queryBody({ query: "  leave? ", modes: ["dense", "hybrid"], k: "5", answer: true }, {}),
    { body: { query: "leave?", modes: ["dense", "hybrid"], k: 5, answer: true, rerank: false } });
  assert.equal(K.queryBody({ query: " ", modes: ["dense"] }, {}).error, "Ask something first");
  assert.match(K.queryBody({ query: "q", modes: [] }, {}).error, /at least one retrieval mode/);
  assert.deepEqual(K.queryBody({ query: "q", modes: [], answer: true, tags: "hr" }, {}).body.filter, { tags_any: ["hr"] });
});

test("an eval case rests on verified citations; the answer only when vouched for", () => {
  const answer = { text: "Twelve days [1].", citations: [{ marker: 1, key: "policy.pdf", quote: "twelve days", pages: [4], span: [1, 2] }] };
  assert.deepEqual(K.caseBody("How long is leave?", answer),
    { body: { query: "How long is leave?", citations: [{ key: "policy.pdf", quote: "twelve days", pages: [4] }] } });
  assert.equal(K.caseBody("q", answer, { keepAnswer: true, k: 8 }).body.answer, "Twelve days.");
  assert.equal(K.caseBody("q", answer, { k: 8 }).body.k, 8);
  assert.match(K.caseBody("q", { text: "No idea.", citations: [] }).error, /verified citation/);
});

test("scores and pages as text", () => {
  assert.equal(K.score(0.016393), "0.016");
  assert.equal(K.score(12.3456), "12.35");
  assert.equal(K.score(null), "—");
  assert.equal(K.pagesText([4]), "p. 4");
  assert.equal(K.pagesText([4, 5, 6]), "pp. 4–6");
  assert.equal(K.pagesText([2, 7]), "pp. 2, 7");
  assert.equal(K.pagesText([]), "");
  assert.equal(K.kindFamily("heading"), "head");
  assert.equal(K.kindFamily("page_footer"), "furniture");
});
