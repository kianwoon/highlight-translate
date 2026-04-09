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

  console.log("[HT-MAIN] MAIN-world script loaded on", window.location.hostname, "v3");

  var POLL_MS = 300;
  var lastText = "";
  // Saved selection info for text replacement
  var savedSelRange = null;
  var savedSelText = "";

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
      document.dispatchEvent(
        new CustomEvent("__ht_sel", { detail: { text: text, rect: rect } })
      );
    } else if (!text && lastText) {
      lastText = "";
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

  // Listen for replace requests from the isolated-world content script.
  document.addEventListener("__ht_replace", function (e) {
    var newText = e.detail && e.detail.text;
    if (!newText) {
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
      return;
    }

    console.log("[HT-MAIN] replace request, text:", newText.substring(0, 40));
    console.log("[HT-MAIN] savedSelRange live:", isRangeLive(savedSelRange), "savedSelText:", savedSelText ? savedSelText.substring(0, 30) : "(none)");

    try {
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

      // Strategy 1: Try execCommand insertText (editors recognize this)
      var replaced = false;
      try {
        if (document.execCommand("insertText", false, newText)) {
          console.log("[HT-MAIN] execCommand insertText succeeded");
          replaced = true;
        }
      } catch (e) { /* not available */ }

      // Strategy 2: Synthetic paste event (editors handle paste natively)
      if (!replaced) {
        try {
          var dt = new DataTransfer();
          dt.setData("text/plain", newText);
          var pasteEvent = new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          });
          target.dispatchEvent(pasteEvent);
          if (pasteEvent.defaultPrevented) {
            console.log("[HT-MAIN] paste event handled by editor");
            replaced = true;
          }
        } catch (e) { /* ClipboardEvent not available */ }
      }

      // Strategy 3: Direct DOM manipulation + InputEvent notification
      if (!replaced) {
        // Dispatch beforeinput BEFORE modifying DOM (standard editing pipeline)
        try {
          target.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: newText
          }));
        } catch (e) { /* ignore */ }

        // Modify the DOM
        range.deleteContents();
        range.insertNode(document.createTextNode(newText));

        // Dispatch InputEvent AFTER modifying DOM
        try {
          target.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: newText
          }));
        } catch (e) { /* ignore */ }
        target.dispatchEvent(new Event("change", { bubbles: true }));
        console.log("[HT-MAIN] direct DOM replacement + InputEvent");
      }

      sel.removeAllRanges();

      console.log("[HT-MAIN] replacement succeeded");
      savedSelRange = null;
      savedSelText = "";
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: true } }));
    } catch (e) {
      console.log("[HT-MAIN] replacement failed:", e.message);
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
    }
  });
})();
