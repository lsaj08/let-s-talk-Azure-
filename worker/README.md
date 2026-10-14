# Worker implementation

Edit `guard.js`. The build regenerates `index.js`; do not edit that copy independently.

The Worker exposes `/mcp`, `/azure/connect`, `/azure/callback`, `/project-review/<id>`, and `/review/<id>`. It trusts the authenticated Sites gateway for the user identity and uses an R2-compatible `BUCKET` binding for encrypted records.

Configure Azure identifiers and protected runtime secrets as described in [SETUP.md](../SETUP.md). No credentials are included in this source. Browser approval pages are currently in Spanish. There is no deployment approval endpoint exposed as an MCP tool.
