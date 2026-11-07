import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const targetCommands = new Set(['Target.getTargetInfo', 'Target.setAutoAttach', 'Target.attachToTarget',
  'Target.detachFromTarget', 'Target.activateTarget', 'Target.closeTarget']);

/** Give one DevTools window access to one page and its attached child targets. */
export class DevToolsBridge {
  constructor(record) {
    this.record = record;
    this.path = '/' + randomBytes(32).toString('hex');
    this.clients = new Set();
    this.sockets = new Set();
    this.server = createServer((_, response) => { response.writeHead(404); response.end(); });
    this.server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      socket.setTimeout(3000, () => socket.destroy());
      socket.on('error', () => {});
    });
    this.websockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    this.server.on('upgrade', (request, socket, head) => {
      if (this.closed || request.url !== this.path || request.headers.origin !== 'devtools://devtools') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.setTimeout(0);
      this.websockets.handleUpgrade(request, socket, head, client => this.connect(client));
    });
  }
  async listen(signal) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: '127.0.0.1', port: 0, signal }, resolve);
    });
    return '127.0.0.1:' + this.server.address().port + this.path;
  }
  connect(socket) {
    this.clients.add(socket);
    const sessions = new Map();
    const targets = new Map([[this.record.targetId, null]]);
    let root;
    let disposed = false;
    const send = value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const remove = id => {
      const item = sessions.get(id);
      if (!item) return;
      for (const [childId, child] of sessions) if (child.parent === id) remove(childId);
      item.session.off('*', item.event);
      item.session.off('sessionattached', item.attached);
      item.session.off('sessiondetached', item.detached);
      sessions.delete(id);
      if (item.targetId) targets.delete(item.targetId);
    };
    const attach = (session, externalId, parent) => {
      const attached = child => attach(child, child.id(), session.id());
      const detached = child => remove(child.id());
      const event = (method, params) => {
        if (typeof method !== 'string' || !method.includes('.')) return;
        if (method === 'Target.attachedToTarget') {
          targets.set(params.targetInfo.targetId, params.targetInfo);
          const child = sessions.get(params.sessionId);
          if (child) child.targetId = params.targetInfo.targetId;
        }
        send({ method, params, ...(externalId ? { sessionId: externalId } : {}) });
      };
      sessions.set(session.id(), { session, event, attached, detached, parent });
      session.on('sessionattached', attached);
      session.on('sessiondetached', detached);
      session.on('*', event);
    };
    const ready = this.record.page.createCDPSession().then(async session => {
      root = session;
      if (disposed) { void root.detach().catch(() => {}); return; }
      attach(root);
      const { targetInfo } = await root.send('Target.getTargetInfo');
      targets.set(targetInfo.targetId, targetInfo);
    });
    ready.catch(() => socket.close(1011, 'Page is unavailable'));
    socket.on('message', async (bytes, binary) => {
      let request;
      try {
        request = JSON.parse(bytes.toString());
        if (binary || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') throw new Error('Invalid DevTools command');
        await ready;
        if (disposed || this.closed || this.record.controller.closed) throw new Error('Page is closed');
        const method = request.method;
        const params = { ...(request.params ?? {}) };
        const session = request.sessionId ? sessions.get(request.sessionId)?.session : root;
        if (!session) throw new Error('Session is outside this view');
        if (method.startsWith('Browser.') && method !== 'Browser.getVersion') throw new Error('Browser-wide command is unavailable');
        if (method === 'Target.getTargets' || method === 'Target.setDiscoverTargets') {
          const result = method === 'Target.getTargets' ? { targetInfos: [...targets.values()].filter(Boolean) } : {};
          send({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
          return;
        }
        if (method.startsWith('Target.') && !targetCommands.has(method)) throw new Error('Target command is unavailable');
        if (params.targetId !== undefined && !targets.has(params.targetId)) throw new Error('Target is outside this view');
        if (method === 'Target.detachFromTarget' && params.sessionId !== undefined && !sessions.has(params.sessionId)) throw new Error('Session is outside this view');
        const context = this.record.group.context.id;
        if (params.browserContextId !== undefined && params.browserContextId !== context) throw new Error('Context is outside this view');
        if (['Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies'].includes(method)) {
          if (context) params.browserContextId = context;
          else delete params.browserContextId;
        }
        if (method.startsWith('Input.') || ['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'].includes(method)) {
          this.record.controller.lastUsed = Date.now();
        }
        const result = await session.send(method, params);
        send({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
      } catch {
        if (Number.isSafeInteger(request?.id)) send({ id: request.id, error: { code: -32000, message: 'DevTools command failed or is outside this view' },
          ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
        else socket.close(1008, 'Invalid DevTools command');
      }
    });
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.clients.delete(socket);
      for (const id of [...sessions.keys()]) remove(id);
      if (root && !root.detached) void root.detach().catch(() => {});
    };
    socket.on('error', dispose);
    socket.once('close', dispose);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.clients) socket.terminate();
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([
      new Promise(resolve => this.server.close(() => resolve())),
      new Promise(resolve => this.websockets.close(() => resolve())),
    ]);
  }
}

