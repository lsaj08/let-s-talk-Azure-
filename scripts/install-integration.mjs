import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
function parseOptions(args) {
  const options = {};
  if (args.length !== 4) throw new Error('Use exactly --client and --project');
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!['--client', '--project'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error('Unknown, missing, or repeated option');
    }
    options[key] = value;
  }
  if (!['codex', 'claude'].includes(options['--client']) || !isAbsolute(options['--project'] || '')) {
    throw new Error('Select codex or claude and an absolute project path');
  }
  return { client: options['--client'], project: options['--project'] };
}

async function entry(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkDestination(root, target) {
  const relativePath = relative(root, target);
  if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('..' + sep)) {
    throw new Error('Destination must stay inside the project');
  }
  let parent = root;
  for (const component of relativePath.split(sep).slice(0, -1)) {
    parent = join(parent, component);
    const info = await entry(parent);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new Error('Destination parent is linked or is not a directory');
    }
  }
  if (await entry(target)) throw new Error('Destination already exists; no files were overwritten');
}

try {
  const { client, project } = parseOptions(process.argv.slice(2));
  if (!(await stat(project)).isDirectory()) throw new Error('Project must be an existing directory');
  const root = await realpath(project);
  const skill = join(root, client === 'codex' ? '.agents/skills/azure-arm-guard' : '.claude/skills/azure-arm-guard');
  const agent = join(root, client === 'codex' ? '.codex/agents/azure-reviewer.toml' : '.claude/agents/azure-reviewer.md');
  await checkDestination(root, skill);
  await checkDestination(root, agent);
  const files = [
    ['skills/azure-arm-guard/SKILL.md', join(skill, 'SKILL.md')],
    ['skills/azure-arm-guard/references/workflow.md', join(skill, 'references/workflow.md')],
    ['integrations/' + client + '/azure-reviewer.' + (client === 'codex' ? 'toml' : 'md'), agent],
  ];
  // Validate bundled inputs before creating any project destinations.
  for (const [source] of files) if (!(await stat(join(repository, source))).isFile()) throw new Error('Missing bundled file');
  const createdFiles = [];
  const createdDirectories = [];
  try {
    await mkdir(dirname(skill), { recursive: true });
    await mkdir(dirname(agent), { recursive: true });
    await checkDestination(root, skill);
    await checkDestination(root, agent);
    await mkdir(skill);
    createdDirectories.push(skill);
    await mkdir(join(skill, 'references'));
    createdDirectories.push(join(skill, 'references'));
    for (const [source, destination] of files) {
      await copyFile(join(repository, source), destination, constants.COPYFILE_EXCL);
      createdFiles.push(destination);
    }
  } catch (error) {
    // Remove only files copied by this invocation and its now-empty skill directories.
    for (const file of createdFiles.reverse()) await unlink(file).catch(() => {});
    for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => {});
    throw error;
  }
  process.stdout.write(JSON.stringify({
    installed: files.map(([, destination]) => destination),
    client,
    mcpConfigured: false,
    instructions: join(repository, 'integrations/README.md'),
    server: join(repository, 'local/server.mjs'),
  }, null, 2) + '\n');
} catch (error) {
  const known = ['Use exactly', 'Unknown, missing', 'Select codex', 'Project must', 'Destination', 'Missing bundled'];
  const reason = known.some(prefix => error.message.startsWith(prefix)) ? error.message : 'Check the project path and filesystem access';
  process.stderr.write('Installation failed: ' + reason + '. Use --client codex|claude --project ABSOLUTE_PROJECT_PATH.\n');
  process.exitCode = 1;
}
