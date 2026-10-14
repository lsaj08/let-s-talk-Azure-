# Let's Talk Azure — Azure ARM Guard

Created by **Leiner Arce ([@lsaj08](https://github.com/lsaj08))**.

Azure tools, a reusable skill, and optional subagents for **Codex and Claude Code**, created around ARM template validation and what-if previews. The recommended local integration reuses your Azure CLI sign-in and exposes a restricted MCP server over stdio. A separate private hosted backend supports explicitly approved deployments.

## Status

The local integration is implemented and tested with simulated Azure responses and real child-process transport. Live Azure CLI calls require an installed CLI and an interactive sign-in; they have not been verified on the development machine. The hosted backend remains experimental: its last OAuth callback failed, and a successful hosted Azure connection or deployment remains unverified. See [integration instructions](integrations/README.md) and [hosted setup](SETUP.md).

## Features

- Local MCP tools for subscriptions, resource groups, resources, validation, what-if, and deployment status.
- A portable skill and optional inspection/planning subagents for both clients.
- Explicit subscription/group/type configuration per MCP process; the model cannot override it in tool arguments.
- No application secret required in local mode. Azure CLI manages its own cached credentials.
- Local MCP cannot deploy, create groups, delete resources, run arbitrary CLI commands, or return tokens.
- The following hosted features remain separate from the local integration:
- Single-tenant Entra ID delegated authentication with authorization code and PKCE S256.
- Encrypted, short-lived token, project, and deployment-plan storage.
- Per-user resource group and resource-type approval.
- ARM validation and what-if previews before a deployment.
- Explicit private browser approval, expiry, scope checks, and one-time submission.
- Restricted Incremental templates; privileged types, scripts, linked templates, secure parameter types, and sensitive field names are rejected. Arbitrary confidential literal values cannot be detected; never submit them.

## Getting started

Requires Node.js 22 or newer. Local Azure operations also require Microsoft's Azure CLI, installed separately. No npm dependencies are needed.

```sh
node --test scripts/*.test.mjs
node scripts/build.mjs
node scripts/validate-artifact.mjs
```

Start with [Codex and Claude Code integration](integrations/README.md). Read [SETUP.md](SETUP.md) only for the hosted backend, Entra application registration, runtime secrets, and browser approval workflow. Read [SECURITY.md](SECURITY.md) for assumptions and limitations.

## Repository layout

| Path | Purpose |
| --- | --- |
| `worker/guard.js` | Authoritative Worker source: MCP, OAuth, policy, and review pages |
| `worker/index.js` | Generated Worker copy; regenerate with the build |
| `local/` | Restricted Azure CLI service and stdio MCP transport |
| `skills/azure-arm-guard/` | Portable skill installed into a project |
| `integrations/` | Codex and Claude agent/configuration instructions |
| `scripts/` | Dependency-free build, artifact validation, and security tests |
| `.openai/hosting.json` | Generic Sites hosting configuration; no account binding |
| `SETUP.md` | Deployment and operator instructions |
| `SECURITY.md` | Security boundaries and acceptance gates |

The hosted build writes `dist/server/index.js` and `dist/.openai/hosting.json`. Only that backend requires a trusted Sites gateway supplying authenticated user identity and an R2-compatible `BUCKET` binding. It must not be exposed directly with client-controlled identity headers. Local MCP runs without Sites or R2.

## Local MCP tools

| Tool | Purpose |
| --- | --- |
| `connection_status` | Check CLI session and configured project scope |
| `list_subscriptions` | Discover accessible subscription metadata |
| `list_resource_groups` | List groups in the configured subscription |
| `list_resources` | List resource metadata in the configured group |
| `validate_template` | Validate a restricted inline ARM JSON template |
| `what_if` | Preview resource IDs and change types without deploying |
| `deployment_status` | Read an existing deployment's status |

Local tools do not expose tags, resource properties, template outputs, or what-if property values. Validation and what-if contact Azure and still require appropriate RBAC. For applying a plan, the parent agent must present exact files, scope, changes, and cost implications and obtain explicit human approval; the local server has no mutation tool. A separately configured hosted approval flow or a human-operated Azure CLI command can apply the plan.

## Hosted MCP tools

| Tool | Purpose |
| --- | --- |
| `connection_status` | Check configuration and connection |
| `prepare_project` | Propose a group and allowed resource types |
| `project_status` | Inspect project approval or group creation |
| `validate_template` | Validate a template for an approved project |
| `prepare_what_if` | Prepare a saved deployment preview |
| `plan_status` | Poll preview and deployment status |

The hosted interface has no MCP approval, deployment, or resource-group listing tool. Deployment approval belongs to the human user. Existing hosted browser labels are currently in Spanish; repository documentation and local integration instructions are in English.

## Credentials and attribution

This repository contains reusable source only. Passwords, client secrets, tokens, vault keys, account-specific hosting IDs, screenshots, local secret-entry utilities, and the original development history are excluded. In local mode, perform `az login` yourself; Azure CLI owns its credential cache, which must remain private. In hosted mode, configure secrets only in protected runtime settings. Never paste credentials or confidential template values into chat, templates, commits, or issue reports.

Project creator: **Leiner Arce / lsaj08**. Implementation assistance: OpenAI Codex. No open-source license has been selected; publication alone does not grant a software license.
