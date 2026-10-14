import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = fileURLToPath(new URL('../', import.meta.url));
const installer = join(repository, 'scripts/install-integration.mjs');
const run = (client, project) => spawnSync(process.execPath,
  [installer, '--client', client, '--project', project], { encoding: 'utf8' });

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'azure-integration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('installs a discoverable Codex skill with its reference and agent', async t => {
  const root = await project(t);
  const result = run('codex', root);
  assert.equal(result.status, 0, result.stderr);
  for (const [installed, original] of [
    ['.agents/skills/azure-arm-guard/SKILL.md', 'skills/azure-arm-guard/SKILL.md'],
    ['.agents/skills/azure-arm-guard/references/workflow.md', 'skills/azure-arm-guard/references/workflow.md'],
    ['.codex/agents/azure-reviewer.toml', 'integrations/codex/azure-reviewer.toml'],
  ]) {
    assert.deepEqual(await readFile(join(root, installed)), await readFile(join(repository, original)));
  }
  await assert.rejects(access(join(root, '.codex/config.toml')));
  await assert.rejects(access(join(root, '.mcp.json')));
});

test('installs a discoverable Claude skill and agent without changing MCP config', async t => {
  const root = await project(t);
  await writeFile(join(root, '.mcp.json'), '{"existing":"preserve"}\n');
  const result = run('claude', root);
  assert.equal(result.status, 0, result.stderr);
  for (const [installed, original] of [
    ['.claude/skills/azure-arm-guard/SKILL.md', 'skills/azure-arm-guard/SKILL.md'],
    ['.claude/skills/azure-arm-guard/references/workflow.md', 'skills/azure-arm-guard/references/workflow.md'],
    ['.claude/agents/azure-reviewer.md', 'integrations/claude/azure-reviewer.md'],
  ]) assert.deepEqual(await readFile(join(root, installed)), await readFile(join(repository, original)));
  assert.equal(await readFile(join(root, '.mcp.json'), 'utf8'), '{"existing":"preserve"}\n');
  await assert.rejects(access(join(root, '.codex/config.toml')));
});

test('refuses an existing skill directory before installing any file', async t => {
  const root = await project(t);
  const skill = join(root, '.agents/skills/azure-arm-guard');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'keep.txt'), 'existing content');
  assert.notEqual(run('codex', root).status, 0);
  assert.deepEqual(await readdir(skill), ['keep.txt']);
  await assert.rejects(access(join(root, '.codex/agents/azure-reviewer.toml')));
});

test('refuses an existing agent before installing the skill', async t => {
  const root = await project(t);
  await mkdir(join(root, '.codex/agents'), { recursive: true });
  await writeFile(join(root, '.codex/agents/azure-reviewer.toml'), 'keep my agent');
  assert.notEqual(run('codex', root).status, 0);
  assert.equal(await readFile(join(root, '.codex/agents/azure-reviewer.toml'), 'utf8'), 'keep my agent');
  await assert.rejects(access(join(root, '.agents/skills/azure-arm-guard')));
});

test('requires an existing absolute project directory and rejects malformed options', async t => {
  const root = await project(t);
  const invalid = [
    ['--client', 'other', '--project', root],
    ['--client', 'codex', '--project', 'relative-project'],
    ['--client', 'codex', '--project', join(root, 'missing')],
    ['--client', 'codex', '--project', root, '--global'],
    ['--client', 'codex', '--client', 'codex', '--project', root],
    ['--project', root],
  ];
  for (const args of invalid) {
    const result = spawnSync(process.execPath, [installer, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, JSON.stringify(args));
  }
  assert.deepEqual(await readdir(root), []);
});

test('refuses linked destination parents and leaves their target untouched', async t => {
  const root = await project(t);
  const outside = await project(t);
  await symlink(outside, join(root, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(run('codex', root).status, 0);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(access(join(root, '.codex/agents/azure-reviewer.toml')));
});

test('a repeated installation preserves all previously installed files', async t => {
  const root = await project(t);
  assert.equal(run('codex', root).status, 0);
  const skillFile = join(root, '.agents/skills/azure-arm-guard/SKILL.md');
  await writeFile(skillFile, 'user customization');
  assert.notEqual(run('codex', root).status, 0);
  assert.equal(await readFile(skillFile, 'utf8'), 'user customization');
});
