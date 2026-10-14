# Let's Talk Azure — Azure ARM Guard

Created by **Leiner Arce ([@lsaj08](https://github.com/lsaj08))**.

A private MCP plugin backend for Microsoft Azure ARM template validation, what-if previews, and explicitly approved deployments. Each project selects an existing resource group or proposes a new one and defines its permitted resource types. The assistant prepares plans; the user reviews and approves changes in a private browser page.

## Status

This is an experimental implementation, not a production-ready service. Local security tests use simulated Azure responses and storage. The latest live OAuth callback failed; successful Azure authentication and deployment remain unverified. Resource groups were inspected separately through Azure Portal. Do not use this project for production changes before completing the integration checks in [SETUP.md](SETUP.md).

## Features

- Single-tenant Entra ID delegated authentication with authorization code and PKCE S256.
- Encrypted, short-lived token, project, and deployment-plan storage.
- Per-user resource group and resource-type approval.
- ARM validation and what-if previews before a deployment.
- Explicit private browser approval, expiry, scope checks, and one-time submission.
- Restricted Incremental templates; privileged types, scripts, linked templates, secure parameter types, and sensitive field names are rejected. Arbitrary confidential literal values cannot be detected; never submit them.

## Getting started

Requires a modern Node.js runtime (Node.js 22 or newer recommended for local checks). No package installation is needed.

```sh
node --test scripts/security.test.mjs
node scripts/build.mjs
node scripts/validate-artifact.mjs
```

Read [SETUP.md](SETUP.md) for hosting, Entra registration, runtime secrets, and the approval workflow. Read [SECURITY.md](SECURITY.md) for assumptions and limitations.

## Repository layout

| Path | Purpose |
| --- | --- |
| `worker/guard.js` | Authoritative Worker source: MCP, OAuth, policy, and review pages |
| `worker/index.js` | Generated Worker copy; regenerate with the build |
| `scripts/` | Dependency-free build, artifact validation, and security tests |
| `.openai/hosting.json` | Generic Sites hosting configuration; no account binding |
| `SETUP.md` | Deployment and operator instructions |
| `SECURITY.md` | Security boundaries and acceptance gates |

The build writes `dist/server/index.js` and `dist/.openai/hosting.json`. The implementation requires a trusted Sites gateway supplying authenticated user identity and an R2-compatible `BUCKET` binding. It must not be exposed directly with client-controlled identity headers.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `connection_status` | Check configuration and connection |
| `prepare_project` | Propose a group and allowed resource types |
| `project_status` | Inspect project approval or group creation |
| `validate_template` | Validate a template for an approved project |
| `prepare_what_if` | Prepare a saved deployment preview |
| `plan_status` | Poll preview and deployment status |

There is no MCP approval, deployment, or resource-group listing tool. Deployment approval belongs to the human user. Existing browser labels are currently in Spanish; repository documentation is in English.

## Credentials and attribution

This repository contains reusable source only. Passwords, client secrets, tokens, vault keys, account-specific hosting IDs, screenshots, local secret-entry utilities, and the original development history are excluded. Configure secrets only in your hosting platform's protected runtime settings. Never paste them into chat, templates, commits, or issue reports.

Project creator: **Leiner Arce / lsaj08**. Implementation assistance: OpenAI Codex. No open-source license has been selected; publication alone does not grant a software license.
