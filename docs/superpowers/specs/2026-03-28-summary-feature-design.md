# Summary Feature Design — Highlight Translate

## Overview

Add a 4th icon (Summary/TL;DR) to the extension's text-selection toolbar. Follows the same architecture as the existing Reply feature.

## Icon

- **Class:** `.ht-summary-icon`
- **Shape:** Circle, 28×28px (matches Translate/Improve/Reply icons)
- **Label text:** `∑` (summation symbol — clean, universally readable)
- **Color:** Teal accent — `color: #00897b`, `border-color: #00897b` on hover
- **Position:** Floats alongside existing icons, same z-index and positioning logic

## Flow

1. User highlights text → all 4 icons appear
2. User clicks `∑` (Summary) icon → `onSummaryClick()` fires
3. `chrome.runtime.sendMessage({ action: "summarize", text })` sent to background
4. Background picks up `summarize` prompt, routes to configured AI provider
5. Result displayed in existing popup (`.ht-result`)

## Files Changed

### `content.js`
- Add `summaryIconEl` variable (module scope)
- Add `createSummaryIcon()` — creates element with `∑`, click handler `onSummaryClick`
- Add `onSummaryClick()` — identical pattern to `onReplyClick()`, sends `action: "summarize"`
- Update icon position logic to include `summaryIconEl`

### `content.css`
- Add `.ht-summary-icon` styles — teal color scheme, matches other icons

### `background.js`
- Add `summarizeDefaultPrompt` constant
- Add `handleSummarize(summarizePrompt, text)` — picks prompt (custom or default), calls `callGeminiSummarize`, `callOpenAISummarize`, `callAnthropicSummarize`, `callCustomSummarize`
- Add provider call functions: `callGeminiSummarize`, `callOpenAISummarize`, `callAnthropicSummarize`, `callCustomSummarize`
- Add `case "summarize":` in the main `chrome.runtime.onMessage` listener
- Route to appropriate provider function

### `options.html`
- Add Summary Prompt textarea (below Reply Prompt), same pattern

### `options.js`
- Load/save `summaryPrompt` in chrome.storage.local
- Pass `summaryPrompt` to `saveSettings()`

## Default Prompt

```
Summarize the following text as a TL;DR with concise bullet points. Return ONLY the bullet points, each starting with "•".
```

## Error Handling

Same pattern as existing features:
- Show inline error in popup on API failure
- Show "Set up your AI provider" link if NO_API_KEY

## No New Permissions

Reuses existing AI provider permissions.
