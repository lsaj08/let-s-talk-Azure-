import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_TIMEOUT = 120_000;
const WINDOWS_UNSAFE = /[&|<>^%!"\r\n\u0000]/;
const PROCESS_FAILURE = 'Azure CLI failed. Check that Azure CLI is installed and run az login.';

function argumentsArray(args) {
  if (!Array.isArray(args) || !args.length || args.length > 128 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 32_768 || /[\r\n\u0000]/.test(arg))) {
    throw new Error('Invalid Azure CLI arguments.');
  }
}

// Every token is quoted, so parentheses stay literal. Quotes and %/! expansion are rejected.
export function buildWindowsCommand(executable, args) {
  if (typeof executable !== 'string' || WINDOWS_UNSAFE.test(executable)) {
    throw new Error('Unsafe Windows executable path.');
  }
  if (!win32.isAbsolute(executable)) throw new Error('Windows executable requires an absolute path.');
  if (win32.basename(executable).toLowerCase() !== 'az.cmd') {
    throw new Error('Only the az.cmd launcher is allowed for Windows batch execution.');
  }
  try { argumentsArray(args); } catch { throw new Error('Unsafe Windows command arguments.'); }
  if (args.some(arg => WINDOWS_UNSAFE.test(arg))) throw new Error('Unsafe Windows command arguments.');
  return '"' + [executable, ...args].map(arg => '"' + arg + '"').join(' ') + '"';
}

function resolveAzureExecutable(environment) {
  const names = process.platform === 'win32' ? ['az.exe', 'az.cmd'] : ['az'];
  const directories = (environment.PATH || environment.Path || '').split(delimiter).filter(Boolean);
  // Prefer a native executable even if a batch launcher appears earlier on PATH.
  for (const name of names) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (!isAbsolute(candidate)) continue;
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* Continue the PATH search. */ }
    }
  }
  throw new Error(PROCESS_FAILURE);
}

function windowsSystemExecutable(environment, name) {
  const root = environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows';
  if (!win32.isAbsolute(root) || WINDOWS_UNSAFE.test(root)) throw new Error('Invalid Azure CLI configuration.');
  return win32.join(root, 'System32', name);
}

function stopProcess(child, environment, batchLauncher) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (!batchLauncher) { child.kill(); return; }
    // Killing cmd.exe alone can leave the Azure Python process running after a deadline.
    const stop = spawn(windowsSystemExecutable(environment, 'taskkill.exe'),
      ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const fallback = setTimeout(() => { stop.kill(); child.kill(); }, 3000);
    fallback.unref();
    stop.on('error', () => { clearTimeout(fallback); child.kill(); });
    stop.on('close', code => { clearTimeout(fallback); if (code !== 0) child.kill(); });
    stop.unref();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

/** executable is trusted operator configuration; it is never an invocation argument. */
export function createAzureRunner({ executable, timeoutMs = MAX_TIMEOUT, maxOutput = MAX_OUTPUT } = {}) {
  if ((executable !== undefined && (typeof executable !== 'string' || !isAbsolute(executable) || /[\r\n\u0000]/.test(executable))) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT ||
      !Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > MAX_OUTPUT) {
    throw new Error('Invalid Azure CLI configuration.');
  }
  const environment = { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: 'no', AZURE_CORE_OUTPUT: 'json', AZURE_CORE_ONLY_SHOW_ERRORS: 'yes' };

  return async args => {
    argumentsArray(args);
    const file = executable || resolveAzureExecutable(environment);
    const argv = [...args, '--output', 'json', '--only-show-errors'];
    let childFile = file;
    let childArgs = argv;
    let verbatim = false;
    if (process.platform === 'win32') {
      if (/\.cmd$/i.test(file)) {
        childFile = windowsSystemExecutable(environment, 'cmd.exe');
        childArgs = ['/d', '/v:off', '/s', '/c', buildWindowsCommand(file, argv)];
        verbatim = true;
      } else if (!/\.exe$/i.test(file)) {
        throw new Error('Invalid Azure CLI configuration.');
      }
    }

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(childFile, childArgs, {
          shell: false, windowsHide: true, windowsVerbatimArguments: verbatim,
          detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: environment,
        });
      } catch { reject(new Error(PROCESS_FAILURE)); return; }
      let settled = false;
      let bytes = 0;
      let output = [];
      const timer = setTimeout(() => fail('Azure CLI timed out. Check your Azure connection before retrying.', true), timeoutMs);

      function fail(message, stop = false) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        output = [];
        if (stop) stopProcess(child, environment, verbatim);
        reject(new Error(message));
      }
      function collect(chunk, stdout) {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxOutput) { fail('Azure CLI output limit exceeded.', true); return; }
        if (stdout) output.push(chunk);
      }
      child.stdout.on('data', chunk => collect(chunk, true));
      child.stderr.on('data', chunk => collect(chunk, false));
      child.on('error', () => fail(PROCESS_FAILURE));
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { fail(PROCESS_FAILURE); return; }
        let decoded;
        try { decoded = JSON.parse(Buffer.concat(output).toString('utf8').trim()); }
        catch { fail('Azure CLI returned invalid JSON.'); return; }
        settled = true;
        clearTimeout(timer);
        output = [];
        resolve(decoded);
      });
    });
  };
}
