"""Every text the GUI can show has an English translation in web/i18n/en.json, and the dictionary has nothing else.

The German text in the code is the key: tr("…") in web/*.js, the page's fixed texts in web/index.html, and the
messages of UserError / CompileError / Msg / tr(lang, "…") in server/*.py."""

import ast
import json
import re
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from bytecode import FAULTS  # noqa: E402

LETTER = re.compile(r"[A-Za-zÄÖÜäöüß]")
norm = lambda s: " ".join(s.split())


def js_keys():
    keys = set()
    for f in (ROOT / "web").glob("*.js"):
        for m in re.finditer(r'\btr\("((?:[^"\\]|\\.)*)"', f.read_text()):
            keys.add(json.loads(f'"{m.group(1)}"'))
    return keys


class PageTexts(HTMLParser):
    """Text nodes and title / placeholder / aria-label, as web/i18n.js translates them."""

    def __init__(self):
        super().__init__()
        self.keys, self.stack = set(), []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for name in ("title", "placeholder", "aria-label"):
            if attrs.get(name):
                self.keys.add(norm(attrs[name]))
        if tag in ("meta", "link", "input", "br"):
            return
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if not set(self.stack) & {"script", "style"} and norm(data):
            self.keys.add(norm(data))


def html_keys():
    text = (ROOT / "web" / "index.html").read_text()
    parser = PageTexts()
    # elements marked data-i18n are translated as a whole: take their inner HTML, skip their text nodes
    wholes = re.findall(r"<(\w+)[^>]*\bdata-i18n\b[^>]*>(.*?)</\1>", text, re.S)
    parser.feed(re.sub(r"(<(\w+)[^>]*\bdata-i18n\b[^>]*>).*?(</\2>)", r"\1\3", text, flags=re.S))
    return parser.keys | {norm(inner) for _, inner in wholes}


def py_keys():
    keys = set(FAULTS.values())
    for f in (ROOT / "server").glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            if not isinstance(node, ast.Call):
                continue
            name = getattr(node.func, "id", getattr(node.func, "attr", None))
            args = node.args[1:] if name == "tr" else node.args if name in ("UserError", "CompileError", "Msg") else []
            if args and isinstance(args[0], ast.Constant) and isinstance(args[0].value, str):
                keys.add(args[0].value)
    return keys


def all_keys():
    return {k for k in js_keys() | html_keys() | py_keys() if LETTER.search(k)}


class Translations(unittest.TestCase):
    def setUp(self):
        self.en = json.loads((ROOT / "web" / "i18n" / "en.json").read_text())

    def test_every_text_has_a_translation(self):
        missing = sorted(all_keys() - set(self.en))
        self.assertEqual(missing, [], "texts without an English translation")

    def test_no_unused_translations(self):
        self.assertEqual(sorted(set(self.en) - all_keys()), [], "translations nothing uses")

    def test_placeholders_match(self):
        names = lambda s: sorted(re.findall(r"\{(\w+)\}", s))
        wrong = [k for k, v in self.en.items() if names(k) != names(v)]
        self.assertEqual(wrong, [])


if __name__ == "__main__":
    unittest.main()
