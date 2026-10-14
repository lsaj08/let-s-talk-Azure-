# Setup and operation

This guide covers the hosted backend. For local Azure CLI integration with Codex or Claude Code, use [integrations/README.md](integrations/README.md). Local mode does not require an Entra application secret, Sites, or R2.

## Hosting

Deploy the Worker through a private Sites project with the MCP capability, an R2 binding named `BUCKET`, and authenticated gateway access. The included hosting manifest is generic. Add your own hosting project binding through the platform; do not reuse another user's project ID. The gateway must strip or verify incoming `oai-authenticated-user-id` headers. A directly exposed Worker is unsafe.

Use `node scripts/build.mjs` followed by `node scripts/validate-artifact.mjs`. Publish the resulting `dist` artifact using your hosting workflow. Restrict site and plugin access to intended users. This repository is source code; it does not automatically install or register a ChatGPT plugin.

## Entra application

1. Register a single-tenant web application in Microsoft Entra ID.
2. Set the exact web redirect URI to `https://YOUR_PRIVATE_HOST/azure/callback`. Do not enable implicit grant.
3. Add the delegated Azure Service Management permission `user_impersonation`. OAuth consent does not grant Azure RBAC permissions.
4. Configure `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_SUBSCRIPTION_ID` in the runtime. Groups and permitted types are approved per project.
5. Store `AZURE_CLIENT_SECRET` and `VAULT_KEY` as protected runtime secrets. `VAULT_KEY` must be a random 32-byte key encoded as base64url. Generate it privately. Never commit either value or place it in a template or chat.
6. Redeploy after updating runtime configuration. Rotate the client secret before expiry. Rotating the vault key invalidates encrypted connections and plans.
7. Open the private site and connect to Microsoft Azure. Sessions last at most one hour; no refresh tokens are requested or stored.

Authorization uses PKCE S256 and a random, user-bound, encrypted state with a five-minute expiry and atomic one-time consumption.

## Least privilege

Use a dedicated human Azure identity limited to the selected resource group. Reader can support inspection, but full what-if requires deployment permissions. An administrator should evaluate a custom role limited to necessary deployment actions and reads/writes for the permitted resource types. Do not grant subscription-wide Owner, Contributor, User Access Administrator, or IAM permissions just to enable this plugin.

Creating a group additionally needs subscription deployment actions and resource group read/write permissions. Evaluate narrowly scoped or temporary access. The server never creates RBAC assignments. Existing user permissions may exceed the plugin's policy; the dedicated identity establishes the stronger Azure-side boundary.

## Workflow

1. Run `connection_status`.
2. Call `prepare_project` with `resource_group`, `allowed_types`, and `create_new`; include `location` for a new group. This prepares a proposal without changing Azure.
3. Personally review the project URL. Existing-group approval saves private authorization only. New-group approval submits an internal template that creates exactly one group. Poll `project_status` until approved before continuing.
4. Call `validate_template` with the approved `project_id`, inline template, and literal parameters. Pending asynchronous validation is not success.
5. Call `prepare_what_if` and poll `plan_status`. Review the exact destination, template, parameters, and predicted changes. Do not approve diagnostic errors, unknown changes, or deletions.
6. Personally open the review URL, check the approval box, and submit. Assistants and browser automation must never approve on your behalf.
7. Poll `plan_status` to completion. After a timeout or uncertain submission, inspect the existing `armguard-<plan_id>` deployment before proposing another plan. Consumed plans cannot be replayed.

Each project or plan review expires in ten minutes. Changing the group or permitted types requires a new approved project.

## Restrictions and operational limits

User templates are resource-group scoped and use Incremental mode. They allow 1–100 resources, literal names/types/values, and direct `parameters()` expressions. Complete mode, deletions, deployment stacks, linked/nested templates, outputs, custom functions, copy/condition, managed identity, IAM, deployment scripts, extensions, and secure parameter types are disabled. Sensitive field names are rejected, but arbitrary confidential literal values cannot be detected; never submit them. New groups use only the fixed internal subscription template.

Incremental mode can reset omitted properties according to provider behavior. What-if is predictive and can become stale; Azure changes are not frozen between preview and deployment. Resource changes can interrupt service or incur costs. There is no automatic rollback.

Configure storage retention and an external audit sink before regular operational use. Expiry prevents reuse but does not automatically delete every stored object. Do not log OAuth or ARM bodies. Report failures without secret values.

## Integration acceptance

Local tests simulate Azure and R2. Before operational use, verify actual Entra consent, Azure RBAC, authenticated gateway header filtering, R2 conditional writes, asynchronous Azure responses, browser approval headers, and a real validation/what-if/deployment in a disposable sandbox. The last observed live OAuth callback failed; its cause remains unresolved. No successful real Azure deployment has been demonstrated.

References: [Microsoft OAuth authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [ARM what-if](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-what-if).
