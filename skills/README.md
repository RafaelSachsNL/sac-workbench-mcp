# Skills

Two [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) that make an assistant much better at the parts
of SAP Analytics Cloud this server cannot check for it:

| Skill | What it does |
|---|---|
| `sac-scripting` | Writes, reviews and debugs SAC scripts (Optimized Story Experience and Analytics Designer) against the official scripting API reference — no guessed methods. Includes verified patterns and pitfalls. |
| `sac-css` | Writes story and theme CSS only with the classes, properties and pseudo-classes the SAC CSS editor accepts (245 `sap-custom-*` classes for 38 object types), plus verified editor behaviour. |

## Install

Claude Code: copy (or symlink) the two folders into `~/.claude/skills/` (all projects) or `.claude/skills/` (one
project). Claude Desktop / claude.ai: upload each folder as a skill (Settings → Capabilities → Skills).

```bash
mkdir -p ~/.claude/skills
cp -R skills/sac-scripting skills/sac-css ~/.claude/skills/
```

## Build the scripting reference (required for `sac-scripting`)

The API reference is SAP documentation and is **not redistributed** here. Build it locally from SAP's public API
Reference Guides — see section 9 of [sac-scripting/SKILL.md](sac-scripting/SKILL.md) (Python 3 + `beautifulsoup4`).
The generated folders are git-ignored.

## Refresh the CSS class list

`skills/tools/build_css_reference.py` rebuilds `sac-css/references/` from a scrape of the SAC CSS editor (section 7 of
[sac-css/SKILL.md](sac-css/SKILL.md)). Only facts are kept (class names, allowed properties, pseudo-classes,
descendants); SAP's description texts are left out.
