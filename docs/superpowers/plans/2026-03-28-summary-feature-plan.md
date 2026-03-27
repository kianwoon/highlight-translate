# Summary Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th TL;DR Summary icon (∑) to the text-selection toolbar that summarizes highlighted text via the configured AI provider.

**Architecture:** Follows the identical pattern as the existing Reply feature — new icon element, click handler, background action routing to multi-provider AI, customizable prompt in settings.

**Tech Stack:** Vanilla JS (content script + background service worker), Chrome Extension MV3, multi-provider AI (Gemini/OpenAI/Anthropic/Custom).

---

## File Overview

| File | Change |
|---|---|
| `content.css` | Add `.ht-summary-icon` styles |
| `content.js` | Add `summaryIconEl` state, `createSummaryIcon()`, `onSummaryClick()`, `removeSummaryIcon()`, update `showIcon()`, `onMouseUp()`, `onDocumentClick()`, `closePopup()`, `onSelectionChange()` |
| `background.js` | Add `SUMMARIZE_DEFAULT_PROMPT`, `handleSummarize()`, 4 provider call functions, `case "summarize"` in message listener |
| `options.html` | Add Summary Prompt textarea (below Reply Prompt) |
| `options.js` | Add `summaryPromptInput`, load `summaryPrompt` from storage, save `summaryPrompt` to storage |

---

### Task 1: Add Summary icon styles

**Files:** Modify: `content.css:70-97` (add after `.ht-reply-icon`)

- [ ] **Step 1: Add `.ht-summary-icon` CSS class**

After the `.ht-reply-icon:hover:active` block (ends line ~97), add:

```css
/* ---- Summary icon (TL;DR) ---- */

.ht-summary-icon {
  position: fixed;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background-color: #ffffff;
  border: 1px solid #d0d0d0;
  color: #00897b;
  font-size: 16px;
  font-weight: 700;
  line-height: 28px;
  text-align: center;
  cursor: pointer;
  z-index: 2147483647;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  user-select: none;
  display: none;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}

.ht-summary-icon:hover {
  border-color: #00897b;
  box-shadow: 0 2px 8px rgba(0, 137, 123, 0.3);
}

.ht-summary-icon:active {
  transform: scale(0.92);
}
```

- [ ] **Step 2: Commit**

```bash
git add content.css && git commit -m "feat: add .ht-summary-icon teal CSS styles"
```

---

### Task 2: Add Summary icon to content.js

**Files:** Modify: `content.js` (multiple locations)

#### 2a. Add state variable

**File:** `content.js:25` (after `let replyIconEl = null;`)

Add:
```js
let summaryIconEl = null;
```

#### 2b. Add `createSummaryIcon()`

**File:** `content.js:82` (after `return replyIconEl;` closing brace of `createReplyIcon()`)

Add before `function createPopup()`:
```js
function createSummaryIcon() {
    if (summaryIconEl) return summaryIconEl;

    summaryIconEl = document.createElement("div");
    summaryIconEl.className = "ht-summary-icon";
    summaryIconEl.title = "Summarize as TL;DR";
    summaryIconEl.setAttribute("role", "button");
    summaryIconEl.setAttribute("aria-label", "Summarize selected text as TL;DR");
    summaryIconEl.textContent = "\u2211"; // ∑

    summaryIconEl.addEventListener("click", onSummaryClick);
    document.body.appendChild(summaryIconEl);
    return summaryIconEl;
  }
```

#### 2c. Add `removeSummaryIcon()`

**File:** `content.js:152` (after `removeReplyIcon()` function, before blank lines or next function)

Add after the closing `}` of `removeReplyIcon()`:
```js
function removeSummaryIcon() {
    if (summaryIconEl) {
      summaryIconEl.remove();
      summaryIconEl = null;
    }
  }
```

#### 2d. Add `onSummaryClick()` handler

**File:** `content.js:562` (after the closing `}` of `onReplyClick()`, before `function onMouseUp()`)

