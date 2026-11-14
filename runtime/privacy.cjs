/** URLs whose documents are reserved for the user, including extension and web sign-in pages. */
function isUserOnlyURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'chrome-extension:' || ['1password.com', '1password.eu', '1password.ca'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  } catch { return false; }
}
const privacyError = () => new Error('This page is protected for user input. No page content was returned.');

/** Inspect DOM structure inside Electron; only protection flags and node references leave this class. */
class PagePrivacy {
  constructor(contents) {
    this.contents = contents;
    this.sessions = new Map();
    this.known = new Map();
    this.sensitiveNodes = new Set();
    this.nodeDocuments = new Map();
    this.nodeBackends = new Map();
    this.observedPasswords = new Map();
    this.version = 0;
    contents.on('did-start-navigation', () => { this.version++; });
    contents.debugger.on('detach', () => { this.ready = null; this.sessions.clear(); this.version++; });
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      sessionId ||= undefined;
      if (method === 'Target.attachedToTarget') {
        this.sessions.set(params.sessionId, params.targetInfo);
        this.version++;
        void this.watch(params.sessionId).catch(() => {});
      } else if (method === 'Target.detachedFromTarget') {
        this.sessions.delete(params.sessionId); this.version++;
      } else if (method === 'Page.frameNavigated' || method === 'DOM.documentUpdated') this.version++;
      else if ((method === 'DOM.childNodeInserted' && this.observe(params.node, sessionId, this.nodeDocuments.get(`${sessionId}:${params.parentNodeId}`)))
        || (method === 'DOM.shadowRootPushed' && this.observe(params.root, sessionId, this.nodeDocuments.get(`${sessionId}:${params.hostId}`)))
        || (method === 'DOM.childNodeRemoved' && this.sensitiveNodes.has(`${sessionId}:${params.nodeId}`))
        || (method === 'DOM.attributeModified' && (['type', 'autocomplete', 'src'].includes(params.name) || this.sensitiveNodes.has(`${sessionId}:${params.nodeId}`)))) {
        // A disappearing overlay must still invalidate a capture already in flight.
        this.version++;
        if (method === 'DOM.attributeModified' && ((params.name === 'type' && params.value.toLowerCase() === 'password') || (params.name === 'autocomplete' && /(?:current|new)-password/i.test(params.value)))) {
          const key = `${sessionId}:${params.nodeId}`;
          this.remember(this.nodeDocuments.get(key), this.nodeBackends.get(key));
        }
      }
    });
  }
  remember(document, backendNodeId) {
    if (!document || !backendNodeId) return;
    if (!this.observedPasswords.has(document)) this.observedPasswords.set(document, new Set());
    this.observedPasswords.get(document).add(backendNodeId);
  }
  observe(node, sessionId, document, liveNodes) {
    if (node.nodeType === 9) document = `${sessionId}:${node.backendNodeId}`;
    this.nodeDocuments.set(`${sessionId}:${node.nodeId}`, document);
    this.nodeBackends.set(`${sessionId}:${node.nodeId}`, node.backendNodeId);
    liveNodes?.add(`${sessionId}:${node.nodeId}`);
    const attrs = new Map();
    for (let i = 0; i < (node.attributes?.length || 0); i += 2) attrs.set(node.attributes[i], node.attributes[i + 1]);
    const password = node.nodeName.toUpperCase() === 'INPUT' && ((attrs.get('type') || '').toLowerCase() === 'password'
      || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(attrs.get('autocomplete') || ''));
    if (password) this.remember(document, node.backendNodeId);
    let sensitive = password || isUserOnlyURL(attrs.get('src'));
    for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) sensitive = this.observe(child, sessionId, document, liveNodes) || sensitive;
    if (sensitive) this.sensitiveNodes.add(`${sessionId}:${node.nodeId}`);
    return sensitive;
  }
  send(method, params = {}, sessionId) { return this.contents.debugger.sendCommand(method, params, sessionId); }
  async watch(sessionId) {
    await this.send('Page.enable', {}, sessionId);
    await this.send('DOM.enable', {}, sessionId);
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] }, sessionId);
  }
  async start() {
    if (!this.ready) this.ready = (async () => {
      this.contents.debugger.attach('1.3');
      await this.watch();
    })();
    await this.ready;
  }
  async report() {
    if (isUserOnlyURL(this.contents.getURL())) throw privacyError();
    try {
      await this.start();
      const { frameTree } = await this.send('Page.getFrameTree');
      const frames = new Map();
      const visit = tree => { frames.set(tree.frame.id, tree.frame); for (const child of tree.childFrames || []) visit(child); };
      visit(frameTree);
      const documents = new Map();
      const liveDocuments = new Set();
      const liveNodes = new Set();
      const redact = [];
      this.sensitiveNodes.clear();
      let passwords = false;
      let entered = false;
      let privateFrames = false;
      const seen = new Set();
      for (const sessionId of [undefined, ...this.sessions.keys()]) {
        const target = this.sessions.get(sessionId);
        if (target && isUserOnlyURL(target.url)) { privateFrames = true; continue; }
        const targetTree = await this.send('Page.getFrameTree', {}, sessionId);
        visit(targetTree.frameTree);
        // Request the tree so subsequent mutations invalidate pending reads and captures.
        const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
        this.observe(root, sessionId, undefined, liveNodes);
        const snapshot = await this.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, sessionId);
        for (const document of snapshot.documents) {
          const frameId = snapshot.strings[document.frameId];
          seen.add(frameId);
          documents.set(frameId, sessionId);
          if (isUserOnlyURL(snapshot.strings[document.documentURL])) { privateFrames = true; continue; }
          const nodes = document.nodes;
          liveDocuments.add(`${sessionId}:${nodes.backendNodeId[0]}`);
          const observed = this.observedPasswords.get(`${sessionId}:${nodes.backendNodeId[0]}`);
          const loader = frames.get(frameId)?.loaderId;
          if (!loader) throw privacyError();
          let known = this.known.get(loader);
          if (!known) { known = new Set(); this.known.set(loader, known); }
          const present = new Set(nodes.backendNodeId);
          for (const node of known) if (!present.has(node)) known.delete(node);
          if (observed) for (const node of observed) if (!present.has(node)) observed.delete(node);
          const values = new Map((nodes.inputValue?.index || []).map((index, i) => [index, snapshot.strings[nodes.inputValue.value[i]]]));
          for (let i = 0; i < nodes.nodeName.length; i++) {
            const attrs = new Map();
            const attributes = nodes.attributes[i] || [];
            for (let j = 0; j < attributes.length; j += 2) attrs.set(snapshot.strings[attributes[j]], snapshot.strings[attributes[j + 1]]);
            const backendNodeId = nodes.backendNodeId[i];
            const type = (attrs.get('type') || '').toLowerCase();
            const autocomplete = (attrs.get('autocomplete') || '').toLowerCase().split(/\s+/);
            const password = snapshot.strings[nodes.nodeName[i]].toUpperCase() === 'INPUT' && (type === 'password' || autocomplete.some(value => ['current-password', 'new-password'].includes(value)) || known.has(backendNodeId) || observed?.has(backendNodeId));
            if (password) {
              known.add(backendNodeId);
              passwords = true;
              entered ||= !!values.get(i)?.length;
              redact.push({ loaderId: loader, backendNodeId, kind: 'password' });
            }
            if (isUserOnlyURL(attrs.get('src'))) {
              privateFrames = true;
              redact.push({ loaderId: loader, backendNodeId, kind: 'private' });
            }
          }
        }
      }
      for (const frame of frames.values()) {
        if (isUserOnlyURL(frame.url) || isUserOnlyURL(frame.securityOrigin)) {
          privateFrames = true;
          if (frame.parentId) {
            const { backendNodeId } = await this.send('DOM.getFrameOwner', { frameId: frame.id }, documents.get(frame.parentId));
            redact.push({ loaderId: frames.get(frame.parentId)?.loaderId, backendNodeId, kind: 'private' });
          }
        } else if (!seen.has(frame.id)) throw new Error('Privacy frame is not ready');
      }
      for (const loader of this.known.keys()) if (![...frames.values()].some(frame => frame.loaderId === loader)) this.known.delete(loader);
      for (const document of this.observedPasswords.keys()) if (!liveDocuments.has(document)) this.observedPasswords.delete(document);
      for (const node of this.nodeDocuments.keys()) if (!liveNodes.has(node)) { this.nodeDocuments.delete(node); this.nodeBackends.delete(node); }
      return { version: this.version, passwords, entered, privateFrames, redact,
        privateLoaders: [...frames.values()].filter(frame => isUserOnlyURL(frame.url) || isUserOnlyURL(frame.securityOrigin)).map(frame => frame.loaderId) };
    } catch (cause) { throw new Error(privacyError().message, { cause }); }
  }
}
module.exports = { isUserOnlyURL, privacyError, PagePrivacy };
