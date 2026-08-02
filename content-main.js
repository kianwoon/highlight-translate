/**
 * MAIN-world content script for UniLingo.
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

  console.log("[HT-MAIN] MAIN-world script loaded on", window.location.hostname, "v4");

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
   * then create a fresh Range selecting it. Prefers VISIBLE nodes.
   */
  function findTextRange(searchText) {
    if (!searchText) return null;
    var prefix = searchText.length > 40 ? searchText.substring(0, 40) : searchText;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    var visibleRange = null;
    var anyRange = null;
    while ((node = walker.nextNode())) {
      var idx = node.nodeValue.indexOf(prefix);
      if (idx !== -1) {
        var range = document.createRange();
        range.setStart(node, idx);
        var endOffset = Math.min(idx + searchText.length, node.nodeValue.length);
        range.setEnd(node, endOffset);
        // Check visibility
        var parent = node.parentNode;
        var rect = parent.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && parent.offsetParent !== null) {
          visibleRange = range;
        }
        if (!anyRange) anyRange = range;
      }
    }
    return visibleRange || anyRange;
  }

  /** Find the Quill instance for a DOM element inside a Quill editor. */
  function findQuill(element) {
    if (!element || !element.closest) return null;
    var container = element.closest(".ql-container");
    if (!container) return null;
    var editor = container.querySelector(".ql-editor");
    if (!editor) return null;
    if (editor.__quill) return editor.__quill;
    if (container.__quill) return container.__quill;
    if (window.Quill && window.Quill.find) {
      try { return window.Quill.find(editor); } catch (e) { /* ignore */ }
    }
    return null;
  }

  /**
   * Find the Lexical editor instance for a node inside LinkedIn's editor.
   * Lexical stores __lexicalEditor on the contenteditable root element.
   */
  function findLexicalEditor(node) {
    if (!node) return null;
    var el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (el && el !== document.body) {
      // Direct __lexicalEditor property
      if (el.__lexicalEditor) {
        console.log("[HT-MAIN] found __lexicalEditor on", el.tagName, el.className.substring(0, 40));
        return el.__lexicalEditor;
      }
      // Search own properties for Lexical-like object (update + getEditorState)
      if (el.getAttribute && (el.isContentEditable || el.getAttribute("contenteditable") === "true")) {
        var keys = Object.getOwnPropertyNames(el);
        for (var i = 0; i < keys.length; i++) {
          try {
            var val = el[keys[i]];
            if (val && typeof val === "object" && typeof val.update === "function" &&
                typeof val.getEditorState === "function") {
              console.log("[HT-MAIN] found Lexical-like editor on property:", keys[i]);
              return val;
            }
          } catch (e) { /* ignore */ }
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Find the editor root element even when contenteditable has been removed on blur.
   */
  function findEditorRoot(node) {
    if (!node) return null;
    var el = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (el && el !== document.body) {
      if (el.isContentEditable) return el;
      if (el.getAttribute) {
        if (el.getAttribute("role") === "textbox") return el;
        if (el.getAttribute("data-lexical-editor") === "true") return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Simulate a real click on the editor to restore contenteditable.
   * LinkedIn removes contenteditable on blur; a real mousedown/click restores it.
   */
  function simulateEditorClick(editorRoot) {
    if (!editorRoot) return;
    var rect = editorRoot.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y,
      view: window, button: 0, buttons: 1 };
    editorRoot.dispatchEvent(new MouseEvent("pointerdown", opts));
    editorRoot.dispatchEvent(new MouseEvent("mousedown", opts));
    editorRoot.dispatchEvent(new MouseEvent("pointerup", opts));
    editorRoot.dispatchEvent(new MouseEvent("mouseup", opts));
    editorRoot.dispatchEvent(new MouseEvent("click", opts));
    editorRoot.focus();
  }

  // Listen for replace requests from the isolated-world content script.
  document.addEventListener("__ht_replace", function (e) {
    var newText = e.detail && e.detail.text;
    if (!newText) {
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
      return;
    }

    console.log("[HT-MAIN] replace request, text:", newText.substring(0, 40));
    console.log("[HT-MAIN] savedSelText:", savedSelText ? savedSelText.substring(0, 30) : "(none)");

    try {
      var range = findTextRange(savedSelText);
      if (!range && isRangeLive(savedSelRange)) {
        range = savedSelRange;
      }
      if (!range) {
        console.log("[HT-MAIN] no range available for replacement");
        document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
        return;
      }

      var target = range.commonAncestorContainer;
      if (target.nodeType === Node.TEXT_NODE) target = target.parentNode;

      // ── Diagnostic: scan entire document for editor elements ──
      (function () {
        // Search for contenteditable elements anywhere
        var ceAll = document.querySelectorAll('[contenteditable]');
        console.log("[HT-MAIN] SCAN contenteditable elements:", ceAll.length);
        for (var i = 0; i < ceAll.length && i < 5; i++) {
          console.log("[HT-MAIN]   CE:", ceAll[i].tagName, "ce:", ceAll[i].contentEditable,
            "text:", ceAll[i].textContent.substring(0, 30));
        }
        // Search for role=textbox
        var tbs = document.querySelectorAll('[role="textbox"]');
        console.log("[HT-MAIN] SCAN role=textbox:", tbs.length);
        for (var i = 0; i < tbs.length && i < 5; i++) {
          console.log("[HT-MAIN]   TB:", tbs[i].tagName, "ce:", tbs[i].contentEditable);
        }
        // Search for textareas
        var tas = document.querySelectorAll('textarea, input[type="text"]');
        console.log("[HT-MAIN] SCAN textareas/inputs:", tas.length);
        for (var i = 0; i < tas.length && i < 5; i++) {
          console.log("[HT-MAIN]   TA:", tas[i].tagName, "val:", tas[i].value.substring(0, 30),
            "display:", getComputedStyle(tas[i]).display);
        }
        // Search for __lexicalEditor on any element
        var foundLex = false;
        var allEls = document.querySelectorAll('*');
        for (var i = 0; i < allEls.length; i++) {
          if (allEls[i].__lexicalEditor) {
            console.log("[HT-MAIN] SCAN found __lexicalEditor on:", allEls[i].tagName, allEls[i].className.substring(0, 40));
            foundLex = true;
            break;
          }
        }
        if (!foundLex) console.log("[HT-MAIN] SCAN no __lexicalEditor found on any element");
        // Search for data-lexical-editor attribute
        var lexAttr = document.querySelectorAll('[data-lexical-editor]');
        console.log("[HT-MAIN] SCAN data-lexical-editor:", lexAttr.length);
      })();

      // ── PHASE 1: Click each ancestor to find which one restores contenteditable ──
      // LinkedIn removes ALL editor elements on blur. We must click the right
      // container to bring the editor back to life, THEN do the replacement.
      var replaced = false;
      var ancestors = [];
      var _anc = target;
      while (_anc && _anc !== document.body && ancestors.length < 12) {
        ancestors.push(_anc);
        _anc = _anc.parentElement;
      }

      console.log("[HT-MAIN] ancestor path:", ancestors.map(function (a) {
        return a.tagName + "#" + (a.id || "").substring(0, 10) + "." + (a.className || "").toString().substring(0, 20);
      }).join(" > "));

      // ── KEY FINDING: elementAtPoint reveals the ACTUAL visible element ──
      // Use elementFromPoint to find the element the user actually sees
      var visCheck = range.startContainer;
      if (visCheck.nodeType === Node.TEXT_NODE) visCheck = visCheck.parentNode;
      var visRect = visCheck.getBoundingClientRect();
      var topElement = document.elementFromPoint(visRect.left + visRect.width / 2, visRect.top + visRect.height / 2);
      console.log("[HT-MAIN] TOP element at text position:", topElement ? topElement.tagName + "." + (topElement.className || "").toString().substring(0, 50) : "null");

      // If topElement is different from our target, IT is what the user sees
      if (topElement && topElement !== target && !topElement.contains(target)) {
        console.log("[HT-MAIN] DIFFERENT top element! Investigating:", topElement.tagName,
          "textContent:", topElement.textContent.substring(0, 60));

        // Check for React fibers on the top element
        var topFiberKeys = Object.getOwnPropertyNames(topElement).filter(function (k) {
          return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactProps$") === 0;
        });
        console.log("[HT-MAIN] top element React keys:", topFiberKeys);

        // Check for __reactProps$ to access event handlers and state
        var topPropsKey = Object.getOwnPropertyNames(topElement).find(function (k) {
          return k.indexOf("__reactProps$") === 0;
        });
        if (topPropsKey) {
          var topProps = topElement[topPropsKey];
          console.log("[HT-MAIN] top element React props keys:", Object.keys(topProps).join(", ").substring(0, 100));

          // Investigate the ref — it might point to the editor instance
          if (topProps.ref) {
            var refVal = topProps.ref;
            console.log("[HT-MAIN] ref type:", typeof refVal);
            if (typeof refVal === "object" && refVal !== null) {
              console.log("[HT-MAIN] ref keys:", Object.keys(refVal).join(", ").substring(0, 100));
              // Check if ref.current points to something useful
              if (refVal.current !== undefined) {
                var refCurrent = refVal.current;
                console.log("[HT-MAIN] ref.current type:", typeof refCurrent,
                  refCurrent ? (refCurrent.tagName || refCurrent.constructor.name || "object") : "null");
                if (refCurrent && typeof refCurrent === "object") {
                  console.log("[HT-MAIN] ref.current keys:", Object.keys(refCurrent).join(", ").substring(0, 100));
                  // Check for editor-like methods
                  if (typeof refCurrent.update === "function" || typeof refCurrent.dispatch === "function" ||
                      typeof refCurrent.focus === "function" || typeof refCurrent.getText === "function") {
                    console.log("[HT-MAIN] ★★★ ref.current has editor-like methods!");
                  }
                  // Check for value/text content
                  if (refCurrent.value !== undefined) {
                    console.log("[HT-MAIN] ref.current.value:", String(refCurrent.value).substring(0, 80));
                  }
                  if (refCurrent.textContent !== undefined) {
                    console.log("[HT-MAIN] ref.current.textContent:", refCurrent.textContent.substring(0, 80));
                  }
                  // Check for __lexicalEditor or similar
                  var refLex = refCurrent.__lexicalEditor;
                  if (refLex) {
                    console.log("[HT-MAIN] ★★★ FOUND __lexicalEditor on ref.current!");
                  }
                  // Check for nested editor objects
                  var refOwnKeys = Object.getOwnPropertyNames(refCurrent);
                  for (var rki = 0; rki < refOwnKeys.length; rki++) {
                    var rk = refOwnKeys[rki];
                    try {
                      var rv = refCurrent[rk];
                      if (rv && typeof rv === "object" && typeof rv.update === "function") {
                        console.log("[HT-MAIN] ★★★ Found editor-like object on ref.current." + rk);
                      }
                    } catch (e) { /* skip */ }
                  }
                }
              }
            }
            // Ref might be a callback ref (function)
            if (typeof refVal === "function") {
              console.log("[HT-MAIN] ref is a callback function");
            }
          }

          // Check children prop
          if (topProps.children) {
            console.log("[HT-MAIN] children type:", typeof topProps.children,
              Array.isArray(topProps.children) ? "array length:" + topProps.children.length : "");
            if (typeof topProps.children === "string") {
              console.log("[HT-MAIN] children string:", topProps.children.substring(0, 60));
            }
          }
        }

        // Walk up from topElement looking for the editor component
        var walkEl = topElement;
        var walkDepth = 0;
        while (walkEl && walkEl !== document.body && walkDepth < 20) {
          var fiberKey = Object.getOwnPropertyNames(walkEl).find(function (k) {
            return k.indexOf("__reactFiber$") === 0;
          });
          if (fiberKey) {
            var fiber = walkEl[fiberKey];
            // Check hooks for text state
            var hState = fiber.memoizedState;
            var hIdx = 0;
            while (hState && hIdx < 30) {
              var hVal = hState.memoizedState;
              if (typeof hVal === "string" && hVal.length > 10) {
                console.log("[HT-MAIN] fiber hook", hIdx, "depth", walkDepth, "string val:", hVal.substring(0, 50));
                if (hVal.indexOf(savedSelText) !== -1) {
                  console.log("[HT-MAIN] ★★★ FOUND TEXT IN FIBER STATE! dispatching update...");
                  if (hState.queue && hState.queue.dispatch) {
                    try {
                      hState.queue.dispatch(hVal.replace(savedSelText, newText));
                      console.log("[HT-MAIN] ★ STATE DISPATCH SENT!");
                      replaced = true;
                    } catch (e) { console.log("[HT-MAIN] dispatch error:", e.message); }
                  }
                }
              }
              // Check ref-like patterns
              if (typeof hVal === "object" && hVal !== null && hVal.current !== undefined) {
                var refVal = hVal.current;
                if (typeof refVal === "string" && refVal.indexOf(savedSelText) !== -1) {
                  console.log("[HT-MAIN] ★★★ FOUND TEXT IN REF! dispatching...");
                  if (hState.queue && hState.queue.dispatch) {
                    try {
                      hState.queue.dispatch(refVal.replace(savedSelText, newText));
                      replaced = true;
                    } catch (e) { /* ignore */ }
                  }
                }
                // Check for Editor/EditorState-like objects in refs
                if (typeof refVal === "object" && refVal !== null) {
                  var refStr = "";
                  try { refStr = JSON.stringify(refVal).substring(0, 300); } catch (e) { refStr = String(refVal).substring(0, 100); }
                  if (refStr.indexOf(savedSelText) !== -1) {
                    console.log("[HT-MAIN] ★★★ FOUND TEXT IN REF OBJECT! preview:", refStr.substring(0, 100));
                  }
                  // Check for Lexical-like methods
                  if (typeof refVal.update === "function" && typeof refVal.getEditorState === "function") {
                    console.log("[HT-MAIN] ★★★ LEXICAL EDITOR found in ref at hook", hIdx, "depth", walkDepth);
                    try {
                      refVal.update(function () {
                        refVal.getEditorState()._nodeMap.forEach(function (node) {
                          if (node && node.__text && node.__text.indexOf(savedSelText) !== -1) {
                            try {
                              var w = node.getWritable();
                              w.__text = w.__text.replace(savedSelText, newText);
                              replaced = true;
                              console.log("[HT-MAIN] ★ LEXICAL UPDATE DONE");
                            } catch (e) {
                              node.__text = node.__text.replace(savedSelText, newText);
                              node.__dirty = true;
                              replaced = true;
                            }
                          }
                        });
                      });
                    } catch (e) { console.log("[HT-MAIN] Lexical update error:", e.message); }
                  }
                }
              }
              // Check for deeply nested objects with text
              if (typeof hVal === "object" && hVal !== null && !Array.isArray(hVal)) {
                try {
                  var deepStr = JSON.stringify(hVal);
                  if (deepStr.indexOf(savedSelText) !== -1 && deepStr.length < 5000) {
                    console.log("[HT-MAIN] ★★★ FOUND TEXT in deep object at hook", hIdx, "depth", walkDepth,
                      "keys:", Object.keys(hVal).join(",").substring(0, 60));
                  }
                } catch (e) { /* too large to stringify */ }
              }
              hState = hState.next;
              hIdx++;
            }
            // Check memoizedProps
            if (fiber.memoizedProps) {
              var mpKeys = Object.keys(fiber.memoizedProps);
              var mpPreview = mpKeys.join(",").substring(0, 80);
              if (walkDepth < 5) {
                console.log("[HT-MAIN] fiber depth", walkDepth, "props keys:", mpPreview);
              }
              // Check for text in children prop
              var ch = fiber.memoizedProps.children;
              if (typeof ch === "string" && ch.indexOf(savedSelText) !== -1) {
                console.log("[HT-MAIN] ★★★ FOUND TEXT in children prop at depth", walkDepth);
              }
            }
          }
          if (replaced) break;
          walkEl = walkEl.parentElement;
          walkDepth++;
        }
      }

      // Skip ancestor clicking — go straight to DOM replacement + React fiber update
      // The click approach doesn't work because LinkedIn doesn't use contenteditable at all.

      // ── LAST RESORT: Clipboard paste approach ──
      // Write new text to clipboard, make the overlay contenteditable, focus it,
      // select old text, and paste.
      if (topElement && topElement !== target) {
        console.log("[HT-MAIN] Trying clipboard paste on overlay element");
        try {
          // Step 1: Write new text to clipboard
          navigator.clipboard.writeText(newText).then(function () {
            console.log("[HT-MAIN] clipboard written");

            // Step 2: Make overlay contenteditable and focus
            topElement.setAttribute("contenteditable", "true");
            topElement.focus();
            console.log("[HT-MAIN] overlay focused, contenteditable set, activeElement:", document.activeElement.tagName);

            // Step 3: Select old text (find it in the now-active overlay)
            var sel = window.getSelection();
            var r = findTextRange(savedSelText);
            if (r) {
              sel.removeAllRanges();
              sel.addRange(r);
              console.log("[HT-MAIN] text selected in overlay for paste");
            } else {
              // Text not found in overlay — try selecting all
              document.execCommand("selectAll");
              console.log("[HT-MAIN] selectAll in overlay");
            }

            // Step 4: Try execCommand paste
            setTimeout(function () {
              try {
                // Also set contenteditable on the P element (in case text is there)
                target.setAttribute("contenteditable", "true");
                target.focus();

                sel.removeAllRanges();
                var r2 = findTextRange(savedSelText);
                if (r2) { sel.addRange(r2); }

                // Try execCommand insertText (works like paste in contenteditable)
                if (document.execCommand("insertText", false, newText)) {
                  console.log("[HT-MAIN] ★ insertText succeeded on focused element!");
                  replaced = true;
                } else {
                  // Try paste via DataTransfer
                  var dt = new DataTransfer();
                  dt.setData("text/plain", newText);
                  var pasteEvt = new ClipboardEvent("paste", {
                    bubbles: true, cancelable: true, clipboardData: dt
                  });
                  topElement.dispatchEvent(pasteEvt);
                  if (pasteEvt.defaultPrevented) {
                    console.log("[HT-MAIN] ★ paste event handled!");
                    replaced = true;
                  }
                }

                // Clean up contenteditable
                topElement.removeAttribute("contenteditable");
                target.removeAttribute("contenteditable");
              } catch (e) {
                console.log("[HT-MAIN] paste attempt error:", e.message);
              }

              finish();
            }, 100);
          }).catch(function (e) {
            console.log("[HT-MAIN] clipboard write failed:", e.message);
            finish();
          });
          return; // Don't call finish() yet — async clipboard
        } catch (e) {
          console.log("[HT-MAIN] clipboard approach failed:", e.message);
        }
      }

      // Fallback: direct nodeValue change
      try {
        var textNode = range.startContainer;
        if (textNode.nodeType === Node.TEXT_NODE) {
          textNode.nodeValue = newText;
          console.log("[HT-MAIN] nodeValue updated directly");
        }
      } catch (e) { /* ignore */ }

      function finish() {
        try {
          var sel = window.getSelection();
          try { sel.collapseToEnd(); } catch (e) { sel.removeAllRanges(); }

          var vText = savedSelText;
          setTimeout(function () {
            var check = findTextRange(vText);
            console.log("[HT-MAIN] VERIFY: original text still present:", !!check);
          }, 500);

          console.log("[HT-MAIN] replacement done, replaced:", replaced);
          savedSelRange = null;
          savedSelText = "";
          document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: replaced } }));
        } catch (e) {
          console.log("[HT-MAIN] finish failed:", e.message);
          document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
        }
      }

      finish();
    } catch (e) {
      console.log("[HT-MAIN] replacement failed:", e.message);
      document.dispatchEvent(new CustomEvent("__ht_replace_result", { detail: { success: false } }));
    }
  });
})();
