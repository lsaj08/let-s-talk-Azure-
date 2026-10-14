# Use Let's Talk Azure in Codex or Claude Code

Created by **Leiner Arce ([@lsaj08](https://github.com/lsaj08))**.

The local integration adds Azure inventory, ARM validation, what-if previews, and existing deployment status to your coding assistant. It reuses your Azure CLI session and needs no Entra application registration or client secret. The separately hosted Worker keeps its own OAuth and human approval setup.

The local integration never deploys or creates resource groups. It prepares a plan you can review before using a separate human-controlled deployment flow.

## Requirements

- Node.js 22 or newer.
- Azure CLI installed and available to the client process.
- A local Codex or Claude Code client with stdio MCP support.
- An Azure identity with the permissions needed for the chosen operations.

Sign in privately from your own terminal with `az login`, or `az login --tenant YOUR_TENANT_ID` to select a tenant. Complete Microsoft authentication yourself. Never put a password, client secret, access token, or Azure CLI cache in chat, the MCP configuration, or this repository. The Azure CLI maintains its own refresh-token cache; its storage protection depends on the operating system.

For ordinary inventory, use an identity with Reader access at the required scope where practical. Template validation and what-if require additional Azure deployment permissions; successful inventory does not establish those permissions. Select an existing group and explicit resource types for each project. This integration does not grant or change RBAC.

## Install the skill and agent in a project

Clone the repository to a stable local directory. Run the installer from that clone, replacing the project argument with the absolute path of the project where you want Azure assistance:

```sh
node scripts/install-integration.mjs --client codex --project /absolute/path/to/your-project
```

For Claude Code:

```sh
node scripts/install-integration.mjs --client claude --project /absolute/path/to/your-project
```

Windows example:

```powershell
node scripts/install-integration.mjs --client codex --project 'C:/Projects/MyApp'
```

The project directory must exist. The installer copies the skill, its workflow reference, and the selected agent definition. It refuses an existing skill directory or agent file, rejects linked destination parents, and never overwrites files. Review upgrades manually if those destinations already exist. It changes no global client files, MCP configuration, login session, or Azure resource.

| Client | Installed skill | Installed agent |
| --- | --- | --- |
| Codex | `.agents/skills/azure-arm-guard/SKILL.md` | `.codex/agents/azure-reviewer.toml` |
| Claude Code | `.claude/skills/azure-arm-guard/SKILL.md` | `.claude/agents/azure-reviewer.md` |

The skill's `references/workflow.md` travels with it. Keep that folder intact. The Codex agent disables its shell capability and inherits the parent session's remaining permissions and MCP servers. The Claude agent allows Read, Glob, Grep, and tools from the `letstalkazure` MCP server only. These definitions guide client behavior; the server's exposed tools enforce its own Azure operation boundary.

## Configure Codex manually

Merge the following table into your target project's `.codex/config.toml`, or into `~/.codex/config.toml` if you deliberately want a user-wide MCP server. Preserve existing settings. Use the absolute path to `local/server.mjs` in your clone and replace the example UUID with the intended subscription ID:

```toml
[mcp_servers.letstalkazure]
command = "node"
args = ["/absolute/path/to/let-s-talk-Azure-/local/server.mjs", "--subscription", "00000000-0000-0000-0000-000000000000"]
tool_timeout_sec = 150
```

Use forward slashes for a Windows path such as `C:/Tools/let-s-talk-Azure-/local/server.mjs`. If `node` is unavailable on the client process's PATH, use its absolute executable path. Codex also accepts a server `cwd` when one is needed. The local server does not depend on the client's working directory to select Azure scope.

Restart the client after adding MCP configuration and check its MCP server list. Use `$azure-arm-guard` for the skill, or ask: `Use the azure-reviewer agent to inspect my configured Azure project.`

## Configure Claude Code manually

Merge this entry into the target project's `.mcp.json`, preserving any existing servers:

```json
{
  "mcpServers": {
    "letstalkazure": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/let-s-talk-Azure-/local/server.mjs",
        "--subscription",
        "00000000-0000-0000-0000-000000000000"
      ]
    }
  }
}
```

Use forward slashes in Windows paths to avoid JSON backslash escaping. Alternatively register it using the Claude CLI:

```sh
claude mcp add --transport stdio --scope project letstalkazure -- node /absolute/path/to/let-s-talk-Azure-/local/server.mjs --subscription 00000000-0000-0000-0000-000000000000
```

Restart the client and review its project-server trust prompt when shown. Check `claude mcp get letstalkazure`. Use `/azure-arm-guard` for the skill, ask Claude to use the `azure-reviewer` subagent, or start the project session with `claude --agent azure-reviewer`.

## Choose project scope and permitted types

With only `--subscription`, the server can inspect account metadata and resource groups. `list_subscriptions` works even without that startup option. To inspect group resources and existing deployments, add `--resource-group` to the server's argument list. To validate and preview templates, also add `--allow-type` once per permitted resource type:

```json
[
  "/absolute/path/to/let-s-talk-Azure-/local/server.mjs",
  "--subscription", "00000000-0000-0000-0000-000000000000",
  "--resource-group", "my-project",
  "--allow-type", "Microsoft.Storage/storageAccounts"
]
```

This is an example argument array for either client's configuration, not a tool call. Replace the subscription, existing group, and permitted types before use. Restart the MCP client whenever these startup arguments change. A tool cannot switch them. Resource-group listing remains subscription-wide; detailed resource inventory and template operations use the configured group.

No arbitrary CLI, token retrieval, deployment, IAM, deletion, or new-group tool is exposed. A workflow needing a new group must first use a separate human-controlled flow, then configure the resulting existing group. Do not use a general shell tool to bypass these limits.

## First use and verification

Ask the assistant: `Use azure-arm-guard to check my connection and list the resource groups in the configured subscription.` After selecting and configuring an existing group, ask it to inspect resource metadata or prepare an allowed ARM template for validation and what-if. The assistant should call `connection_status`, report the actual target, and distinguish observed Azure results from drafts.

The local server returns metadata and resource IDs/change types rather than resource properties, tags, deployment outputs, or full what-if property differences. It suppresses raw CLI errors. Templates must follow the restrictions in the bundled [workflow](../skills/azure-arm-guard/references/workflow.md). What-if is a preview and may drift; validation does not estimate cost or guarantee a successful deployment.

Run the local tests and integration-installer checks from the clone before first use:

```sh
node --test scripts/local-mcp.test.mjs scripts/azure-cli.test.mjs scripts/install-integration.test.mjs
```

These checks use controlled inputs and temporary files. They do not prove that your client connected, that Azure CLI is authenticated, that RBAC permits the requested operation, or that a live template can deploy. Verify those through the client after private sign-in. The hosted OAuth connection has its own pending integration checks in [SETUP.md](../SETUP.md).

Record the client, configured scope, observed tool result, and any pending verification without recording tokens or confidential values. Use the [verification record](../docs/VERIFICATION.md) for the current baseline and live acceptance checklist.

## Troubleshooting and upgrades

| Symptom | Check |
| --- | --- |
| Skill appears but Azure tools are missing | MCP configuration is a separate step; check the client server list and restart the client. |
| Node cannot be found | Set `command` to the absolute Node executable path available to that client. |
| Azure CLI request fails | In your own terminal, verify CLI availability, sign-in, selected subscription, and RBAC. Raw errors are intentionally suppressed in MCP. |
| Scope or allowed-type configuration is missing | Add the required startup options and restart the MCP client; these are not tool arguments. |
| Template policy rejects an expression | Use the restricted inline JSON format in the skill workflow; arbitrary ARM functions and Bicep compilation are not supported by this server. |
| Installer reports an existing destination | Review and update the installed skill/reference/agent manually; the installer never overwrites them. |
| What-if times out | Inspect the situation privately before retrying. Timeout does not prove cancellation or successful completion. |

Keep the repository clone at the path referenced by MCP. After pulling an update, review its changes, refresh the installed skill and agent files as needed, and restart the client. Pulling this repository does not update previously copied skill files or a separately deployed hosted Worker.

## Official configuration references

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex skill locations](https://learn.chatgpt.com/docs/build-skills)
- [Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Azure CLI authentication](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli?view=azure-cli-latest)
- [Azure CLI token-cache behavior](https://learn.microsoft.com/en-us/cli/azure/msal-based-azure-cli?view=azure-cli-latest)
