# Build and checks

These scripts use Node.js built-in modules and require no dependencies.

- `security.test.mjs`: simulated Azure and R2 tests for template policy, OAuth state, approval, encryption, and replay prevention.
- `local-mcp.test.mjs`: local scope, output filtering, template validation, and MCP lifecycle checks.
- `azure-cli.test.mjs`: real controlled child-process checks for the Azure CLI runner.
- `build.mjs`: copies the authoritative `worker/guard.js` into `worker/index.js` and `dist/server/index.js`, and copies the hosting manifest into `dist`.
- `validate-artifact.mjs`: verifies that the manifest is JSON and the generated Worker is an ES module exporting `default.fetch`.
- `stdio.test.mjs`: real MCP child-process handshake and bounded message framing.
- `install-integration.mjs`: install the skill and subagent into a chosen project without overwriting existing files or editing MCP settings.
- `install-integration.test.mjs`: installation, conflict, and destination-boundary checks.
- `build.sh`: shell entry point for the same build.mjs implementation.

Run tests, build, and validate before publishing. Local passing tests do not establish successful real Azure authentication or deployment.

```sh
node --test scripts/*.test.mjs
node scripts/build.mjs
node scripts/validate-artifact.mjs
```

The Windows junction test may require permission outside a restricted filesystem sandbox. Use an authorized test environment; preserve the boundary check. For documentation-only edits, check Git whitespace and local Markdown links. The [verification record](../docs/VERIFICATION.md) captures the tested source baseline and remaining integration work; the [architecture](../docs/ARCHITECTURE.md) identifies authoritative and generated files.
