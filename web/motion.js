/*
 * RNAxRay Web motion layer.
 *
 * app.js re-renders #app with innerHTML on every state change, so this file
 * never touches application state. A MutationObserver classifies each render
 * into a "scene" (landing idle / loading / review, workspace page). Only a
 * scene change adds a motion-* class; renders within the same scene paint in
 * their final state. Long-lived pieces (the hero canvas) are moved into each
 * fresh placeholder rather than rebuilt, so they keep animating across
 * renders.
 */
(function () {
  "use strict";

  const root = document.documentElement;
  const reduceQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const MOTION_KEY = "rnaxray-web-motion";
  const SCENE_CLASSES = ["motion-intro", "motion-panel", "motion-workspace", "motion-page"];

  try {
    if (window.localStorage.getItem(MOTION_KEY) === "reduced") {
      root.dataset.motion = "reduced";
    }
  } catch (error) {
    // Storage can be unavailable (private mode); motion stays on.
  }

  function motionReduced() {
    return root.dataset.motion === "reduced" || !!(reduceQuery && reduceQuery.matches);
  }

  function cssVar(name, fallback) {
    const value = getComputedStyle(root).getPropertyValue(name).trim();
    return value || fallback;
  }

  // ------------------------------------------------------------------
  // Scene orchestration
  // ------------------------------------------------------------------

  let app = null;
  let lastScene = null;
  let sceneTimer = 0;
  let sceneClass = null;
  let sceneStartedAt = 0;
  let sceneSettled = false;
  let lastGliderTop = null;
  let gliderFrom = null;
  // Pages often render twice: once immediately, then again a few ms later
  // when async provider data arrives. A same-scene render inside this window
  // continues the entrance instead of cancelling it.
  const SCENE_GRACE_MS = 450;

  function readScene() {
    if (!app) {
      return null;
    }
    if (app.querySelector(".landing")) {
      if (app.querySelector(".load-state .progress-bar")) {
        return "landing:loading";
      }
      if (app.querySelector(".prepared-file-card")) {
        return "landing:review";
      }
      if (app.querySelector(".load-state")) {
        return "landing:error";
      }
      return "landing:idle";
    }
    if (app.querySelector(".workspace")) {
      const active = app.querySelector(".sidebar .nav-button.is-active, .mobile-nav .nav-button.is-active");
      return "workspace:" + (active ? active.getAttribute("data-page") : "other");
    }
    return "other";
  }

  function setScene(className) {
    SCENE_CLASSES.forEach(function (name) {
      app.classList.remove(name);
    });
    window.clearTimeout(sceneTimer);
    sceneClass = className;
    if (!className || motionReduced()) {
      return;
    }
    // No forced reflow: every scene arrives as freshly rendered nodes, which
    // start their animations on insertion. Reading layout here cost ~25 ms
    // on long pages such as the report.
    className.split(" ").forEach(function (name) {
      app.classList.add(name);
    });
    sceneTimer = window.setTimeout(function () {
      SCENE_CLASSES.forEach(function (name) {
        app.classList.remove(name);
      });
    }, 2600);
  }

  // Overlays that app.js re-creates on each render: animate only on the
  // render where they first appear. A closed overlay is simply missing from
  // the new tree, so its last node is put back once to play the exit.
  const APPEARING = [".pop-layer", ".record-drawer", ".tweaks-panel"];
  const present = {};
  const lastNode = {};
  const INERT_ATTRS = ["id", "data-action", "data-feature-action", "data-dialog", "name", "for"];

  function exitMs() {
    return parseFloat(cssVar("--dur-exit", "200")) || 200;
  }

  // The copy lives outside #app, stripped of ids and actions, so no handler,
  // query or focus trap mistakes it for the live overlay.
  function playExit(node) {
    if (!node || node.isConnected || motionReduced()) {
      return;
    }
    [node].concat(Array.prototype.slice.call(node.querySelectorAll("*"))).forEach(function (el) {
      INERT_ATTRS.forEach(function (name) {
        el.removeAttribute(name);
      });
    });
    node.classList.remove("is-appearing");
    node.classList.add("is-leaving");
    node.setAttribute("aria-hidden", "true");
    node.inert = true;
    document.body.appendChild(node);
    window.setTimeout(function () {
      node.remove();
    }, exitMs() + 40);
  }

  function markAppearing() {
    APPEARING.forEach(function (selector) {
      const node = app.querySelector(selector);
      if (node && !present[selector] && !motionReduced()) {
        node.classList.add("is-appearing");
      }
      if (!node && present[selector]) {
        playExit(lastNode[selector]);
      }
      present[selector] = !!node;
      lastNode[selector] = node;
    });
  }

  function onRender() {
    markAppearing();
    const scene = readScene();
    if (!scene) {
      return;
    }
    const previous = lastScene;
    lastScene = scene;
    const changed = scene !== previous;
    const now = performance.now();
    // Only the first follow-up render settles; a burst of progress renders
    // must not keep restarting the entrance.
    const settling = !changed && !sceneSettled && !!sceneClass && now - sceneStartedAt < SCENE_GRACE_MS;
    if (changed) {
      sceneStartedAt = now;
      sceneSettled = false;
    } else {
      sceneSettled = true;
    }

    if (scene.indexOf("landing:") === 0) {
      mountHero();
      armReveals(changed);
      armMagnetic();
      if (changed) {
        if (!previous || previous.indexOf("landing:") !== 0) {
          setScene("motion-intro");
          scrambleIn(app.querySelector("[data-scramble]"));
        } else {
          setScene("motion-panel");
        }
      } else if (settling) {
        setScene(sceneClass);
      } else {
        setScene(null);
      }
      return;
    }

    if (scene.indexOf("workspace:") === 0) {
      hero.detach();
      const enteringWorkspace = !previous || previous.indexOf("workspace:") !== 0;
      if (changed || settling) {
        assignStagger();
        setScene(changed ? (enteringWorkspace ? "motion-workspace motion-page" : "motion-page") : sceneClass);
        countUp();
      } else {
        setScene(null);
      }
      if (changed) {
        gliderFrom = enteringWorkspace ? null : lastGliderTop;
      }
      placeGlider(changed || settling ? gliderFrom : null, now - sceneStartedAt);
      return;
    }

    hero.detach();
    setScene(null);
  }

  function assignStagger() {
    const wrap = app.querySelector(".content-wrap");
    if (wrap) {
      Array.prototype.forEach.call(wrap.querySelectorAll(":scope > * > *"), function (node, index) {
        node.style.setProperty("--stagger", String(Math.min(index, 8)));
      });
    }
    [".metric-card", ".data-card", ".bar-fill", ".type-meter > span"].forEach(function (selector) {
      Array.prototype.forEach.call(app.querySelectorAll(selector), function (node, index) {
        node.style.setProperty("--stagger", String(Math.min(index, 12)));
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll(".sidebar .sidebar-file, .sidebar .nav-label, .sidebar .nav-button, .sidebar-footer"), function (node, index) {
      node.style.setProperty("--stagger", String(index));
    });
  }

  // ------------------------------------------------------------------
  // Count-up for headline numbers (overview metrics, quality stats)
  // ------------------------------------------------------------------

  function countUp() {
    if (motionReduced()) {
      return;
    }
    const nodes = app.querySelectorAll(".metric-value, .quality-stat strong");
    Array.prototype.forEach.call(nodes, function (node, index) {
      const text = node.textContent;
      const match = /^(\D*)([\d,]+(?:\.\d+)?)(.*)$/.exec(text.trim());
      if (!match) {
        return;
      }
      const target = Number(match[2].replace(/,/g, ""));
      if (!isFinite(target) || target === 0) {
        return;
      }
      const decimals = (match[2].split(".")[1] || "").length;
      const grouped = match[2].indexOf(",") !== -1 || target >= 1000;
      const format = function (value) {
        const fixed = value.toFixed(decimals);
        if (!grouped) {
          return fixed;
        }
        const parts = fixed.split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        return parts.join(".");
      };
      const duration = 1100 + Math.min(index, 4) * 90;
      const delay = 160 + index * 70;
      // Keep the final width from the start so the layout never jitters.
      node.style.minWidth = node.getBoundingClientRect().width + "px";
      node.style.display = node.style.display || "inline-block";
      node.textContent = match[1] + format(0) + match[3];
      const start = performance.now() + delay;
      function frame(now) {
        if (!node.isConnected) {
          return;
        }
        const t = Math.max(0, Math.min(1, (now - start) / duration));
        const eased = 1 - Math.pow(1 - t, 4);
        node.textContent = match[1] + format(target * eased) + match[3];
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          node.textContent = text;
        }
      }
      requestAnimationFrame(frame);
    });
  }

  // ------------------------------------------------------------------
  // Sidebar glider
  // ------------------------------------------------------------------

  function placeGlider(fromTop, elapsed) {
    const sidebar = app.querySelector(".sidebar");
    const active = sidebar && sidebar.querySelector(".nav-button.is-active");
    if (!sidebar || !active) {
      lastGliderTop = null;
      return;
    }
    const glider = document.createElement("span");
    glider.className = "nav-glider";
    glider.setAttribute("aria-hidden", "true");
    const sidebarRect = sidebar.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    const top = rect.top - sidebarRect.top + sidebar.scrollTop;
    glider.style.top = top + "px";
    glider.style.height = rect.height + "px";
    sidebar.insertBefore(glider, sidebar.firstChild);
    sidebar.classList.add("has-glider");
    if (fromTop !== null && fromTop !== top && !motionReduced() && glider.animate) {
      const distance = fromTop - top;
      const gliderMs = parseFloat(cssVar("--dur-move", "400")) || 400;
      glider.animate([
        { transform: "translateY(" + distance + "px) scaleY(1)" },
        { transform: "translateY(" + distance * 0.25 + "px) scaleY(1.18)", offset: 0.55 },
        { transform: "translateY(0) scaleY(1)" }
      ], { duration: gliderMs, delay: -Math.min(elapsed || 0, gliderMs), easing: cssVar("--ease-out", "ease-out") });
    }
    lastGliderTop = top;
  }

  // ------------------------------------------------------------------
  // Eyebrow decode: letters resolve out of nucleotide noise
  // ------------------------------------------------------------------

  function scrambleIn(node) {
    if (!node || motionReduced()) {
      return;
    }
    const finalText = node.textContent;
    const glyphs = "ACGU";
    const started = performance.now() + 140;
    const duration = 900;
    node.setAttribute("aria-label", finalText);
    function frame(now) {
      if (!node.isConnected) {
        return;
      }
      const t = Math.max(0, (now - started) / duration);
      let out = "";
      for (let i = 0; i < finalText.length; i += 1) {
        const ch = finalText[i];
        const reveal = i / finalText.length;
        if (ch === " " || ch === "·" || t >= reveal + 0.18) {
          out += ch;
        } else if (t >= reveal - 0.1) {
          out += glyphs[(Math.random() * 4) | 0];
        } else {
          out += " ";
        }
      }
      node.textContent = out;
      if (t < 1.2) {
        requestAnimationFrame(frame);
      } else {
        node.textContent = finalText;
      }
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Scroll reveal for landing cards
  // ------------------------------------------------------------------

  const revealed = new Set();
  let revealObserver = null;

  function armReveals(sceneChanged) {
    const targets = app.querySelectorAll(".web-capability-card");
    if (!("IntersectionObserver" in window) || motionReduced()) {
      Array.prototype.forEach.call(targets, function (node) {
        node.classList.add("is-revealed");
      });
      return;
    }
    if (revealObserver) {
      revealObserver.disconnect();
    } else {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-revealed");
            revealed.add(entry.target.className.split(" ")[0]);
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.18, rootMargin: "0px 0px -6% 0px" });
    }
    Array.prototype.forEach.call(targets, function (node) {
      const key = node.className.split(" ")[0];
      if (revealed.has(key) && !sceneChanged) {
        // Already shown in this scene: paint final state without replay.
        node.classList.add("is-revealed");
        node.style.animation = "none";
        Array.prototype.forEach.call(node.querySelectorAll("*"), function (child) {
          child.style.animation = "none";
        });
        return;
      }
      if (revealed.has(key)) {
        node.classList.add("is-revealed");
        return;
      }
      node.setAttribute("data-reveal", "");
      revealObserver.observe(node);
    });
  }

  // ------------------------------------------------------------------
  // Magnetic primary actions on the landing page
  // ------------------------------------------------------------------

  function armMagnetic() {
    if (motionReduced() || !window.matchMedia("(pointer: fine)").matches) {
      return;
    }
    const buttons = app.querySelectorAll('.landing [data-action="load-example"], .landing [data-action="choose-hyb"], .landing [data-action="enter-analysis"]');
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.hasAttribute("data-magnetic")) {
        return;
      }
      button.setAttribute("data-magnetic", "");
      button.addEventListener("pointermove", function (event) {
        const rect = button.getBoundingClientRect();
        const x = (event.clientX - rect.left - rect.width / 2) / rect.width;
        const y = (event.clientY - rect.top - rect.height / 2) / rect.height;
        button.style.transform = "translate(" + (x * 8).toFixed(2) + "px," + (y * 6).toFixed(2) + "px)";
      });
      button.addEventListener("pointerleave", function () {
        button.style.transform = "";
      });
    });
  }

  // ------------------------------------------------------------------
  // Theme toggle: circular reveal from the pressed control
  // ------------------------------------------------------------------

  let themeBypass = false;

  document.addEventListener("click", function (event) {
    const toggle = event.target.closest && event.target.closest('[data-action="toggle-theme"]');
    if (!toggle || themeBypass || typeof document.startViewTransition !== "function" || motionReduced()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = toggle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(function () {
      themeBypass = true;
      try {
        toggle.click();
      } finally {
        themeBypass = false;
      }
    });
    transition.ready.then(function () {
      root.animate({
        clipPath: ["circle(0px at " + x + "px " + y + "px)", "circle(" + radius + "px at " + x + "px " + y + "px)"]
      }, {
        duration: parseFloat(cssVar("--dur-hero", "750")) || 750,
        easing: cssVar("--ease-in-out", "ease-in-out"),
        pseudoElement: "::view-transition-new(root)"
      });
    }).catch(function () {});
  }, true);

  // Display panel motion toggle (rendered by app.js, handled here).
  document.addEventListener("click", function (event) {
    const toggle = event.target.closest && event.target.closest("[data-motion-toggle]");
    if (!toggle) {
      return;
    }
    const reduced = root.dataset.motion === "reduced";
    if (reduced) {
      delete root.dataset.motion;
    } else {
      root.dataset.motion = "reduced";
    }
    try {
      window.localStorage.setItem(MOTION_KEY, reduced ? "full" : "reduced");
    } catch (error) {
      // Preference simply does not persist.
    }
    if (!toggle.classList.contains("segmented-option")) {
      toggle.textContent = reduced ? "Reduce motion" : "Turn motion on";
    }
    hero.refresh();
  });

  // ------------------------------------------------------------------
  // Hero stage: illustrative arc diagram
  // ------------------------------------------------------------------

  const hero = createHeroStage();

  function mountHero() {
    const slot = app.querySelector("[data-hero-canvas]");
    if (slot) {
      hero.attach(slot);
    }
  }

  function createHeroStage() {
    const N = 180;
    const BASES = "ACGU";
    let seed = 20261015;
    function random() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }

    const sequence = [];
    for (let i = 0; i < N; i += 1) {
      sequence.push(BASES[(random() * 4) | 0]);
    }

    // Stems: runs of nested pairs above the sequence (intramolecular).
    const stemSpecs = [[6, 40, 5], [14, 31, 3], [48, 92, 6], [56, 82, 4], [62, 74, 3], [100, 172, 5], [108, 138, 4], [114, 130, 3], [144, 166, 4]];
    const stems = [];
    stemSpecs.forEach(function (spec, stemIndex) {
      for (let k = 0; k < spec[2]; k += 1) {
        stems.push({ i: spec[0] + k, j: spec[1] - k, stem: stemIndex, outer: k === 0, bp: spec[2], start: spec[0], end: spec[1] });
      }
    });

    // Chimeric contacts: long-range arcs below, weighted by read support.
    const contacts = [
      { i: 22, j: 128, reads: 214 },
      { i: 70, j: 156, reads: 131 },
      { i: 36, j: 104, reads: 88 },
      { i: 12, j: 176, reads: 62 },
      { i: 88, j: 120, reads: 47 }
    ];

    let host = null;
    let canvas = null;
    let ctx = null;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let rafId = 0;
    let visible = true;
    let born = 0;
    let lastFrame = 0;
    let pointer = null;
    let palette = null;
    let reads = 0;
    let readsNode = null;
    let probeNode = null;
    let particles = [];
    let nextSpawn = 0;
    let ripples = [];
    let resizeObserver = null;
    let visibilityObserver = null;

    function readPalette() {
      palette = {
        ink: cssVar("--ink", "#132c47"),
        muted: cssVar("--muted", "#607286"),
        line: cssVar("--line", "#dce7ec"),
        teal: cssVar("--primary", "#0060fe"),
        violet: cssVar("--accent", "#9c05f8"),
        surface: cssVar("--surface", "#ffffff"),
        dark: root.dataset.theme === "dark",
        bases: {
          A: cssVar("--primary", "#0060fe"),
          U: cssVar("--accent", "#9c05f8"),
          G: cssVar("--muted-strong", "#38516a"),
          C: cssVar("--warning", "#a96614")
        }
      };
    }

    function ensureCanvas() {
      if (canvas) {
        return;
      }
      canvas = document.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      ctx = canvas.getContext("2d");
      canvas.addEventListener("pointermove", function (event) {
        const rect = canvas.getBoundingClientRect();
        pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        if (motionReduced()) {
          draw(performance.now());
        }
      });
      canvas.addEventListener("pointerleave", function () {
        pointer = null;
        setProbe("Hover the sequence");
        if (motionReduced()) {
          draw(performance.now());
        }
      });
      if ("ResizeObserver" in window) {
        resizeObserver = new ResizeObserver(resize);
      }
      if ("IntersectionObserver" in window) {
        visibilityObserver = new IntersectionObserver(function (entries) {
          visible = entries[entries.length - 1].isIntersecting;
          schedule();
        });
      }
      new MutationObserver(function () {
        readPalette();
        if (motionReduced()) {
          draw(performance.now());
        }
      }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
      document.addEventListener("visibilitychange", schedule);
      readPalette();
      born = performance.now();
    }

    function attach(slot) {
      ensureCanvas();
      const stage = slot.closest(".hero-stage");
      readsNode = stage && stage.querySelector("[data-hero-reads]");
      probeNode = stage && stage.querySelector("[data-hero-probe]");
      if (readsNode) {
        readsNode.textContent = reads.toLocaleString("en-US");
      }
      if (canvas.parentNode !== slot) {
        slot.appendChild(canvas);
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver.observe(slot);
        }
        if (visibilityObserver) {
          visibilityObserver.disconnect();
          visibilityObserver.observe(slot);
        }
        host = slot;
        resize();
      }
      schedule();
    }

    function detach() {
      host = null;
      if (canvas && canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
      cancelAnimationFrame(rafId);
      rafId = 0;
    }

    function refresh() {
      if (host) {
        if (motionReduced()) {
          cancelAnimationFrame(rafId);
          rafId = 0;
          draw(performance.now());
        } else {
          schedule();
        }
      }
    }

    function resize() {
      if (!host) {
        return;
      }
      const rect = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      draw(performance.now());
    }

    function schedule() {
      if (!host || rafId || motionReduced() || !visible || document.hidden) {
        if (host && motionReduced()) {
          draw(performance.now());
        }
        return;
      }
      rafId = requestAnimationFrame(tick);
    }

    function tick(now) {
      rafId = 0;
      draw(now);
      schedule();
    }

    function setProbe(text) {
      if (probeNode && probeNode.textContent !== text) {
        probeNode.textContent = text;
      }
    }

    // Geometry ------------------------------------------------------

    function geometry() {
      const padX = 22;
      const base = Math.round(height * 0.5);
      const step = (width - padX * 2) / (N - 1);
      return { padX: padX, base: base, step: step, x: function (i) { return padX + i * step; } };
    }

    function arcShape(g, i, j, above) {
      const x1 = g.x(i);
      const x2 = g.x(j);
      const rx = (x2 - x1) / 2;
      const room = above ? g.base - 26 : height - g.base - 26;
      const ry = Math.min(room, rx * (above ? 0.9 : 0.62));
      return { cx: x1 + rx, rx: rx, ry: ry };
    }

    function easeOut(t) {
      return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
    }

    // Drawing --------------------------------------------------------

    function draw(now) {
      if (!ctx || !width) {
        return;
      }
      const reduced = motionReduced();
      const elapsed = reduced ? 1e9 : now - born;
      // a frame stamp before the last one (a timer restarted on navigation) is
      // no time at all: a negative dt would grow the ripples past their size
      const dt = lastFrame ? Math.max(0, Math.min(64, now - lastFrame)) : 16;
      lastFrame = now;
      const g = geometry();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Hover target: nearest nucleotide and the arc it belongs to.
      let probeIndex = -1;
      let focus = null;
      if (pointer) {
        probeIndex = Math.round((pointer.x - g.padX) / g.step);
        probeIndex = Math.max(0, Math.min(N - 1, probeIndex));
        const below = pointer.y > g.base;
        let best = Infinity;
        (below ? contacts : stems).forEach(function (arc) {
          const d = Math.min(Math.abs(arc.i - probeIndex), Math.abs(arc.j - probeIndex));
          const inside = probeIndex > arc.i && probeIndex < arc.j;
          const score = d + (inside ? 0 : 40) + (below ? -arc.reads / 100 : 0);
          if (score < best && (d <= 3 || inside)) {
            best = score;
            focus = { arc: arc, below: below };
          }
        });
        if (focus && !focus.below) {
          focus.stem = focus.arc.stem;
        }
      }

      // Baseline sweep.
      const lineT = easeOut(elapsed / 800);
      ctx.lineCap = "round";
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(g.x(0), g.base);
      ctx.lineTo(g.x(0) + (g.x(N - 1) - g.x(0)) * lineT, g.base);
      ctx.stroke();

      // Stems above.
      stems.forEach(function (arc) {
        const delay = 500 + arc.stem * 120 + (arc.outer ? 0 : 60);
        const t = easeOut((elapsed - delay) / 900);
        if (t <= 0) {
          return;
        }
        const s = arcShape(g, arc.i, arc.j, true);
        const highlighted = focus && !focus.below && focus.stem === arc.stem;
        const dim = focus && !highlighted;
        ctx.globalAlpha = dim ? 0.18 : (arc.outer ? 0.95 : 0.55);
        ctx.strokeStyle = palette.teal;
        ctx.lineWidth = highlighted ? 2.2 : (arc.outer ? 1.6 : 1.1);
        ctx.beginPath();
        ctx.ellipse(s.cx, g.base, s.rx, s.ry, 0, Math.PI, Math.PI + Math.PI * t, false);
        ctx.stroke();
      });

      // Contacts below, thickness by support.
      contacts.forEach(function (arc, index) {
        const delay = 1500 + index * 160;
        const t = easeOut((elapsed - delay) / 1100);
        if (t <= 0) {
          return;
        }
        const s = arcShape(g, arc.i, arc.j, false);
        const highlighted = focus && focus.below && focus.arc === arc;
        const dim = focus && !highlighted;
        const pulse = arc.pulse ? Math.max(0, arc.pulse) : 0;
        ctx.globalAlpha = dim ? 0.15 : 0.35 + 0.35 * (arc.reads / 214) + pulse * 0.3;
        ctx.strokeStyle = palette.violet;
        ctx.lineWidth = 1 + 3.2 * (arc.reads / 214) + (highlighted ? 1.4 : 0) + pulse * 1.6;
        ctx.beginPath();
        ctx.ellipse(s.cx, g.base, s.rx, s.ry, 0, Math.PI, Math.PI - Math.PI * t, true);
        ctx.stroke();
        if (arc.pulse) {
          arc.pulse = Math.max(0, arc.pulse - dt / 700);
        }
      });
      ctx.globalAlpha = 1;

      // Nucleotides pop in as a wave behind the baseline sweep.
      for (let i = 0; i < N; i += 1) {
        const t = easeOut((elapsed - 120 - i * 3.2) / 360);
        if (t <= 0) {
          continue;
        }
        const x = g.x(i);
        const tall = i % 10 === 0;
        const h = (tall ? 9 : 5) * t;
        const near = probeIndex >= 0 ? Math.max(0, 1 - Math.abs(i - probeIndex) / 6) : 0;
        ctx.globalAlpha = 0.45 + near * 0.55;
        ctx.fillStyle = palette.bases[sequence[i]];
        ctx.fillRect(x - 0.9, g.base - h / 2 - near * 4, 1.8, h + near * 8);
      }
      ctx.globalAlpha = 1;

      // Coordinate ruler.
      ctx.font = "600 9.5px " + cssVar("--font-mono", "ui-monospace, monospace");
      ctx.fillStyle = palette.muted;
      ctx.textAlign = "center";
      ctx.globalAlpha = easeOut((elapsed - 700) / 600);
      for (let i = 0; i < N; i += 30) {
        ctx.fillText(String(i + 1), g.x(i), height - 6);
      }
      ctx.globalAlpha = 1;

      // Reads travel along contacts; arrival bumps the HUD counter.
      if (!reduced && elapsed > 2600) {
        if (now >= nextSpawn) {
          const weights = contacts.map(function (c) { return c.reads; });
          const total = weights.reduce(function (a, b) { return a + b; }, 0);
          let pick = random() * total;
          let chosen = contacts[0];
          for (let k = 0; k < contacts.length; k += 1) {
            pick -= weights[k];
            if (pick <= 0) {
              chosen = contacts[k];
              break;
            }
          }
          particles.push({ arc: chosen, t: 0, forward: random() > 0.5, speed: 0.00055 + random() * 0.0004 });
          nextSpawn = now + 180 + random() * 380;
        }
        particles = particles.filter(function (p) {
          p.t += p.speed * dt;
          if (p.t >= 1) {
            p.arc.pulse = 1;
            const s = arcShape(g, p.arc.i, p.arc.j, false);
            ripples.push({ x: p.forward ? s.cx + s.rx : s.cx - s.rx, life: 1 });
            reads += 1;
            if (readsNode) {
              readsNode.textContent = reads.toLocaleString("en-US");
            }
            return false;
          }
          const s = arcShape(g, p.arc.i, p.arc.j, false);
          const angle = p.forward ? Math.PI - Math.PI * p.t : Math.PI * p.t;
          // Ellipse below baseline: angle runs π → 0 through π/2 (bottom).
          const px = s.cx + s.rx * Math.cos(angle);
          const py = g.base + s.ry * Math.sin(angle);
          ctx.shadowColor = palette.violet;
          ctx.shadowBlur = 12;
          ctx.fillStyle = palette.dark ? "#ffffff" : palette.violet;
          ctx.beginPath();
          ctx.arc(px, py, 2.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          return true;
        });
        ripples = ripples.filter(function (r) {
          r.life -= dt / 650;
          if (r.life <= 0) {
            return false;
          }
          ctx.globalAlpha = r.life * 0.6;
          ctx.strokeStyle = palette.violet;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(r.x, g.base, (1 - r.life) * 14 + 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          return true;
        });
      }

      // Scanner line + probe readout.
      if (pointer && probeIndex >= 0) {
        const x = g.x(probeIndex);
        ctx.strokeStyle = palette.ink;
        ctx.globalAlpha = 0.22;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(x, 8);
        ctx.lineTo(x, height - 18);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.bases[sequence[probeIndex]];
        ctx.beginPath();
        ctx.arc(x, g.base, 3.4, 0, Math.PI * 2);
        ctx.fill();
        let label = "nt " + (probeIndex + 1) + " · " + sequence[probeIndex];
        if (focus && focus.below) {
          label += "  —  contact " + (focus.arc.i + 1) + " ⇄ " + (focus.arc.j + 1) + " · " + focus.arc.reads + " reads";
        } else if (focus) {
          const arc = focus.arc;
          label += "  —  stem " + (arc.start + 1) + "–" + (arc.end + 1) + " · " + arc.bp + " bp";
        }
        setProbe(label);
      }
    }

    return { attach: attach, detach: detach, refresh: refresh };
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  function boot() {
    app = document.getElementById("app");
    if (!app) {
      return;
    }
    new MutationObserver(onRender).observe(app, { childList: true });
    if (app.firstElementChild) {
      onRender();
    }
    if (reduceQuery && typeof reduceQuery.addEventListener === "function") {
      reduceQuery.addEventListener("change", hero.refresh);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
