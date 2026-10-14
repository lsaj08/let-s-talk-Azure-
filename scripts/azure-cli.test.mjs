import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Removing argv isolation, bounded execution, or error redaction must fail these tests.
const runnerModule = await import('../local/azure-cli.mjs').catch(() => null);
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'azure runner test '));
const fixture = join(fixtureDirectory, 'controlled-child.mjs');
await writeFile(fixture, `
const mode = process.argv[2];
if (mode === 'ok') console.log(JSON.stringify({ args: process.argv.slice(3), telemetry: process.env.AZURE_CORE_COLLECT_TELEMETRY }));
else if (mode === 'invalid') console.log('not json: SECRET_SENTINEL');
else if (mode === 'error') { console.error('SECRET_SENTINEL'); console.log('SECRET_SENTINEL'); process.exitCode = 9; }
else if (mode === 'large') process.stdout.write(' '.repeat(200000));
else if (mode === 'stderr-large') process.stderr.write('SECRET_SENTINEL'.repeat(20000));
else if (mode === 'timeout') setTimeout(() => console.log('{}'), 10000);
else if (mode === 'late-effect') setTimeout(async () => { const fs = await import('node:fs/promises'); await fs.writeFile(process.argv[3], 'unsafe'); console.log('{}'); }, 350);
`);
test.after(async () => rm(fixtureDirectory, { recursive: true, force: true }));

function runner(options = {}) {
  assert.equal(typeof runnerModule?.createAzureRunner, 'function', 'createAzureRunner must exist');
  return runnerModule.createAzureRunner({ executable: process.execPath, ...options });
}

function windowsCommand(executable, args) {
  assert.equal(typeof runnerModule?.buildWindowsCommand, 'function', 'Windows quoting boundary must exist');
  return runnerModule.buildWindowsCommand(executable, args);
}

test('real child receives separate argv, forced JSON flags, and disabled telemetry', async () => {
  const value = await runner()([fixture, 'ok', 'group with spaces', '@C:\\Temp\\body file.json']);
  assert.deepEqual(value, {
    args: ['group with spaces', '@C:\\Temp\\body file.json', '--output', 'json', '--only-show-errors'],
    telemetry: 'no',
  });
});

test('nonzero child exit returns no stdout or stderr secrets', async () => {
  await assert.rejects(runner()([fixture, 'error']), error =>
    /Azure CLI/.test(error.message) && /az login/.test(error.message) && !error.message.includes('SECRET_SENTINEL') && !error.cause);
});

test('malformed JSON returns no fragment of the child output', async () => {
  await assert.rejects(runner()([fixture, 'invalid']), error =>
    /JSON/.test(error.message) && !error.message.includes('SECRET_SENTINEL') && !error.cause);
});

test('stdout over the configured limit is rejected', async () => {
  await assert.rejects(runner({ maxOutput: 1024 })([fixture, 'large']), /output limit/i);
});

test('stderr is bounded even though it is never exposed', async () => {
  await assert.rejects(runner({ maxOutput: 1024 })([fixture, 'stderr-large']), error =>
    /output limit/i.test(error.message) && !error.message.includes('SECRET_SENTINEL'));
});

test('a process that exceeds the deadline is stopped', async () => {
  const started = Date.now();
  await assert.rejects(runner({ timeoutMs: 80 })([fixture, 'timeout']), /timed out/i);
  assert.ok(Date.now() - started < 3000);
});

test('timed out child cannot perform a later file side effect', async () => {
  const lateFile = join(fixtureDirectory, 'must-not-exist.txt');
  await assert.rejects(runner({ timeoutMs: 80 })([fixture, 'late-effect', lateFile]), /timed out/i);
  await new Promise(resolve => setTimeout(resolve, 550));
  await assert.rejects(access(lateFile), { code: 'ENOENT' });
});

test('missing executable error exposes neither path nor platform stderr', async () => {
  const missing = join(fixtureDirectory, process.platform === 'win32' ? 'missing-SECRET_SENTINEL.exe' : 'missing-SECRET_SENTINEL');
  await assert.rejects(runner({ executable: missing })([fixture, 'ok']), error =>
    /Azure CLI/.test(error.message) && !error.message.includes('SECRET_SENTINEL') && !error.cause);
});

test('argv must be strings and may not contain control characters', async () => {
  const run = runner();
  for (const args of [null, {}, [], [123], ['group\u0000list'], ['group\nlist'], ['group\rlist']]) {
    await assert.rejects(run(args), /argument/i);
  }
});

test('operator executable must be an absolute path and limits are bounded', () => {
  for (const options of [{ executable: 'az' }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { maxOutput: 0 }, { maxOutput: 2097153 }]) {
    assert.throws(() => runner(options), /configuration/i);
  }
});

test('Windows wrapper quotes spaces and @body paths inside a fixed command', () => {
  assert.equal(windowsCommand('C:\\Azure CLI\\az.cmd', ['group', 'list', '@C:\\Temp\\body file.json']),
    '""C:\\Azure CLI\\az.cmd" "group" "list" "@C:\\Temp\\body file.json""');
});

test('Windows batch launcher preserves parentheses in its path and each literal argument', { skip: process.platform !== 'win32' }, async () => {
  const directory = join(fixtureDirectory, 'Program Files (x86)', 'Azure CLI');
  await mkdir(directory, { recursive: true });
  const launcher = join(directory, 'az.cmd');
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" ok %*\r\n`);
  const result = await runner({ executable: launcher })(['group', 'show', '--name', 'project (sandbox)', '@C:\\Temp\\body (review).json']);
  assert.deepEqual(result, {
    args: ['group', 'show', '--name', 'project (sandbox)', '@C:\\Temp\\body (review).json', '--output', 'json', '--only-show-errors'],
    telemetry: 'no',
  });
});

test('Windows wrapper rejects expansion, operators, newlines, and quote injection', () => {
  for (const marker of ['&', '|', '<', '>', '^', '%', '!', '"', '\n', '\r', '\u0000']) {
    assert.throws(() => windowsCommand(`C:\\bad${marker}path\\az.cmd`, ['group', 'list']), /unsafe/i);
    assert.throws(() => windowsCommand('C:\\Azure\\az.cmd', ['group', `list${marker}whoami`]), /unsafe/i);
  }
});

test('Windows wrapper does not execute an arbitrary batch file', () => {
  assert.throws(() => windowsCommand('C:\\Temp\\attacker.cmd', ['group', 'list']), /az\.cmd/i);
  assert.throws(() => windowsCommand('az.cmd', ['group', 'list']), /absolute/i);
});
