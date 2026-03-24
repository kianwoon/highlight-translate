/**
 * Background service worker for Highlight Translate.
 * Handles translation requests by calling the Google Translate API.
 * Handles improve requests by calling the Gemini API.
 */

const TRANSLATE_URL =
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=";

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

    // Return true to indicate we will call sendResponse asynchronously.
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
            translatedText: "Please set your Gemini API key in extension settings.",
          });
        } else {
          sendResponse({
            success: false,
            translatedText: "Failed to improve text: " + error.message,
          });
        }
      });

    // Return true to indicate we will call sendResponse asynchronously.
    return true;
  }


});

/**
 * Calls the Google Translate API and parses the response.
 * Mirrors the logic from translate.sh:
 *   data[0] is an array of chunks; each chunk[0] is a text fragment.
 *   We stitch them together, skipping null entries.
 *
 * @param {string} text - The text to translate.
 * @returns {Promise<string>} The translated text.
 */
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

  // Stitch translation fragments together (same logic as translate.sh).
  const translated = data[0]
    .map((chunk) => (chunk && chunk[0] ? chunk[0] : ""))
    .join("")
    .trim();

  if (!translated) {
    throw new Error("Empty translation result");
  }

  return translated;
}

/**
 * Calls the Gemini API to improve the given text.
 *
 * @param {string} text - The text to improve.
 * @returns {Promise<string>} The improved text.
 */
async function handleImprove(text) {
  const { geminiApiKey, customPrompt } = await chrome.storage.local.get(["geminiApiKey", "customPrompt"]);
  if (!geminiApiKey) {
    throw new Error("NO_API_KEY");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: {
          parts: [
            {
              text: customPrompt || "Fix all grammar, spelling, and punctuation errors. Then rewrite the text to sound natural, human-written, and conversational. Use varied sentence structure and contractions where appropriate. Keep the same meaning. Return ONLY the improved text, nothing else.",
            },
          ],
        },
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    }
  );

  if (!response.ok) {
    if (response.status === 429) {
      const errBody = await response.text().catch(() => '');
      console.error("[Highlight Translate] 429 rate limited:", errBody);
    }
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  if (
    !data ||
    !data.candidates ||
    !data.candidates[0] ||
    !data.candidates[0].content ||
    !data.candidates[0].content.parts ||
    !data.candidates[0].content.parts[0]
  ) {
    throw new Error("Unexpected API response format");
  }

  return data.candidates[0].content.parts[0].text;
}
