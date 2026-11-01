#!/usr/bin/env python3
"""Convert the CSS editor class definitions of an SAC Optimized Story into Markdown.

Input: JSON {objectType: commentText} as scraped from the story CSS editor
(Outline > Global Settings > Edit CSS, dropdown "Select an object", element .cssClassDefinition).

Usage:
    python3 build_css_reference.py <raw.json> <out_dir> [<scrape date>]
"""
import json
import re
import sys
from pathlib import Path

ENTRY = re.compile(
    r"\*\s+(?P<name>[^\n]+?):\s*\n"
    r"\*\s+Description:\s*(?P<desc>.*?);\s*\n"
    r"\*\s+Properties:\s*(?P<props>.*?);\s*\n"
    r"\*\s+Descendants:\s*(?P<desc2>.*?);\s*\n"
    r"\*\s+Pseudos:\s*(?P<pseudos>.*?);",
    re.S,
)


def clean(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return "" if s == "N/A" else s


def parse(text: str):
    text = re.sub(r"\n\s*\*", "\n*", text)
    entries = [{k: clean(v) for k, v in m.groupdict().items()} for m in ENTRY.finditer(text)]
    for e in entries:
        e["name"] = e["name"].lstrip("* ").strip()
    return entries


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    raw = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    date = sys.argv[3] if len(sys.argv) > 3 else ""
    out.mkdir(parents=True, exist_ok=True)
    flat = []
    lines = [
        "# SAC Story CSS – supported classes per object type",
        "",
        f"Scraped from the CSS editor of an Optimized Story{' (' + date + ')' if date else ''}. "
        "Only the listed properties/pseudos/descendants are accepted for each class. "
        "`Widget CSS Class` = your own class name assigned in the widget's Styling panel.",
        "",
    ]
    for obj in sorted(raw, key=str.lower):
        entries = parse(raw[obj])
        # SAP's description texts are left out on purpose (only the facts: class, properties, pseudos, descendants)
        lines += [f"## {obj}", "", "| Class | Properties | Pseudos | Descendants |", "|---|---|---|---|"]
        for e in entries:
            name = e["name"] if e["name"].startswith(".") else f"*{e['name']}*"
            lines.append(
                f"| `{e['name']}` | {e['props']} | {e['pseudos']} | {e['desc2']} |"
                if e["name"].startswith(".") else
                f"| {name} | {e['props']} | {e['pseudos']} | {e['desc2']} |"
            )
            if e["name"].startswith("."):
                flat.append((e["name"], obj, e["props"], e["pseudos"], e["desc2"]))
        lines.append("")
    (out / "css-classes.md").write_text("\n".join(lines), encoding="utf-8")

    seen = {}
    for name, obj, props, pseudos, desc2 in flat:
        seen.setdefault(name, {"objs": [], "props": props, "pseudos": pseudos, "desc2": desc2})["objs"].append(obj)
    idx = ["# SAC CSS – one line per class (grep me)",
           "# .class  | object types | properties | pseudos | descendants"]
    for name in sorted(seen):
        v = seen[name]
        idx.append(f"{name} | {', '.join(v['objs'])} | {v['props']} | {v['pseudos'] or '-'} | {v['desc2'] or '-'}")
    (out / "CSS_CLASSES.txt").write_text("\n".join(idx) + "\n", encoding="utf-8")
    print(f"{len(raw)} object types, {len(flat)} entries, {len(seen)} distinct classes")


if __name__ == "__main__":
    main()
