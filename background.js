/**
 * Background service worker for Highlight Translate.
 * Handles translation requests by calling the Google Translate API.
 * Handles improve requests by calling the selected AI provider API.
 */

const TRANSLATE_URL =
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=";

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
  custom: {
    model: "",
  },
};

// One-time migration: migrate old geminiApiKey to new format
(async function migrateOldSettings() {
  const { geminiApiKey, provider } = await chrome.storage.local.get(["geminiApiKey", "provider"]);
  if (geminiApiKey && !provider) {
    console.log("[Highlight Translate] Migrating old geminiApiKey to new format");
    await chrome.storage.local.set({
      provider: "gemini",
      apiKey: geminiApiKey,
      model: PROVIDER_DEFAULTS.gemini.model,
    });
    await chrome.storage.local.remove("geminiApiKey");
  }
})();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "translate" && message.text) {
    handleTranslation(message.text)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[Highlight Translate] Translation failed:", error);
        sendResponse({
          success: false,
          translatedText: "Translation failed. Please try again.",
        });
      });
    return true;
  }

  if (message.action === "improve" && message.text) {
    handleImprove(message.text)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[Highlight Translate] Improve failed:", error);
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
});

async function handleTranslation(text) {
  const url = TRANSLATE_URL + encodeURIComponent(text);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const data = await response.json();
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

async function handleImprove(text) {
  const { provider, apiKey, model, customEndpoint, customPrompt } =
    await chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint", "customPrompt"]);

  if (!apiKey || !provider) {
    throw new Error("NO_API_KEY");
  }

  const resolvedModel = model || PROVIDER_DEFAULTS[provider].model;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    let result;
    switch (provider) {
      case "gemini":
        result = await callGemini(apiKey, resolvedModel, text, customPrompt, controller.signal);
        break;
      case "openai":
        result = await callOpenAI(apiKey, resolvedModel, text, customPrompt, controller.signal);
        break;
      case "anthropic":
        result = await callAnthropic(apiKey, resolvedModel, text, customPrompt, controller.signal);
        break;
      case "custom":
        if (!customEndpoint) throw new Error("Custom endpoint not configured");
        result = await callCustom(apiKey, customEndpoint, resolvedModel, text, customPrompt, controller.signal);
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