Add:
```js
function onSummaryClick(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText();
    if (!text || isTranslating) return;

    isTranslating = true;
    showLoading();

    chrome.runtime.sendMessage(
      { action: "summarize", text: text },
      function (response) {
        isTranslating = false;

        if (chrome.runtime.lastError) {
          showPopup("Failed to summarize. Please try again.", text);
          return;
        }

        if (response && response.success) {
          showPopup(response.translatedText, text);
        } else if (response && response.error === "NO_API_KEY") {
          var msg =
            "No AI provider configured. " +
            "<a href='" + chrome.runtime.getURL("options.html") +
            "' target='_blank' style='color:#1a73e8;'>Open settings</a>" +
            " to set up your AI provider.";
          var popup = createPopup();
          var sourceEl = popup.querySelector(".ht-source");
          var loadingEl = popup.querySelector(".ht-loading");
          var resultEl = popup.querySelector(".ht-result");
          loadingEl.style.display = "none";
          sourceEl.style.display = "none";
          resultEl.innerHTML = msg;
          popup.style.display = "block";
          positionPopup();
          clearDismissTimer();
        } else if (response && response.error === "API_ERROR") {
          showPopup(response.translatedText || "API error occurred.", text);
        } else {
          var fallback =
            response && response.translatedText
              ? response.translatedText
              : "Failed to summarize. Please try again.";
          showPopup(fallback, text);
        }
      }
    );
  }
```

#### 2e. Update `showIcon()` to show Summary icon

**File:** `content.js:276-279` (after the reply icon block)

After the reply icon positioning:
```js
const replyIcon = createReplyIcon();
    replyIcon.style.top = (top + 72) + "px";
    replyIcon.style.left = left + "px";
    replyIcon.style.display = "block";
```

Add:
```js
const summaryIcon = createSummaryIcon();
    summaryIcon.style.top = (top + 108) + "px";
    summaryIcon.style.left = left + "px";
    summaryIcon.style.display = "block";
```

#### 2f. Update `onMouseUp()` to include summary icon

**File:** `content.js:566` (the guard condition in `onMouseUp`)

Find the line starting with:
```js
if (e.target && (e.target.closest(".ht-translate-icon") || e.target.closest(".ht-humanize-icon") || e.target.closest(".ht-reply-icon") || e.target.closest(".ht-translate-popup"))) {
```

Add `|| e.target.closest(".ht-summary-icon")` before the closing parenthesis:
```js
if (e.target && (e.target.closest(".ht-translate-icon") || e.target.closest(".ht-humanize-icon") || e.target.closest(".ht-reply-icon") || e.target.closest(".ht-summary-icon") || e.target.closest(".ht-translate-popup"))) {
```

#### 2g. Update `onDocumentClick()` to include summary icon

**File:** `content.js` — in the `onDocumentClick` function, find the four `isInsideXxx` variable declarations. Add:

```js
var isInsideSummaryIcon = summaryIconEl && summaryIconEl.contains(e.target);
```

Then update the guard:
```js
if (!isInsideIcon && !isInsideHumanizeIcon && !isInsideReplyIcon && !isInsideSummaryIcon && !isInsidePopup) {
```

And update the dismiss calls:
```js
removeIcon();
removeHumanizeIcon();
removeReplyIcon();
removeSummaryIcon();
```

#### 2h. Update `closePopup()` to remove summary icon

**File:** `content.js` — in `closePopup()`, after `removeReplyIcon()` add:
```js
removeSummaryIcon();
```

#### 2i. Update `onSelectionChange()` dismiss guard

**File:** `content.js` — in `onSelectionChange()`, find:
```js
} else if (!text && (iconEl || humanizeIconEl || replyIconEl)) {
```
Update to:
```js
} else if (!text && (iconEl || humanizeIconEl || replyIconEl || summaryIconEl)) {
```

- [ ] **Step 3: Commit**

```bash
git add content.js && git commit -m "feat: add Summary icon (∑) to content script"
```

---

### Task 3: Add Summarize logic to background.js

**Files:** Modify: `background.js` (multiple locations)

#### 3a. Add default prompt constant

**File:** `background.js:367` (after `REPLY_DEFAULT_PROMPT`, before `async function callGeminiReply`)

Add:
```js
const SUMMARIZE_DEFAULT_PROMPT = "Summarize the following text as a TL;DR with concise bullet points. Return ONLY the bullet points, each starting with \"\u2022\".";
```

#### 3b. Add `handleSummarize()`

**File:** `background.js:222` (after the closing `}` of `handleReply()`, before `function makeApiError`)

Add:
```js
async function handleSummarize(text) {
  const { provider, apiKey, model, customEndpoint, summaryPrompt } =
    await chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint", "summaryPrompt"]);

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
        result = await callGeminiSummarize(apiKey, resolvedModel, text, summaryPrompt, controller.signal);
        break;
      case "openai":
        result = await callOpenAISummarize(apiKey, resolvedModel, text, summaryPrompt, controller.signal);
        break;
      case "anthropic":
        result = await callAnthropicSummarize(apiKey, resolvedModel, text, summaryPrompt, controller.signal);
        break;
      case "custom":
        if (!customEndpoint) throw new Error("Custom endpoint not configured");
        result = await callCustomSummarize(apiKey, customEndpoint, resolvedModel, text, summaryPrompt, controller.signal);
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
```

