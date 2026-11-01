#!/usr/bin/env python3
"""Merge the per-class Analytics Designer files into one CLASSES.md (keeps the plugin under the file limit).

Usage: python3 merge_ad_reference.py <references/analytics-designer dir>
"""
import re
import sys
from pathlib import Path

d = Path(sys.argv[1])
files = sorted([f for f in d.glob("*.md") if f.name not in ("INDEX.md", "CLASSES.md")], key=lambda f: f.name.lower())
out = ["# Analytics Designer API Reference Guide — all classes", "",
       "One section per class, each starting with `# <ClassName>`. Find a class with `grep -n '^# DataSource$' CLASSES.md`, then read from that line.", ""]
for f in files:
    out += [f.read_text(encoding="utf-8").rstrip(), "", "---", ""]
(d / "CLASSES.md").write_text("\n".join(out), encoding="utf-8")
for f in files:
    f.unlink()
idx = (d / "INDEX.md").read_text(encoding="utf-8")
idx = re.sub(r"\[([^\]]+)\]\(\1\.md\)", r"\1", idx).replace("One file per class: `<Name>.md`.", "All classes in `CLASSES.md`.")
(d / "INDEX.md").write_text(idx, encoding="utf-8")
print(f"{len(files)} classes merged into {d / 'CLASSES.md'}")
