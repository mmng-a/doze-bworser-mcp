import { readFile, writeFile, mkdir, cp, copyFile, chmod, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platforms } from './platforms.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(await readFile(join(root, 'runtime/package.json'), 'utf8'));
const target = process.argv[2] ?? platforms.find(item => item.os === process.platform && item.cpu === process.arch)?.target;
const platform = platforms.find(item => item.target === target);
if (!platform) throw new Error('Unsupported build target: ' + target);
if (!process.env.npm_execpath) throw new Error('Run this script with npm run package:npm');
const cargo = await readFile(join(root, 'Cargo.toml'), 'utf8');
if (cargo.match(/^version = "([^"]+)"/m)?.[1] !== metadata.version) throw new Error('Rust and runtime versions differ');
const output = join(root, 'dist/npm', platform.key);
const staging = join(output, 'staging');
const main = join(staging, 'main');
const native = join(staging, 'native');
const executable = 'doze-bworser-mcp' + (platform.os === 'win32' ? '.exe' : '');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed with status ' + result.status);
};
const npm = args => run(process.execPath, [process.env.npm_execpath, ...args]);
const buildEnv = { ...process.env };
delete buildEnv.DOZE_RUNTIME_DIR;
delete buildEnv.DOZE_NODE_PATH;
run('cargo', ['build', '--release', '--locked', '--target', target], { env: buildEnv });
npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(root, 'runtime')]);
await rm(staging, { recursive: true, force: true });
await Promise.all([mkdir(join(main, 'runtime'), { recursive: true }), mkdir(join(main, 'bin'), { recursive: true }), mkdir(join(native, 'bin'), { recursive: true })]);
const common = { version: metadata.version, license: 'MIT AND Apache-2.0', repository: { type: 'git', url: 'https://github.com/mmng-a/doze-bworser-mcp.git' } };
await writeFile(join(main, 'package.json'), JSON.stringify({
  ...common, name: 'doze-bworser-mcp', description: 'Project-scoped persistent Chrome for concurrent Codex browser tools.',
  type: 'module', engines: metadata.engines, bin: { 'doze-bworser-mcp': 'bin/cli.mjs' },
  files: ['bin', 'runtime', 'LICENSE', 'README.md', 'README.ja.md'],
  dependencies: metadata.dependencies, bundledDependencies: Object.keys(metadata.dependencies),
  optionalDependencies: Object.fromEntries(platforms.map(item => ['doze-bworser-mcp-' + item.key, metadata.version])),
}, null, 2) + '\n');
await writeFile(join(native, 'package.json'), JSON.stringify({
  ...common, license: 'MIT', name: 'doze-bworser-mcp-' + platform.key, description: 'Native launcher for doze-bworser-mcp (' + platform.key + ')',
  os: [platform.os], cpu: [platform.cpu], ...(platform.os === 'linux' ? { libc: ['glibc'] } : {}), files: ['bin', 'LICENSE'],
}, null, 2) + '\n');
for (const file of ['LICENSE', 'README.md', 'README.ja.md']) await copyFile(join(root, file), join(main, file));
await copyFile(join(root, 'LICENSE'), join(native, 'LICENSE'));
for (const file of await readdir(join(root, 'runtime'))) {
  if (file === 'package.json' || (file.endsWith('.mjs') && !file.endsWith('.test.mjs'))) await copyFile(join(root, 'runtime', file), join(main, 'runtime', file));
}
await cp(join(root, 'runtime/vendor'), join(main, 'runtime/vendor'), { recursive: true });
await cp(join(root, 'runtime/node_modules'), join(main, 'node_modules'), { recursive: true });
await copyFile(join(root, 'npm/cli.mjs'), join(main, 'bin/cli.mjs'));
await copyFile(join(root, 'npm/platforms.mjs'), join(main, 'bin/platforms.mjs'));
await copyFile(join(root, 'target', target, 'release', executable), join(native, 'bin', executable));
await chmod(join(main, 'bin/cli.mjs'), 0o755);
await chmod(join(native, 'bin', executable), 0o755);
for (const directory of [native, main]) {
  const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', output, directory],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(packed.stderr);
  const [archive] = JSON.parse(packed.stdout);
  const allowed = directory === main
    ? file => ['package.json', 'LICENSE', 'README.md', 'README.ja.md'].includes(file) || file.startsWith('bin/') || file.startsWith('node_modules/') || (file.startsWith('runtime/') && !file.endsWith('.test.mjs'))
    : file => ['package.json', 'LICENSE', 'bin/' + executable].includes(file);
  if (!archive.files.every(file => allowed(file.path))) throw new Error('Unexpected file in npm archive');
  console.log(archive.filename + ' (' + archive.size + ' bytes)');
}
console.log('Prepared npm tarballs in ' + resolve(output));
