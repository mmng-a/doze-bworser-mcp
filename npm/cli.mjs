#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { platforms } from './platforms.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const platform = platforms.find(item => item.os === process.platform && item.cpu === process.arch);
try {
  if (!platform) throw new Error('Unsupported platform: ' + process.platform + '-' + process.arch);
  if (platform.os === 'linux' && !process.report.getReport().header.glibcVersionRuntime) throw new Error('Linux packages require glibc; musl/Alpine is unsupported');
  const name = 'doze-bworser-mcp-' + platform.key;
  let manifest;
  try { manifest = createRequire(import.meta.url).resolve(name + '/package.json'); }
  catch { throw new Error('Missing native package ' + name + '. Reinstall with npm optional dependencies enabled'); }
  if (JSON.parse(readFileSync(manifest, 'utf8')).version !== version) throw new Error('Native package version mismatch; reinstall doze-bworser-mcp');
  const executable = join(dirname(manifest), 'bin', 'doze-bworser-mcp' + (platform.os === 'win32' ? '.exe' : ''));
  const child = spawn(executable, process.argv.slice(2), {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, DOZE_RUNTIME_DIR: join(root, 'runtime'), DOZE_NODE_PATH: process.execPath },
  });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map(signal => () => child.kill(signal));
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  child.once('error', error => { console.error('Cannot start doze-bworser-mcp: ' + error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    signals.forEach((name, index) => process.off(name, handlers[index]));
    process.exitCode = code ?? 128 + (constants.signals[signal] ?? 0);
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
