/**
 * Background service worker for UniLingo.
 * Handles translation requests by calling the Google Translate API.
 * Handles improve requests by calling the selected AI provider API.
 */

const TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const DEFAULT_TRANSLATION_TARGET = "zh-CN";
const CHINESE_TRANSLATION_TARGET = "en";

const PROVIDER_DEFAULTS = {
  gemini: {
    model: "gemini-2.0-flash",
  },
  openai: {
    model: "gpt-4o-mini",
  },
  anthropic: {
    model: "claude-haiku-4-5-20251001",
  },
  openrouter: {
    model: "openai/gpt-4o-mini",
  },
  ollama: {
    model: "qwen3:1.7b",
  },
  codingplan: {
    model: "",
  },
  custom: {
    model: "",
  },
};

// One-time migration: migrate old geminiApiKey to new format
(async function migrateOldSettings() {
  const { geminiApiKey, provider } = await chrome.storage.local.get(["geminiApiKey", "provider"]);
  if (geminiApiKey && !provider) {
    console.log("[UniLingo] Migrating old geminiApiKey to new format");
    await chrome.storage.local.set({
      provider: "gemini",
      apiKey: geminiApiKey,
      model: PROVIDER_DEFAULTS.gemini.model,
    });
    await chrome.storage.local.remove("geminiApiKey");
  }
})();

// Helper: fetch Ollama API directly from service worker.
// http://localhost:11434/* is declared in host_permissions, so this bypasses CORS.
async function ollamaFetch(body) {
  let r;
  try {
    r = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw makeApiError("Cannot reach Ollama. Make sure it's running on localhost:11434.");
  }

  if (r.status === 403) {
    throw makeApiError(
      "Ollama blocked this extension. Run this command in Terminal and restart Ollama:\n\n" +
      'launchctl setenv OLLAMA_ORIGINS "*"\n\n' +
      "Then quit and reopen the Ollama app."
    );
  }
  if (!r.ok) throw makeApiError("Ollama returned HTTP " + r.status);
  const data = await r.json();
  if (!data || !data.message || !data.message.content) throw makeApiError("Unexpected response");
  return data.message.content;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "translate" && message.text) {
    handleTranslation(message.text)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[UniLingo] Translation failed:", error);
        sendResponse({
          success: false,
          translatedText: "Translation failed. Please try again.",
        });
      });
    return true;
  }

  if (message.action === "improve" && message.text) {
    handleImprove(message.text, message.languageCode)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[UniLingo] Improve failed:", error, error.details || "");
        if (error.message === "NO_API_KEY") {
          sendResponse({
            success: false,
            error: "NO_API_KEY",
            translatedText: "Set up your AI provider",
          });
        } else if (error.message === "API_ERROR") {
          sendResponse({
            success: false,
            error: "API_ERROR",
            translatedText: error.details || "API error occurred.",
          });
        } else {
          sendResponse({
            success: false,
            translatedText: "Failed to improve text: " + error.message,
          });
        }
      });
    return true;
  }

  if (message.action === "reply" && message.text) {
    handleReply(message.text, message.languageCode)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[UniLingo] Reply failed:", error, error.details || "");
        if (error.message === "NO_API_KEY") {
          sendResponse({
            success: false,
            error: "NO_API_KEY",
            translatedText: "Set up your AI provider",
          });
        } else if (error.message === "API_ERROR") {
          sendResponse({
            success: false,
            error: "API_ERROR",
            translatedText: error.details || "API error occurred.",
          });
        } else {
          sendResponse({
            success: false,
            translatedText: "Failed to craft reply: " + error.message,
          });
        }
      });
    return true;
  }

  if (message.action === "summarize" && message.text) {
    handleSummarize(message.text, message.languageCode)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[UniLingo] Summarize failed:", error, error.details || "");
        if (error.message === "NO_API_KEY") {
          sendResponse({
            success: false,
            error: "NO_API_KEY",
            translatedText: "Set up your AI provider",
          });
        } else if (error.message === "API_ERROR") {
          sendResponse({
            success: false,
            error: "API_ERROR",
            translatedText: error.details || "API error occurred.",
          });
        } else {
          sendResponse({
            success: false,
            translatedText: "Failed to summarize: " + error.message,
          });
        }
      });
    return true;
  }
});

