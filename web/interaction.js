/*
 * RNAxRay Web interaction layer.
 *
 * Keyboard and pointer affordances that sit on top of app.js without
 * touching its state: a command palette (⌘K / Ctrl+K or "/"), go-to chords
 * ("g" then a letter), a crosshair and floating readout on analysis canvases,
 * press ripples, card spotlights, a scroll-progress rail, and dialog focus
 * handling. Everything acts through the app's own buttons, so behaviour stays
 * identical to clicking.
 */
(function () {
  "use strict";

  const root = document.documentElement;
  const reduceQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD_LABEL = isMac ? "⌘" : "Ctrl";

  // Letter after "g" → workspace page id.
  const CHORDS = {
    o: "overview",
    i: "interactions",
    c: "contact-map",
    v: "viewpoint",
    r: "region",
    p: "compare",
    s: "structure",
    e: "report"
  };
  const CHORD_FOR_PAGE = Object.keys(CHORDS).reduce(function (map, key) {
    map[CHORDS[key]] = key;
    return map;
  }, {});
  const ANALYSIS_ORDER = ["overview", "interactions", "contact-map", "viewpoint", "region", "compare", "structure"];

  let app = null;

  function motionReduced() {
    return root.dataset.motion === "reduced" || !!(reduceQuery && reduceQuery.matches);
  }

  function isTyping(target) {
    if (!target || !target.closest) {
      return false;
    }
    return !!target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
  }

  function visible(node) {
    if (!node || !node.isConnected || node.disabled) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function clickAction(selector) {
    const node = app && app.querySelector(selector);
    if (node) {
      node.click();
      return true;
    }
    return false;
  }

  function navigateTo(page) {
    return clickAction('.sidebar [data-action="navigate"][data-page="' + page + '"]')
      || clickAction('.mobile-nav [data-action="navigate"][data-page="' + page + '"]')
      || clickAction('[data-action="navigate"][data-page="' + page + '"]');
  }

  function activePage() {
    const active = app && app.querySelector(".sidebar .nav-button.is-active, .mobile-nav .nav-button.is-active");
    return active ? active.getAttribute("data-page") : null;
  }

  // ------------------------------------------------------------------
  // Command palette
  // ------------------------------------------------------------------

  const palette = createPalette();

  function createPalette() {
    let layer = null;
    let input = null;
    let list = null;
    let glider = null;
    let items = [];
    let filtered = [];
    let activeIndex = 0;
    let returnFocus = null;
    let openState = false;

    const ACTION_PATTERN = /^(Export|Download|Generate|Explore|Update|Copy|Run|Reset|Try example|Choose|Add|Open|Print|Review|View|Fold|Enter analysis|Replace)/i;

    function build() {
      layer = document.createElement("div");
      layer.className = "cmdk";
      layer.hidden = true;
      layer.innerHTML = [
        '<div class="cmdk-backdrop" data-cmdk-close></div>',
        '<div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="Command palette">',
        '  <div class="cmdk-search">',
        '    <svg class="cmdk-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg>',
        '    <input type="text" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Jump to a page or run an action…">',
        '    <kbd>esc</kbd>',
        "  </div>",
        '  <div class="cmdk-body"><span class="cmdk-glider" aria-hidden="true"></span><ul id="cmdk-list" class="cmdk-list" role="listbox" aria-label="Commands"></ul></div>',
        '  <footer class="cmdk-footer"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>g</kbd> then a letter jumps</span><span><kbd>[</kbd><kbd>]</kbd> prev / next page</span></footer>',
        "</div>"
      ].join("");
      document.body.appendChild(layer);
      input = layer.querySelector("input");
      list = layer.querySelector(".cmdk-list");
      glider = layer.querySelector(".cmdk-glider");

      input.addEventListener("input", function () {
        activeIndex = 0;
        renderList();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Enter") {
          event.preventDefault();
          run(filtered[activeIndex]);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "Tab") {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        }
      });
      list.addEventListener("pointermove", function (event) {
        const option = event.target.closest("[data-index]");
        if (option) {
          const index = Number(option.getAttribute("data-index"));
          if (index !== activeIndex) {
            activeIndex = index;
            paintActive(false);
          }
        }
      });
      list.addEventListener("click", function (event) {
        const option = event.target.closest("[data-index]");
        if (option) {
          run(filtered[Number(option.getAttribute("data-index"))]);
        }
      });
      layer.addEventListener("click", function (event) {
        if (event.target.closest("[data-cmdk-close]")) {
          close();
        }
      });
    }

    function collect() {
      const out = [];
      const page = activePage();
      const inWorkspace = !!(app && app.querySelector(".workspace"));

      if (inWorkspace) {
        Array.prototype.forEach.call(app.querySelectorAll('.sidebar [data-action="navigate"][data-page]'), function (button) {
          const id = button.getAttribute("data-page");
          out.push({
            group: "Go to",
            label: button.getAttribute("aria-label") || button.textContent.trim(),
            hint: CHORD_FOR_PAGE[id] ? "g " + CHORD_FOR_PAGE[id] : "",
            icon: "page",
            current: id === page,
            run: function () { navigateTo(id); }
          });
        });
      }

      const scope = app && (app.querySelector(".content-wrap") || app.querySelector(".landing-main"));
      const seen = {};
      if (scope) {
        Array.prototype.forEach.call(scope.querySelectorAll("button, a.quiet-button, a.button"), function (button) {
          const label = button.textContent.replace(/\s+/g, " ").trim();
          if (!label || label.length > 48 || seen[label] || !ACTION_PATTERN.test(label) || !visible(button)) {
            return;
          }
          seen[label] = true;
          out.push({
            group: "On this page",
            label: label,
            hint: "",
            icon: /^(Export|Download)/i.test(label) ? "download" : "action",
            run: function () {
              if (button.isConnected) {
                button.click();
                return;
              }
              const again = Array.prototype.find.call(app.querySelectorAll("button, a"), function (node) {
                return node.textContent.replace(/\s+/g, " ").trim() === label;
              });
              if (again) {
                again.click();
              }
            }
          });
        });
      }

      const general = [
        { label: "Data and files", action: "open-files" },
        { label: "Help for this page", action: "open-help" },
        { label: "Display settings", action: "open-display" },
        { label: "Privacy", action: "open-privacy" },
        { label: "Start over…", action: "start-over", fallback: "open-files" }
      ];
      general.forEach(function (entry) {
        // Start over lives in the Data panel: open it, then ask.
        const opener = app && (app.querySelector('[data-action="' + entry.action + '"]') ? entry.action : entry.fallback && app.querySelector('[data-action="' + entry.fallback + '"]') ? entry.fallback : null);
        if (opener) {
          out.push({ group: "General", label: entry.label, hint: "", icon: "action", run: function () {
            clickAction('[data-action="' + opener + '"]');
            if (opener !== entry.action) {
              window.requestAnimationFrame(function () { clickAction('[data-action="' + entry.action + '"]'); });
            }
          } });
        }
      });
      out.push({
        group: "General",
        label: root.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        hint: "",
        icon: "theme",
        // the theme switch lives in the Display panel
        run: function () {
          if (!clickAction('[data-action="toggle-theme"]') && clickAction('[data-action="open-display"]')) {
            window.requestAnimationFrame(function () { clickAction('[data-action="toggle-theme"]'); });
          }
        }
      });
      out.push({
        group: "General",
        label: root.dataset.motion === "reduced" ? "Turn motion on" : "Reduce motion",
        hint: "",
        icon: "motion",
        run: function () { toggleMotion(); }
      });
      return out;
    }

    // Subsequence match: consecutive and word-start hits score higher.
    function score(label, query) {
      if (!query) {
        return { score: 0, hits: [] };
      }
      const text = label.toLowerCase();
      const q = query.toLowerCase().replace(/\s+/g, "");
      let from = 0;
      let total = 0;
      let streak = 0;
      const hits = [];
      for (let i = 0; i < q.length; i += 1) {
        const at = text.indexOf(q[i], from);
        if (at === -1) {
          return null;
        }
        const wordStart = at === 0 || /[\s\-·/(]/.test(text[at - 1]);
        streak = at === from && i > 0 ? streak + 1 : 0;
        total += 1 + streak * 2 + (wordStart ? 3 : 0) - Math.min(at - from, 6) * 0.15;
        hits.push(at);
        from = at + 1;
      }
      return { score: total, hits: hits };
    }

    function highlight(label, hits) {
      if (!hits.length) {
        return escapeHtml(label);
      }
      const set = {};
      hits.forEach(function (index) { set[index] = true; });
      let out = "";
      for (let i = 0; i < label.length; i += 1) {
        out += set[i] ? "<mark>" + escapeHtml(label[i]) + "</mark>" : escapeHtml(label[i]);
      }
      return out;
    }

    const ICONS = {
      page: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="M3.5 8h13"/></svg>',
      action: '<svg viewBox="0 0 20 20"><path d="M7 4.5l7 5.5-7 5.5z"/></svg>',
      download: '<svg viewBox="0 0 20 20"><path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12"/></svg>',
      theme: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/><path d="M10 4a6 6 0 0 1 0 12z" fill="currentColor"/></svg>',
      motion: '<svg viewBox="0 0 20 20"><path d="M3 13c2.5 0 2.5-6 5-6s2.5 6 5 6 2.5-6 4-6"/></svg>'
    };

    function renderList() {
      const query = input.value.trim();
      const scored = [];
      items.forEach(function (item, order) {
        const match = score(item.label, query);
        if (match) {
          scored.push({ item: item, match: match, order: order });
        }
      });
      if (query) {
        scored.sort(function (a, b) { return b.match.score - a.match.score || a.order - b.order; });
      }
      filtered = scored.map(function (entry) { return entry.item; });
      if (!scored.length) {
        list.innerHTML = '<li class="cmdk-empty" role="presentation">No matching page or action</li>';
        glider.style.opacity = "0";
        input.removeAttribute("aria-activedescendant");
        return;
      }
      let html = "";
      let lastGroup = null;
      scored.forEach(function (entry, index) {
        const item = entry.item;
        if (!query && item.group !== lastGroup) {
          html += '<li class="cmdk-group" role="presentation">' + escapeHtml(item.group) + "</li>";
          lastGroup = item.group;
        }
        html += '<li class="cmdk-item' + (item.current ? " is-current" : "") + '" role="option" id="cmdk-opt-' + index + '" data-index="' + index + '" aria-selected="false">'
          + '<span class="cmdk-item-icon" aria-hidden="true">' + (ICONS[item.icon] || ICONS.action) + "</span>"
          + '<span class="cmdk-item-label">' + highlight(item.label, entry.match.hits) + "</span>"
          + (item.current ? '<span class="cmdk-item-meta">Current</span>' : "")
          + (item.hint ? '<kbd class="cmdk-item-kbd">' + escapeHtml(item.hint) + "</kbd>" : "")
          + (query ? '<span class="cmdk-item-meta">' + escapeHtml(item.group) + "</span>" : "")
          + "</li>";
      });
      list.innerHTML = html;
      activeIndex = Math.min(activeIndex, filtered.length - 1);
      paintActive(true);
    }

    function paintActive(instant) {
      const options = list.querySelectorAll("[data-index]");
      Array.prototype.forEach.call(options, function (node) {
        const on = Number(node.getAttribute("data-index")) === activeIndex;
        node.classList.toggle("is-active", on);
        node.setAttribute("aria-selected", on ? "true" : "false");
      });
      const current = list.querySelector('[data-index="' + activeIndex + '"]');
      if (!current) {
        return;
      }
      input.setAttribute("aria-activedescendant", current.id);
      glider.classList.toggle("is-instant", !!instant || motionReduced());
      glider.style.opacity = "1";
      glider.style.transform = "translateY(" + current.offsetTop + "px)";
      glider.style.height = current.offsetHeight + "px";
      const body = list.parentNode;
      if (current.offsetTop < body.scrollTop) {
        body.scrollTop = current.offsetTop - 8;
      } else if (current.offsetTop + current.offsetHeight > body.scrollTop + body.clientHeight) {
        body.scrollTop = current.offsetTop + current.offsetHeight - body.clientHeight + 8;
      }
    }

    function move(delta) {
      if (!filtered.length) {
        return;
      }
      activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
      paintActive(false);
    }

    function run(item) {
      if (!item) {
        return;
      }
      close(true);
      // Let the palette leave before the app re-renders.
      window.setTimeout(item.run, 0);
    }

    function open(prefill) {
      if (!layer) {
        build();
      }
      if (openState) {
        input.select();
        return;
      }
      openState = true;
      returnFocus = document.activeElement;
      hideLens();
      items = collect();
      input.value = prefill || "";
      activeIndex = 0;
      layer.hidden = false;
      layer.classList.remove("is-leaving");
      void layer.offsetWidth;
      layer.classList.add("is-open");
      renderList();
      input.focus();
      document.body.classList.add("cmdk-locked");
    }

    function close(skipFocus) {
      if (!openState) {
        return;
      }
      openState = false;
      layer.classList.remove("is-open");
      document.body.classList.remove("cmdk-locked");
      const finish = function () {
        if (!openState) {
          layer.hidden = true;
          layer.classList.remove("is-leaving");
        }
      };
      if (motionReduced()) {
        finish();
      } else {
        layer.classList.add("is-leaving");
        window.setTimeout(finish, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dur-exit")) || 200);
      }
      if (!skipFocus && returnFocus && returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    }

    return {
      open: open,
      close: close,
      toggle: function () { if (openState) { close(); } else { open(); } },
      isOpen: function () { return openState; }
    };
  }

  function toggleMotion() {
    const toggle = document.querySelector("[data-motion-toggle]");
    if (toggle) {
      toggle.click();
      return;
    }
    // motion.js listens for clicks on [data-motion-toggle]; use a detached proxy.
    const proxy = document.createElement("button");
    proxy.setAttribute("data-motion-toggle", "");
    proxy.hidden = true;
    document.body.appendChild(proxy);
    proxy.click();
    proxy.remove();
  }

  // ------------------------------------------------------------------
  // Keyboard: palette, go-to chords, page stepping, dialog escape
  // ------------------------------------------------------------------

  let chordTimer = 0;
  let chordActive = false;
  const chordHud = document.createElement("div");
  chordHud.className = "chord-hud";
  chordHud.setAttribute("aria-hidden", "true");

  function setChord(on) {
    chordActive = on;
    window.clearTimeout(chordTimer);
    document.body.classList.toggle("is-chording", on);
    if (on) {
      if (!chordHud.isConnected) {
        document.body.appendChild(chordHud);
      }
      chordHud.innerHTML = "<kbd>g</kbd><span>then</span>" + Object.keys(CHORDS).map(function (key) {
        return '<span class="chord-hud-pair"><kbd>' + key + "</kbd>" + escapeHtml(labelFor(CHORDS[key])) + "</span>";
      }).join("");
      chordTimer = window.setTimeout(function () { setChord(false); }, 1600);
    }
  }

  function labelFor(page) {
    const button = app && app.querySelector('.sidebar [data-page="' + page + '"]');
    return button ? (button.getAttribute("aria-label") || page) : page;
  }

  // One Esc closes one layer. app.js may close a dialog before the handler
  // below runs, so note in the capture phase whether a dialog was open.
  let escClosedDialog = false;
  document.addEventListener("keydown", function (event) {
    escClosedDialog = event.key === "Escape" && !!document.querySelector("#app [data-dialog]");
  }, true);

  document.addEventListener("keydown", function (event) {
    const key = event.key;

    if ((key === "k" || key === "K") && (event.metaKey || event.ctrlKey) && !event.altKey) {
      event.preventDefault();
      palette.toggle();
      return;
    }
    if (palette.isOpen()) {
      return;
    }

    const dialog = document.querySelector("[data-dialog]");
    if (dialog) {
      if (key === "Escape") {
        const closeButton = dialog.querySelector('[data-action="close-dialog"]');
        if (closeButton) {
          event.preventDefault();
          closeButton.click();
        }
      } else if (key === "Tab") {
        trapFocus(dialog, event);
      }
      return;
    }

    // Esc also closes the non-modal panels, unless it is clearing a field
    // outside them or app.js already used it to close a dialog.
    if (key === "Escape" && !escClosedDialog) {
      const panelClose = closePanelButton();
      if (panelClose && (!isTyping(event.target) || panelClose.closest("aside").contains(event.target))) {
        event.preventDefault();
        panelClose.click();
        return;
      }
    }

    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) {
      return;
    }

    if (chordActive) {
      const page = CHORDS[key.toLowerCase()];
      setChord(false);
      if (page && app.querySelector(".workspace")) {
        event.preventDefault();
        navigateTo(page);
      }
      return;
    }

    if (key === "/" || key === "?") {
      event.preventDefault();
      palette.open();
      return;
    }
    if ((key === "g" || key === "G") && app && app.querySelector(".workspace")) {
      event.preventDefault();
      setChord(true);
      return;
    }
    if ((key === "[" || key === "]") && app && app.querySelector(".workspace")) {
      const index = ANALYSIS_ORDER.indexOf(activePage());
      if (index !== -1) {
        event.preventDefault();
        const next = ANALYSIS_ORDER[(index + (key === "]" ? 1 : -1) + ANALYSIS_ORDER.length) % ANALYSIS_ORDER.length];
        navigateTo(next);
      }
    }
  });

  function focusables(container) {
    return Array.prototype.filter.call(container.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"), function (node) {
      return !node.disabled && node.offsetParent !== null;
    });
  }

  function trapFocus(dialog, event) {
    const nodes = focusables(dialog);
    if (!nodes.length) {
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  // ------------------------------------------------------------------
  // Canvas lens: crosshair + floating readout that follows the pointer
  // ------------------------------------------------------------------

  const DEFAULT_READOUT = /^Hover a cell/;
  const lens = document.createElement("div");
  lens.className = "canvas-lens";
  lens.setAttribute("aria-hidden", "true");
  let lensTarget = { x: 0, y: 0 };
  let lensPos = null;
  let lensRaf = 0;
  let lensCanvas = null;
  let crosshair = null;

  function readoutFor(canvas) {
    let text = canvas.getAttribute("title");
    if (text) {
      canvas.setAttribute("data-lens-title", text);
      // Suppress the slow native tooltip; the lens shows the same text.
      canvas.removeAttribute("title");
    } else if (canvas.hasAttribute("data-lens-title")) {
      text = "";
    }
    if (!text) {
      const card = canvas.closest(".data-card, section, .card") || canvas.parentNode;
      const stage = canvas.getAttribute("data-contact-stage");
      const tooltip = stage
        ? document.querySelector('[data-contact-tooltip="' + stage + '"]')
        : (card && card.querySelector("[data-contact-tooltip]"));
      if (tooltip && !DEFAULT_READOUT.test(tooltip.textContent)) {
        text = tooltip.textContent;
      }
    }
    return text || "";
  }

  function lensMarkup(text) {
    const parts = text.split(" · ");
    return '<strong>' + escapeHtml(parts[0]) + "</strong>" + parts.slice(1).map(function (part) {
      return "<span>" + escapeHtml(part) + "</span>";
    }).join("");
  }

  function ensureCrosshair(canvas) {
    const wrap = canvas.parentNode;
    if (!wrap) {
      return null;
    }
    let node = wrap.querySelector(":scope > .canvas-crosshair");
    if (!node) {
      node = document.createElement("div");
      node.className = "canvas-crosshair";
      node.setAttribute("aria-hidden", "true");
      node.innerHTML = '<span class="canvas-crosshair-x"></span><span class="canvas-crosshair-y"></span>';
      wrap.appendChild(node);
    }
    const twoD = canvas.matches(".contact-canvas, [data-comparison-map], [data-contact-stage]");
    node.classList.toggle("is-1d", !twoD);
    return node;
  }

  function stepLens() {
    lensRaf = 0;
    if (!lensPos) {
      return;
    }
    const follow = motionReduced() ? 1 : 0.28;
    lensPos.x += (lensTarget.x - lensPos.x) * follow;
    lensPos.y += (lensTarget.y - lensPos.y) * follow;
    const width = lens.offsetWidth;
    const flip = lensTarget.x + width + 28 > window.innerWidth;
    const x = flip ? lensPos.x - width - 18 : lensPos.x + 18;
    lens.style.transform = "translate3d(" + x.toFixed(1) + "px," + (lensPos.y + 18).toFixed(1) + "px,0)";
    if (Math.abs(lensTarget.x - lensPos.x) > 0.3 || Math.abs(lensTarget.y - lensPos.y) > 0.3) {
      lensRaf = requestAnimationFrame(stepLens);
    }
  }

  document.addEventListener("pointermove", function (event) {
    const canvas = event.target && event.target.closest && event.target.closest(".workspace .canvas-wrap canvas, .workspace canvas[data-comparison-map]");
    if (!canvas || event.pointerType === "touch") {
      hideLens();
      return;
    }
    if (lensCanvas !== canvas) {
      hideLens();
      lensCanvas = canvas;
      crosshair = ensureCrosshair(canvas);
    }
    const wrapRect = canvas.parentNode.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (crosshair) {
      crosshair.style.setProperty("--cx", (event.clientX - wrapRect.left) + "px");
      crosshair.style.setProperty("--cy", (event.clientY - wrapRect.top) + "px");
      crosshair.style.setProperty("--top", (canvasRect.top - wrapRect.top) + "px");
      crosshair.style.setProperty("--height", canvasRect.height + "px");
      crosshair.classList.add("is-on");
    }
    // Read after the app's own canvas handler has updated its readout.
    const text = readoutFor(canvas);
    if (text) {
      if (!lens.isConnected) {
        document.body.appendChild(lens);
      }
      if (lens.getAttribute("data-text") !== text) {
        lens.setAttribute("data-text", text);
        lens.innerHTML = lensMarkup(text);
      }
      lensTarget = { x: event.clientX, y: event.clientY };
      if (!lensPos) {
        lensPos = { x: event.clientX, y: event.clientY };
      }
      lens.classList.add("is-on");
      if (!lensRaf) {
        lensRaf = requestAnimationFrame(stepLens);
      }
    } else {
      lens.classList.remove("is-on");
    }
  }, { passive: true });

  function hideLens() {
    lens.classList.remove("is-on");
    lensPos = null;
    if (crosshair) {
      crosshair.classList.remove("is-on");
    }
    if (lensCanvas && lensCanvas.hasAttribute("data-lens-title") && !lensCanvas.hasAttribute("title")) {
      lensCanvas.removeAttribute("data-lens-title");
    }
    lensCanvas = null;
    crosshair = null;
  }

  document.addEventListener("pointerleave", hideLens);
  window.addEventListener("scroll", hideLens, { passive: true });

  // ------------------------------------------------------------------
  // Press ripple + card spotlight
  // ------------------------------------------------------------------

  const RIPPLE_TARGETS = ".button, .quiet-button, .text-button, .nav-button, .icon-button, .local-chip, .tweaks-trigger, .cmdk-trigger";

  document.addEventListener("pointerdown", function (event) {
    if (motionReduced() || event.button !== 0) {
      return;
    }
    const target = event.target.closest && event.target.closest(RIPPLE_TARGETS);
    if (!target || target.disabled) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const size = Math.hypot(rect.width, rect.height) * 2;
    const ripple = document.createElement("span");
    ripple.className = "press-ripple";
    ripple.style.width = ripple.style.height = size + "px";
    ripple.style.left = (event.clientX - rect.left - size / 2) + "px";
    ripple.style.top = (event.clientY - rect.top - size / 2) + "px";
    target.appendChild(ripple);
    ripple.addEventListener("animationend", function () { ripple.remove(); });
  }, { passive: true });

  const SPOTLIGHT = ".metric-card, .web-capability-card, .file-card-inner, .hero-stage";
  document.addEventListener("pointermove", function (event) {
    const card = event.target.closest && event.target.closest(SPOTLIGHT);
    if (!card) {
      return;
    }
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", (event.clientX - rect.left) + "px");
    card.style.setProperty("--my", (event.clientY - rect.top) + "px");
  }, { passive: true });

  // ------------------------------------------------------------------
  // Scroll rail + header state
  // ------------------------------------------------------------------

  const rail = document.createElement("div");
  rail.className = "scroll-rail";
  rail.setAttribute("aria-hidden", "true");
  let railRaf = 0;

  function updateRail() {
    railRaf = 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    rail.style.transform = "scaleX(" + progress.toFixed(4) + ")";
    document.body.classList.toggle("is-scrolled", window.scrollY > 6);
  }

  window.addEventListener("scroll", function () {
    if (!railRaf) {
      railRaf = requestAnimationFrame(updateRail);
    }
  }, { passive: true });

  // ------------------------------------------------------------------
  // Per-render decoration: palette trigger, nav shortcut hints, dialogs
  // ------------------------------------------------------------------

  let lastDialog = null;
  let dialogReturnFocus = null;
  // The control that opened a dialog is destroyed by the re-render, so
  // remember its action and focus the fresh copy when the dialog closes.
  let lastAction = null;

  document.addEventListener("click", function (event) {
    const control = event.target.closest && event.target.closest("[data-action]");
    if (control && !control.closest("[data-dialog]")) {
      lastAction = control.getAttribute("data-action");
    }
  }, true);

  // The record drawer is not a dialog, and the render that opens or closes
  // it replaces the row that was clicked, so focus would fall to <body>.
  // Put it back on the matching row in the new tree.
  let openedRecord = null;

  function closePanelButton() {
    return app && app.querySelector('.record-drawer [data-feature-action="close-record"]');
  }

  function focusAfterRender(selector) {
    window.requestAnimationFrame(function () {
      const target = app && app.querySelector(selector);
      if (target && visible(target) && (!document.activeElement || document.activeElement === document.body)) {
        target.focus({ preventScroll: true });
      }
    });
  }

  // Capture phase: read the clicked control before the render replaces it
  // (and motion.js strips the old copy for its exit animation).
  document.addEventListener("click", function (event) {
    const control = event.target.closest && event.target.closest('[data-feature-action="open-record"], [data-feature-action="close-record"]');
    if (!control) {
      return;
    }
    if (control.matches('[data-feature-action="open-record"]')) {
      openedRecord = control.getAttribute("data-record-index");
      focusAfterRender('.virtual-row[data-record-index="' + openedRecord + '"]');
    } else {
      focusAfterRender(openedRecord !== null ? '.virtual-row[data-record-index="' + openedRecord + '"]' : ".interaction-table-card");
    }
  }, true);

  function decorate() {
    const workspace = app.querySelector(".workspace");
    document.body.classList.toggle("has-workspace", !!workspace);
    if (workspace && !rail.isConnected) {
      document.body.appendChild(rail);
    }
    updateRail();

    const actions = app.querySelector(".workspace-header .toolbar-actions, .landing-header .header-actions");
    if (actions && !actions.querySelector(".cmdk-trigger")) {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "cmdk-trigger";
      trigger.setAttribute("aria-label", "Open command palette");
      trigger.setAttribute("aria-keyshortcuts", isMac ? "Meta+K" : "Control+K");
      trigger.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4 4"/></svg><span>Search</span><kbd>' + MOD_LABEL + "K</kbd>";
      trigger.addEventListener("click", function () { palette.open(); });
      actions.insertBefore(trigger, actions.firstChild);
    }

    Array.prototype.forEach.call(app.querySelectorAll('.sidebar .nav-button[data-page]'), function (button) {
      const key = CHORD_FOR_PAGE[button.getAttribute("data-page")];
      if (key && !button.querySelector(".nav-kbd")) {
        const hint = document.createElement("kbd");
        hint.className = "nav-kbd";
        hint.setAttribute("aria-hidden", "true");
        hint.textContent = key;
        button.appendChild(hint);
        button.setAttribute("aria-keyshortcuts", "G " + key.toUpperCase());
      }
    });

    // Dialogs: move focus in when one opens, give it back when it closes.
    const dialog = app.querySelector("[data-dialog]");
    const dialogKey = dialog ? dialog.getAttribute("aria-labelledby") || "dialog" : null;
    if (dialog && dialogKey !== lastDialog) {
      if (!lastDialog) {
        dialogReturnFocus = lastAction;
      }
      const preferred = dialog.querySelector('[data-action="close-dialog"]') || focusables(dialog)[0];
      if (preferred) {
        preferred.focus({ preventScroll: true });
      }
    } else if (!dialog && lastDialog && dialogReturnFocus) {
      const back = app.querySelector('[data-action="' + dialogReturnFocus + '"]');
      if (back && visible(back)) {
        back.focus({ preventScroll: true });
      }
      dialogReturnFocus = null;
    }
    lastDialog = dialogKey;
  }

  function boot() {
    app = document.getElementById("app");
    if (!app) {
      return;
    }
    new MutationObserver(decorate).observe(app, { childList: true });
    if (app.firstElementChild) {
      decorate();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
