/**
 * Background service worker for Highlight Translate.
 * Handles translation requests by calling the Google Translate API.
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
