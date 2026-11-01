#!/usr/bin/env python3
"""Convert an SAP Analytics Cloud API Reference Guide (single-page HTML) into
per-class Markdown files plus an index, for use by the sac-scripting skill.

Usage:
    python3 build_reference.py <index.html> <out_dir>

Sources:
    Analytics Designer:  https://help.sap.com/doc/958d4c11261f42e992e8d01a4c0dde25/release/en-US/index.html
    Optimized Story Exp: https://help.sap.com/doc/1639cb9ccaa54b2592224df577abe822/release/en-US/index.html
"""
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString, Tag

KIND_BY_BULLET = {
    "backgroundComponent": "class",
    "backgroundEnum": "enum",
    "backgroundFunction": "function",
    "backgroundOther": "other",
}


def inline(node) -> str:
    """Render inline HTML (signatures, type lists, descriptions) to plain text."""
    out = []
    for child in node.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
            continue
        if not isinstance(child, Tag):
            continue
        cls = child.get("class") or []
        if child.name == "br":
            out.append("\n")
        elif "paragraphseparator" in cls:
            out.append("\n\n")
        elif "highlightword" in cls or "highlightwordDeprecated" in cls:
            word = child.get_text(strip=True)
            if word == "Optional":
                out.append("?")
            elif word == "static":
                out.append("static ")
            else:
                out.append(f" [{word}]")
        elif child.name == "ul":
            for li in child.find_all("li", recursive=False):
                out.append("\n- " + norm(inline(li)))
            out.append("\n")
        else:
            out.append(inline(child))
    return "".join(out)


def norm(text: str) -> str:
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def render_detail_cell(cell: Tag) -> str:
    """Render one member's detail cell: signature, description, params, returns, since."""
    lines = []
    buf = []
    params = []
    meta = {}
    current_sub = None

    def flush():
        txt = norm(inline_list(buf))
        buf.clear()
        return txt

    def inline_list(nodes):
        wrapper = BeautifulSoup("<div></div>", "html.parser").div
        for n in nodes:
            wrapper.append(n.__copy__() if isinstance(n, Tag) else NavigableString(str(n)))
        return inline(wrapper)

    signature = None
    description = None
    for child in list(cell.children):
        cls = (child.get("class") or []) if isinstance(child, Tag) else []
        if isinstance(child, Tag) and "subsection-title" in cls:
            text = flush()
            if current_sub is None:
                if signature is None:
                    signature, _, description = text.partition("\n\n")
                    description = description.strip()
            else:
                meta[current_sub] = text
            current_sub = child.get_text(strip=True)
            continue
        if isinstance(child, Tag) and child.name == "table" and "table-parameter" in cls:
            for row in child.find_all("tr", recursive=False):
                tds = row.find_all("td", recursive=False)
                if len(tds) < 2:
                    continue
                name = one_line(inline(tds[0])).rstrip(":").strip().replace(" ?", "?")
                typ = one_line(inline(tds[1]))
                desc = one_line(inline(tds[2])) if len(tds) > 2 else ""
                params.append((name, typ, desc))
            continue
        buf.append(child)
    text = flush()
    if current_sub is None:
        signature, _, description = text.partition("\n\n")
        description = description.strip()
    else:
        meta[current_sub] = text

    sig = one_line(signature or "")
    lines.append(f"### `{sig}`")
    if "Deprecated" in meta or "[Deprecated]" in sig:
        lines.append(f"**DEPRECATED** {one_line(meta.get('Deprecated', ''))}".rstrip())
    if description:
        lines.append(description)
    if params:
        lines.append("Parameters:")
        for name, typ, desc in params:
            lines.append(f"- `{name}`: {typ}" + (f" — {desc}" if desc else ""))
    if meta.get("Returns"):
        lines.append(f"Returns: {one_line(meta['Returns'])}")
    if meta.get("Mobile Support"):
        lines.append(f"Mobile support: {one_line(meta['Mobile Support'])}")
    tags = []
    if meta.get("Since"):
        tags.append(f"since {one_line(meta['Since'])}")
    if meta.get("Last Update"):
        tags.append(f"updated {one_line(meta['Last Update'])}")
    if tags:
        lines.append(f"_{', '.join(tags)}_")
    return "\n".join(lines)


def class_header(content: Tag):
    """Parse the header area of a class page (before the first .section)."""
    info = {"typelib": "", "extends": "", "since": "", "updated": "", "subclasses": "",
            "description": "", "kind": "class", "deprecated": ""}
    title = content.find("div", class_="title-table-title")
    bullet = title.find("div", class_="bulletBig") if title else None
    if bullet:
        for c in bullet.get("class", []):
            if c in KIND_BY_BULLET:
                info["kind"] = KIND_BY_BULLET[c]
    head_nodes = []
    for child in content.children:
        if isinstance(child, Tag) and "section" in (child.get("class") or []):
            break
        if child is title:
            continue
        head_nodes.append(child)
    wrapper = BeautifulSoup("<div></div>", "html.parser").div
    for n in head_nodes:
        wrapper.append(n.__copy__() if isinstance(n, Tag) else NavigableString(str(n)))
    current = "_pre"
    chunks = {"_pre": []}
    for child in wrapper.children:
        if isinstance(child, Tag) and "subsection-title" in (child.get("class") or []):
            current = child.get_text(strip=True)
            chunks[current] = []
            continue
        chunks[current].append(child)
    def txt(nodes):
        w = BeautifulSoup("<div></div>", "html.parser").div
        for n in nodes:
            w.append(n.__copy__() if isinstance(n, Tag) else NavigableString(str(n)))
        return norm(inline(w))
    pre = txt(chunks["_pre"])
    m = re.search(r"Type Library\s+(\S+)", pre)
    if m:
        info["typelib"] = m.group(1)
        pre = pre.replace(m.group(0), "", 1)
    m = re.search(r"extends\s+([A-Za-z0-9_]+)", pre)
    if m:
        info["extends"] = m.group(1)
        pre = pre.replace(m.group(0), "", 1)
    info["description"] = norm(pre).lstrip(", ")
    info["since"] = one_line(txt(chunks.get("Since", [])))
    last = txt(chunks.get("Last Update", []))
    # description text may follow the Last Update value
    first, _, rest = last.partition("\n")
    info["updated"] = one_line(first)
    if rest.strip():
        info["description"] = norm(info["description"] + "\n\n" + rest)
    info["subclasses"] = one_line(txt(chunks.get("Direct Subclasses", [])))
    info["deprecated"] = one_line(txt(chunks.get("Deprecated", [])))
    return info


