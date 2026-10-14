# Build and checks

These scripts use Node.js built-in modules and require no dependencies.

- `security.test.mjs`: simulated Azure and R2 tests for template policy, OAuth state, approval, encryption, and replay prevention.
- `build.mjs`: copies the authoritative `worker/guard.js` into `worker/index.js` and `dist/server/index.js`, and copies the hosting manifest into `dist`.
- `validate-artifact.mjs`: verifies that the manifest is JSON and the generated Worker is an ES module exporting `default.fetch`.
- `build.sh`: legacy shell build that copies the existing Worker index; use build.mjs to regenerate it from guard.js.

Run tests, build, and validate before publishing. Local passing tests do not establish successful real Azure authentication or deployment.