function getBaseLanguage(languageCode) {
  if (!languageCode) return "";
  try {
    return new Intl.Locale(languageCode).language;
  } catch (error) {
    return languageCode;
  }
}

function getDetectedLanguage(data) {
  return Array.isArray(data) && typeof data[2] === "string" ? data[2] : "";
}

function getTranslationTargetForDetectedLanguage(detectedLanguage) {
  return getBaseLanguage(detectedLanguage) === "zh"
    ? CHINESE_TRANSLATION_TARGET
    : DEFAULT_TRANSLATION_TARGET;
}

function getLanguageDisplayName(languageCode) {
  const baseLanguage = getBaseLanguage(languageCode);
  if (!baseLanguage) return "";
  try {
    const displayNames = new Intl.DisplayNames(["en"], { type: "language" });
    return displayNames.of(baseLanguage) || baseLanguage;
  } catch (error) {
    return baseLanguage;
  }
}

function buildLanguageInstruction(languageCode) {
  const languageName = getLanguageDisplayName(languageCode);
  if (!languageName) {
    return "Return the result in the same language as the selected text.";
  }
  return `The selected text was detected as ${languageName}. Return the result in ${languageName}.`;
}

function buildImproveDefaultPrompt(languageCode) {
  return [
    "Improve the selected text while preserving its meaning.",
    "Fix grammar, spelling, punctuation, wording, fluency, and readability in a natural human tone.",
    buildLanguageInstruction(languageCode),
    "Return ONLY the improved text, nothing else.",
  ].join(" ");
}

function buildReplyDefaultPrompt(languageCode) {
  return [
    "Write a professional, concise reply to the selected message.",
    "Match the tone and context.",
    buildLanguageInstruction(languageCode),
    "Return ONLY the reply text, nothing else.",
  ].join(" ");
}

function buildSummarizeDefaultPrompt(languageCode) {
  return [
    "Summarize the selected text as a concise TL;DR with bullet points.",
    "Each bullet point must start with \"\u2022\".",
    buildLanguageInstruction(languageCode),
    "Return ONLY the bullet points, nothing else.",
  ].join(" ");
}

function buildTranslationUrl(text, targetLanguage) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: targetLanguage,
    dt: "t",
    q: text,
  });
  return `${TRANSLATE_ENDPOINT}?${params.toString()}`;
}

function extractTranslatedText(data) {
  if (!data || !Array.isArray(data[0])) {
    throw new Error("Unexpected API response format");
  }
  const translated = data[0]
    .map((chunk) => (chunk && chunk[0] ? chunk[0] : ""))
    .join("")
    .trim();
  if (!translated) {
    throw new Error("Empty translation result");
  }
  return translated;
}

