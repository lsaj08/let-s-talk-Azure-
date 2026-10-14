# Verification record and live acceptance

Project creator: **Leiner Arce ([@lsaj08](https://github.com/lsaj08))**.

## Recorded implementation baseline

The following results were observed for implementation commit `14642cdb4d5145939653918c569a5aef730cea6e` (version 0.2.0) on 2026-10-13, using Windows and Node.js v24.19.0. They are historical evidence for that source baseline, not an assertion that every future checkout was tested or that Azure was contacted.

| Check | Observed result |
| --- | --- |
| `node --test scripts/*.test.mjs` | 55 passed, 0 failed, 0 skipped; exit 0 |
| `node scripts/build.mjs` | Worker built; exit 0 |
| `node scripts/validate-artifact.mjs` | Valid ESM artifact exporting `default.fetch`; exit 0 |
| Skill Creator frontmatter validation | Skill valid; exit 0 |
| Codex agent TOML parsing and required fields | Passed; shell capability disabled; exit 0 |
| Git whitespace checks | No errors; exit 0 |
| Known credential and personal identifier pattern scan | No matches; not an exhaustive proof of secret absence |
| Independent skill exercise | Simulated inventory, identical validation/preview inputs, and human deployment handoff; no live Azure request |

The suite includes 22 hosted/shared-policy checks, 8 local-service checks, 14 CLI-runner checks, 7 installer checks, and 4 stdio checks. The Windows runner test executes a controlled `az.cmd` fixture; it does not execute the real Azure CLI. The installer boundary test creates a real temporary Windows junction and may need permission beyond a restricted filesystem sandbox. Do not remove that test to claim a passing suite.

A parameter-default expression bypass was reproduced before the shared-policy fix. Regression checks then confirmed rejection before the local runner was invoked.

## Checks for future changes

For runtime, shared-policy, or installer changes, run the suite, build, and artifact validation against the exact source being published. For client instructions, also validate skill frontmatter, agent configuration, referenced paths, and the tool names/arguments described in the workflow. Documentation-only changes need a whitespace and local-link check; they do not require a live deployment.

Do not commit diagnostic output containing credentials or confidential templates. Record a date/source revision, check outcome, and whether Azure behavior was simulated or live.

## Pending local acceptance

- [ ] Azure CLI installed and available to the actual client process; Node executable resolved.
- [ ] Human interactive Azure sign-in completed privately.
- [ ] Codex discovers the installed skill, subagent, and configured MCP server.
- [ ] Claude Code discovers the installed skill, subagent, and configured MCP server.
- [ ] Live `connection_status` confirms the intended subscription and project scope.
- [ ] Live group/resource inventory agrees with Azure Portal.
- [ ] Live restricted-template validation succeeds with the intended RBAC.
- [ ] Live what-if returns an understood result in a disposable existing group.
- [ ] Unix runner behavior verified on a supported target system.

The local server has no deployment or group-creation tool. A successful local preview does not complete a deployment test. Deployment acceptance belongs to a separately reviewed human-operated or hosted flow.

## Pending hosted acceptance

The last observed hosted OAuth callback failed. Entra registration and a consent screen were observed, but a successful token exchange, stored connection, and real deployment were not demonstrated.

- [ ] Successful Entra OAuth callback and subscription/tenant check.
- [ ] Verified gateway identity-header filtering and private access control.
- [ ] Real R2 conditional-write, encryption, and retention behavior.
- [ ] Live validation/what-if polling with provider-specific responses.
- [ ] Exact human-approved deployment succeeds in a disposable sandbox.
- [ ] Expiry, replay, concurrency, failure recovery, and audit behavior verified in the deployed environment.

GitHub publication verifies source availability only. It does not install the client integration, configure Azure, or redeploy the hosted site. See [integration setup](../integrations/README.md), [hosted setup](../SETUP.md), and [security boundaries](../SECURITY.md).
