"use strict";

// Guards the motion and colour rules the web UI is built on:
// - every duration, easing and stagger comes from the motion tokens;
// - no loop cycles more than 3 times a second (WCAG 2.3.1);
// - springs drive position and size only, never opacity or colour;
// - reduced motion switches everything off;
// - text colour tokens clear WCAG 4.5:1 in both themes;
// - toasts stay up long enough to read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const web = path.resolve(__dirname, "..", "web");
const read = (name) => fs.readFileSync(path.join(web, name), "utf8");
const motionCss = read("motion.css");
const interactionCss = read("interaction.css");
const motionJs = read("motion.js");
const stylesCss = read("styles.css");
const appJs = read("app.js");
const motionSheets = { "motion.css": motionCss, "interaction.css": interactionCss };

// ---------------------------------------------------------------- tokens

const rootBlock = motionCss.match(/:root\s*{([\s\S]*?)\n}/);
assert.ok(rootBlock, "motion.css must open with a :root block of motion tokens");
const defined = new Set(Array.from(rootBlock[1].matchAll(/--((?:dur|ease|stagger)-[\w-]+)\s*:/g), (m) => m[1]));
["dur-press", "dur-feedback", "dur-quick", "dur-move", "dur-hero", "dur-reveal", "dur-exit",
  "ease-out", "ease-in", "ease-in-out", "ease-spring", "ease-pop",
  "stagger-word", "stagger-item", "stagger-list"].forEach((name) => {
  assert.ok(defined.has(name), "motion token --" + name + " must be defined in motion.css :root");
});

const referenced = [];
Object.values(motionSheets).forEach((css) => {
  for (const m of css.matchAll(/var\(--((?:dur|ease|stagger)-[\w-]+)/g)) referenced.push(m[1]);
});
for (const m of motionJs.matchAll(/cssVar\("--((?:dur|ease|stagger)-[\w-]+)"/g)) referenced.push(m[1]);
referenced.forEach((name) => {
  assert.ok(defined.has(name), "--" + name + " is used but not defined in motion.css :root");
});

const springSupports = motionCss.match(/@supports \(transition-timing-function: linear\(0, 1\)\)\s*{\s*:root\s*{([\s\S]*?)}\s*}/);
assert.ok(springSupports, "the linear() spring curves must sit behind an @supports check");
["ease-spring", "ease-pop"].forEach((name) => {
  const curve = springSupports[1].match(new RegExp("--" + name + ":\\s*linear\\(([^)]*)\\)"));
  assert.ok(curve, "--" + name + " must have a linear() spring curve");
  const stops = curve[1].split(",").map(Number);
  assert.equal(stops[0], 0, "--" + name + " must start at 0");
  assert.equal(stops[stops.length - 1], 1, "--" + name + " must settle at 1");
  assert.ok(Math.max.apply(null, stops) > 1, "--" + name + " must overshoot like a spring");
});

// Strip comments, then split each sheet into flat (selector, body) rules.
function rules(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+){([^{}]*)}/g)) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function declarations(body, property) {
  return Array.from(body.matchAll(new RegExp("(?:^|[;\\s])" + property + "\\s*:\\s*([^;]+)", "g")), (m) => m[1].trim());
}

function splitTop(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const TIME = /^-?(?:\d+|\d*\.\d+)m?s$/;
const isLoop = (part) => /\binfinite\b/.test(part) || /\s\d+(?:\.\d+)?$/.test(part.replace(/\s+(?:both|forwards|backwards|none|alternate|paused|running)\b/g, ""));

function firstTime(part) {
  const tokens = part.match(/var\([^)]*\)|calc\((?:[^()]|\([^()]*\))*\)|[^\s]+/g) || [];
  return tokens.find((t) => TIME.test(t) || t.startsWith("var(--dur") || t.startsWith("calc("));
}

function seconds(time) {
  return time.endsWith("ms") ? parseFloat(time) / 1000 : parseFloat(time);
}

const keyframes = {};
Object.values(motionSheets).forEach((css) => {
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*{((?:[^{}]|{[^{}]*})*)}/g)) keyframes[m[1]] = m[2];
});

