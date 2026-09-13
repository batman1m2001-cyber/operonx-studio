/* operonx studio — LLM backend detection.
 *
 * Pure data → data, split out of studio.js so it runs under
 * `node --test` (tests/js/providers.test.mjs) exactly as it runs in the
 * browser. Resource fields arrive VERBATIM from the IR — `${VAR}` and
 * `${VAR:default}` placeholders included — so detection first resolves
 * a field to its effective value: defaults substituted, bare required
 * vars blanked (their value is unknowable here, by design).
 */
(function (global) {
  const PROVIDERS = {
    claude:  {icon: "✳︎", label: "Claude"},
    gemini:  {icon: "✦",  label: "Gemini"},
    openai:  {icon: "⬡",  label: "OpenAI"},
    vllm:    {icon: "⚙︎", label: "vLLM"},
    ollama:  {icon: "◉",  label: "Ollama"},
    mistral: {icon: "Ⓜ",  label: "Mistral"},
  };

  const ENV_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

  function resolvedField(v) {
    return String(v ?? "").replace(ENV_TOKEN, (m, name, dflt) => dflt || "");
  }

  /* ref: {resource, fields} — fields as the IR carries them. Order
   * matters: explicit provider names beat protocol hints (nearly every
   * gateway speaks the openai protocol), and an HF-style org/model id
   * or a self-hosted url means a vLLM-class gateway even then. */
  function detectProvider(ref) {
    const det = (ref && ref.fields) || {};
    const model = resolvedField(det.model);
    const hay = [ref && ref.resource, det.api_type, det.provider, det.model,
                 det.base_url, det.url].filter(Boolean)
      .map(resolvedField).join(" ").toLowerCase();
    if (/claude|anthropic/.test(hay)) return "claude";
    if (/gemini|generativelanguage|vertex/.test(hay)) return "gemini";
    if (/mistral/.test(hay)) return "mistral";
    if (/ollama|:11434/.test(hay)) return "ollama";
    if (/gpt-|o[134]-mini|api\.openai\.com/.test(hay)) return "openai";
    if (/vllm/.test(hay) || /^[\w.-]+\/[\w.-]+$/.test(model)
        || /localhost|127\.0\.0\.1|:8000\b/.test(hay)) return "vllm";
    if (/openai/.test(hay)) return "openai";
    return null;
  }

  const api = { PROVIDERS, resolvedField, detectProvider };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Providers = api;
})(typeof window !== "undefined" ? window : globalThis);
