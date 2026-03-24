/**
 * Content script for Highlight Translate.
 * Shows a floating icon when text is selected, and displays translation popup on click.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DEBOUNCE_MS = 300;
  const DISMISS_TIMEOUT_MS = 5000;
  const MAX_SOURCE_LENGTH = 500; // characters to show in the source preview

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let iconEl = null;
  let popupEl = null;
  let dismissTimer = null;
  let debounceTimer = null;
  let isTranslating = false;

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
    document.body.appendChild(iconEl);
    return iconEl;
  }

  function createPopup() {
    if (popupEl) return popupEl;

    popupEl = document.createElement("div");
    popupEl.className = "ht-translate-popup";

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

    popupEl.appendChild(closeBtn);
    popupEl.appendChild(sourceDiv);
    popupEl.appendChild(loadingDiv);
    popupEl.appendChild(resultDiv);

    closeBtn.addEventListener("click", dismiss);
    document.body.appendChild(popupEl);
    return popupEl;
  }

  function removeIcon() {
    if (iconEl) {
      iconEl.remove();
      iconEl = null;
    }
  }

  function removePopup() {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Selection helpers
  // ---------------------------------------------------------------------------

  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return "";
    return selection.toString().trim();
  }

  /**
   * Returns a { top, left } position for the icon, placed at the end of the
   * last range in the current selection.
   */
  function getSelectionPosition() {
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
    if (!text) {
      dismiss();
      return;
    }

    const icon = createIcon();
    const { top, left } = getSelectionPosition();
    icon.style.top = top + "px";
    icon.style.left = left + "px";
    icon.style.display = "block";

    resetDismissTimer();
  }

  function positionPopup() {
    if (!popupEl || !iconEl) return;

    const iconRect = iconEl.getBoundingClientRect();
    let top = iconRect.bottom + 6;
    let left = iconRect.left;

    // Keep popup within viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popupWidth = 320;

    if (left + popupWidth > vw) {
      left = Math.max(8, vw - popupWidth - 8);
    }
    if (top + 200 > vh) {
      // Not enough room below; flip above the icon.
      top = iconRect.top - 6;
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
    resetDismissTimer();
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
    removePopup();
    removeIcon();
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

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function onIconClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const text = getSelectedText();
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

  function onMouseUp(e) {
    // Don't reposition icon when clicking the icon itself.
    if (e.target && (e.target.closest('.ht-translate-icon') || e.target.closest('.ht-translate-popup'))) {
      return;
    }
    // Debounce to avoid flicker while the user is still selecting.
    clearTimeout(debounceTimer);
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
    // Dismiss if clicking outside the icon or popup.
    if (
      iconEl && !iconEl.contains(e.target) &&
      popupEl && !popupEl.contains(e.target)
    ) {
      dismiss();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      dismiss();
    }
  }

  function onSelectionChange() {
    // If the user changes the selection while popup is visible, dismiss.
    if (popupEl || iconEl) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var text = getSelectedText();
        if (!text) {
          dismiss();
        }
      }, DEBOUNCE_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("selectionchange", onSelectionChange, true);
})();
