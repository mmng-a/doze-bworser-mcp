import { downloadArtifact } from '@electron/get';
import extract from 'extract-zip';
import { readFile, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Acquire the pinned runtime without running an npm installation script. */
export async function electronPath() {
  const { config } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const root = join(homedir(), '.cache', 'doze-bworser-mcp', 'electron', config.electron_version, `${process.platform}-${process.arch}`);
  const executable = join(root, process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');
  try { await access(join(root, '.complete')); await access(executable); return executable; } catch {}
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const archive = await downloadArtifact({ version: config.electron_version, artifactName: 'electron', platform: process.platform, arch: process.arch, cacheRoot: join(root, '..', 'downloads') });
  await extract(archive, { dir: root });
  await access(executable);
  await writeFile(join(root, '.complete'), '');
  return executable;
}
