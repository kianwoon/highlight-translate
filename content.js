/**
 * Content script for UniLingo.
 * Shows a floating icon when text is selected, and displays translation popup on click.
 */

(function () {
  "use strict";
  console.log("[HT] LOADED frame:", window.location.href, "body:", !!document.body);

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DEBOUNCE_MS = 300;
  const DISMISS_TIMEOUT_MS = 5000;
  const MAX_SOURCE_LENGTH = 500; // characters to show in the source preview
  const POLL_INTERVAL_MS = 500;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let shadowHost = null;
  let shadowRoot = null;
  let iconEl = null;
  let humanizeIconEl = null;
  let replyIconEl = null;
  let summaryIconEl = null;
  let popupEl = null;
  let dismissTimer = null;
  let debounceTimer = null;
  let isTranslating = false;
  let injectedSel = null; // selection data relayed from main-world script
  let lastMousePos = null; // Tracks mouse position for icon placement
  let savedText = ""; // Selected text saved when icon appears (prevents race on click)
  let savedRange = null; // Cloned Range for text replacement
  let savedEditableEl = null; // contenteditable ancestor for re-querying stale ranges
  let iconLabelRequestId = 0;
  let selectedLanguageText = "";
  let selectedLanguageCode = "";

  // ---------------------------------------------------------------------------
  // Shadow DOM initialization for CSS isolation
  // ---------------------------------------------------------------------------

  function createHtmlElement(tagName) {
    return document.createElementNS("http://www.w3.org/1999/xhtml", tagName);
  }

  function initShadowDOM() {
    if (!document.body) {
      return false;
    }

    shadowHost = createHtmlElement("div");
    shadowHost.id = "ht-shadow-host";
    if (!shadowHost.style) {
      shadowHost = null;
      return false;
    }

    // Reset all inherited CSS properties to prevent host page styles from leaking in
    // (e.g., color: white from user-injected CSS), then override with our specific values
    shadowHost.style.cssText = "all:initial; position:fixed; top:0; left:0; width:0; height:0; pointer-events:auto; z-index:2147483647;";
    shadowRoot = shadowHost.attachShadow({ mode: "open" });

    // Load content.css into shadow root via <link> (sync XHR blocked by MV3 permissions policy)
    var linkEl = createHtmlElement("link");
    linkEl.rel = "stylesheet";
    linkEl.href = chrome.runtime.getURL("content.css");
    shadowRoot.appendChild(linkEl);

    document.body.appendChild(shadowHost);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helper for event handling inside Shadow DOM
  // ---------------------------------------------------------------------------

  function isInsideExtension(e) {
    return shadowHost != null && e.composedPath().indexOf(shadowHost) !== -1;
  }

  // ---------------------------------------------------------------------------
  // Safe message wrapper
  // ---------------------------------------------------------------------------

  function sendMessageSafe(action, text, extra) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
          resolve({ success: false, error: 'CONTEXT_INVALID', message: 'Extension context invalidated' });
          return;
        }
        const payload = Object.assign({ action: action, text: text }, extra || {});
        chrome.runtime.sendMessage(
          payload,
          function (response) {
            try {
              if (chrome.runtime.lastError) {
                resolve({ success: false, error: 'LAST_ERROR', message: chrome.runtime.lastError.message });
                return;
              }
              resolve(response || {});
            } catch (error) {
              resolve({ success: false, error: 'CONTEXT_INVALID', message: error.message });
            }
          }
        );
      } catch (e) {
        resolve({ success: false, error: 'CONTEXT_INVALID', message: e.message });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Ollama proxy — content scripts can fetch http://localhost, service workers can't
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.action === "ollama_proxy") {
      fetch("http://localhost:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg.body),
      })
      .then(function (r) {
        if (!r.ok) throw new Error("Ollama HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.message || !data.message.content) {
          sendResponse({ success: false, error: "Unexpected response" });
        } else {
          sendResponse({ success: true, text: data.message.content });
        }
      })
      .catch(function (e) {
        sendResponse({ success: false, error: e.message });
      });
      return true; // async response
    }
  });

  // ---------------------------------------------------------------------------
  // Text replacement — delegated to main-world script via CustomEvent
  // ---------------------------------------------------------------------------

  function replaceSelectedText(newText) {
    if (!savedText && !savedRange) return Promise.resolve(false);

    return new Promise(function (resolve) {
      console.log("[HT] Replace: delegating to main-world script. savedText:", savedText ? savedText.substring(0, 30) : "(none)");

      // Listen for result from main-world script
      function onResult(e) {
        document.removeEventListener("__ht_replace_result", onResult);
        var success = e.detail && e.detail.success;
        console.log("[HT] Replace: main-world result:", success);
        if (success) {
          savedRange = null;
          savedEditableEl = null;
        }
        resolve(success);
      }
      document.addEventListener("__ht_replace_result", onResult);

      // Dispatch replacement request to main-world script
      document.dispatchEvent(new CustomEvent("__ht_replace", { detail: { text: newText } }));
    });
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  function createIcon() {
    if (iconEl) return iconEl;

    iconEl = document.createElement("div");
    iconEl.className = "ht-translate-icon";
    iconEl.title = "Translate to Chinese";
    iconEl.setAttribute("role", "button");
    iconEl.setAttribute("aria-label", "Translate selected text");
    iconEl.textContent = "\u8BD1"; // "译"

    iconEl.addEventListener("click", onIconClick);
    console.log("[HT] Appending icon to shadow root in", window.location.hostname);
    shadowRoot.appendChild(iconEl);
    return iconEl;
  }

  function getBaseLanguage(languageCode) {
    if (!languageCode) return "";
    try {
      return new Intl.Locale(languageCode).language;
    } catch (error) {
      return languageCode;
    }
  }

  function setTranslateIconForLanguage(languageCode) {
    if (!iconEl) return;
    const isChinese = getBaseLanguage(languageCode) === "zh";
    iconEl.textContent = isChinese ? "Eng" : "\u8BD1";
    iconEl.title = isChinese ? "Translate to English" : "Translate to Chinese";
  }

  function detectSelectedLanguage(text) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id || !chrome.i18n || typeof chrome.i18n.detectLanguage !== "function") {
          resolve("");
          return;
        }

        chrome.i18n.detectLanguage(text, function (result) {
          try {
            if (chrome.runtime.lastError || !result || !Array.isArray(result.languages)) {
              resolve("");
              return;
            }
            resolve(result.languages.length ? result.languages[0].language : "");
          } catch (error) {
            resolve("");
          }
        });
      } catch (error) {
        resolve("");
      }
    });
  }

  function refreshTranslateIconLabel(text) {
    const requestId = ++iconLabelRequestId;
    selectedLanguageText = text;
    selectedLanguageCode = "";
    setTranslateIconForLanguage("");

    detectSelectedLanguage(text).then(function (languageCode) {
      if (requestId !== iconLabelRequestId || text !== savedText || !iconEl) return;
      selectedLanguageCode = languageCode;
      setTranslateIconForLanguage(languageCode);
    });
  }

  function getLanguageHintForText(text) {
    if (selectedLanguageText === text && selectedLanguageCode) {
      return Promise.resolve(selectedLanguageCode);
    }
    return detectSelectedLanguage(text).then(function (languageCode) {
      if (text === savedText) {
        selectedLanguageText = text;
        selectedLanguageCode = languageCode;
      }
      return languageCode;
    });
  }

  function createHumanizeIcon() {
    if (humanizeIconEl) return humanizeIconEl;

    humanizeIconEl = document.createElement("div");
    humanizeIconEl.className = "ht-humanize-icon";
    humanizeIconEl.title = "Improve text";
    humanizeIconEl.setAttribute("role", "button");
    humanizeIconEl.setAttribute("aria-label", "Improve selected text");
    humanizeIconEl.textContent = "AI";

    humanizeIconEl.addEventListener("click", onHumanizeClick);
    shadowRoot.appendChild(humanizeIconEl);
    return humanizeIconEl;
  }

  function createReplyIcon() {
    if (replyIconEl) return replyIconEl;

    replyIconEl = document.createElement("div");
    replyIconEl.className = "ht-reply-icon";
    replyIconEl.title = "Craft a reply";
    replyIconEl.setAttribute("role", "button");
    replyIconEl.setAttribute("aria-label", "Craft a reply to selected text");
    replyIconEl.textContent = "\u2709";

    replyIconEl.addEventListener("click", onReplyClick);
    shadowRoot.appendChild(replyIconEl);
    return replyIconEl;
  }

  function createSummaryIcon() {
    if (summaryIconEl) return summaryIconEl;

    summaryIconEl = document.createElement("div");
    summaryIconEl.className = "ht-summary-icon";
    summaryIconEl.title = "Summarize as TL;DR";
    summaryIconEl.setAttribute("role", "button");
    summaryIconEl.setAttribute("aria-label", "Summarize selected text as TL;DR");
    summaryIconEl.textContent = "\u2211"; // ∑

    summaryIconEl.addEventListener("click", onSummaryClick);
    shadowRoot.appendChild(summaryIconEl);
    return summaryIconEl;
  }

  function createPopup() {
    if (popupEl) return popupEl;

    popupEl = document.createElement("div");
    popupEl.className = "ht-translate-popup";

    const copyBtn = document.createElement("button");
    copyBtn.className = "ht-copy-btn";
    copyBtn.setAttribute("aria-label", "Copy result");
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy to clipboard";

    const replaceBtn = document.createElement("button");
    replaceBtn.className = "ht-replace-btn";
    replaceBtn.setAttribute("aria-label", "Replace original text");
    replaceBtn.textContent = "Replace";
    replaceBtn.title = "Replace selected text with result";
    replaceBtn.style.display = "none"; // hidden by default, shown per-action

    const closeBtn = document.createElement("button");
    closeBtn.className = "ht-close-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "\u00D7"; // multiplication sign (x-like)

    const sourceDiv = document.createElement("div");
    sourceDiv.className = "ht-source";

    const loadingDiv = document.createElement("div");
    loadingDiv.className = "ht-loading";

    const resultDiv = document.createElement("div");
    resultDiv.className = "ht-result";

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "ht-actions";
    actionsDiv.appendChild(copyBtn);
    actionsDiv.appendChild(replaceBtn);

    popupEl.appendChild(actionsDiv);
    popupEl.appendChild(closeBtn);
    popupEl.appendChild(sourceDiv);
    popupEl.appendChild(loadingDiv);
    popupEl.appendChild(resultDiv);

    copyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const resultEl = popupEl.querySelector(".ht-result");
      if (!resultEl || !resultEl.textContent) return;

      navigator.clipboard.writeText(resultEl.textContent).then(function () {
        copyBtn.textContent = "Copied!";
        // Dismiss the popup shortly after copying (brief flash for feedback).
        setTimeout(closePopup, 500);
      });
    });

    replaceBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var resultEl = popupEl.querySelector(".ht-result");
      if (!resultEl || !resultEl.textContent) return;

      replaceBtn.textContent = "...";
      replaceSelectedText(resultEl.textContent).then(function (success) {
        if (success) {
          closePopup();
        } else {
          replaceBtn.textContent = "Failed";
          setTimeout(function () {
            replaceBtn.textContent = "Replace";
          }, 1500);
        }
      });
    });

    closeBtn.addEventListener("click", closePopup);
    shadowRoot.appendChild(popupEl);
    return popupEl;
  }

  function removeIcon() {
    if (iconEl) {
      iconEl.remove();
      iconEl = null;
    }
  }

  function removeHumanizeIcon() {
    if (humanizeIconEl) {
      humanizeIconEl.remove();
      humanizeIconEl = null;
    }
  }

  function removeReplyIcon() {
    if (replyIconEl) {
      replyIconEl.remove();
      replyIconEl = null;
    }
  }

  function removeSummaryIcon() {
    if (summaryIconEl) {
      summaryIconEl.remove();
      summaryIconEl = null;
    }
  }

  function removePopup() {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Listen for selection events from the main-world script (content-main.js).
  // ---------------------------------------------------------------------------

  document.addEventListener("__ht_sel", function (e) {
    injectedSel = e.detail || null;
    console.log("[HT] Received __ht_sel event, text:", injectedSel ? injectedSel.text.substring(0, 30) : "(null)");
  });
  document.addEventListener("__ht_sel_clear", function () {
    injectedSel = null;
  });

  // ---------------------------------------------------------------------------
  // Selection helpers
  // ---------------------------------------------------------------------------

  function getSelectedText() {
    // Prefer main-world selection data (fixes Brave isolation issue).
    if (injectedSel && injectedSel.text) return injectedSel.text;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return "";
    return selection.toString().trim();
  }

  /**
   * Returns a { top, left } position for the icon, placed at the end of the
   * last range in the current selection.
   */
  function getSelectionPosition() {
    // Prefer mouse position for icon placement (more reliable than rect
    // inside modals/overlays with CSS transforms).
    if (lastMousePos) {
      let _top = lastMousePos.clientY + 10;
      let _left = lastMousePos.clientX + 10;
      const _vw = window.innerWidth;
      const _vh = window.innerHeight;
      if (_left + 36 > _vw) _left = lastMousePos.clientX - 44;
      if (_top + 36 > _vh) _top = lastMousePos.clientY - 44;
      if (_top < 4) _top = 4;
      if (_left < 4) _left = 4;
      return { top: _top, left: _left };
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return { top: 0, left: 0 };
    }

    // Use the last range that has a non-zero bounding rect.
    let bestRect = null;
    for (let i = selection.rangeCount - 1; i >= 0; i--) {
      const range = selection.getRangeAt(i);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        bestRect = rect;
        break;
      }
    }

    // Fallback: try the focus node directly
    if (!bestRect) {
      try {
        const node = selection.focusNode;
        const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        bestRect = el.getBoundingClientRect();
      } catch (e) {
        // ignore
      }
    }

    if (!bestRect) return { top: 0, left: 0 };

    // Return the selection bottom-right corner; showIcon() places icons upward from here.
    let top = bestRect.bottom;
    let left = bestRect.right + 4;

    // Clamp within viewport.
    const vw = window.innerWidth;

    if (left + 36 > vw) {
      left = vw - 40;
    }

    return { top, left };
  }

  // ---------------------------------------------------------------------------
  // Show / hide
  // ---------------------------------------------------------------------------

  function showIcon() {
    const text = getSelectedText();
    console.log("[HT] showIcon in", window.location.hostname, "text:", text ? text.substring(0, 40) : "(empty)");
    if (!text) {
      dismiss();
      return;
    }

    savedText = text; // Save for click handler — selection may be cleared by the click itself

    // Clone the current selection Range for potential text replacement
    savedRange = null;
    savedEditableEl = null;
    const _sel = window.getSelection();
    if (_sel && _sel.rangeCount > 0 && !_sel.isCollapsed) {
      try { savedRange = _sel.getRangeAt(0).cloneRange(); } catch (e) { /* not clonable */ }
      // Save the contenteditable ancestor so we can re-query text if savedRange goes stale
      if (savedRange) {
        let _node = savedRange.commonAncestorContainer;
        if (_node && _node.nodeType === Node.TEXT_NODE) _node = _node.parentNode;
        while (_node && _node !== document.body) {
          if (_node.isContentEditable) { savedEditableEl = _node; break; }
          _node = _node.parentNode;
        }
      }
    }

    // If content script couldn't see the selection (e.g., LinkedIn, Brave),
    // try to find the editable element via the main-world relayed marker.
    if (!savedEditableEl && injectedSel && injectedSel.editableId) {
      var el = document.querySelector('[data-ht-editable="' + injectedSel.editableId + '"]');
      if (el) {
        savedEditableEl = el;
        console.log("[HT] Found editable element via main-world marker:", injectedSel.editableId);
      } else {
        console.log("[HT] marker not found in DOM:", injectedSel.editableId);
      }
    }

    // Fallback: search all contenteditable or marked elements for the selected text.
    if (!savedEditableEl && savedText) {
      var candidates = document.querySelectorAll("[contenteditable='true'], [contenteditable=''], [data-ht-editable], [role='textbox'], textarea");
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].textContent && candidates[i].textContent.indexOf(savedText) !== -1) {
          savedEditableEl = candidates[i];
          console.log("[HT] Found editable element via fallback search:", candidates[i].tagName);
          break;
        }
      }
    }

    console.log("[HT] showIcon: savedRange:", !!savedRange, "savedEditableEl:", !!savedEditableEl, "savedText:", savedText.substring(0, 30));

    const icon = createIcon();
    refreshTranslateIconLabel(text);
    const { top, left } = getSelectionPosition();
    const GAP = 36;
    const ICON_H = 28; // icon height in px

    // Icons go upward from selection bottom — last icon top edge at selection line.
    const base = top - ICON_H;

    icon.style.top = (base - GAP * 3) + "px";
    icon.style.left = left + "px";
    icon.style.display = "block";

    const humanizeIcon = createHumanizeIcon();
    humanizeIcon.style.top = (base - GAP * 2) + "px";
    humanizeIcon.style.left = left + "px";
    humanizeIcon.style.display = "block";

    const replyIcon = createReplyIcon();
    replyIcon.style.top = (base - GAP) + "px";
    replyIcon.style.left = left + "px";
    replyIcon.style.display = "block";

    const summaryIcon = createSummaryIcon();
    summaryIcon.style.top = base + "px";
    summaryIcon.style.left = left + "px";
    summaryIcon.style.display = "block";

    resetDismissTimer();
  }

  /** Expand popup width to fit content (up to viewport limit). */
  function resizePopupToFit() {
    if (!popupEl) return;
    const vw = window.innerWidth;
    const maxWidth = vw - 16; // leave 8px margin each side

    // Temporarily remove width constraints to measure natural content width.
    popupEl.style.width = "auto";
    popupEl.style.minWidth = "0";

    // Measure the content's ideal width (scrollWidth includes overflow).
    const contentWidth = popupEl.scrollWidth;
    const targetWidth = Math.min(Math.max(contentWidth, 200), maxWidth);

    popupEl.style.width = targetWidth + "px";
    popupEl.style.minWidth = "200px";
  }

  function positionPopup() {
    if (!popupEl) return;

    // Position relative to whichever icon triggered it.
    let anchorEl = summaryIconEl || replyIconEl || humanizeIconEl || iconEl;
    if (!anchorEl) return;

    const anchorRect = anchorEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const margin = 8;
    const gap = 6;

    // Clear any stale transform left over from a previous call — popupEl is
    // reused across show/hide cycles, not recreated.
    popupEl.style.transform = "";

    // NO height cap and NO scrolling — the popup grows to show its FULL
    // content. Without a max-height there is nothing to scroll, so the whole
    // returned text is always visible.
    popupEl.style.maxHeight = "none";

    // Size width to content first, then measure the full natural height.
    resizePopupToFit();
    const popupWidth = popupEl.offsetWidth;
    const popupHeight = popupEl.offsetHeight;

    // Keep popup within viewport horizontally (both edges).
    let left = anchorRect.left;
    if (left + popupWidth > vw - margin) left = vw - popupWidth - margin;
    if (left < margin) left = margin;
    popupEl.style.left = left + "px";

    // Vertical placement: prefer below the anchor; if the full content doesn't
    // fit below, place it above; and always keep the TOP on-screen so the
    // whole popup (buttons + full content) is shown without scrolling.
    const spaceBelow = vh - anchorRect.bottom - margin;
    let top;
    if (popupHeight + gap <= spaceBelow) {
      top = anchorRect.bottom + gap;
    } else {
      top = anchorRect.top - gap - popupHeight; // place above the icon
      if (top < margin) top = margin;           // never let the top go off-screen
    }
    popupEl.style.top = top + "px";

    // Diagnostic marker: if this line does NOT appear in the console when the
    // popup shows, the browser is running a cached OLD content.js (reload the
    // extension in chrome://extensions to pick up this file).
    console.log("[HT] positionPopup v5-full — vh:", vh, "popupHeight:", popupHeight,
      "maxHeight:", popupEl.style.maxHeight, "top:", Math.round(top), "(no scroll, full content)");
  }

  function showPopup(translatedText, sourceText, actionType) {
    const popup = createPopup();
    const sourceEl = popup.querySelector(".ht-source");
    const loadingEl = popup.querySelector(".ht-loading");
    const resultEl = popup.querySelector(".ht-result");
    const replaceBtn = popup.querySelector(".ht-replace-btn");

    loadingEl.style.display = "none";
    sourceEl.style.display = sourceText ? "block" : "none";
    replaceBtn.style.display = (actionType === "translate" || actionType === "improve") ? "" : "none";

    if (sourceText && sourceText.length > MAX_SOURCE_LENGTH) {
      sourceText = sourceText.substring(0, MAX_SOURCE_LENGTH) + "...";
    }
    sourceEl.textContent = sourceText || "";
    resultEl.textContent = translatedText;
    popup.style.display = "block";

    // Auto-resize to fit content, then reposition.
    resizePopupToFit();
    positionPopup();
    // Don't auto-dismiss the popup — let user close it manually.
    clearDismissTimer();
  }

  function showLoading() {
    const popup = createPopup();
    const sourceEl = popup.querySelector(".ht-source");
    const loadingEl = popup.querySelector(".ht-loading");
    const resultEl = popup.querySelector(".ht-result");

    loadingEl.style.display = "block";
    resultEl.textContent = "";
    sourceEl.textContent = "";
    sourceEl.style.display = "none";
    popup.style.display = "block";

    resizePopupToFit();
    positionPopup();
  }

  function dismiss() {
    // Never auto-remove the popup — only explicit user action (close button / Escape) can close it.
    // This prevents X.com Draft.js and other frameworks from dismissing the popup via synthetic events.
    removeIcon();
    removeHumanizeIcon();
    removeReplyIcon();
    removeSummaryIcon();
    clearDismissTimer();
    isTranslating = false;
  }

  function closePopup() {
    // Explicit close — remove everything including the popup.
    removePopup();
    removeIcon();
    removeHumanizeIcon();
    removeReplyIcon();
    removeSummaryIcon();
    clearDismissTimer();
    isTranslating = false;
    savedRange = null;
  }

  function resetDismissTimer() {
    clearDismissTimer();
    dismissTimer = setTimeout(dismiss, DISMISS_TIMEOUT_MS);
  }

  function clearDismissTimer() {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }

  function startSelectionPolling() {
    var _pollCount = 0;
    setInterval(function () {
      // Only poll if no popup is currently shown
      if (popupEl) return;
      var text = getSelectedText();
      var rawSel = window.getSelection();
      _pollCount++;
      if (_pollCount % 6 === 0) {
        // Log every ~3 seconds (6 x 500ms) regardless of selection state
        console.log("[HT] HEARTBEAT", window.location.hostname,
          "sel:", text ? text.substring(0, 30) : "(empty)",
          "collapsed:", rawSel ? rawSel.isCollapsed : "no-sel",
          "rangeCount:", rawSel ? rawSel.rangeCount : 0,
          "icon:", !!iconEl);
      }
      if (text && !iconEl) {
        showIcon();
      } else if (!text && iconEl && !popupEl) {
        // Selection was cleared while polling
        dismiss();
      }
    }, POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function onIconClick(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText(); // Use saved text first (selection may be cleared on click)
    if (!text || isTranslating) return;

    isTranslating = true;
    showLoading();

    sendMessageSafe("translate", text).then((response) => {
      isTranslating = false;

      if (response.error === 'CONTEXT_INVALID') {
        showPopup("Extension reloaded. Please refresh the page.", text);
        return;
      }

      if (response.success) {
        showPopup(response.translatedText, text, "translate");
      } else {
        var fallback =
          response && response.translatedText
            ? response.translatedText
            : "Translation failed. Please try again.";
        showPopup(fallback, text);
      }
    });
  }

  function onHumanizeClick(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText(); // Use saved text first (selection may be cleared on click)
    if (!text || isTranslating) return;

    isTranslating = true;
    showLoading();

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("improve", text, { languageCode: languageCode })).then((response) => {
      isTranslating = false;

      if (response.error === 'CONTEXT_INVALID') {
        showPopup("Extension reloaded. Please refresh the page.", text);
        return;
      }

      if (response.success) {
        showPopup(response.translatedText, text, "improve");
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
            : "Failed to improve text. Please try again.";
        showPopup(fallback, text);
      }
    });
  }

  function onReplyClick(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText();
    if (!text || isTranslating) return;

    isTranslating = true;
    showLoading();

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("reply", text, { languageCode: languageCode })).then((response) => {
      isTranslating = false;

      if (response.error === 'CONTEXT_INVALID') {
        showPopup("Extension reloaded. Please refresh the page.", text);
        return;
      }

      if (response.success) {
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
            : "Failed to craft reply. Please try again.";
        showPopup(fallback, text);
      }
    });
  }

  function onSummaryClick(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText();
    if (!text || isTranslating) return;

    isTranslating = true;
    showLoading();

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("summarize", text, { languageCode: languageCode })).then((response) => {
      isTranslating = false;

      if (response.error === 'CONTEXT_INVALID') {
        showPopup("Extension reloaded. Please refresh the page.", text);
        return;
      }

      if (response.success) {
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
    });
  }

  function onMouseUp(e) {
    // Don't reposition icon when clicking inside the extension's shadow DOM.
    if (isInsideExtension(e)) {
      return;
    }
    // Don't dismiss popup while translating or while popup is showing a result.
    if (isTranslating || popupEl) return;
    // Debounce to avoid flicker while the user is still selecting.
    clearTimeout(debounceTimer);
    lastMousePos = { clientX: e.clientX, clientY: e.clientY };
    console.log("[HT] mouseUp in", window.location.hostname, "target:", e.target && e.target.tagName);
    debounceTimer = setTimeout(function () {
      var text = getSelectedText();
      if (text) {
        showIcon();
      } else {
        dismiss();
      }
    }, DEBOUNCE_MS);
  }

  function onDocumentClick(e) {
    // Only remove floating icons when clicking outside the extension's shadow DOM.
    // The popup stays until explicitly closed (X button or Escape).
    if (!isInsideExtension(e)) {
      removeIcon();
      removeHumanizeIcon();
      removeReplyIcon();
      removeSummaryIcon();
      clearDismissTimer();
      isTranslating = false;
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      closePopup();
    }
  }

  function onSelectionChange() {
    // Don't dismiss while translating or while popup is showing a result.
    // Clicking the icon clears the selection, but we want the popup to stay.
    if (isTranslating || popupEl) return;
    // Handle both: showing icon on NEW selection and dismissing on deselection.
    // This is critical for rich-text editors (Quill, contenteditable) where
    // mouseup/pointerup events may be suppressed by the host page.
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      var text = getSelectedText();
      console.log("[HT] selChange in", window.location.hostname, "text:", text ? text.substring(0, 40) : "(empty)");
      if (text && !popupEl) {
        showIcon();
      } else if (!text && (iconEl || humanizeIconEl || replyIconEl || summaryIconEl)) {
        dismiss();
      }
    }, DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  if (!initShadowDOM()) {
    console.log("[HT] Unsupported document for toolbar UI:", window.location.href);
    return;
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("pointerup", onMouseUp, true);  // touch / stylus support
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("selectionchange", onSelectionChange, true);

  // Also listen on mousedown for sites that prevent mouseup propagation.
  document.addEventListener("mousedown", function () {
    // Clear debounce on mousedown start of a new selection.
    clearTimeout(debounceTimer);
  }, true);
  document.addEventListener("pointerdown", function () {
    // Clear debounce on pointerdown (touch / stylus) start of a new selection.
    clearTimeout(debounceTimer);
  }, true);

  // Watch for dynamically added iframes and ensure content scripts run.
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      for (var j = 0; j < mutations[i].addedNodes.length; j++) {
        var node = mutations[i].addedNodes[j];
        if (node.nodeName === "IFRAME" || (node.querySelector && node.querySelector("iframe"))) {
          // The content script should auto-inject via all_frames:true,
          // but some dynamically loaded iframes may need a nudge.
          // We'll re-attach our document listeners just in case.
          try {
            var doc = node.contentDocument || (node.nodeName === "IFRAME" ? null : null);
            if (doc) {
              doc.addEventListener("mouseup", onMouseUp, true);
              doc.addEventListener("click", onDocumentClick, true);
              doc.addEventListener("keydown", onKeyDown, true);
            }
          } catch (e) {
            // Cross-origin iframe — cannot access, all_frames should handle it.
          }
        }
      }
    }
  });
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });

  console.log("[HT] INIT COMPLETE in", window.location.hostname);

  // Inject MAIN-world script via script src tag (bypasses page CSP).
  // LinkedIn's CSP allows chrome-extension:// scripts but blocks inline scripts.
  var mainScript = document.createElement("script");
  mainScript.src = chrome.runtime.getURL("content-main.js");
  (document.head || document.documentElement).appendChild(mainScript);
  mainScript.onload = function () {
    console.log("[HT] MAIN-world script loaded via src tag");
    mainScript.remove();
  };
  mainScript.onerror = function () {
    console.error("[HT] MAIN-world script failed to load");
  };

  startSelectionPolling();
})();
