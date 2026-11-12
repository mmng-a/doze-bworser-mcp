const { safeStorage } = require('electron');
const { readFile, writeFile, rename, rm } = require('node:fs/promises');

/** Preserve session cookies without extending their server-defined lifetime. */
async function preserveSessionCookies(session, path, onError) {
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('OS encryption is unavailable for saved session cookies');
    }
  }
  let saved;
  try { saved = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved) {
    requireEncryption();
    const cookies = JSON.parse(safeStorage.decryptString(saved));
    for (const cookie of cookies) {
      const { name, value, domain, path: cookiePath, secure, httpOnly, sameSite, hostOnly } = cookie;
      await session.cookies.set({ url: `${secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${cookiePath}`, name, value,
        ...(!hostOnly ? { domain } : {}), path: cookiePath, secure, httpOnly, sameSite });
    }
  }
  let tail = Promise.resolve();
  let failure;
  function save() {
    tail = tail.then(async () => {
      const cookies = (await session.cookies.get({})).filter(cookie => cookie.session);
      if (!cookies.length) { await rm(path, { force: true }); return; }
      requireEncryption();
      await writeFile(path + '.new', safeStorage.encryptString(JSON.stringify(cookies)), { mode: 0o600 });
      await rename(path + '.new', path);
    });
    tail.catch(error => { if (!failure) { failure = error; onError(error); } });
    return tail;
  }
  session.cookies.on('changed', () => { void save(); });
  return async () => { if (failure) throw failure; await save(); await session.cookies.flushStore(); session.flushStorageData(); };
}
module.exports = { preserveSessionCookies };
