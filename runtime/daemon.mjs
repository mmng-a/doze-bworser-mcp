import net from 'node:net';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BrowserManager } from './browser.mjs';
import { createMcp } from './tools.mjs';

const configPath = process.argv[2];
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const parentsPath = join(dirname(configPath), 'parents.json');
let savedParents = {};
try { savedParents = JSON.parse(readFileSync(parentsPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const manager = new BrowserManager(config, new Map(Object.entries(savedParents)));
const clients = new Map();
const sockets = new Set();
let closing = false;
let stopping = false;
let idle;
function saveParents() {
  const pending = parentsPath + '.new';
  writeFileSync(pending, JSON.stringify(Object.fromEntries(manager.parents)), { mode: 0o600 });
  renameSync(pending, parentsPath);
}
manager.saveParents = saveParents;
function idleExit() {
  clearTimeout(idle);
  if (!clients.size && !closing) idle = setTimeout(() => void stop(), 3000);
}
async function stop() {
  if (stopping) return;
  stopping = true;
  closing = true;
  clearTimeout(idle);
  server.close();
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    for (const client of clients.values()) client.abort.abort();
    await manager.closeWhere(() => true);
    for (const socket of sockets) socket.destroy();
    clearTimeout(deadline);
    process.exit(0);
  } catch (error) { console.error(error); process.exit(1); }
}
async function hook(payload) {
  const thread = payload.session_id;
  switch (payload.hook_event_name) {
    case 'SessionStart': manager.startThread(thread); break;
    case 'SubagentStart': manager.startThread(payload.agent_id, thread); break;
    case 'SessionEnd': await manager.endThread(thread); break;
    default: throw new Error('Unsupported lifecycle hook');
  }
}
function reply(socket, result) { socket.write(JSON.stringify({ ok: true, result }) + '\n'); }

const server = net.createServer(socket => {
  clearTimeout(idle);
  sockets.add(socket);
  socket.on('error', error => console.error('IPC connection:', error.message));
  socket.once('close', () => { sockets.delete(socket); idleExit(); });
  socket.setTimeout(3000, () => socket.destroy());
  let bytes = Buffer.alloc(0);
  let nonce;
  const greeting = chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 65536) { socket.destroy(); return; }
    const end = bytes.indexOf(10);
    if (end < 0) return;
    socket.pause();
    socket.removeListener('data', greeting);
    void (async () => {
      const request = JSON.parse(bytes.subarray(0, end));
      bytes = bytes.subarray(end + 1);
      const mac = role => createHmac('sha256', config.token).update(`${role}:${nonce}`).digest();
      if (nonce === undefined) {
        if (typeof request.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(request.nonce)) throw new Error('Invalid IPC nonce');
        nonce = request.nonce;
        socket.write(JSON.stringify({ proof: mac('server').toString('hex') }) + '\n');
        socket.on('data', greeting);
        if (bytes.length) { const remainder = bytes; bytes = Buffer.alloc(0); socket.unshift(remainder); }
        socket.resume();
        return;
      }
      const proof = Buffer.from(request.proof ?? '', 'hex');
      const expected = mac('client');
      if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) throw new Error('Unauthorized IPC connection');
      if (closing) throw Object.assign(new Error('Service is stopping; reconnect after it exits'), { code: 'stopping' });
      if (request.command === 'mcp') {
        clearTimeout(idle);
        socket.setTimeout(0);
        const connection = randomUUID();
        const abort = new AbortController();
        const mcp = createMcp(manager, { id: connection, signal: abort.signal });
        clients.set(connection, { abort, mcp });
        socket.once('close', () => {
          abort.abort();
          void (async () => {
            try { await mcp.close(); }
            finally { await manager.closeWhere(p => p.connection === connection); }
          })().catch(console.error).finally(() => { clients.delete(connection); idleExit(); });
        });
        reply(socket);
        await mcp.connect(new StdioServerTransport(socket, socket));
        if (bytes.length) socket.unshift(bytes);
        socket.resume();
      } else {
        if (request.command === 'status') reply(socket, { connections: clients.size, pages: manager.pages.size, browsers: manager.engines.size });
        else if (request.command === 'stop') {
          if (clients.size || manager.pages.size) throw new Error('Service is in use; close MCP connections before updating');
          closing = true;
          reply(socket, 'Stopping');
          socket.end();
          setImmediate(() => void stop());
          return;
        } else if (request.command === 'hook') { await hook(request.payload); reply(socket); }
        else throw new Error('Unknown IPC command');
        socket.end();
        idleExit();
      }
    })().catch(error => {
      socket.end(JSON.stringify({ ok: false, error: error.message, code: error.code }) + '\n');
      idleExit();
    });
  };
  socket.on('data', greeting);
});
server.on('error', error => { console.error(error); process.exit(1); });
server.listen(config.socket_path, () => {
  if (process.platform !== 'win32') chmodSync(config.socket_path, 0o600);
  idleExit();
});
const expiry = setInterval(() => { void manager.expireIdle().catch(console.error); }, 30_000);
expiry.unref();
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
