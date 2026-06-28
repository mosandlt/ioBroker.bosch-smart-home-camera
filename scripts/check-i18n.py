#!/usr/bin/env python3
"""Gate: flag i18n strings still identical to English (ioBroker E5606 rule).

Exit 0 = clean. Exit 1 = untranslated strings found.
Run: python3 scripts/check-i18n.py
"""
import json, os, sys

BASE = os.path.join(os.path.dirname(__file__), "..", "admin", "i18n")
en_path = os.path.join(BASE, "en.json")

with open(en_path, encoding="utf-8") as f:
    en = json.load(f)

# Only long strings are flagged by ioBroker (>5 words heuristic)
en_long = {k: v for k, v in en.items() if len(v.split()) > 5}

errors = []
lang_files = sorted(f for f in os.listdir(BASE) if f.endswith(".json") and f != "en.json")

for fname in lang_files:
    lang = fname[:-5]
    with open(os.path.join(BASE, fname), encoding="utf-8") as f:
        d = json.load(f)
    untranslated = [k for k, v in en_long.items() if d.get(k) == v]
    missing = [k for k in en_long if k not in d]
    for k in untranslated:
        errors.append(f"  {lang}: untranslated: {k[:80]!r}")
    for k in missing:
        errors.append(f"  {lang}: missing key: {k[:80]!r}")

if errors:
    print(f"i18n gate FAILED ({len(errors)} issue(s)):")
    for e in errors:
        print(e)
    sys.exit(1)

print(f"i18n gate OK — {len(lang_files)} languages, {len(en_long)} long strings all translated.")
