import { createHash } from 'node:crypto';
import { mkdir, chmod, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Identify a workspace by its canonical local paths, never its Git remote or display name. */
export async function workspaceKey(paths = []) {
  if (!paths.length) return null;
  if (paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Workspace paths must be absolute');
  const canonical = [...new Set(await Promise.all(paths.map(path => realpath(path))))].sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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
