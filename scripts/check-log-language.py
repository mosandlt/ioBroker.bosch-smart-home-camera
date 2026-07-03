#!/usr/bin/env python3
"""Gate: flag German text reaching this.log.* calls (log messages must be English-only).

Heuristic: scans every `this.log.<level>(...)` call site in src/**/*.ts (test files
excluded) for German umlauts/ß or a short list of common German words. Catches the
class of bug from the 2026-07-02 ioBroker.repositories#5983 manual review, where
German notification strings (verbMap etc.) were interpolated straight into log.info.

Exit 0 = clean. Exit 1 = German text found in a log call.
Run: python3 scripts/check-log-language.py
"""
import os, re, sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "src")

LOG_CALL_RE = re.compile(r"this\.log\.(debug|info|warn|error)\s*\(")
GERMAN_MARKER_RE = re.compile(
    r"[äöüÄÖÜß]|\b(und|nicht|wieder|geplant|läuft|beendet|Kamera|Wartung|verfügbar|erreichbar)\b"
)

errors = []

for dirpath, _dirnames, filenames in os.walk(SRC):
    for fname in filenames:
        if not fname.endswith(".ts") or fname.endswith(".spec.ts") or fname.endswith(".d.ts"):
            continue
        path = os.path.join(dirpath, fname)
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
        for i, line in enumerate(lines, start=1):
            if not LOG_CALL_RE.search(line):
                continue
            # Look at the call line plus a couple of following lines for multi-line calls.
            window = "".join(lines[i - 1 : i + 2])
            if GERMAN_MARKER_RE.search(window):
                rel = os.path.relpath(path, ROOT)
                errors.append(f"  {rel}:{i}: possible German text in log call: {line.strip()[:100]!r}")

if errors:
    print(f"log-language gate FAILED ({len(errors)} issue(s)):")
    for e in errors:
        print(e)
    sys.exit(1)

print("log-language gate OK — no German text found in this.log.* call sites.")
