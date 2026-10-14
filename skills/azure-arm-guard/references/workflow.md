# Local Azure workflow

Created by **Leiner Arce (@lsaj08)**.

The local `letstalkazure` MCP server uses Azure CLI authentication already established by the operator. All calls below use the MCP tools, not a shell. Client prefixes may differ; use the names discovered in the current tool catalog.

| Tool | Arguments | Result and required configuration |
| --- | --- | --- |
| `connection_status` | `{}` | Selected account metadata and configured project scope; requires a startup subscription |
| `list_subscriptions` | `{}` | Accessible subscription metadata; works without selecting a subscription |
| `list_resource_groups` | `{}` | Group IDs, names, and locations in the startup subscription |
| `list_resources` | `{}` | Resource IDs, names, types, and locations in the startup group |
| `validate_template` | `{ "template": ARM_JSON, "parameters": PARAMETER_VALUES }` | Returns `valid: true` only for a successful validation; requires subscription, group, and allowed types |
| `what_if` | Same template arguments | Successful preview with resource IDs and change types; requires subscription, group, and allowed types |
| `deployment_status` | `{ "name": "existing-deployment-name" }` | Existing deployment metadata and provisioning state in the startup group |

`parameters` is optional and defaults to `{}`. When supplied it maps declared parameter names to `{ "value": literal }`, for example `{ "region": { "value": "centralus" } }`. Do not pass a full parameter-file wrapper or paths. Do not add subscription IDs, group names, type lists, flags, or commands to tool arguments.

## Inspect and plan

Start with `connection_status`, then use `list_resource_groups` to identify an existing group if needed. `list_resources` requires the group to be configured at server startup. It intentionally excludes tags and arbitrary resource properties. `deployment_status` reads a known deployment; it does not enumerate deployments or retrieve outputs.

Before template operations, the operator must configure `--subscription UUID`, `--resource-group NAME`, and one `--allow-type TYPE` for each permitted type, then restart the MCP client. Choose the scope for the current project. Do not imply that selection grants Azure RBAC permissions; Azure evaluates the logged-in identity's actual access.

Draft inline, resource-group ARM templates in Incremental mode. Use 1-100 resources with literal names and types from the configured list. Resource values may use literals or direct `parameters()` references supported by the shared policy. Outputs, linked/nested templates, cross-scope resources, copy loops, conditions, identity configuration, arbitrary ARM expressions, scripts, extensions, IAM, and managed-identity resource types are rejected. Literal variables are accepted, but variable-reference expressions are not supported. Secure parameter types and sensitive field names are rejected. This filter cannot identify every confidential literal; never submit secrets.

Call `validate_template` before `what_if`. Use the identical template and parameter values in both. Show Create, Modify, Delete, Ignore, Unsupported, or other returned changes without claiming property-level comparisons: this local preview returns resource IDs and change types only. Investigate Delete, Ignore, and Unsupported entries before handing the plan back. Azure what-if can drift or be incomplete, and successful validation does not prove deployment readiness, permission sufficiency, or cost.

## Deployment handoff

No local tool submits an ARM deployment, creates a group, approves a plan, changes RBAC, or returns a token. Return the prepared template and preview for the human's independent review. If a separately configured hosted Azure ARM Guard flow is selected, use its own project approval and private browser review; the local what-if result does not approve or substitute for its plan. The human approves the exact intended changes before any submission. Never click that approval on the human's behalf.

Report what Azure was actually queried, what was only drafted or simulated, and what still needs live verification. Stop if the required scope, session, or permitted type is unavailable.