async function fetchTranslation(text, targetLanguage) {
  const url = buildTranslationUrl(text, targetLanguage);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function handleTranslation(text) {
  const initialData = await fetchTranslation(text, DEFAULT_TRANSLATION_TARGET);
  const detectedLanguage = getDetectedLanguage(initialData);
  const targetLanguage = getTranslationTargetForDetectedLanguage(detectedLanguage);

  if (targetLanguage === DEFAULT_TRANSLATION_TARGET) {
    return extractTranslatedText(initialData);
  }

  const translatedData = await fetchTranslation(text, targetLanguage);
  return extractTranslatedText(translatedData);
}

async function handleImprove(text, languageCode) {
  const { provider, apiKey, model, customEndpoint, customPrompt } =
    await chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint", "customPrompt"]);

  if (!provider || (!apiKey && provider !== "ollama")) {
    throw new Error("NO_API_KEY");
  }

  const resolvedModel = model || PROVIDER_DEFAULTS[provider].model;
  const effectivePrompt = customPrompt || buildImproveDefaultPrompt(languageCode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    let result;
    switch (provider) {
      case "gemini":
        result = await callGemini(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "openai":
        result = await callOpenAI(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "anthropic":
        result = await callAnthropic(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "openrouter":
        result = await callOpenRouter(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "ollama":
        result = await callOllama(resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "codingplan":
        if (!customEndpoint) throw new Error("Coding Plan endpoint not configured");
        result = await callCodingPlan(apiKey, customEndpoint, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "custom":
        if (!customEndpoint) throw new Error("Custom endpoint not configured");
        result = await callCustom(apiKey, customEndpoint, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      default:
        throw new Error("Unknown provider: " + provider);
    }
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.message === "API_ERROR") throw error; // already wrapped by makeApiError
    if (error.name === "AbortError") {
      throw makeApiError("Request timed out (30s). Check your connection.");
    }
    if (error.name === "TypeError") {
      throw makeApiError("Network error. Check your connection.");
    }
    throw error;
  }
}

async function handleReply(text, languageCode) {
  const { provider, apiKey, model, customEndpoint, replyPrompt } =
    await chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint", "replyPrompt"]);

  if (!provider || (!apiKey && provider !== "ollama")) {
    throw new Error("NO_API_KEY");
  }

  const resolvedModel = model || PROVIDER_DEFAULTS[provider].model;
  const effectivePrompt = replyPrompt || buildReplyDefaultPrompt(languageCode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    let result;
    switch (provider) {
      case "gemini":
        result = await callGeminiReply(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "openai":
        result = await callOpenAIReply(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "anthropic":
        result = await callAnthropicReply(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "openrouter":
        result = await callOpenRouterReply(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "ollama":
        result = await callOllamaReply(resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "codingplan":
        if (!customEndpoint) throw new Error("Coding Plan endpoint not configured");
        result = await callCodingPlanReply(apiKey, customEndpoint, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "custom":
        if (!customEndpoint) throw new Error("Custom endpoint not configured");
        result = await callCustomReply(apiKey, customEndpoint, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      default:
        throw new Error("Unknown provider: " + provider);
    }
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw makeApiError("Request timed out (30s). Check your connection.");
    }
    if (error.name === "TypeError") {
      throw makeApiError("Network error. Check your connection.");
    }
    throw error;
  }
}

async function handleSummarize(text, languageCode) {
  const { provider, apiKey, model, customEndpoint, summaryPrompt } =
    await chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint", "summaryPrompt"]);

  if (!provider || (!apiKey && provider !== "ollama")) {
    throw new Error("NO_API_KEY");
  }

  const resolvedModel = model || PROVIDER_DEFAULTS[provider].model;
  const effectivePrompt = summaryPrompt || buildSummarizeDefaultPrompt(languageCode);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    let result;
    switch (provider) {
      case "gemini":
        result = await callGeminiSummarize(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "openai":
        result = await callOpenAISummarize(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "anthropic":
        result = await callAnthropicSummarize(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "openrouter":
        result = await callOpenRouterSummarize(apiKey, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "ollama":
        result = await callOllamaSummarize(resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "codingplan":
        if (!customEndpoint) throw new Error("Coding Plan endpoint not configured");
        result = await callCodingPlanSummarize(apiKey, customEndpoint, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      case "custom":
        if (!customEndpoint) throw new Error("Custom endpoint not configured");
        result = await callCustomSummarize(apiKey, customEndpoint, resolvedModel, text, effectivePrompt, controller.signal);
        break;
      default:
        throw new Error("Unknown provider: " + provider);
    }
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      throw makeApiError("Request timed out (30s). Check your connection.");
    }
    if (error.name === "TypeError") {
      throw makeApiError("Network error. Check your connection.");
    }
    throw error;
  }
}

function makeApiError(message) {
  const err = new Error("API_ERROR");
  err.details = message;
  return err;
}

async function callGemini(apiKey, model, text, customPrompt, signal) {
  const systemPrompt = customPrompt ||
    "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal,
    }
  );

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Gemini API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();

  if (!data?.candidates?.[0]?.content) {
    throw makeApiError("Response blocked by safety filter.");
  }
  if (!data.candidates[0].content?.parts?.[0]) {
    throw new Error("Unexpected API response format");
  }

  return data.candidates[0].content.parts[0].text;
}

async function callOpenAI(apiKey, model, text, customPrompt, signal) {
  const systemPrompt = customPrompt ||
    "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your OpenAI API key.");
  if (response.status === 429) throw makeApiError("Rate limited or quota exceeded. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callAnthropic(apiKey, model, text, customPrompt, signal) {
  const systemPrompt = customPrompt ||
    "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Anthropic API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.content?.[0]?.text) {
    throw new Error("Unexpected API response format");
  }

  return data.content[0].text;
}

async function callOpenRouter(apiKey, model, text, customPrompt, signal) {
  const systemPrompt = customPrompt ||
    "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your OpenRouter API key.");
  if (response.status === 429) throw makeApiError("Rate limited or insufficient credits. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callOllama(model, text, customPrompt, signal) {
  const systemPrompt = customPrompt ||
    "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

  return ollamaFetch({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    stream: false,
  });
}

// --- AI Coding Plan provider ---
// Sends requests with AI coding tool headers so providers recognize coding plan subscriptions.
// Auto-detects API format: Anthropic (/v1/messages) or OpenAI (/chat/completions) based on endpoint URL.

function isAnthropicFormat(endpoint) {
  return /anthropic/i.test(endpoint);
}

async function callCodingPlanBase(apiKey, endpoint, model, messages, signal, maxTokens) {
  if (!model) throw new Error("Model required for AI Coding Plan");

  const useAnthropic = isAnthropicFormat(endpoint);
  // Use endpoint URL as-is — user provides the full URL including path
  const url = endpoint;

  const sessionId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Claude-Code/1.0",
    "x-session-id": sessionId,
    "x-claude-code-session-id": sessionId,
    "x-session-name": "highlight-translate",
    "Accept": "application/json",
  };

  let body;
  if (useAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "prompt-caching-2024-07-31,token-counting-2024-11-01";
    // Anthropic format: system as top-level field, content as block arrays
    const systemMsg = messages.find(m => m.role === "system");
    const userMessages = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role,
      content: [{ type: "text", text: m.content }],
    }));
    body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: systemMsg?.content || "" }],
      messages: userMessages,
      stream: false,
    });
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: maxTokens,
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Coding Plan API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();

  // Try Anthropic format first (content array with text blocks)
  if (Array.isArray(data?.content)) {
    const textBlock = data.content.find(b => b.type === "text");
    if (textBlock?.text) return textBlock.text;
  }

  // Try OpenAI format (choices array)
  if (data?.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }

  // Fallback: try raw content string (some APIs return { content: "text" })
  if (typeof data?.content === "string") return data.content;

  // Fallback: try text field directly
  if (typeof data?.text === "string") return data.text;

  throw new Error("Unexpected API response format: " + JSON.stringify(data).slice(0, 200));
}

const IMPROVE_DEFAULT_PROMPT = "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

async function callCodingPlan(apiKey, endpoint, model, text, customPrompt, signal) {
  const systemPrompt = customPrompt || IMPROVE_DEFAULT_PROMPT;
  return callCodingPlanBase(apiKey, endpoint, model, [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ], signal, 2048);
}

async function callCodingPlanReply(apiKey, endpoint, model, text, replyPrompt, signal) {
  const systemPrompt = replyPrompt || "Write a professional, concise reply to the following message. Match the tone and context. Return ONLY the reply text, nothing else.";
  return callCodingPlanBase(apiKey, endpoint, model, [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ], signal, 2048);
}

async function callCodingPlanSummarize(apiKey, endpoint, model, text, summaryPrompt, signal) {
  const systemPrompt = summaryPrompt || "Summarize the following text as a concise TL;DR. Use bullet points starting with '•'. Return ONLY the bullet points, nothing else.";
  return callCodingPlanBase(apiKey, endpoint, model, [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ], signal, 1024);
}

// --- Custom (OpenAI-compatible) provider ---

async function callCustom(apiKey, customEndpoint, model, text, customPrompt, signal) {
  if (!model) throw new Error("Model required for custom provider");

  const systemPrompt = customPrompt ||
    "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.";

  const response = await fetch(`${customEndpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your custom endpoint API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

const REPLY_DEFAULT_PROMPT = "Write a professional, concise reply to the following message. Match the tone and context. Return ONLY the reply text, nothing else.";

const SUMMARIZE_DEFAULT_PROMPT = "Summarize the following text as a TL;DR with concise bullet points. Return ONLY the bullet points, each starting with \"\u2022\".";

async function callGeminiReply(apiKey, model, text, replyPrompt, signal) {
  const systemPrompt = replyPrompt || REPLY_DEFAULT_PROMPT;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
      signal,
    }
  );

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Gemini API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();

  if (!data?.candidates?.[0]?.content) {
    throw makeApiError("Response blocked by safety filter.");
  }
  if (!data.candidates[0].content?.parts?.[0]) {
    throw new Error("Unexpected API response format");
  }

  return data.candidates[0].content.parts[0].text;
}

async function callOpenAIReply(apiKey, model, text, replyPrompt, signal) {
  const systemPrompt = replyPrompt || REPLY_DEFAULT_PROMPT;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your OpenAI API key.");
  if (response.status === 429) throw makeApiError("Rate limited or quota exceeded. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callAnthropicReply(apiKey, model, text, replyPrompt, signal) {
  const systemPrompt = replyPrompt || REPLY_DEFAULT_PROMPT;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Anthropic API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.content?.[0]?.text) {
    throw new Error("Unexpected API response format");
  }

  return data.content[0].text;
}

async function callOpenRouterReply(apiKey, model, text, replyPrompt, signal) {
  const systemPrompt = replyPrompt || REPLY_DEFAULT_PROMPT;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your OpenRouter API key.");
  if (response.status === 429) throw makeApiError("Rate limited or insufficient credits. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callOllamaReply(model, text, replyPrompt, signal) {
  const systemPrompt = replyPrompt || REPLY_DEFAULT_PROMPT;

  return ollamaFetch({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    stream: false,
  });
}

async function callCustomReply(apiKey, customEndpoint, model, text, replyPrompt, signal) {
  if (!model) throw new Error("Model required for custom provider");

  const systemPrompt = replyPrompt || REPLY_DEFAULT_PROMPT;

  const response = await fetch(`${customEndpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your custom endpoint API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callGeminiSummarize(apiKey, model, text, summaryPrompt, signal) {
  const systemPrompt = summaryPrompt || SUMMARIZE_DEFAULT_PROMPT;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
      signal,
    }
  );

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Gemini API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();

  if (!data?.candidates?.[0]?.content) {
    throw makeApiError("Response blocked by safety filter.");
  }
  if (!data.candidates[0].content?.parts?.[0]) {
    throw new Error("Unexpected API response format");
  }

  return data.candidates[0].content.parts[0].text;
}

async function callOpenAISummarize(apiKey, model, text, summaryPrompt, signal) {
  const systemPrompt = summaryPrompt || SUMMARIZE_DEFAULT_PROMPT;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your OpenAI API key.");
  if (response.status === 429) throw makeApiError("Rate limited or quota exceeded. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callAnthropicSummarize(apiKey, model, text, summaryPrompt, signal) {
  const systemPrompt = summaryPrompt || SUMMARIZE_DEFAULT_PROMPT;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages: [{ role: "user", content: text }],
      temperature: 0.7,
      max_tokens: 1024,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your Anthropic API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.content?.[0]?.text) {
    throw new Error("Unexpected API response format");
  }

  return data.content[0].text;
}

async function callOpenRouterSummarize(apiKey, model, text, summaryPrompt, signal) {
  const systemPrompt = summaryPrompt || SUMMARIZE_DEFAULT_PROMPT;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your OpenRouter API key.");
  if (response.status === 429) throw makeApiError("Rate limited or insufficient credits. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}

async function callOllamaSummarize(model, text, summaryPrompt, signal) {
  const systemPrompt = summaryPrompt || SUMMARIZE_DEFAULT_PROMPT;

  return ollamaFetch({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    stream: false,
  });
}

async function callCustomSummarize(apiKey, customEndpoint, model, text, summaryPrompt, signal) {
  if (!model) throw new Error("Model required for custom provider");

  const systemPrompt = summaryPrompt || SUMMARIZE_DEFAULT_PROMPT;

  const response = await fetch(`${customEndpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    }),
    signal,
  });

  if (response.status === 401) throw makeApiError("Invalid API key. Check your custom endpoint API key.");
  if (response.status === 429) throw makeApiError("Rate limited. Try again later.");
  if (!response.ok) throw makeApiError(`HTTP ${response.status}: ${response.statusText}`);

  const data = await response.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error("Unexpected API response format");
  }

  return data.choices[0].message.content;
}
