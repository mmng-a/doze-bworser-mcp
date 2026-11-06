import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, chmod, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';

const run = promisify(execFile);

/** Identify storage by its Git worktree root, or its canonical folder outside Git. */
export async function workspaceKey(cwd, { signal, timeout = 20_000 } = {}) {
  if (cwd === undefined) return null;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Workspace path must be absolute');
  signal?.throwIfAborted();
  const folder = await realpath(cwd);
  let root = folder;
  for (let directory = folder; ; directory = dirname(directory)) {
    signal?.throwIfAborted();
    try { await lstat(join(directory, '.git')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (dirname(directory) === directory) break;
      continue;
    }
    try {
      // Inherited Git overrides must not redirect another project's storage.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
      const { stdout } = await run('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { env, signal, timeout, maxBuffer: 64 * 1024 });
      const path = stdout.replace(/\r?\n$/, '');
      if (!isAbsolute(path)) throw new Error('Git returned an invalid worktree root');
      root = await realpath(path);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Cannot determine Git root: ${error.stderr?.trim() || error.message}`, { cause: error });
    }
    break;
  }
  return createHash('sha256').update(JSON.stringify([root])).digest('hex');
}

/** Keep browser credentials outside the checkout and inaccessible to other OS users. */
export async function prepareProfile(directory, key) {
  if (!directory) throw new Error('Project profile directory is not configured');
  const path = join(directory, key);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
    await chmod(path, 0o700);
  }
  return path;
}
