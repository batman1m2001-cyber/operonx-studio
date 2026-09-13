// Backend detection's spec layer — pure data → data, no browser.
// Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PROVIDERS, resolvedField, detectProvider } =
  require("../../operonx_studio/static/providers.js");

test("resolvedField substitutes defaults and blanks bare vars", () => {
  assert.equal(resolvedField("${M:gpt-4o-mini}"), "gpt-4o-mini");
  assert.equal(resolvedField("${API_URL}"), "");
  assert.equal(resolvedField("plain-value"), "plain-value");
  assert.equal(resolvedField("https://${HOST:x.dev}/v1/${PATH}"),
    "https://x.dev/v1/");
  assert.equal(resolvedField(null), "");
  assert.equal(resolvedField(30.5), "30.5");
});

test("explicit provider names win, wherever they appear", () => {
  assert.equal(detectProvider({fields: {model: "claude-sonnet-5"}}), "claude");
  assert.equal(detectProvider({fields: {base_url: "https://api.anthropic.com"}}), "claude");
  assert.equal(detectProvider({fields: {model: "gemini-2.5-pro"}}), "gemini");
  assert.equal(detectProvider({fields: {model: "mistral-large"}}), "mistral");
  assert.equal(detectProvider({resource: "claude-main", fields: {}}), "claude");
});

test("a provider name beats the protocol it speaks", () => {
  // anthropic reached through an openai-protocol proxy is still Claude
  assert.equal(detectProvider({fields: {
    api_type: "openai", model: "claude-haiku-4-5"}}), "claude");
});

test("openai by model family or official endpoint", () => {
  assert.equal(detectProvider({fields: {model: "gpt-4o"}}), "openai");
  assert.equal(detectProvider({fields: {base_url: "https://api.openai.com/v1"}}), "openai");
});

test("an HF-style org/model id on a gateway is vLLM-class — the educa case,", () => {
  // the field arrives VERBATIM with its env placeholder; the default
  // must be resolved before the org/model shape can be recognised
  assert.equal(detectProvider({resource: "inhouse", fields: {
    api_type: "openai",
    base_url: "${LLM_API_URL:https://llm-callbot.example.vn:8689/v1}",
    model: "${LLM_MODEL_NAME:google/gemma-4-E2B-it}",
  }}), "vllm");
});

test("self-hosted hints: vllm by name, localhost, ollama port", () => {
  assert.equal(detectProvider({fields: {base_url: "http://localhost:8000/v1",
    model: "x"}}), "vllm");
  assert.equal(detectProvider({fields: {base_url: "http://127.0.0.1:11434"}}), "ollama");
  assert.equal(detectProvider({resource: "vllm-lab", fields: {}}), "vllm");
});

test("bare openai protocol with nothing else still reads openai; silence reads null", () => {
  assert.equal(detectProvider({fields: {api_type: "openai", model: "${M}"}}), "openai");
  assert.equal(detectProvider({fields: {}}), null);
  assert.equal(detectProvider(null), null);
});

test("every detected provider has a face", () => {
  for (const key of ["claude", "gemini", "openai", "vllm", "ollama", "mistral"])
    assert.ok(PROVIDERS[key].icon && PROVIDERS[key].label);
});
