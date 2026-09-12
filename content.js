/**
 * Content script for UniLingo.
 * Shows a floating icon when text is selected, and displays translation popup on click.
 */

(function () {
  "use strict";

  // If the extension was reloaded/updated while this page stayed open, the old
  // content script's runtime context is invalidated and chrome.runtime.getURL()
  // returns "chrome-extension://invalid/". Bail out immediately so we never
  // issue failed fetches or inject dead script tags.
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      // Isolated-world runtime is dead. This is a SAME-world check only — the
      // MAIN world has its own window object and cannot observe this flag.
      console.log("[HT] extension context invalid, aborting");
      return;
    }
  } catch (e) {
    return;
  }

  // Returns a safe extension URL, or "#" when the runtime context is invalid
  // (chrome.runtime.getURL() then yields "chrome-extension://invalid/" which
  // pollutes the console with failed GETs). Never call getURL directly.
  function htExtUrl(path) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return "#";
      var u = chrome.runtime.getURL(path);
      if (!u || u.indexOf("invalid") !== -1) return "#";
      return u;
    } catch (e) {
      return "#";
    }
  }

  // ---------------------------------------------------------------------------
  // Security / anti-bot guard
  //
  // Do NOT run on security-critical pages or frames. Cloudflare's Turnstile
  // challenge (and other anti-bot verifiers) treat extensions that observe
  // their DOM, re-attach listeners into dynamically created iframes, or poll
  // window.getSelection() as automation signals, which makes the challenge
  // fail with "Human Verify Check Failed". We must stay completely invisible
  // on these pages/frames.
  // ---------------------------------------------------------------------------

  function isSecurityPage() {
    try {
      var href = window.location.href || "";
      var host = window.location.hostname || "";
      if (
        /^https?:\/\/([^\/]*\.)?challenges\.cloudflare\.com/i.test(href) ||
        /cdn-cgi\/challenge/i.test(href) ||
        /\/challenge-platform\//i.test(href) ||
        /\/_\/hc\//i.test(href) ||
        /turnstile/i.test(host) ||
        host === "challenges.cloudflare.com"
      ) {
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function isSubframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      // Cross-origin access to window.top is blocked — we are in a subframe.
      return true;
    }
  }

  // Never run inside Cloudflare challenge frames, and only run in the top
  // frame. Subframes (ad iframes, embedded widgets, login iframes, payment
  // frames, etc.) are where anti-bot verifiers live and are where our
  // event interception / selection polling is most likely to be flagged.
  if (isSecurityPage() || isSubframe()) {
    console.log("[HT] Skipping injection in", window.location.href, "(security page or subframe)");
    return;
  }

  console.log("[HT] LOADED frame:", window.location.href, "body:", !!document.body);

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DEBOUNCE_MS = 300;
  const CLEAR_DEBOUNCE_MS = 800;
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
  let socialIconEl = null;
  let toolbarEl = null; // single popover container for all 5 icons
  let toolbarVisible = false;
  let lastUiRoot = null; // last root the toolbar was ensured into (modal host tracking)
  let popupEl = null;
  let dismissTimer = null;
  let debounceTimer = null;
  let isTranslating = false;
  let injectedSel = null; // selection data relayed from main-world script
  let lastInjectedSelTime = 0; // Date.now() of last __ht_sel with text (freshness check)
  let clearInjectedSelTimer = null; // debounced __ht_sel_clear (survives composer re-render)

  // Isolated-world getSelection() is unreliable inside LinkedIn's contenteditable
  // (farbling / Draft.js); a fresh main-world injectedSel is the source of truth.
  function hasFreshInjectedSel(ms) {
    if (typeof ms !== "number") ms = 1500;
    return !!(
      injectedSel &&
      injectedSel.text &&
      Date.now() - lastInjectedSelTime < ms
    );
  }

  // Native LIVE non-collapsed selection with real text. Isolated-world
  // getSelection() may be unreliable inside editors, but a collapsed/empty
  // result is trustworthy evidence that NO text is selected (the bug: caret
  // inside a word must never surface the toolbar).
  function hasLiveSelection() {
    try {
      var s = window.getSelection();
      if (!s || s.rangeCount < 1 || s.isCollapsed) return false;
      return s.toString().trim().length >= 2;
    } catch (e) {
      return false;
    }
  }

  // Form-field (<input>/<textarea>) selection lives in its own shadow tree,
  // so it is invisible to getSelection() but still a real user selection.
  function hasLiveFormFieldSelection() {
    try {
      var ae = document.activeElement;
      if (!ae) return false;
      if (ae.tagName === "TEXTAREA" ||
          (ae.tagName === "INPUT" && ae.type !== "hidden" && ae.type !== "password")) {
        return typeof ae.selectionStart === "number" && ae.selectionEnd > ae.selectionStart;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // The single source of truth for "may a toolbar appear right now?". A stale
  // main-world injectedSel alone is NEVER sufficient; it must be fresh AND
  // corroborated by a live native or form-field selection.
  function hasLiveSelectionSource() {
    return hasLiveSelection() || hasLiveFormFieldSelection();
  }
  let lastMousePos = null; // Tracks mouse position for toolbar placement
  // Authoritative on-screen rect of the toolbar, captured BEFORE hideToolbar()
  // sets display:none (which zeroes getBoundingClientRect on the anchor icon).
  // positionPopup() prefers this so the popup anchors to the cursor, not (8,8).
  let lastAnchorRect = null; // {left,top,right,bottom,width,height} | null
  let lastMouseTime = 0; // Date.now() of last mouse move/up (freshness check)
  let savedText = ""; // Selected text saved when icon appears (prevents race on click)
  let savedRange = null; // Cloned Range for text replacement
  let savedEditableEl = null; // contenteditable ancestor for re-querying stale ranges
  let refocusEditableEl = null; // element to refocus after the popup closes (post-replace)
  let iconLabelRequestId = 0;
  let selectedLanguageText = "";
  let selectedLanguageCode = "";
  let lastToolbarPressTime = 0; // Guards dismissal when mouse events land on the toolbar
  let lastHandledPressTime = 0; // Dedupe pointerdown vs click activation (one action per press)

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

    // LIGHT DOM: the toolbar/popup are promoted to the top layer via the
    // Popover API. Chrome has hit-testing bugs with popover elements inside
    // shadow roots (icons visible but clicks do nothing, e.g. inside the
    // LinkedIn dialog). Light DOM + showPopover is reliable. Styles are
    // injected via an adopted <link> in document.head; ht- class names avoid
    // host-page CSS collisions.
    shadowHost = null;
    shadowRoot = null;

    // Inline critical toolbar CSS via <style id="ht-content-styles"> instead of
    // a <link> in <head>: injected ONCE with an id check, and textContent set
    // asynchronously — no render-blocking network injection into <head> that
    // could trigger host-page hydration mismatches (React error #418).
    if (!document.getElementById("ht-content-styles")) {
      var styleEl = createHtmlElement("style");
      styleEl.id = "ht-content-styles";
      document.head.appendChild(styleEl);
      var cssUrl = "";
      try { cssUrl = chrome.runtime.getURL("content.css"); } catch (e) {}
      if (!cssUrl || cssUrl.indexOf("invalid") !== -1) {
        console.log("[HT] skip CSS fetch, context invalid");
      } else {
        fetch(cssUrl)
          .then(function (r) { return r.text(); })
          .then(function (css) { styleEl.textContent = css; })
          .catch(function (e) {
            if (!initShadowDOM._cssErrLogged) {
              initShadowDOM._cssErrLogged = true;
              console.log("[HT] CSS fetch failed (falling back to UA styles):", e && e.message);
            }
          });
      }
    }
    return true;
  }

  // Find the topmost open modal <dialog>. showModal() makes everything
  // OUTSIDE the dialog inert for hit-testing — top-layer popovers anchored to
  // body still paint above but do NOT receive pointer events. To stay
  // clickable, our UI must live INSIDE the open dialog itself. Prefer a real
  // `dialog[open]` (that is what applies inertness); otherwise a large visible
  // role=dialog container; null when no modal is present.
  function getModalHost() {
    var ds = document.querySelectorAll("dialog[open],[role=dialog]");
    for (var i = ds.length - 1; i >= 0; i--) {
      var d = ds[i];
      try {
        if (d.open && d.matches("dialog")) return d;
      } catch (e) {}
    }
    for (var j = ds.length - 1; j >= 0; j--) {
      var d2 = ds[j];
      var r = d2.getBoundingClientRect();
      if (r.width > 200 && r.height > 200) return d2;
    }
    return null;
  }

  function getUiRoot() {
    var host = getModalHost();
    if (host) {
      try {
        if (!host.hasAttribute("data-ht-host")) host.setAttribute("data-ht-host", "1");
      } catch (e) {}
      return host;
    }
    return document.body || document.documentElement;
  }

  // Append the UI node into the resolved UI root exactly once. When the root
  // is LinkedIn's React-managed dialog, appending our own (unknown-to-React)
  // child is safe because React does not remove foreign children — but the
  // append must never throw, so fall back to document.body on failure.
  function ensureInRoot(el) {
    var target = getUiRoot();
    if (!el) return target;
    if (el.parentNode === target) return target;
    try {
      demoteFromTopLayer(el); // promote later; never leave a stale shown popover on a moved node
      target.appendChild(el);
    } catch (e) {
      try {
        demoteFromTopLayer(el);
        (document.body || document.documentElement).appendChild(el);
        return document.body;
      } catch (e2) {
        /* leave wherever it is; never throw */
      }
    }
    return el.parentNode || target;
  }

  // ---------------------------------------------------------------------------
  // Helper for event handling inside Shadow DOM
  // ---------------------------------------------------------------------------

  function isInsideExtension(e) {
    // Guard via closest() so clicks anywhere on the toolbar/popup (including
    // child icons and text nodes) never trigger outside-dismiss logic.
    var t = e.target;
    if (t && typeof t.closest === "function" && t.closest("#ht-toolbar, #ht-popup")) return true;
    if (toolbarEl && (toolbarEl === t || toolbarEl.contains(t))) return true;
    if (popupEl && (popupEl === t || popupEl.contains(t))) return true;
    // Legacy: keep composedPath check for any shadow remnants.
    return shadowHost != null && e.composedPath().indexOf(shadowHost) !== -1;
  }

  // Stamp the time of the most recent mouse interaction with the toolbar.
  // A fresh press suppresses any dismissal (dismiss()/onDocumentClick) for a
  // short window so pressing a button cannot hide the toolbar before its
  // click handler runs — even if the host page clears the selection first.
  function recordToolbarPress() {
    lastToolbarPressTime = Date.now();
  }

  function isRecentToolbarPress() {
    return Date.now() - lastToolbarPressTime < 500;
  }

  // Shared activation for toolbar icon presses. pointerdown fires BEFORE the
  // host page (LinkedIn modal) can blur/clear the selection and before any
  // capture-phase dismiss handler runs, so activating here wins the race;
  // the click that follows within 500ms is deduped via lastHandledPressTime.
  function handleIconPress(e, handler) {
    e.preventDefault();
    e.stopPropagation();
    recordToolbarPress();
    // Capture the toolbar's on-screen rect BEFORE hiding: hideToolbar() sets
    // display:none, after which getBoundingClientRect() returns zeros and
    // positionPopup() would clamp to (8,8). lastAnchorRect keeps the popup
    // anchored to the cursor/toolbar position.
    captureToolbarRect();
    // Hide the 5-icon toolbar immediately, before handler(e), so no poll or
    // selectionchange can re-show it mid-request. hideToolbar() only toggles
    // visibility (display/:popover-open) — it does NOT touch savedText or
    // isTranslating, so the in-flight request keeps its captured text.
    hideToolbar();
    var now = Date.now();
    if (now - lastHandledPressTime < 500) return; // click after pointerdown: already handled
    lastHandledPressTime = now;
    handler(e);
  }

  // Snapshot the visible toolbar's rect into lastAnchorRect (ignores zero-size
  // i.e. hidden/not-yet-laid-out elements).
  function captureToolbarRect() {
    if (!toolbarEl) return;
    var r = toolbarEl.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      lastAnchorRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
  }

  // Attach both pointerdown and click activation to an icon div.
  function bindIconActivation(iconEl, handler) {
    iconEl.addEventListener("pointerdown", function (e) {
      handleIconPress(e, handler);
    });
    iconEl.addEventListener("click", function (e) {
      handleIconPress(e, handler);
    });
  }

  // Delegated activation in CAPTURE phase. Bubble-phase per-icon listeners are
  // unreliable when the toolbar is in the top layer (popover retargeting /
  // listener-world mismatch); document-level capture listeners always see the
  // event, same as the dismiss handlers that do fire.
  function routeIconPress(ic, e) {
    var name, handler;
    if (ic.classList.contains("ht-translate-icon")) { name = "translate"; handler = onIconClick; }
    else if (ic.classList.contains("ht-humanize-icon")) { name = "humanize"; handler = onHumanizeClick; }
    else if (ic.classList.contains("ht-reply-icon")) { name = "reply"; handler = onReplyClick; }
    else if (ic.classList.contains("ht-summary-icon")) { name = "summary"; handler = onSummaryClick; }
    else if (ic.classList.contains("ht-social-icon")) { name = "social"; handler = onSocialClick; }
    if (!handler) return;
    console.log("[HT] ICON PRESS-DELEGATED", name);
    handleIconPress(e, handler);
  }

  document.addEventListener("pointerdown", function (e) {
    var ic = e.target && e.target.closest ? e.target.closest("#ht-toolbar .ht-icon") : null;
    if (!ic) return;
    e.preventDefault();
    e.stopPropagation();
    recordToolbarPress();
    routeIconPress(ic, e);
  }, true);

  // Same delegated path for "click" so keyboard/AT activation still works;
  // lastHandledPressTime dedupes the pointerdown+click double-fire.
  document.addEventListener("click", function (e) {
    var ic = e.target && e.target.closest ? e.target.closest("#ht-toolbar .ht-icon") : null;
    if (!ic) return;
    e.preventDefault();
    e.stopPropagation();
    recordToolbarPress();
    routeIconPress(ic, e);
  }, true);

  // ---------------------------------------------------------------------------
  // Top-layer promotion (Popover API).
  // Native <dialog showModal>/popover elements render in the browser's top
  // layer, which paints ABOVE any z-index (even 2147483647). Promoting our
  // icons/popup via popover="manual" + showPopover() puts them in that same
  // top layer so they stay visible above modal dialogs (e.g. LinkedIn composer).
  // ---------------------------------------------------------------------------

  function supportsPopover(el) {
    return !!el && typeof el.showPopover === "function" && typeof el.hidePopover === "function";
  }

  function promoteToTopLayer(el) {
    if (!supportsPopover(el)) return false; // graceful fallback: fixed + max z-index
    try {
      if (el.getAttribute("popover") !== "manual") el.setAttribute("popover", "manual");
      if (!el.isConnected) return false; // showing a detached node throws
      if (!el.matches(":popover-open")) el.showPopover(); // no-op-safe if already shown
      return true;
    } catch (e) {
      // Some pages break popover (e.g. InvalidStateError on detached nodes); fall back silently.
      return false;
    }
  }

  function demoteFromTopLayer(el) {
    if (!supportsPopover(el)) return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
    } catch (e) { /* ignore */ }
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
        var editableId = e.detail && e.detail.editableId;
        console.log("[HT] Replace: main-world result:", success, "editableId:", editableId);
        if (success) {
          // NOTE: do NOT clear savedEditableEl before using it below — it is
          // the only handle we have to refocus contenteditable editors (like
          // x.com), whose internal caret/focus is not restored by the
          // replacement itself. Capture what we need, then clear state.
          var focusEl = null;
          if (editableId) {
            focusEl = document.querySelector('[data-ht-editable="' + editableId + '"]');
          } else if (savedEditableEl) {
            focusEl = savedEditableEl;
          }
          // Remember it so closePopup() (which runs right after and removes
          // the popup, stealing focus) can restore it.
          refocusEditableEl = focusEl || null;
          if (focusEl) {
            try { focusEl.focus(); } catch (err) { /* ignore */ }
            if (typeof focusEl.selectionStart === "number" && typeof focusEl.setSelectionRange === "function") {
              try {
                var caret = focusEl.selectionStart || 0;
                focusEl.setSelectionRange(caret, caret);
              } catch (err) { /* ignore */ }
            }
          }
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

  // ---------------------------------------------------------------------------
  // Single toolbar (the ONLY top-layer popover; 5 icon buttons are children).
  // ---------------------------------------------------------------------------

  function createToolbar() {
    if (toolbarEl) return toolbarEl;

    toolbarEl = createHtmlElement("div");
    toolbarEl.id = "ht-toolbar";
    toolbarEl.className = "ht-toolbar";
    toolbarEl.setAttribute("popover", "manual");

    const icon = createHtmlElement("div");
    icon.className = "ht-icon ht-translate-icon";
    icon.title = "Translate to Chinese";
    icon.setAttribute("role", "button");
    icon.setAttribute("aria-label", "Translate selected text");
    icon.textContent = "\u8BD1"; // "译"
    bindIconActivation(icon, onIconClick);
    iconEl = icon;

    const humanizeIcon = createHtmlElement("div");
    humanizeIcon.className = "ht-icon ht-humanize-icon";
    humanizeIcon.title = "Improve text";
    humanizeIcon.setAttribute("role", "button");
    humanizeIcon.setAttribute("aria-label", "Improve selected text");
    humanizeIcon.textContent = "AI";
    bindIconActivation(humanizeIcon, onHumanizeClick);
    humanizeIconEl = humanizeIcon;

    const replyIcon = createHtmlElement("div");
    replyIcon.className = "ht-icon ht-reply-icon";
    replyIcon.title = "Craft a reply";
    replyIcon.setAttribute("role", "button");
    replyIcon.setAttribute("aria-label", "Craft a reply to selected text");
    replyIcon.textContent = "\u2709";
    bindIconActivation(replyIcon, onReplyClick);
    replyIconEl = replyIcon;

    const summaryIcon = createHtmlElement("div");
    summaryIcon.className = "ht-icon ht-summary-icon";
    summaryIcon.title = "Summarize as TL;DR";
    summaryIcon.setAttribute("role", "button");
    summaryIcon.setAttribute("aria-label", "Summarize selected text as TL;DR");
    summaryIcon.textContent = "\u2211"; // ∑
    bindIconActivation(summaryIcon, onSummaryClick);
    summaryIconEl = summaryIcon;

    const socialIcon = createHtmlElement("div");
    socialIcon.className = "ht-icon ht-social-icon";
    socialIcon.title = "Rewrite as social hook";
    socialIcon.setAttribute("role", "button");
    socialIcon.setAttribute("aria-label", "Rewrite selected text as a strong social hook");
    socialIcon.textContent = "\u26A1"; // ⚡
    bindIconActivation(socialIcon, onSocialClick);
    socialIconEl = socialIcon;

    // Keep the text selection alive and guard against dismissal when the user
    // presses down on a button. recordToolbarPress() stamps a timestamp that
    // dismiss() checks, so selection-clearing / debounced dismissals triggered
    // by the mousedown cannot hide the toolbar before the button's click fires.
    toolbarEl.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      recordToolbarPress();
    });
    toolbarEl.addEventListener("mouseup", function (e) {
      e.stopPropagation();
      recordToolbarPress();
    });
    toolbarEl.addEventListener("click", function (e) {
      e.stopPropagation();
      recordToolbarPress();
    });

    toolbarEl.appendChild(icon);
    toolbarEl.appendChild(humanizeIcon);
    toolbarEl.appendChild(replyIcon);
    toolbarEl.appendChild(summaryIcon);
    toolbarEl.appendChild(socialIcon);

    ensureInRoot(toolbarEl);
    return toolbarEl;
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
        // Dismiss the popup after replacing, like the Copy button does.
        closePopup();
      });
    });

    closeBtn.addEventListener("click", closePopup);
    ensureInRoot(popupEl);
    promoteToTopLayer(popupEl);
    return popupEl;
  }

  function hideToolbar() {
    // Hide the single toolbar (guarded hidePopover via :popover-open check).
    if (toolbarEl) {
      try {
        if (toolbarEl.matches(":popover-open")) toolbarEl.hidePopover();
      } catch (e) { /* ignore */ }
      toolbarEl.style.display = "none";
    }
    toolbarVisible = false;
  }

  // Back-compat shims: callers previously removed individual icons; now they
  // all just hide the single toolbar.
  function removeIcon() { hideToolbar(); }
  function removeHumanizeIcon() { hideToolbar(); }
  function removeReplyIcon() { hideToolbar(); }
  function removeSummaryIcon() { hideToolbar(); }
  function removeSocialIcon() { hideToolbar(); }

  function removePopup() {
    if (popupEl) {
      demoteFromTopLayer(popupEl);
      popupEl.remove();
      popupEl = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Listen for selection events from the main-world script (content-main.js).
  // ---------------------------------------------------------------------------

  document.addEventListener("__ht_sel", function (e) {
    injectedSel = e.detail || null;
    if (injectedSel && injectedSel.text) {
      lastInjectedSelTime = Date.now();
      // A fresh selection supersedes any pending debounced clear.
      if (clearInjectedSelTimer) {
        clearTimeout(clearInjectedSelTimer);
        clearInjectedSelTimer = null;
      }
    }
    console.log("[HT] Received __ht_sel event, text:", injectedSel ? injectedSel.text.substring(0, 30) : "(null)");
    // Always (re)schedule the icon using the injected text — even if the popup
    // is already open, a fresh selection must still update savedText. showIcon()
    // itself decides whether to (re)anchor.
    if (injectedSel && injectedSel.text) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        if (hasFreshInjectedSel() && hasLiveSelectionSource()) showIcon();
      }, DEBOUNCE_MS);
    }
  });
  document.addEventListener("__ht_sel_clear", function () {
    // A blur-clear during a toolbar icon press (or while translating) is
    // noise, not user intent — keep the injected selection so freshness
    // guards keep working. lastInjectedSelTime is untouched, so genuine
    // clears still expire naturally after the freshness window.
    // NOTE: toolbarVisible is deliberately NOT checked here — otherwise a
    // genuine deselect after the toolbar is shown could never clear state.
    if (isTranslating || isRecentToolbarPress()) return;
    // A real (LIVE) selection still present means this is a blur-clear, not a
    // deselect. We must NOT use getSelectedText() here: it returns the stale
    // injectedSel.text that this event is about to clear, which would always
    // early-return and re-deadlock the clear.
    var liveSel = window.getSelection();
    if (liveSel && !liveSel.isCollapsed && liveSel.toString().trim()) return;
    // LinkedIn re-renders the composer and collapses the selection within a
    // few hundred ms of our __ht_sel. Nulling injectedSel synchronously would
    // beat the 300ms showIcon debounce (hasFreshInjectedSel → false) and the
    // toolbar would never appear. Debounce the clear so the pending show wins;
    // a follow-up __ht_sel cancels this timer.
    if (clearInjectedSelTimer) clearTimeout(clearInjectedSelTimer);
    clearInjectedSelTimer = setTimeout(function () {
      clearInjectedSelTimer = null;
      if (isTranslating || isRecentToolbarPress()) return;
      if (hasFreshInjectedSel()) return; // a newer selection arrived meanwhile
      injectedSel = null;
      // Genuine deselect: drop the icons too, unless a popup is showing or a
      // press/translation is in flight.
      if (!popupEl && !isTranslating && !isRecentToolbarPress()) hideToolbar();
    }, CLEAR_DEBOUNCE_MS);
  });

  // ---------------------------------------------------------------------------
  // Selection helpers
  // ---------------------------------------------------------------------------

  function getSelectedText() {
    // Form fields keep their selection in a shadow tree; read it directly.
    if (hasLiveFormFieldSelection()) {
      try { return document.activeElement.value.substring(document.activeElement.selectionStart, document.activeElement.selectionEnd).trim(); } catch (e) { /* ignore */ }
    }
    const selection = window.getSelection();
    const nativeText = (selection && !selection.isCollapsed) ? selection.toString().trim() : "";
    // Native selection is authoritative when present.
    if (nativeText) return nativeText;
    // Only fall back to main-world injected text when it is fresh AND a live
    // selection corroborates it. A stale injectedSel must never resurrect text.
    if (hasFreshInjectedSel() && hasLiveSelectionSource() && injectedSel && injectedSel.text) {
      return injectedSel.text;
    }
    return "";
  }

  /**
   * Returns a { top, left } position for the icon, placed at the end of the
   * last range in the current selection.
   */
  function getSelectionPosition() {
    // Prefer mouse position for icon placement (more reliable than rect
    // inside modals/overlays with CSS transforms). Icons are placed ABOVE the
    // selection/cursor and clamped to the viewport ("shift to top" behavior);
    // flipped below only when there is no room above.
    if (lastMousePos) {
      const _vw = window.innerWidth;
      const _vh = window.innerHeight;
      const MARGIN = 8;
      // Anchor to the top of the selection when known (mouse Y sits at/below
      // the highlight bottom); showIcon() builds the stack upward from here,
      // so icons default ABOVE the selection ("shift to top") and only flip
      // below when there is no room above (fitsAbove check in showIcon()).
      let anchorY = lastMousePos.clientY;
      if (injectedSel && injectedSel.rect && typeof injectedSel.rect.top === "number") {
        anchorY = Math.min(anchorY, injectedSel.rect.top);
      }
      if (anchorY < MARGIN) anchorY = MARGIN;
      if (anchorY > _vh - MARGIN) anchorY = _vh - MARGIN;
      let _left = lastMousePos.clientX + 10;
      if (_left + 36 > _vw - MARGIN) _left = lastMousePos.clientX - 44;
      if (_left < MARGIN) _left = MARGIN;
      return { top: anchorY, left: _left };
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

    // Return the selection TOP-LEFT anchor; showIcon() stacks the icons
    // upward from here (so they default ABOVE the selection, "shift to top")
    // and flips below only when there is no room above, with viewport clamps.
    let top = bestRect.top;
    let left = bestRect.left + 4;

    // Clamp within viewport.
    const vw = window.innerWidth;
    const MARGIN = 8;

    if (left + 36 > vw - MARGIN) {
      left = vw - MARGIN - 36;
    }
    if (left < MARGIN) {
      left = MARGIN;
    }
    if (top < MARGIN) {
      top = MARGIN;
    }

    return { top, left };
  }

  // ---------------------------------------------------------------------------
  // Show / hide
  // ---------------------------------------------------------------------------

  function showIcon() {
    // HARD GATE: never show the toolbar without a LIVE non-collapsed selection.
    // A fresh-but-stale injectedSel relayed from the main world (caret inside a
    // word, ProseMirror range churn) is not user intent. Collapsed/empty native
    // selection is treated as authoritative "no selection".
    if (!hasLiveSelectionSource()) {
      if (!popupEl && !isTranslating && !isRecentToolbarPress()) dismiss();
      return;
    }
    // Prefer main-world injected text — isolated-world selection is unreliable
    // inside LinkedIn's contenteditable. It is only trusted here because the
    // hard gate above proved a live corroborating selection exists.
    var text = (hasFreshInjectedSel() && injectedSel && injectedSel.text) || getSelectedText();
    console.log("[HT] showIcon in", window.location.hostname, "text:", text ? text.substring(0, 40) : "(empty)");
    if (!text) {
      if (hasFreshInjectedSel()) return; // injected sel is truth; don't dismiss
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
      var candidates = document.querySelectorAll("[contenteditable='true'], [contenteditable=''], [data-ht-editable], [role='textbox'], .ProseMirror[contenteditable], .tiptap.ProseMirror, .ProseMirror[role='textbox'], textarea");
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].textContent && candidates[i].textContent.indexOf(savedText) !== -1) {
          savedEditableEl = candidates[i];
          console.log("[HT] Found editable element via fallback search:", candidates[i].tagName);
          break;
        }
      }
    }

    console.log("[HT] showIcon: savedRange:", !!savedRange, "savedEditableEl:", !!savedEditableEl, "savedText:", savedText.substring(0, 30));

    refreshTranslateIconLabel(text);
    const { top, left } = getSelectionPosition();
    // Single toolbar layout: 5 icons in a flex row, anchored near the cursor,
    // clamped to the viewport. Estimated size: 180 x 36 px.
    const ROW_WIDTH = 5 * 28 + 4 * 6; // 164px icons+gaps
    const MARGIN = 8;

    // Anchor preference: fresh mouse position (<1500ms) → injectedSel focus
    // point → selection rect end → getSelectionPosition() fallback. Never use
    // the multi-line bounding rect.right as the primary anchor.
    const now = Date.now();
    const mouseFresh = lastMousePos && (now - lastMouseTime) < 1500;
    let anchorX, anchorY;
    if (mouseFresh) {
      anchorX = lastMousePos.clientX + 12;
      anchorY = lastMousePos.clientY + 12;
    } else if (injectedSel && injectedSel.rect && typeof injectedSel.rect.right === "number") {
      anchorX = injectedSel.rect.right + 8;
      anchorY = injectedSel.rect.bottom + 8;
    } else {
      anchorX = left + 8;
      anchorY = top + 8;
    }

    // Clamp to viewport so the whole toolbar stays on-screen.
    // Toolbar size: 5 * 28px icons + 4 * 6px gaps + 8px padding ≈ 180x36.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rowLeft = Math.min(Math.max(anchorX, MARGIN), Math.max(MARGIN, vw - ROW_WIDTH - 12 - MARGIN));
    const rowTop = Math.min(Math.max(anchorY, MARGIN), Math.max(MARGIN, vh - 40 - MARGIN));

    const toolbar = createToolbar();
    // Show ordering: make displayable BEFORE showPopover — a popover with
    // display:none cannot be promoted to the top layer.
    toolbar.style.left = rowLeft + "px";
    toolbar.style.top = rowTop + "px";
    toolbar.style.display = "flex";
    // Parent into the active modal dialog (if any) — a body-anchored node is
    // inert while a showModal() dialog is open, so it must live inside the
    // dialog to receive pointer events. ensureInRoot performs the single
    // append+demote; if the root changed (or the node was reparented), the
    // promote step below runs AFTER the move so the popover is restored.
    var uiRoot = ensureInRoot(toolbar);
    var rootChanged = lastUiRoot !== uiRoot;
    lastUiRoot = uiRoot;
    // A reparent hides a shown popover, so re-promote whenever the root changed
    // or the toolbar was already visible. First-ever show also reaches here via
    // rootChanged (null -> host); the fallback below keeps it clickable.
    if (rootChanged || toolbarVisible) {
      demoteFromTopLayer(toolbar); // reset before re-promoting the moved node
    }
    toolbarVisible = true;
    if (toolbar.isConnected) {
      if (!promoteToTopLayer(toolbar)) {
        // Fallback: fixed + max z-index (already display:flex above).
        try { if (!toolbar.matches(":popover-open")) toolbar.showPopover(); } catch (e) { /* ignore */ }
      }
    }

    resetDismissTimer();
    // Authoritative on-screen position: persist it so a later icon press can
    // anchor the popup here even after this toolbar is display:none'd.
    captureToolbarRect();
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
    let anchorEl = socialIconEl || summaryIconEl || replyIconEl || humanizeIconEl || iconEl;
    if (!anchorEl) return;

    // Anchor: prefer the cached visible-toolbar rect (captured before hiding);
    // else the live anchor (may be zero-size if display:none); else the last
    // mouse position; else a fixed (120,120). Never let a zero rect clamp the
    // popup to the top-left corner.
    let anchorRect = null;
    if (lastAnchorRect && lastAnchorRect.width > 0 && lastAnchorRect.height > 0) {
      anchorRect = lastAnchorRect;
    } else {
      const live = anchorEl.getBoundingClientRect();
      if (live && live.width > 0 && live.height > 0) {
        anchorRect = live;
      } else {
        const mx = lastMousePos ? lastMousePos.clientX : 120;
        const my = lastMousePos ? lastMousePos.clientY : 120;
        anchorRect = { left: mx, top: my, right: mx + 40, bottom: my + 40, width: 40, height: 40 };
      }
    }
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
    replaceBtn.style.display = (actionType === "translate" || actionType === "improve" || actionType === "social") ? "" : "none";

    if (sourceText && sourceText.length > MAX_SOURCE_LENGTH) {
      sourceText = sourceText.substring(0, MAX_SOURCE_LENGTH) + "...";
    }
    sourceEl.textContent = sourceText || "";
    resultEl.textContent = translatedText;
    popup.style.display = "block";
    ensureInRoot(popup); // re-anchor in case dialog context changed
    promoteToTopLayer(popup); // re-promote each show, AFTER display is set

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
    promoteToTopLayer(popup);

    resizePopupToFit();
    positionPopup();
  }

  function dismiss() {
    // Never dismiss while a translate request is in flight or a popup exists.
    if (isTranslating || popupEl) return;
    // Never auto-remove the popup — only explicit user action (close button / Escape) can close it.
    // This prevents X.com Draft.js and other frameworks from dismissing the popup via synthetic events.
    // Ignore dismissal while a toolbar button press is in flight (mousedown→click).
    if (isRecentToolbarPress()) return;
    // toolbarVisible + savedText means the user selected text and is aiming at
    // the toolbar — treat as intent. Only auto-dismiss if the injected selection
    // went stale (>3s) with no toolbar press in flight.
    if (toolbarVisible && savedText && hasFreshInjectedSel(1500) && hasLiveSelectionSource() && !popupEl) return;
    // A fresh main-world selection is truth — don't dismiss on unreliable
    // isolated-world empty-selection reports (LinkedIn contenteditable). Only
    // when a live selection corroborates it; a stale injectedSel must not.
    if (hasFreshInjectedSel() && hasLiveSelectionSource() && !popupEl) return;
    removeIcon();
    removeHumanizeIcon();
    removeReplyIcon();
    removeSummaryIcon();
    removeSocialIcon();
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
    removeSocialIcon();
    clearDismissTimer();
    isTranslating = false;
    savedRange = null;
    // Removing the popup (and its focused Replace button) from the shadow DOM
    // resets focus to <body>. If we just replaced text in an editable element
    // (form field or contenteditable like x.com's editor), restore focus so
    // the user can keep editing (typing / Del) immediately.
    try {
      if (refocusEditableEl && refocusEditableEl !== document.activeElement &&
          typeof refocusEditableEl.focus === "function") {
        refocusEditableEl.focus();
      }
    } catch (e) { /* ignore */ }
    refocusEditableEl = null;
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
      // Only poll if no popup is currently shown, and never dismiss while a
      // translate request is in flight (popup may not exist yet during loading).
      if (popupEl || isTranslating) return;
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
      if (text && hasLiveSelectionSource() && !iconEl) {
        showIcon();
      } else if (!text && iconEl && !popupEl && !isRecentToolbarPress()) {
        // Selection was cleared while polling (skip during toolbar button press)
        // Isolated-world empty selection is unreliable in LinkedIn contenteditable.
        if (hasLiveSelectionSource()) return;
        dismiss();
      }
      // Hard expiry: a visible toolbar whose selection is genuinely gone (no
      // live native/form-field selection) must not linger. A stale injectedSel
      // alone is NOT a reason to keep it. Guarded so a press or in-flight
      // translation is never interrupted (popupEl/isTranslating returned above).
      if (
        toolbarVisible &&
        !hasLiveSelectionSource() &&
        !isRecentToolbarPress() &&
        !isTranslating &&
        !popupEl
      ) {
        dismiss();
      }
    }, POLL_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function onIconClick(e) {
    console.log("[HT] ICON PRESS", "icon", "savedText:", (savedText || "").substring(0, 30));
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText(); // Use saved text first (selection may be cleared on click)
    if (!text || isTranslating) return;

    isTranslating = true;
    try { showLoading(); } catch (err) { isTranslating = false; }
    var safetyTimer = setTimeout(function () {
      if (isTranslating) {
        isTranslating = false;
        showPopup("Request timed out. Please try again.", text);
      }
    }, 30000);

    sendMessageSafe("translate", text).then((response) => {
      clearTimeout(safetyTimer);
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
    console.log("[HT] ICON PRESS", "humanize", "savedText:", (savedText || "").substring(0, 30));
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText(); // Use saved text first (selection may be cleared on click)
    if (!text || isTranslating) return;

    isTranslating = true;
    try { showLoading(); } catch (err) { isTranslating = false; }
    var safetyTimer = setTimeout(function () {
      if (isTranslating) {
        isTranslating = false;
        showPopup("Request timed out. Please try again.", text);
      }
    }, 30000);

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("improve", text, { languageCode: languageCode })).then((response) => {
      clearTimeout(safetyTimer);
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
          "<a href='" + htExtUrl("options.html") +
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
    console.log("[HT] ICON PRESS", "reply", "savedText:", (savedText || "").substring(0, 30));
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText();
    if (!text || isTranslating) return;

    isTranslating = true;
    try { showLoading(); } catch (err) { isTranslating = false; }
    var safetyTimer = setTimeout(function () {
      if (isTranslating) {
        isTranslating = false;
        showPopup("Request timed out. Please try again.", text);
      }
    }, 30000);

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("reply", text, { languageCode: languageCode })).then((response) => {
      clearTimeout(safetyTimer);
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
          "<a href='" + htExtUrl("options.html") +
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
    console.log("[HT] ICON PRESS", "summary", "savedText:", (savedText || "").substring(0, 30));
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText();
    if (!text || isTranslating) return;

    isTranslating = true;
    try { showLoading(); } catch (err) { isTranslating = false; }
    var safetyTimer = setTimeout(function () {
      if (isTranslating) {
        isTranslating = false;
        showPopup("Request timed out. Please try again.", text);
      }
    }, 30000);

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("summarize", text, { languageCode: languageCode })).then((response) => {
      clearTimeout(safetyTimer);
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
          "<a href='" + htExtUrl("options.html") +
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

  function onSocialClick(e) {
    console.log("[HT] ICON PRESS", "social", "savedText:", (savedText || "").substring(0, 30));
    e.preventDefault();
    e.stopPropagation();
    clearDismissTimer();

    const text = savedText || getSelectedText();
    if (!text || isTranslating) return;

    isTranslating = true;
    try { showLoading(); } catch (err) { isTranslating = false; }
    var safetyTimer = setTimeout(function () {
      if (isTranslating) {
        isTranslating = false;
        showPopup("Request timed out. Please try again.", text);
      }
    }, 30000);

    getLanguageHintForText(text).then((languageCode) => sendMessageSafe("social", text, { languageCode: languageCode })).then((response) => {
      clearTimeout(safetyTimer);
      isTranslating = false;

      if (response.error === 'CONTEXT_INVALID') {
        showPopup("Extension reloaded. Please refresh the page.", text);
        return;
      }

      if (response.success) {
        showPopup(response.translatedText, text, "social");
      } else if (response && response.error === "NO_API_KEY") {
        var msg =
          "No AI provider configured. " +
          "<a href='" + htExtUrl("options.html") +
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
            : "Failed to rewrite hook. Please try again.";
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
    lastMouseTime = Date.now();
    console.log("[HT] mouseUp in", window.location.hostname, "target:", e.target && e.target.tagName);
    debounceTimer = setTimeout(function () {
      // The press may have happened DURING the wait — re-check here.
      if (isTranslating) return;
      // A toolbar button press may clear the selection before click fires —
      // do not dismiss if this mouseup landed on (or right after) the toolbar.
      if (isRecentToolbarPress()) return;
      var text = getSelectedText();
      if (text && hasLiveSelectionSource()) {
        showIcon();
      } else if (hasFreshInjectedSel() && hasLiveSelectionSource()) {
        // Isolated-world selection reads empty; injected sel is truth — but
        // only with a live native/form-field selection corroborating it.
        showIcon();
      } else {
        dismiss();
      }
    }, DEBOUNCE_MS);
  }

  function onDocumentClick(e) {
    // Only remove floating icons when clicking outside the extension's shadow DOM.
    // The popup stays until explicitly closed (X button or Escape).
    // Defer to a macrotask so a genuine toolbar icon click (whose own handler
    // runs first in bubble phase) always wins the race; re-check containment
    // inside the deferred callback before hiding anything.
    if (isInsideExtension(e)) return;
    setTimeout(function () {
      // A press in flight must never be torn down by a deferred outside-click.
      if (isTranslating || popupEl) return;
      if (isInsideExtension(e)) return; // click landed on toolbar/popup: never dismiss
      if (isRecentToolbarPress()) return;
      if (!iconEl && !humanizeIconEl && !replyIconEl && !summaryIconEl && !socialIconEl) return;
      dismiss();
    }, 0);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      closePopup();
    }
  }

  function onMouseMove(e) {
    // Track the cursor continuously so the toolbar always anchors at the
    // actual mouse position (e.g. when selecting backwards from "when").
    lastMousePos = { clientX: e.clientX, clientY: e.clientY };
    lastMouseTime = Date.now();
  }

  function onViewportShift() {
    // Hide the toolbar on scroll/resize — its fixed position is stale.
    if (toolbarVisible && !popupEl) hideToolbar();
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
      // The press may have happened DURING the 300ms wait — re-check here.
      if (isTranslating) return;
      var text = getSelectedText();
      // Suppress dismissal while a toolbar button press is in flight.
      if (isRecentToolbarPress()) return;
      console.log("[HT] selChange in", window.location.hostname, "text:", text ? text.substring(0, 40) : "(empty)");
      if (text && hasLiveSelectionSource() && !popupEl) {
        showIcon();
      } else if (!text && (iconEl || humanizeIconEl || replyIconEl || summaryIconEl || socialIconEl)) {
        // Isolated-world empty selection is unreliable in LinkedIn contenteditable.
        if (hasFreshInjectedSel() && hasLiveSelectionSource()) return;
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
  document.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
  document.addEventListener("scroll", onViewportShift, { capture: true, passive: true });
  window.addEventListener("resize", onViewportShift, { passive: true });
  document.addEventListener("click", onDocumentClick, true);
  // Bubble-phase click for outside-dismiss: capture-phase click on LinkedIn
  // fires before the dialog's own handling; bubble-phase + closest() guard
  // avoids the "click lands on toolbar but dismisses first" race.
  document.addEventListener("click", function (e) {
    if (isInsideExtension(e)) return;
    if (!toolbarVisible && !popupEl) return;
    if (toolbarEl && toolbarEl.contains(e.target)) return;
    if (popupEl && popupEl.contains(e.target)) return;
    // Defer: an icon's pointerdown/click handler (same press) must win first.
    setTimeout(function () {
      // A press in flight must never be torn down by a deferred outside-click.
      if (isTranslating || popupEl) return;
      if (isInsideExtension(e)) return;
      if (isRecentToolbarPress()) return;
      dismiss();
    }, 0);
  });
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("selectionchange", onSelectionChange, true);

  // Also listen on mousedown for sites that prevent mouseup propagation.
  document.addEventListener("mousedown", function () {
    // Clear debounce on mousedown start of a new selection — but not when a
    // fresh injected selection exists: the pending showIcon (e.g. from the
    // comment-box selection) must survive the editor's focus-steal mousedown.
    if (hasFreshInjectedSel()) return;
    clearTimeout(debounceTimer);
  }, true);
  document.addEventListener("pointerdown", function () {
    if (hasFreshInjectedSel()) return;
    // Clear debounce on pointerdown (touch / stylus) start of a new selection.
    clearTimeout(debounceTimer);
  }, true);

  console.log("[HT] INIT COMPLETE in", window.location.hostname);

  // Inject MAIN-world script via script src tag (bypasses page CSP).
  // LinkedIn's CSP allows chrome-extension:// scripts but blocks inline scripts.
  var mainUrls;
  try {
    mainUrls = chrome.runtime && chrome.runtime.id ? chrome.runtime.getURL("content-main.js") : null;
  } catch (e) {
    mainUrls = null;
  }
  if (!mainUrls || mainUrls.indexOf("invalid") !== -1) {
    console.log("[HT] skip main-world inject, context invalid");
  } else {
    var mainScript = document.createElement("script");
    mainScript.src = mainUrls;
    (document.head || document.documentElement).appendChild(mainScript);
    mainScript.onload = function () {
      console.log("[HT] MAIN-world script loaded via src tag");
      mainScript.remove();
    };
    mainScript.onerror = function () {
      console.error("[HT] MAIN-world script failed to load");
    };
  }

  startSelectionPolling();
})();
