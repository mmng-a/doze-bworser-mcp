const { randomUUID } = require('node:crypto');
const { PagePrivacy, isUserOnlyURL, privacyError } = require('./privacy.cjs');

async function withNode(privacy, frameId, backendNodeId, fn) {
  const frame = privacy.frames.get(frameId);
  if (!frame) throw new Error('The selected element is no longer available');
  const session = privacy.documentSessions.get(frame.loaderId);
  const { object } = await privacy.send('DOM.resolveNode', { backendNodeId }, session);
  if (!object.objectId) throw new Error('The selected element is no longer available');
  try {
    const result = await privacy.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn.toString(), returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error('The selected element is no longer available');
    return result.result.value;
  } finally { await privacy.send('Runtime.releaseObject', { objectId: object.objectId }, session); }
}
async function bounds(privacy, frameId, backendNodeId) {
  const rect = await withNode(privacy, frameId, backendNodeId, function () {
    if (!this.isConnected || !this.getBoundingClientRect) throw new Error();
    const r = this.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  let frame = privacy.frames.get(frameId);
  while (frame.parentId) {
    const parent = privacy.frames.get(frame.parentId);
    if (!parent) throw new Error('The selected frame is no longer available');
    const { backendNodeId: owner } = await privacy.send('DOM.getFrameOwner', { frameId: frame.id }, privacy.documentSessions.get(parent.loaderId));
    const offset = await withNode(privacy, parent.id, owner, function () {
      const r = this.getBoundingClientRect();
      return { x: r.x + this.clientLeft, y: r.y + this.clientTop };
    });
    rect.x += offset.x; rect.y += offset.y;
    frame = parent;
  }
  return rect;
}
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Resolve a user selection without reading text, HTML, attributes containing values, or screenshots. */
async function selectAnnotation(entry, selection) {
  const wc = entry.content.webContents;
  if (entry.userOnly || isUserOnlyURL(wc.getURL()) || entry.dialog) throw privacyError();
  const privacy = entry.privacy ||= new PagePrivacy(wc);
  const before = await privacy.report();
  if (before.entered) throw privacyError();
  const zoom = wc.getZoomFactor();
  const { cssLayoutViewport: viewport } = await privacy.send('Page.getLayoutMetrics');
  const limit = { width: viewport.clientWidth, height: viewport.clientHeight };
  let rect = selection.backendNodeId ? null : { x: selection.x / zoom, y: selection.y / zoom, width: selection.width / zoom, height: selection.height / zoom };
  if (rect && (!Object.values(rect).every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.x >= limit.width || rect.y >= limit.height || rect.width < 0 || rect.height < 0)) throw new Error('Invalid annotation selection');
  let target;
  let frameId = selection.frameId;
  let backendNodeId = selection.backendNodeId;
  if (selection.kind === 'element') {
    if (!backendNodeId) ({ backendNodeId, frameId } = await privacy.send('DOM.getNodeForLocation', { x: Math.floor(rect.x), y: Math.floor(rect.y), includeUserAgentShadowDOM: true }));
    const frame = privacy.frames.get(frameId);
    if (!frame || isUserOnlyURL(frame.url) || isUserOnlyURL(frame.securityOrigin)
      || before.redact.some(node => node.loaderId === frame.loaderId && node.backendNodeId === backendNodeId)) throw privacyError();
    rect = await bounds(privacy, frameId, backendNodeId);
    target = await withNode(privacy, frameId, backendNodeId, function () {
      const parts = [];
      for (let node = this; node?.localName && parts.length < 5; node = node.parentElement) {
        if (node.id) { parts.unshift(node.localName + '#' + CSS.escape(node.id)); break; }
        const siblings = node.parentElement ? [...node.parentElement.children].filter(item => item.localName === node.localName) : [];
        parts.unshift(node.localName + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : ''));
      }
      return { tag: this.localName, selector: parts.join(' > ') };
    });
  } else if (selection.kind !== 'area') throw new Error('Unknown annotation selection');
  rect = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(rect.x + rect.width, limit.width) - Math.max(0, rect.x), height: Math.min(rect.y + rect.height, limit.height) - Math.max(0, rect.y) };
  if (rect.width < 1 || rect.height < 1) throw new Error('Select a visible element or area');
  for (const node of before.redact) {
    const frame = [...privacy.frames.values()].find(frame => frame.loaderId === node.loaderId);
    if (!frame) throw privacyError();
    const protectedRect = await bounds(privacy, frame.id, node.backendNodeId);
    if (overlaps(rect, protectedRect)) throw privacyError();
  }
  const after = await privacy.report();
  if (entry.userOnly || after.entered || after.version !== before.version) throw new Error('The page changed. Select the annotation target again.');
  return { id: randomUUID(), kind: selection.kind, rect, target, frameId, backendNodeId,
    document: entry.document, url: wc.getURL(), viewport: { width: limit.width, height: limit.height, scrollX: viewport.pageX, scrollY: viewport.pageY }, zoom };
}
function publicAnnotation(note, entry) {
  const { frameId, backendNodeId, document, zoom, editId, ...result } = note;
  return { ...result, current: document === entry.document && note.url === entry.content.webContents.getURL() };
}
module.exports = { selectAnnotation, publicAnnotation };