def summary_line(cell: Tag) -> str:
    text = norm(inline(cell))
    sig, _, desc = text.partition("\n")
    desc = one_line(desc).split(". ")[0].rstrip(".")
    return f"- `{one_line(sig)}`" + (f" — {desc}" if desc else "")


def convert_class(content: Tag, guide: str):
    cid = content["id"]
    info = class_header(content)
    md = [f"# {cid}", ""]
    meta = [f"Kind: {info['kind']}"]
    if info["typelib"]:
        meta.append(f"type library `{info['typelib']}`")
    if info["extends"]:
        meta.append(f"extends [{info['extends']}]({info['extends']}.md)")
    if info["since"]:
        meta.append(f"since {info['since']}")
    if info["updated"]:
        meta.append(f"updated {info['updated']}")
    md.append(" · ".join(meta))
    md.append(f"Source: {guide}")
    if info["deprecated"]:
        md += ["", f"**DEPRECATED** {info['deprecated']}"]
    if info["subclasses"]:
        md += ["", f"Direct subclasses: {info['subclasses']}"]
    if info["description"]:
        md += ["", info["description"]]

    counts = {}
    summaries = {}
    for section in content.find_all("div", class_="section", recursive=False):
        title = section.find("div", class_="section-title").get_text(strip=True)
        kind, _, part = title.rpartition(" ")
        if part == "Summary":
            rows = section.find("table").find_all("tr", recursive=False)[1:]
            summaries[kind] = [summary_line(r.find("td")) for r in rows]
            continue
        # Detail section
        md += ["", f"## {kind}s" if not kind.endswith("y") else f"## {kind[:-1]}ies"]
        n = 0
        for table in section.find_all("table", class_="table", recursive=False):
            rows = table.find_all("tr", recursive=False)
            if len(rows) < 2:
                continue
            md += ["", render_detail_cell(rows[1].find("td"))]
            n += 1
        counts[kind] = n
    # Sections that have only a summary (e.g. enum values) still need listing.
    for kind, lines in summaries.items():
        if kind not in counts:
            md += ["", f"## {kind} Summary", *lines]
    return cid, info, summaries, "\n".join(md).rstrip() + "\n"


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    html = src.read_text(encoding="utf-8")
    soup = BeautifulSoup(html, "lxml")
    title = soup.title.get_text(strip=True)
    out.mkdir(parents=True, exist_ok=True)
    index_rows = []
    sig_lines = []
    by_lib = {}
    for content in soup.find_all("div", class_="content"):
        cid = content.get("id")
        if not cid or cid == "typelibraries":
            continue
        cid, info, summaries, md = convert_class(content, title)
        (out / f"{cid}.md").write_text(md, encoding="utf-8")
        members = sum(len(v) for v in summaries.values())
        desc = one_line(info["description"]).split(". ")[0][:140]
        dep = " **(deprecated)**" if info["deprecated"] else ""
        index_rows.append((cid, info, members, desc + dep))
        for kind, rows in summaries.items():
            for row in rows:
                body = row[3:].replace("`", "", 2)
                tag = kind.lower()
                if body.startswith("static "):
                    body, tag = body[7:], tag + ", static"
                sig_lines.append(f"{cid}.{body}  [{tag}]")
        by_lib.setdefault(info["typelib"] or "-", []).append(cid)

    lines = [f"# {title} — Index", "",
             f"{len(index_rows)} classes/enums. One file per class: `<Name>.md`. "
             "Grep this index or the files (e.g. `grep -l 'setDimensionFilter' *.md`).", "",
             "| Name | Kind | Extends | Lib | Members | Summary |",
             "|---|---|---|---|---|---|"]
    for cid, info, members, desc in sorted(index_rows, key=lambda r: r[0].lower()):
        lines.append(f"| [{cid}]({cid}.md) | {info['kind']} | {info['extends']} | "
                     f"{info['typelib']} | {members} | {desc.replace('|', '/')} |")
    lines += ["", "## By type library", ""]
    for lib in sorted(by_lib):
        lines.append(f"- **{lib}**: " + ", ".join(sorted(by_lib[lib])))
    (out / "INDEX.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "SIGNATURES.txt").write_text(
        f"# {title} — one line per member: Class.member(signature): type — short description  [kind]\n"
        + "\n".join(sig_lines) + "\n", encoding="utf-8")
    print(f"{title}: wrote {len(index_rows)} files to {out}")


if __name__ == "__main__":
    main()