Object.entries(motionSheets).forEach(([file, css]) => {
  rules(css).forEach(({ selector, body }) => {
    if (/!important/.test(body)) {
      return; // the reduced-motion override
    }
    declarations(body, "transition").forEach((value) => {
      splitTop(value).forEach((part) => {
        const time = firstTime(part);
        if (time && TIME.test(time)) {
          assert.equal(seconds(time), 0, file + " " + selector + ": transition '" + part + "' must use a --dur token");
        }
        if (/\b(opacity|color|background|border-color|box-shadow)\b/.test(part.split(/\s/)[0])) {
          assert.doesNotMatch(part, /--ease-(spring|pop)/, file + " " + selector + ": '" + part + "' must not spring; opacity and colour never bounce");
        }
      });
    });
    declarations(body, "transition-duration").forEach((value) => {
      assert.match(value, /^var\(--dur-/, file + " " + selector + ": transition-duration must use a --dur token");
    });
    declarations(body, "animation").forEach((value) => {
      splitTop(value).forEach((part) => {
        if (part === "none") return;
        const name = part.split(/\s+/)[0];
        const time = firstTime(part);
        if (isLoop(part)) {
          assert.ok(time && TIME.test(time), file + " " + selector + ": loop '" + part + "' needs a literal period");
          const cycles = (/\balternate\b/.test(part) ? 0.5 : 1) / seconds(time);
          assert.ok(cycles <= 3, file + " " + selector + ": '" + part + "' cycles " + cycles.toFixed(1) + " times a second; WCAG allows 3");
          return;
        }
        assert.ok(time && !TIME.test(time), file + " " + selector + ": animation '" + part + "' must use a --dur token");
        if (/--ease-(spring|pop)/.test(part) && keyframes[name]) {
          assert.doesNotMatch(keyframes[name], /\b(opacity|color|background)\s*:/,
            file + " " + selector + ": @keyframes " + name + " rides a spring, so it must not animate opacity or colour");
        }
      });
    });
  });
});

assert.match(motionCss, /@media \(prefers-reduced-motion: reduce\)/, "motion.css must honour prefers-reduced-motion");
assert.match(motionCss, /:root\[data-motion="reduced"\] \*[\s\S]*?animation-duration: \.001ms !important;[\s\S]*?animation-iteration-count: 1 !important;/,
  "the Tweaks reduced-motion switch must stop every animation and loop");

// ---------------------------------------------------------------- contrast

function tokenBlock(selector) {
  const m = stylesCss.match(new RegExp(selector.replace(/[[\]"=]/g, "\\$&") + "\\s*{([^}]*)}"));
  assert.ok(m, "styles.css must define " + selector);
  return Object.fromEntries(Array.from(m[1].matchAll(/--([\w-]+):\s*([^;]+);/g), (t) => [t[1], t[2].trim()]));
}

const light = tokenBlock(":root");
const dark = Object.assign({}, light, tokenBlock(':root[data-theme="dark"]'));

function resolve(theme, name) {
  let value = theme[name];
  for (let guard = 0; value && value.startsWith("var(") && guard < 8; guard += 1) value = theme[value.slice(6, -1)];
  assert.match(value || "", /^#[0-9a-f]{6}$/i, "--" + name + " must resolve to a hex colour");
  return value;
}

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ["ink", "muted", "muted-strong", "primary-ink", "accent", "success", "warning", "error"];
const SURFACES = ["surface", "surface-subtle", "canvas"];
const PAIRS = [["primary-foreground", "primary"], ["primary-foreground", "primary-hover"],
  ["accent", "accent-soft"], ["success", "success-soft"], ["warning", "warning-soft"], ["error", "error-soft"],
  ["muted", "primary-soft"], ["muted", "accent-soft"], ["muted", "warning-soft"]]
  .concat(...TEXT.map((fg) => SURFACES.map((bg) => [fg, bg])));

[["light", light], ["dark", dark]].forEach(([label, theme]) => {
  PAIRS.forEach(([fg, bg]) => {
    const ratio = contrast(resolve(theme, fg), resolve(theme, bg));
    assert.ok(ratio >= 4.5, label + ": --" + fg + " on --" + bg + " is " + ratio.toFixed(2) + ":1; text needs 4.5:1");
  });
});

fs.readdirSync(web).filter((name) => name.endsWith(".css")).forEach((name) => {
  assert.doesNotMatch(read(name), /(?<![\w-])color:\s*var\(--primary\)\s*[;!]/,
    name + ": teal text must use --primary-ink; --primary is 3.2:1 on white");
});

// ---------------------------------------------------------------- toasts

const holdSource = appJs.match(/function toastHoldMs\(message\)\s*{[\s\S]*?\n  }/);
assert.ok(holdSource, "app.js must size toast hold time from the message");
const toastHoldMs = vm.runInNewContext("(" + holdSource[0] + ")");
assert.equal(toastHoldMs("Summary JSON downloaded locally."), 2900, "short confirmations keep the 2.9 s floor");
assert.equal(toastHoldMs(Array(20).fill("word").join(" ")), 6500, "0.3 s per word plus 0.5 s");
assert.equal(toastHoldMs(Array(60).fill("word").join(" ")), 10000, "toasts cap at 10 s");

process.stdout.write("motion-contract: ok\n");
