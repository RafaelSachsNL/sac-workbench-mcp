# Runbook: an SAC update broke a tool

Most tools use the interfaces the SAC web UI uses. SAP changes them without notice, usually with a quarterly release
(QRC) or a wave. When a tool that worked before fails:

1. **Confirm it.** Run the smoke test against your sandbox tenant and note the failing step and the error:
   `npm run smoke -- <folderId>`. Note the SAC version (Help → About).
2. **Narrow it down.** Does the failing tool write a recorded payload (`templates/`) or read a structure SAC now
   stores differently? `sac_story_snapshot` before and `sac_story_diff` after a change usually shows it.
3. **Record the new behaviour.** Do the same action once in the SAC UI while recording (`sac_capture_start` /
   `sac_capture_stop` / `sac_capture_get`), or snapshot a story, change it in the UI, save and diff.
4. **Fix the payload or the code.** Re-parameterise the template (placeholders, no tenant data — see
   [CONTRIBUTING.md](../CONTRIBUTING.md)) or adapt the code. Keep the old form working if older tenants still send it.
5. **Verify** with the smoke test and a manual look at the result in SAC.
6. **Release** a patch version ([RELEASE.md](RELEASE.md)); mention the SAC version in the changelog
   (`### Fixed — works again with SAC 2026.xx`).

If you cannot fix it yourself, open an issue with the failing step, the error text and your SAC version. Leave out
tenant URLs, ids and business data.
