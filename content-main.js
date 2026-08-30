/**
 * MAIN-world content script for Highlight Translate.
 * Runs in the page's main JavaScript world to bypass Brave browser's
 * fingerprinting protection ("farbling") which makes window.getSelection()
 * return empty in content scripts.
 *
 * Also handles text replacement — since the main world has full access to
 * window.getSelection() and the DOM, it can reliably replace text in editors
 * like LinkedIn's that the isolated-world content script cannot reach.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Security / anti-bot guard — same policy as content.js.
  // This script runs in the page's MAIN world, so it must be even more
  // careful: never poll getSelection() or touch the DOM on anti-bot
  // challenge pages/frames (Cloudflare Turnstile et al.). The isolated
  // content script already guards against injection, but this file can also
  // be loaded directly by other means (web_accessible_resources), so guard
  // here too.
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

  if (isSecurityPage() || isSubframe()) {
    console.log("[HT-MAIN] Skipping injection in", window.location.href, "(security page or subframe)");
    return;
  }

  console.log("[HT-MAIN] MAIN-world script loaded on", window.location.hostname, "v3");

  var POLL_MS = 300;
  var lastText = "";
  // Saved selection info for text replacement
  var savedSelRange = null;
  var savedSelText = "";
  var savedFormField = null; // { el, start, end, text } for <input>/<textarea> selections
  var wasFormFieldSel = false; // true once a form-field selection was captured this cycle

  /**
   * Tags an editable element with a stable data attribute so the isolated
   * content script (content.js) can find and refocus it after the popup
   * closes. Returns the id used.
   */
  function markEditable(el) {
    try {
      if (!el) return null;
      var id = el.getAttribute("data-ht-editable");
      if (!id) {
        id = "ht-ed-" + Math.random().toString(36).slice(2, 10);
        el.setAttribute("data-ht-editable", id);
      }
      return id;
    } catch (e) {
      return null;
    }
  }

  setInterval(function () {
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : "";

    if (text && text !== lastText) {
      lastText = text;
      var rect = null;
      if (sel.rangeCount > 0) {
        // Save the range for later replacement
        try {
          savedSelRange = sel.getRangeAt(0).cloneRange();
          savedSelText = text;
        } catch (e) { /* not clonable */ }

        try {
          var r = sel.getRangeAt(0).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            rect = { top: r.bottom + 4, left: r.right + 4 };
          }
        } catch (e) { /* ignore */ }
      }

      // NEW: Form fields (<input>/<textarea>) keep their real selection in
      // their own shadow tree — getRangeAt(0) above is a collapsed caret
      // range. Capture the actual selection offsets so replacement can
      // target the field's value directly instead of the page body.
      savedFormField = null;
      wasFormFieldSel = false;
      try {
        var ae = document.activeElement;
        if (ae && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && ae.type !== "hidden" && ae.type !== "password"))) {
          if (typeof ae.selectionStart === "number" && ae.selectionEnd > ae.selectionStart) {
            savedFormField = {
              el: ae,
              start: ae.selectionStart,
              end: ae.selectionEnd,
              text: ae.value.substring(ae.selectionStart, ae.selectionEnd)
            };
            wasFormFieldSel = true;
          }
        }
      } catch (e) { /* ignore */ }

      document.dispatchEvent(
        new CustomEvent("__ht_sel", { detail: { text: text, rect: rect } })
      );
    } else if (!text && lastText) {
      lastText = "";
      // IMPORTANT: do NOT clear savedFormField here. Clicking the extension's
      // own icon/popup clears the page selection (and the form field loses
      // focus), but the user may still click "Replace" afterwards. The saved
      // form-field handle is validated at replace time and overwritten when a
      // NEW selection is captured — it must survive focus loss.
      document.dispatchEvent(new CustomEvent("__ht_sel_clear"));
    }
  }, POLL_MS);

  // ---------------------------------------------------------------------------
  // Text replacement — runs in main world where selection is fully accessible
  // ---------------------------------------------------------------------------

  /** Check whether a Range still points to live DOM nodes. */
  function isRangeLive(range) {
    try {
      if (!range) return false;
      return document.body.contains(range.startContainer) && document.body.contains(range.endContainer);
    } catch (e) {
      return false;
    }
  }

  /**
   * Tree-walk the document to find a text node containing `searchText`,
   * then create a fresh Range selecting it.
   */
  function findTextRange(searchText) {
    if (!searchText) return null;
    // Try shorter prefix first (handles text split across nodes)
    var prefix = searchText.length > 40 ? searchText.substring(0, 40) : searchText;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var idx = node.nodeValue.indexOf(prefix);
      if (idx !== -1) {
        var range = document.createRange();
        range.setStart(node, idx);
        // Extend to cover as much of the full text as possible
        var endOffset = Math.min(idx + searchText.length, node.nodeValue.length);
        range.setEnd(node, endOffset);
        return range;
      }
    }
    return null;
  }

  /** Walk up from a node to find the nearest contenteditable ancestor. */
  function focusEditableAncestor(range) {
    var node = range.commonAncestorContainer;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node !== document.body) {
      if (node.isContentEditable) { node.focus(); return true; }
      node = node.parentNode;
    }
    return false;
  }

  /**
   * Checks whether `newText` actually landed in the live DOM under `target`.
   * A strategy's own return value (execCommand) or defaultPrevented flag
   * (synthetic paste) only proves the DOM was touched — NOT that a
   * framework-managed editor (React/Draft.js-style, e.g. X.com's composer)
   * updated its own internal content model. If the model stays stale, the
   * editor silently reverts the DOM back to it on its next re-render
   * (e.g. when the user clicks back into the field). Checking the actual
   * textContent is the only reliable success signal here.
   */
  function verifyReplacement(target, newText) {
    try {
      return target.textContent.indexOf(newText) !== -1;
    } catch (e) {
      return false;
    }
  }

  /**
   * Place the DOM caret right after the first occurrence of `text` within the
   * editable target. Needed for React/Draft contenteditable editors where the
   * replacement via execCommand can leave the caret collapsed at the wrong
   * offset (start of node), which makes Del/typing appear dead.
   */
  function placeCaretAfter(text) {
    try {
      var sel = window.getSelection();
      if (!sel || !text) return;
      var focusNode = sel.focusNode;
      if (!focusNode) return;
      // Climb to the editable element to scope the search.
      var ed = focusNode;
      if (ed.nodeType === Node.TEXT_NODE) ed = ed.parentNode;
      while (ed && !ed.isContentEditable && ed !== document.body) ed = ed.parentNode;
      if (!ed || !ed.isContentEditable) return;
      // Search for the text node containing `text` and set the caret after it.
      var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while ((node = walker.nextNode())) {
        var idx = node.nodeValue.indexOf(text);
        if (idx !== -1) {
          var range = document.createRange();
          range.setStart(node, idx + text.length);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          ed.focus();
          return;
        }
      }
    } catch (e) { /* ignore */ }
  }

  /** Runs the replacement strategies in order, verifying each before moving on. */
  function finishReplace(range, target, newText) {
    var strategy = "none";
    var replaced = false;
    // Snapshot the original selected text so we can detect "something already
    // changed the DOM, even if verifyReplacement's exact match missed it"
    // (e.g. an editor trims/normalizes whitespace on insert) — without this,
    // a false-negative verify would run the NEXT strategy too and double-insert.
    var originalText = "";
    try { originalText = range.toString(); } catch (e) { /* ignore */ }

    // Strategy 1: Synthetic paste event FIRST. Framework-managed rich
    // editors (X.com and similar React/contenteditable editors) read
    // e.clipboardData in their own paste handler and update their internal
    // model correctly — this is the one path that reliably stays in sync
    // with such editors, so it's tried before execCommand. On plain
    // (non-framework) contenteditables this is a silent no-op (untrusted
    // paste events aren't processed natively), and verification below
    // correctly falls through to the next strategy in that case.
    try {
      var dt = new DataTransfer();
      dt.setData("text/plain", newText);
      var pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      target.dispatchEvent(pasteEvent);
    } catch (e) { /* ClipboardEvent not available */ }

    if (verifyReplacement(target, newText)) {
      replaced = true;
      strategy = "paste";
    }

    // Bail out before any further destructive strategy if the original text
    // is already gone but didn't verify as our exact newText — that means
    // strategy 1 (or the page itself) already changed something, and firing
    // another full insertion strategy risks inserting newText a second time.
    var safeToRetry = !originalText || target.textContent.indexOf(originalText) !== -1;

    // Strategy 2: execCommand insertText. NOTE: a truthy return here does
    // NOT prove a framework editor's internal state was updated — only
    // that the DOM was mutated. We verify actual content instead of
    // trusting the return value (see verifyReplacement doc above).
    if (!replaced && safeToRetry) {
      // Ensure the DOM selection is exactly the target range so the editor's
      // own editing pipeline (React onChange / Draft beforeinput) processes
      // the insert against the correct span and keeps its model in sync.
      try {
        var ceSel = window.getSelection();
        ceSel.removeAllRanges();
        ceSel.addRange(range);
      } catch (e) { /* ignore */ }

      try {
        document.execCommand("insertText", false, newText);
      } catch (e) { /* not available */ }

      if (verifyReplacement(target, newText)) {
        replaced = true;
        strategy = "execCommand";
        // Restore the caret to just after the inserted text so the editor
        // keeps a valid cursor (Del / typing work). Without this, a
        // React/Draft editor may leave the caret collapsed at the wrong
        // position and reject subsequent keystrokes.
        try {
          placeCaretAfter(newText);
        } catch (e) { /* ignore */ }
      }
      safeToRetry = !originalText || target.textContent.indexOf(originalText) !== -1;
    }

    // Strategy 3: Direct DOM manipulation — last resort. Works reliably on
    // plain (non-framework) contenteditable/text, but framework-managed
    // editors that don't recognize the raw mutation may still revert it.
    if (!replaced && safeToRetry) {
      try {
        target.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: newText
        }));
      } catch (e) { /* ignore */ }

      try {
        // Use the live selection's range if the framework normalized it
        // during the deferral below; fall back to the originally saved one.
        var sel = window.getSelection();
        var liveRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0) : range;
        liveRange.deleteContents();
        var insertedNode = document.createTextNode(newText);
        liveRange.insertNode(insertedNode);

        // Leave the cursor right after the inserted text so the field stays editable.
        liveRange.setStartAfter(insertedNode);
        liveRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(liveRange);
      } catch (e) { /* ignore */ }

      try {
        target.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: newText
        }));
      } catch (e) { /* ignore */ }
      target.dispatchEvent(new Event("change", { bubbles: true }));

      if (verifyReplacement(target, newText)) {
        replaced = true;
        strategy = "rawDOM";
      }
    }
    // Note: strategies 1 (paste) and 2 (execCommand) already leave the
    // browser/editor's own caret correctly positioned after the inserted
    // text — we must NOT clear the selection after them, or the field is
    // left with no active cursor and appears uneditable until re-clicked.

    console.log("[HT-MAIN] replacement result:", replaced, "strategy:", strategy);
    var editableId = null;
    if (replaced) {
      savedSelRange = null;
      savedSelText = "";
      // Tag the editable ancestor (contenteditable or form field) so the
      // isolated content script can refocus it after the popup closes. For
      // framework editors (x.com's React/Draft.js) focus is NOT auto-restored
      // by the replacement — without this the editor loses the caret and
      // typing / Del appear dead.
      try {
        var edTarget = target;
        if (edTarget && edTarget.nodeType === Node.TEXT_NODE) edTarget = edTarget.parentNode;
        while (edTarget && edTarget !== document.body && edTarget !== document.documentElement) {
          if (edTarget.isContentEditable || edTarget.tagName === "TEXTAREA" ||
              (edTarget.tagName === "INPUT" && edTarget.type !== "hidden" && edTarget.type !== "password")) {
            editableId = markEditable(edTarget);
            break;
          }
          edTarget = edTarget.parentNode;
        }
      } catch (e) { /* ignore */ }
    }
    document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: replaced, strategy: strategy, editableId: editableId } }));
  }

  // Listen for replace requests from the isolated-world content script.
  document.addEventListener("__ht_replace", function (e) {
    var newText = e.detail && e.detail.text;
    if (!newText) {
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
      return;
    }

    console.log("[HT-MAIN] replace request, text:", newText.substring(0, 40));
    console.log("[HT-MAIN] savedSelRange live:", isRangeLive(savedSelRange), "savedSelText:", savedSelText ? savedSelText.substring(0, 30) : "(none)",
      "savedFormField:", savedFormField ? savedFormField.el.tagName + "[" + savedFormField.start + "," + savedFormField.end + "]" : "(none)");

    try {
      // FORM FIELDS FIRST: <input>/<textarea> keep their selection in their
      // own shadow tree, so the document Range below is a collapsed caret and
      // cannot be used for replacement. The form-field handle is captured by
      // the poller and is the ONLY reliable way to replace inside such fields.
      if (savedFormField) {
        var ff = savedFormField;
        var el = ff.el;
        // Field must still be in the document.
        if (document.body.contains(el)) {
          // Find the ORIGINAL selected text inside the field's current value.
          // Offsets may have shifted (e.g. the page/editor normalized text
          // between selection and replace), so search rather than trusting
          // the saved start/end.
          var idx = el.value.indexOf(ff.text);
          if (idx === -1) {
            // Trimmed fallback: some editors trim/normalize whitespace.
            var trimmed = ff.text.trim();
            if (trimmed) idx = el.value.indexOf(trimmed);
          }
          if (idx !== -1) {
            var newValue = el.value.substring(0, idx) + newText + el.value.substring(idx + ff.text.length);
            el.focus();
            // Use the NATIVE value setter instead of `el.value = ...` so React
            // controlled inputs (which install a value tracker that ignores
            // direct assignments and reverts them on the next render) see the
            // change. Fall back to a plain assignment if the prototype setter
            // is unavailable.
            try {
              var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              var valueSetter = Object.getOwnPropertyDescriptor(proto, "value");
              if (valueSetter && valueSetter.set) {
                valueSetter.set.call(el, newValue);
              } else {
                el.value = newValue;
              }
            } catch (e) {
              el.value = newValue;
            }
            // Restore the caret right after the inserted text.
            try {
              var caretPos = idx + newText.length;
              el.setSelectionRange(caretPos, caretPos);
            } catch (e) { /* ignore */ }
            try {
              el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: newText }));
            } catch (e) { /* ignore */ }
            el.dispatchEvent(new Event("change", { bubbles: true }));

            savedFormField = null;
            savedSelRange = null;
            savedSelText = "";
            console.log("[HT-MAIN] form-field replacement succeeded, strategy: formField");
            document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: true, strategy: "formField", editableId: markEditable(el) } }));
            return;
          }
          // The original text is no longer in the field — the selection is
          // genuinely stale (user typed over it / new content). Fall through.
          console.log("[HT-MAIN] saved form field text not found, falling through to range strategies");
          savedFormField = null;
        } else {
          console.log("[HT-MAIN] saved form field no longer in DOM");
          savedFormField = null;
        }
      }

      // GUARD: If the selection that triggered this flow was a FORM-FIELD
      // selection, the document range saved by getRangeAt(0) is a collapsed
      // caret (form-field selections live in the field's shadow tree, not the
      // document). Falling through to the range strategies below would insert
      // newText into the page <body> — a "replace that appends non-editable
      // text" bug. If we couldn't replace via the field handle, FAIL SAFE.
      if (wasFormFieldSel) {
        console.log("[HT-MAIN] form-field selection could not be replaced; refusing to touch page body");
        savedSelRange = null;
        savedSelText = "";
        document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false, reason: "form-field selection lost" } }));
        return;
      }

      var range = null;

      // Try the saved selection range first
      if (isRangeLive(savedSelRange)) {
        range = savedSelRange;
        console.log("[HT-MAIN] using saved range");
      }

      // If saved range is stale, search for the original text
      if (!range && savedSelText) {
        range = findTextRange(savedSelText);
        console.log("[HT-MAIN] searched for text:", range ? "found" : "not found");
      }

      if (!range) {
        console.log("[HT-MAIN] no range available for replacement");
        document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
        return;
      }

      // Focus the editable area
      focusEditableAncestor(range);

      // Restore selection
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      // Determine the target element for events
      var target = range.commonAncestorContainer;
      if (target.nodeType === Node.TEXT_NODE) target = target.parentNode;

      // Defer one tick before mutating: framework-managed editors (React/
      // Draft.js-style, e.g. X.com's composer) track selection internally
      // via their own "selectionchange" listener, which fires as a queued
      // task — not synchronously. Mutating in the same tick as
      // sel.addRange() above can act against the editor's still-stale
      // internal cursor position, leaving its content model unsynced (the
      // DOM looks right until the editor's next re-render, e.g. on click,
      // silently reverts it). Deferring lets that listener run first.
      setTimeout(function () {
        finishReplace(range, target, newText);
      }, 0);
    } catch (e) {
      console.log("[HT-MAIN] replacement failed:", e.message);
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
    }
  });
})();
