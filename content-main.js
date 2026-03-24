/**
 * MAIN-world content script for Highlight Translate.
 * Runs in the page's main JavaScript world to bypass Brave browser's
 * fingerprinting protection ("farbling") which makes window.getSelection()
 * return empty in content scripts.
 *
 * Communicates selection data to the ISOLATED-world content.js via CustomEvents.
 */
(function () {
  "use strict";

  console.log("[HT-MAIN] MAIN-world script loaded on", window.location.hostname);

  var POLL_MS = 300;
  var lastText = "";

  setInterval(function () {
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : "";

    if (text && text !== lastText) {
      lastText = text;
      var rect = null;
      if (sel.rangeCount > 0) {
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
})();
