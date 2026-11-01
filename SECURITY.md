# Security

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") of this repository.

What happens then: we confirm the report within 5 working days, agree on the details with you in the private
advisory, fix it on a private branch and publish the fix as a patch release together with the advisory (and a CVE if
it warrants one). You are credited unless you prefer not to be.

## What this server can access

- It acts **with the rights of the signed-in SAC user** (browser session) and, if configured, an OAuth client.
  Everything that user may do, an MCP client connected to this server may do.
- The browser profile (`~/.sac-mcp/browser-profile` by default) holds the SAC session. Treat it like a password.
- `captures/` can contain request/response data, story snapshots and fact-data backups — business data.

## Recommendations

- Use a dedicated SAC user with only the rights the assistant needs; consider `readOnly: true`.
- Leave `expertTools` off unless you need it: `sac_browser_eval` runs any JavaScript in the SAC page,
  `sac_api_request` and `sac_replay` send any request the session may send.
- Do not expose the server over a network; it is meant to run locally over stdio for one user.
- Review changes before confirming them (`allowalteration`) and test in a sandbox first.
- Keep `sac-mcp.config.json`, the browser profile and `captures/` out of version control and backups you share.

This project is not affiliated with SAP; report SAP product vulnerabilities to SAP, not here.
