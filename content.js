/**
 * Content script for Highlight Translate.
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

  let iconEl = null;
  let humanizeIconEl = null;
  let popupEl = null;
  let dismissTimer = null;
  let debounceTimer = null;
  let isTranslating = false;
  let injectedSel = null; // selection data relayed from main-world script
  let lastMousePos = null; // Tracks mouse position for icon placement
  let savedText = ""; // Selected text saved when icon appears (prevents race on click)

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
    console.log("[HT] Appending icon to body in", window.location.hostname);
    document.body.appendChild(iconEl);
    return iconEl;
  }

  function createHumanizeIcon() {
    if (humanizeIconEl) return humanizeIconEl;

    humanizeIconEl = document.createElement("div");
    humanizeIconEl.className = "ht-humanize-icon";
    humanizeIconEl.title = "Improve text";
    humanizeIconEl.setAttribute("role", "button");
    humanizeIconEl.setAttribute("aria-label", "Improve selected text");
    humanizeIconEl.textContent = "\u2728"; // sparkle

    humanizeIconEl.addEventListener("click", onHumanizeClick);
    document.body.appendChild(humanizeIconEl);
    return humanizeIconEl;
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

    popupEl.appendChild(copyBtn);
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
        setTimeout(function () {
          copyBtn.textContent = "Copy";
        }, 1500);
      });
    });

    closeBtn.addEventListener("click", closePopup);
    document.body.appendChild(popupEl);
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

    // Place icon at the end of the selection.
    let top = bestRect.bottom + 4;
    let left = bestRect.right + 4;

    // Clamp within viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (left + 36 > vw) {
      left = vw - 40;
    }
    if (top + 36 > vh) {
      top = bestRect.top - 36;
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

    const icon = createIcon();
    const { top, left } = getSelectionPosition();
    icon.style.top = top + "px";
    icon.style.left = left + "px";
    icon.style.display = "block";

    const humanizeIcon = createHumanizeIcon();
    humanizeIcon.style.top = (top + 36) + "px";
    humanizeIcon.style.left = left + "px";
    humanizeIcon.style.display = "block";

    resetDismissTimer();
  }

  function positionPopup() {
    if (!popupEl) return;

    // Position relative to whichever icon triggered it.
    let anchorEl = iconEl || humanizeIconEl;
    if (!anchorEl) return;

    const anchorRect = anchorEl.getBoundingClientRect();
    let top = anchorRect.bottom + 6;
    let left = anchorRect.left;

    // Keep popup within viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popupWidth = 320;

    if (left + popupWidth > vw) {
      left = Math.max(8, vw - popupWidth - 8);
    }
    if (top + 200 > vh) {
      // Not enough room below; flip above the icon.
      top = anchorRect.top - 6;
      popupEl.style.transform = "translateY(-100%)";
    } else {
      popupEl.style.transform = "translateY(0)";
    }

    popupEl.style.top = top + "px";
    popupEl.style.left = left + "px";
  }

  function showPopup(translatedText, sourceText) {
    const popup = createPopup();
    const sourceEl = popup.querySelector(".ht-source");
    const loadingEl = popup.querySelector(".ht-loading");
    const resultEl = popup.querySelector(".ht-result");

    loadingEl.style.display = "none";
    sourceEl.style.display = sourceText ? "block" : "none";

    if (sourceText && sourceText.length > MAX_SOURCE_LENGTH) {
      sourceText = sourceText.substring(0, MAX_SOURCE_LENGTH) + "...";
    }
    sourceEl.textContent = sourceText || "";
    resultEl.textContent = translatedText;
    popup.style.display = "block";

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

    positionPopup();
  }

  function dismiss() {
    // Never auto-remove the popup — only explicit user action (close button / Escape) can close it.
    // This prevents X.com Draft.js and other frameworks from dismissing the popup via synthetic events.
    removeIcon();
    removeHumanizeIcon();
    clearDismissTimer();
    isTranslating = false;
  }

  function closePopup() {
    // Explicit close — remove everything including the popup.
    removePopup();
    removeIcon();
    removeHumanizeIcon();
    clearDismissTimer();
    isTranslating = false;
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

    chrome.runtime.sendMessage(
      { action: "translate", text: text },
      function (response) {
        isTranslating = false;

        if (chrome.runtime.lastError) {
          showPopup("Translation failed. Please try again.", text);
          return;
        }

        if (response && response.success) {
          showPopup(response.translatedText, text);
        } else {
          var fallback =
            response && response.translatedText
              ? response.translatedText
              : "Translation failed. Please try again.";
          showPopup(fallback, text);
        }
      }
    );
  }

  function onHumanizeClick(e) {
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText(); // Use saved text first (selection may be cleared on click)
    if (!text || isTranslating) return;

    isTranslating = true;
    showLoading();

    chrome.runtime.sendMessage(
      { action: "improve", text: text },
      function (response) {
        isTranslating = false;

        if (chrome.runtime.lastError) {
          showPopup("Failed to improve text. Please try again.", text);
          return;
        }

        if (response && response.success) {
          showPopup(response.translatedText, text);
        } else if (response && response.error === "NO_API_KEY") {
          var msg =
            "No API key set. " +
            "<a href='" + chrome.runtime.getURL("options.html") +
            "' target='_blank' style='color:#1a73e8;'>Open settings</a>" +
            " to add your Gemini API key.";
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
        } else {
          var fallback =
            response && response.translatedText
              ? response.translatedText
              : "Failed to improve text. Please try again.";
          showPopup(fallback, text);
        }
      }
    );
  }

  function onMouseUp(e) {
    // Don't reposition icon when clicking the icon itself or the humanize icon.
    if (e.target && (e.target.closest(".ht-translate-icon") || e.target.closest(".ht-humanize-icon") || e.target.closest(".ht-translate-popup"))) {
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
    // Only remove floating icons when clicking outside.
    // The popup stays until explicitly closed (X button or Escape).
    var isInsideIcon = iconEl && iconEl.contains(e.target);
    var isInsideHumanizeIcon = humanizeIconEl && humanizeIconEl.contains(e.target);
    var isInsidePopup = popupEl && popupEl.contains(e.target);

    if (!isInsideIcon && !isInsideHumanizeIcon && !isInsidePopup) {
      removeIcon();
      removeHumanizeIcon();
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
      } else if (!text && (iconEl || humanizeIconEl)) {
        dismiss();
      }
    }, DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

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
