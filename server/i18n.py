"""Texts for the GUI: German is the source text in the code, English comes from web/i18n/en.json (shared with the
page, keyed by the German text). Placeholders are {name}, filled in by Msg / tr."""

import json
from pathlib import Path

EN_FILE = Path(__file__).resolve().parent.parent / "web" / "i18n" / "en.json"
LANGS = ("de", "en")

try:
    EN = json.loads(EN_FILE.read_text())
except (OSError, ValueError):
    EN = {}


def tr(lang, text, **args):
    """text in `lang`, with the placeholders filled in (a Msg renders itself)."""
    if isinstance(text, Msg):
        return text.render(lang)
    if lang == "en":
        text = EN.get(text, text)
    return text.format(**{k: tr(lang, v) if isinstance(v, Msg) else v for k, v in args.items()}) if args else text


class Msg(str):
    """A message that can still be shown in either language. As a str it is the German text, so it can be
    compared, logged and stored like one; render(lang) gives it in the reader's language."""

    def __new__(cls, text, **args):
        self = super().__new__(cls, tr("de", text, **args))
        self.text, self.args = text, args
        return self

    def render(self, lang):
        return tr(lang, self.text, **self.args)


def lang_of(value):
    return value if value in LANGS else "de"
