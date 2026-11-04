import { install, Browser } from '@puppeteer/browsers';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Download the supported Chrome for Testing through Puppeteer's browser manager. */
export async function chromePath() {
  const { config } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const cacheDir = join(homedir(), '.cache', 'doze-bworser-mcp', config.chrome_version);
  const complete = join(cacheDir, '.complete');
  // The shared download owns this version's cache; interrupted extraction must not look installed.
  if (!existsSync(complete)) await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  const browser = await install({ browser: Browser.CHROME, buildId: config.chrome_version, cacheDir });
  await writeFile(complete, '');
  return browser.executablePath;
}
