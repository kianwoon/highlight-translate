# Multi-Provider AI Support for Grammar & Humanize Feature

**Date:** 2026-03-25
**Status:** Approved
**Branch:** v1.1.0

---

## Problem

The Grammar & Humanize feature is hardcoded to use Google Gemini (`gemini-3-flash-preview`). Users cannot choose their preferred AI provider, limiting adoption for users who already have OpenAI or Anthropic API keys, or who live in regions where Gemini is unavailable.

## Goals

- Support 4 providers: Gemini, OpenAI, Anthropic, and Custom (OpenAI-compatible endpoint)
- Allow per-provider API key and configurable model selection
- Maintain backward compatibility with existing translate feature (unchanged)
- Keep the implementation simple with minimal file restructuring

## Non-Goals

- Provider adapter pattern or plugin system (overkill for 4 providers)
- Dynamic model list fetching from provider APIs

---

## Storage Schema

### New `chrome.storage.local` keys

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `provider` | string | Yes | `"gemini"` \| `"openai"` \| `"anthropic"` \| `"custom"` |
| `apiKey` | string | Yes | API key for the selected provider |
| `model` | string | No | Model override. Defaults per provider if empty. |
| `customEndpoint` | string | Custom only | Base URL for custom OpenAI-compatible endpoint |
| `customPrompt` | string | No | Custom system prompt (already exists, unchanged) |

> **Design decision:** Single shared `apiKey` field rather than per-provider keys. Users must re-enter their key when switching providers. This keeps storage and UI simple.

### Removed keys

- `geminiApiKey` — replaced by generic `apiKey`

### Default model mapping

| Provider | Default model |
|----------|--------------|
| Gemini | `gemini-2.0-flash` |
| OpenAI | `gpt-4o-mini` |
| Anthropic | `claude-haiku-4-5-20251001` |
| Custom | (user must specify) |

### Migration

On extension update: if `geminiApiKey` exists in storage, migrate it: set `provider = "gemini"`, `apiKey = geminiApiKey`, then remove `geminiApiKey`. This preserves the user's existing configuration.

---

## Settings UI (`options.html` / `options.js`)

### Layout

1. **Provider dropdown** — select from Gemini, OpenAI, Anthropic, Custom
2. **API Key field** — password input with show/hide toggle (reuses existing pattern)
3. **Model field** — text input, pre-filled with default for selected provider; user can override
4. **Custom Endpoint field** — only visible when "Custom" is selected. Label: "Base URL (without /v1/chat/completions)". Placeholder: `https://api.groq.com/openai`
5. **Custom Prompt textarea** — already exists, unchanged
6. **Save button** — validates before saving

### Validation rules

- API key required for all providers
- Model required for Custom provider
- Custom Endpoint required for Custom provider; strip trailing `/v1/chat/completions` if user accidentally includes it

### Dynamic behavior

- Changing provider auto-fills model field with that provider's default. When the user selects a new provider, the model field is overwritten with that provider's default. Previous overrides are lost on switch.
- Help link below API key field changes per provider:
  - Gemini: `https://aistudio.google.com/apikey`
  - OpenAI: `https://platform.openai.com/api-keys`
  - Anthropic: `https://console.anthropic.com/settings/keys`
  - Custom: hidden

---

## Background Service Worker (`background.js`)

### `handleImprove()` refactored flow

```
1. Read { provider, apiKey, model, customEndpoint, customPrompt } from storage
2. Build messages array: [{ role: "user", content: text }]
3. Resolve model: use stored model or provider default
4. Set `AbortController` with 30-second timeout for the fetch call
5. Switch on provider:
   - gemini:    POST to generativelanguage.googleapis.com
   - openai:    POST to https://api.openai.com/v1/chat/completions
   - anthropic: POST to https://api.anthropic.com/v1/messages
   - custom:    POST to {customEndpoint}/v1/chat/completions
6. Parse provider-specific response → extract text content
7. Return result
```

### Provider-specific API details

**Gemini:**
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
- Body: `{ contents: [{ parts: [{ text }] }], systemInstruction: { parts: [{ text: prompt }] }, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } }`
- Response: `candidates[0].content.parts[0].text`
- If `candidates[0].content` is null (safety filter triggered), return `{ error: "API_ERROR", message: "Response blocked by safety filter." }`

**OpenAI:**
- Endpoint: `https://api.openai.com/v1/chat/completions`
- Headers: `Authorization: Bearer {apiKey}`, `Content-Type: application/json`
- Body: `{ model, messages: [{ role: "system", content: prompt }, { role: "user", content: text }], temperature: 0.7, max_tokens: 2048 }`
- Response: `choices[0].message.content`

**Anthropic:**
- Endpoint: `https://api.anthropic.com/v1/messages`
- Headers: `x-api-key: {apiKey}`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`
  - Note: Verify latest stable API version at implementation time
- Body: `{ model, system: prompt, messages: [{ role: "user", content: text }], temperature: 0.7, max_tokens: 2048 }`
- Response: `content[0].text`

**Custom (OpenAI-compatible):**
- Endpoint: `{customEndpoint}/v1/chat/completions`
- Headers: `Authorization: Bearer {apiKey}`, `Content-Type: application/json`
- Body: Same as OpenAI
- Response: Same as OpenAI

### Error handling

| Condition | Response |
|-----------|----------|
| No API key | `{ error: "NO_API_KEY" }` (existing pattern) |
| Invalid key / auth error | `{ error: "API_ERROR", message: "..." }` (new) |
| Rate limit | `{ error: "API_ERROR", message: "Rate limited. Try again later." }` |
| Network error | `{ error: "API_ERROR", message: "Network error. Check your connection." }` |

---

## Content Script Updates (`content.js`)

- Update "no API key" message from Gemini-specific to generic: "Set up your AI provider"
- Display `API_ERROR` messages as plain text in the popup result area, matching the existing error display format
- No other changes needed — the `NO_API_KEY` → options.html link already works generically

---

## Manifest Updates (`manifest.json`)

Add `host_permissions`:
- `https://api.openai.com/*`
- `https://api.anthropic.com/*`

Add `optional_host_permissions`:
- `https://*/*` — for custom OpenAI-compatible endpoints. Call `chrome.permissions.request()` when the user first saves a custom endpoint. This requires a user permission prompt in the browser.

Keep existing permissions:
- `https://generativelanguage.googleapis.com/*` (Gemini)
- `https://translate.googleapis.com/*` (translate, unchanged)
- `storage`

---

## Files Modified

| File | Change |
|------|--------|
| `options.html` | Redesign settings UI with provider dropdown, model field, custom endpoint field |
| `options.js` | Add provider selection logic, dynamic model defaults, validation, per-provider help links |
| `background.js` | Refactor `handleImprove()` with provider switch block; add error types |
| `content.js` | Update error messages to be provider-agnostic |
| `manifest.json` | Add OpenAI and Anthropic host_permissions; add optional_host_permissions for custom endpoints |
