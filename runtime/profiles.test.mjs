import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, symlink, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceKey, prepareProfile } from './profiles.mjs';
import { callerFromMeta } from './tools.mjs';
import { BrowserManager } from './browser.mjs';

test('Codex storage uses sandboxCwd and refuses missing or invalid folder information', async () => {
  const meta = { 'x-codex-turn-metadata': { thread_id: 'root', workspaces: { '/unrelated': {} } },
    'codex/sandbox-state': { sandboxCwd: pathToFileURL(process.cwd()).href } };
  assert.equal(callerFromMeta(meta, 'connection').cwd, process.cwd());
  assert.equal(callerFromMeta({}, 'connection').cwd, undefined);
  for (const uri of ['relative', 'https://example.com/', 'file:///example?query=1']) {
    assert.throws(() => callerFromMeta({ ...meta, 'codex/sandbox-state': { sandboxCwd: uri } }, 'connection'), /sandboxCwd/);
  }
  const manager = new BrowserManager({ electron_path: 'fixture', operation_timeout_seconds: 1 });
  const missing = callerFromMeta({ 'x-codex-turn-metadata': { thread_id: 'root' } }, 'connection');
  await assert.rejects(manager.call(missing, 'open_page', { url: 'about:blank' }), /sandboxCwd/);
  assert.equal(manager.engines.size, 0);
});

test('Git roots share storage while plain folders and separate worktrees retain their own profiles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'doze-workspaces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const one = join(directory, 'one 日本語');
  const two = join(directory, 'two');
  const nested = join(one, 'nested');
  const hooks = join(directory, 'hooks');
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(two), mkdir(hooks)]);
  const git = args => execFileSync('git', ['-c', `core.hooksPath=${hooks}`, ...args], { stdio: 'pipe' });
  assert.equal(await workspaceKey(), null);
  assert.notEqual(await workspaceKey(one), await workspaceKey(two));
  assert.notEqual(await workspaceKey(one), await workspaceKey(nested));
  const oldKey = createHash('sha256').update(JSON.stringify([await realpath(one)])).digest('hex');
  assert.equal(await workspaceKey(one), oldKey, 'existing single-folder profile hashes remain addressable');
  await assert.rejects(workspaceKey('relative'), /absolute/);
  await assert.rejects(workspaceKey(join(directory, 'missing')), { code: 'ENOENT' });
  git(['init', '--quiet', one]);
  assert.equal(await workspaceKey(one), await workspaceKey(nested));
  const another = join(directory, 'another');
  git(['init', '--quiet', another]);
  assert.notEqual(await workspaceKey(one), await workspaceKey(another));
  const moduleUrl = new URL('./profiles.mjs', import.meta.url).href;
  const overridden = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { workspaceKey } = await import(${JSON.stringify(moduleUrl)}); console.log(await workspaceKey(process.argv[1]));`, one],
  { encoding: 'utf8', env: { ...process.env, GIT_DIR: join(another, '.git'), GIT_WORK_TREE: another } });
  assert.equal(overridden.trim(), await workspaceKey(one), 'inherited Git overrides cannot select another repository profile');
  git(['-C', one, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Fixture']);
  const worktree = join(directory, 'worktree');
  git(['-C', one, 'worktree', 'add', '--quiet', '--detach', worktree]);
  assert.notEqual(await workspaceKey(one), await workspaceKey(worktree));
  await mkdir(join(two, '.git'));
  await assert.rejects(workspaceKey(two), /Cannot determine Git root/);
  git(['init', '--quiet', nested]);
  await rm(join(nested, '.git', 'HEAD'));
  await assert.rejects(workspaceKey(nested), /Git root mismatch/);
  if (process.platform !== 'win32') {
    const alias = join(directory, 'alias');
    await symlink(one, alias);
    assert.equal(await workspaceKey(one), await workspaceKey(alias));
  }
  const profiles = join(directory, 'profiles');
  const profile = await prepareProfile(profiles, await workspaceKey(one));
  assert.equal((await stat(profile)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(profiles)).mode & 0o777, 0o700);
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
  }
});
