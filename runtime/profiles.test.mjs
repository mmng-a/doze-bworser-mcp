import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceKey, prepareProfile } from './profiles.mjs';
import { callerFromMeta } from './tools.mjs';

test('workspace metadata selects canonical local folders and keeps unknown clients temporary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'doze-workspaces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const one = join(directory, 'one');
  const two = join(directory, 'two');
  await Promise.all([mkdir(one), mkdir(two)]);
  const caller = callerFromMeta({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'root', workspaces: { [one]: {} } }) }, 'connection');
  assert.deepEqual(caller.workspaces, [one]);
  assert.equal(await workspaceKey(), null);
  assert.deepEqual(callerFromMeta({}, 'connection').workspaces, []);
  assert.notEqual(await workspaceKey([one]), await workspaceKey([two]));
  assert.equal(await workspaceKey([one, two]), await workspaceKey([two, one, one]));
  await assert.rejects(workspaceKey(['relative']), /absolute/);
  await assert.rejects(workspaceKey([join(directory, 'missing')]), { code: 'ENOENT' });
  assert.throws(() => callerFromMeta({ 'x-codex-turn-metadata': { workspaces: [] } }, 'connection'), /workspace/);
  if (process.platform !== 'win32') {
    const alias = join(directory, 'alias');
    await symlink(one, alias);
    assert.equal(await workspaceKey([one]), await workspaceKey([alias]));
  }
  const profiles = join(directory, 'profiles');
  const profile = await prepareProfile(profiles, await workspaceKey([one]));
  assert.equal((await stat(profile)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(profiles)).mode & 0o777, 0o700);
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
  }
});
