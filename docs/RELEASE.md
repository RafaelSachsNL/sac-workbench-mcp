# Releasing

Day-to-day work happens in a private repository; this repository receives squashed releases. Steps for a release:

1. **Changelog.** Move the entries under `[Unreleased]` in `CHANGELOG.md` to a new version heading with the date
   (`## [0.4.0] — YYYY-MM-DD`) and add the compare link at the bottom.
2. **Version.** Set `version` in `package.json` (the server reports it from there).
3. **Build and check.**
   ```bash
   npm ci
   npm run build
   node scripts/list-tools.mjs        # every tool registers, parameter names are valid
   npm run docs:tools                 # regenerate TOOLS.md
   npm audit --omit=dev
   ```
4. **Smoke test** against a sandbox tenant (creates and deletes its own test objects in the folder you pass):
   ```bash
   npm run smoke -- <folderId> [model] [connection] [space]
   SMOKE_SAC_MODEL="<planning model>" npm run smoke -- <folderId>       # also SAC planning models
   ```
   Note the SAC version you tested (Help → About) in the release notes and the README.
5. **Scan for tenant data.** No tenant URLs or ids, user ids, customer or model names, tokens or local paths in the
   diff (`git diff --stat`, then `git grep` for your tenant host and user id).
6. **Commit, tag, release.**
   ```bash
   git commit -m "chore(release): v0.4.0"
   git tag v0.4.0 && git push && git push --tags
   gh release create v0.4.0 --title "v0.4.0" --notes-file <notes from CHANGELOG>
   ```
7. **Optional: npm.** `npm publish` (runs the build and the tool check first).
