"use strict";

// Language of the page: German is the source text in the code, English comes from i18n/en.json (keyed by the
// German text, shared with the server). tr(text, { n: 2 }) translates and fills in the {n} placeholders; a text
// without a translation stays German. Loads flow.js and app.js once the dictionary is there.

const LANG_KEY = "mbot-lang";
const LANG = (() => {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "de" || saved === "en") return saved;
  } catch (_) { /* no storage */ }
  return /^de\b/i.test(navigator.language || "") ? "de" : "en";
})();
let I18N = {};

function tr(text, args) {
  const s = LANG === "en" && Object.prototype.hasOwnProperty.call(I18N, text) ? I18N[text] : text;
  return args ? s.replace(/\{(\w+)\}/g, (m, k) => (k in args ? String(args[k]) : m)) : s;
}

// numbers the way the reader writes them: 0,5 / 0.5
const fmtNum = n => (LANG === "de" ? String(n).replace(".", ",") : String(n));

function setLang(lang) {
  try { localStorage.setItem(LANG_KEY, lang); } catch (_) { /* ignore */ }
  location.reload();
}

// The page's fixed texts: every text node and title / placeholder / aria-label, matched as a whole (whitespace
// collapsed). An element with data-i18n is translated as a whole, markup included.
const norm = s => s.trim().replace(/\s+/g, " ");
function translatePage(root = document.body) {
  document.title = tr(document.title);
  root.querySelectorAll("[data-i18n]").forEach(e => { e.innerHTML = tr(norm(e.innerHTML)); });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement.closest("[data-i18n], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const key = norm(n.nodeValue);
    if (!key) continue;
    const [lead, trail] = [n.nodeValue.match(/^\s*/)[0], n.nodeValue.match(/\s*$/)[0]];
    n.nodeValue = lead + tr(key) + trail;
  }
  for (const attr of ["title", "placeholder", "aria-label"]) {
    root.querySelectorAll(`[${attr}]`).forEach(e => e.setAttribute(attr, tr(norm(e.getAttribute(attr)))));
  }
}

(async () => {
  document.documentElement.lang = LANG;
  if (LANG === "en") {
    try { I18N = await (await fetch("i18n/en.json")).json(); } catch (_) { /* stays German */ }
  }
  translatePage();
  for (const src of ["flow.js", "app.js"]) {
    await new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = reject;
      document.body.append(el);
    });
  }
})();
