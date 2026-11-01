# Contributing

Thanks for helping! A few rules keep the project usable for everyone.

## Before you start

- Read the disclaimer in the [README](README.md): most tools use undocumented SAP Analytics Cloud interfaces.
  Contributions must not include anything that would bypass SAC security, licensing or rights checks.
- Work against your own sandbox tenant or a dedicated test folder.

## Adding or fixing a tool

0. **Switch on the expert tools** in your sandbox setup (`"expertTools": true` or `SAC_EXPERT_TOOLS=true`, see
   [README](README.md#extending-the-server-expert-tools)).
1. **Record** what the SAC UI does: `sac_capture_start`, perform the action (by hand or with `sac_browser_ui`),
   `sac_capture_stop`, inspect the calls with `sac_capture_get`.
2. **Parameterise**: if you store a recorded payload in `templates/`, replace everything tenant-specific with the
   placeholders the code substitutes at runtime (see the existing templates). **Never commit** tenant URLs or ids,
   user ids, real model/customer names, business data, tokens or cookies.
3. **Guard writes**: every tool that changes something takes `allowalteration` and calls `assertWritable(...)`.
4. **Describe** the tool for the model: what it does, which parameters matter, and pitfalls SAC has.
5. **Verify** against a real tenant: `npm run smoke -- <folderId> [model] [connection] [space]`, plus a manual check of
   the result in SAC. Say in the pull request what you tested and on which SAC release.

## Code style

TypeScript, ES modules, no new runtime dependencies without a good reason. Match the surrounding code; comments
explain *why* (usually: what SAC requires and how it was found out).

## Pull requests

- `npm run build` and `node scripts/list-tools.mjs` must pass before a pull request is merged.
- Keep `captures/`, `sac-mcp.config.json` and browser profiles out of commits (they are git-ignored).
- Update `README.md` / `docs/STORY_GUIDELINES.md` when behaviour changes, and add a line under `[Unreleased]` in
  `CHANGELOG.md`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(story): …`,
  `fix(theme): …`, `docs: …`, `chore: …`. A breaking change gets `!` (`feat(config)!: …`).

By contributing you agree that your contribution is licensed under the MIT License of this project.