#### 3c. Add provider call functions

**File:** `background.js` — after `callCustomReply()` (ends ~line 499), before the message listener block

Add all four functions in order:

```js
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
```

#### 3d. Add `case "summarize"` in message listener

**File:** `background.js` — in `chrome.runtime.onMessage.addListener`, add this case after the `reply` case block (which ends with `return true; } }`):

```js
if (message.action === "summarize" && message.text) {
    handleSummarize(message.text)
      .then((translatedText) => {
        sendResponse({ success: true, translatedText });
      })
      .catch((error) => {
        console.error("[Highlight Translate] Summarize failed:", error);
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
```

- [ ] **Step 4: Commit**

```bash
git add background.js && git commit -m "feat: add Summarize action with multi-provider AI support"
```

---

### Task 4: Add Summary Prompt to options page

**Files:** Modify: `options.html`, `options.js`

#### 4a. Add Summary Prompt textarea in options.html

**File:** `options.html:112-116` (after the reply prompt section, before the save button section)

After:
```html
<p class="help">Customize the AI prompt for crafting replies. Leave empty to use the default.</p>
  </div>

  <div class="section">
    <div class="input-row">
```

Insert:
```html
<div class="section">
    <label for="summaryPrompt">Summary Prompt <span style="font-weight:400;color:#5f6368">(optional)</span></label>
    <textarea id="summaryPrompt" rows="3" placeholder="e.g. Summarize the following text as a TL;DR with concise bullet points. Return ONLY the bullet points, each starting with '•'."></textarea>
    <p class="help">Customize the AI prompt for summarizing text. Leave empty to use the default.</p>
  </div>
```

#### 4b. Add `summaryPromptInput` variable in options.js

**File:** `options.js:9` (after `const replyPromptInput = document.getElementById('replyPrompt');`)

Add:
```js
const summaryPromptInput = document.getElementById('summaryPrompt');
```

#### 4c. Load `summaryPrompt` from storage in options.js

**File:** `options.js:73-76` (after the `replyPrompt` load block)

Add:
```js
if (data.summaryPrompt) {
      summaryPromptInput.value = data.summaryPrompt;
    }
```

#### 4d. Save `summaryPrompt` in options.js

**File:** `options.js:111` (after `const replyPrompt = replyPromptInput.value.trim();`)

Add:
```js
const summaryPrompt = summaryPromptInput.value.trim();
```

#### 4e. Pass `summaryPrompt` to `saveSettings()` in options.js

**File:** `options.js:143` (two occurrences — inside the chrome.permissions.request callback and the else branch)

Update both:
```js
saveSettings(provider, key, model, endpoint, prompt, replyPrompt, summaryPrompt);
```
And:
```js
saveSettings(provider, key, model, endpoint, prompt, replyPrompt, summaryPrompt);
```

#### 4f. Update `saveSettings()` function signature and body in options.js

**File:** `options.js:154` (update function signature)

Change:
```js
function saveSettings(provider, key, model, endpoint, prompt, replyPrompt) {
    const data = { provider: provider, apiKey: key, customPrompt: prompt, replyPrompt: replyPrompt };
```

To:
```js
function saveSettings(provider, key, model, endpoint, prompt, replyPrompt, summaryPrompt) {
    const data = { provider: provider, apiKey: key, customPrompt: prompt, replyPrompt: replyPrompt, summaryPrompt: summaryPrompt };
```

- [ ] **Step 5: Commit**

```bash
git add options.html options.js && git commit -m "feat: add Summary Prompt textarea to options page"
```

---

## Verification

Manual test — no automated tests in this project:

1. Load the extension as unpacked in Chrome (`chrome://extensions`, Developer mode, "Load unpacked")
2. Navigate to any page with text (e.g. an article)
3. Highlight a paragraph of text
4. Verify 4 icons appear (translate, humanize, reply, summary)
5. Click the ∑ (Summary) icon
6. Verify a loading popup appears, then the TL;DR summary is displayed
7. Click the Copy button to verify clipboard works
8. Close the popup and test on a different site
9. Go to the options page and verify the Summary Prompt textarea appears and saves
10. Test with a custom prompt to verify it overrides the default
