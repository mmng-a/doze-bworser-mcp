const { selectAnnotation, withNode } = require('./annotations.cjs');

const properties = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
  'color', 'background-color', 'opacity', 'width', 'height', 'border-radius',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'display', 'flex-direction', 'align-items', 'justify-content'];
const choices = {
  'text-align': ['left', 'center', 'right', 'justify', 'start', 'end'],
  display: ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'],
  'flex-direction': ['row', 'column', 'row-reverse', 'column-reverse'],
  'align-items': ['normal', 'stretch', 'start', 'end', 'center', 'baseline', 'flex-start', 'flex-end'],
  'justify-content': ['normal', 'start', 'end', 'center', 'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end'],
};
function validateChange(property, value) {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('Invalid adjustment value');
  if (property === 'text') return value;
  value = value.trim();
  if (!properties.includes(property) || !value || value.length > 200 || /[;{}\\]|url\s*\(|var\s*\(|env\s*\(/i.test(value)) throw new Error('Invalid adjustment value');
  let valid;
  if (choices[property]) valid = choices[property].includes(value);
  else if (property === 'font-family') valid = /^[\p{L}\p{N}\s,"'_-]+$/u.test(value);
  else if (property === 'font-weight') valid = /^(normal|bold|[1-9]\d{0,2}|1000)$/.test(value);
  else if (property === 'color' || property === 'background-color') valid = /^[\w#(),.%\s+/-]+$/.test(value);
  else if (property === 'opacity') valid = Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1;
  else if (['normal', 'auto'].includes(value)) valid = value === 'auto' ? ['width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'].includes(property) : ['line-height', 'letter-spacing', 'gap'].includes(property);
  else {
    valid = /^-?(?:\d+(?:\.\d+)?|\.\d+)(px|em|rem|%|vw|vh)?$/.test(value) && Math.abs(parseFloat(value)) <= 10000;
    if (!property.startsWith('margin-') && property !== 'letter-spacing' && parseFloat(value) < 0) valid = false;
  }
  if (!valid) throw new Error('Invalid adjustment value');
  return value;
}
const hasAdjustments = changes => !!changes && (Object.keys(changes.styles || {}).length > 0 || !!changes.text);
const gone = error => /no longer available|No node|Could not find|Cannot find context|Inspected target navigated/i.test(error.message);

/** Own temporary style previews and restore only properties changed through Adjust. */
class PageAdjustments {
  constructor(entry) { this.entry = entry; this.nodes = new Map(); this.sequence = 0; this.queue = Promise.resolve(); }
  run(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  current(draft) {
    const entry = this.entry;
    if (entry.document !== draft.document || !entry.view.annotating || entry.view.annotationDraft?.id !== draft.id) throw new Error('The page changed. Select the target again.');
  }
  nodeCall(node, fn, value) { return withNode(this.entry.privacy, node.frameId, node.backendNodeId, fn, value); }
  async inspect(node) {
    return this.nodeCall(node, function (properties) {
      if (!this.isConnected || !this.style) throw new Error();
      const computed = getComputedStyle(this);
      const styles = Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)]));
      const original = Object.fromEntries(properties.map(property => [property, { value: this.style.getPropertyValue(property), priority: this.style.getPropertyPriority(property) }]));
      let formContent = false;
      for (let node = this; node; node = node.getRootNode()?.host) {
        if (node.closest?.('input,textarea,select,option,[contenteditable]')) formContent = true;
      }
      const canText = !formContent && this.namespaceURI === 'http://www.w3.org/1999/xhtml' && !this.childElementCount && !this.isContentEditable
        && !this.matches('input,textarea,select,option,iframe,object,embed,script,style,link,meta,canvas,video,audio');
      const text = canText && this.textContent.length <= 4000 ? this.textContent : null;
      return { styles, original, text };
    }, properties);
  }
  begin(draft) { return this.run(async () => {
    this.current(draft);
    await selectAnnotation(this.entry, draft, true);
    const key = `${draft.document}:${draft.frameId}:${draft.backendNodeId}`;
    const snapshot = await this.inspect(draft);
    await selectAnnotation(this.entry, draft, true);
    this.current(draft);
    let node = this.nodes.get(key);
    if (!node) { node = { document: draft.document, frameId: draft.frameId, backendNodeId: draft.backendNodeId, key, original: snapshot.original, text: snapshot.text, touched: [], last: {} }; this.nodes.set(key, node); }
    const changes = structuredClone(draft.adjustments || { styles: {} });
    this.draft = { id: draft.id, node, selection: draft, before: snapshot, initialChanges: structuredClone(changes), changes };
    await this.render(node);
    return { values: { ...snapshot.styles, ...Object.fromEntries(Object.entries(changes.styles).map(([key, change]) => [key, change.after])) },
      text: changes.text?.after ?? snapshot.text, changes };
  }); }
  update(draft, property, value) { return this.run(async () => {
    this.current(draft);
    const tx = this.draft;
    if (!tx || tx.id !== draft.id) throw new Error('Select the adjustment target again.');
    value = validateChange(property, value);
    const selected = await selectAnnotation(this.entry, draft, true);
    this.current(draft);
    const previous = structuredClone(tx.changes);
    if (property === 'text') {
      if (tx.before.text === null) throw new Error('Text adjustment is unavailable for this element');
      const before = tx.initialChanges.text?.before ?? tx.before.text;
      if (value === before) delete tx.changes.text;
      else tx.changes.text = { before, after: value };
    } else {
      const valid = await this.nodeCall(tx.node, function ({ property, value }) { return CSS.supports(property, value); }, { property, value });
      if (!valid) throw new Error('Invalid adjustment value');
      const before = tx.initialChanges.styles?.[property]?.before ?? tx.before.styles[property];
      if (value === before) delete tx.changes.styles[property];
      else tx.changes.styles[property] = { before, after: value };
      if (!tx.node.touched.includes(property)) tx.node.touched.push(property);
    }
    try {
      await this.render(tx.node);
      this.current(draft);
      Object.assign(selected, await selectAnnotation(this.entry, draft, true));
      this.current(draft);
    } catch (error) { tx.changes = previous; await this.render(tx.node); throw error; }
    return { ...selected, adjustments: structuredClone(tx.changes) };
  }); }
  reset(draft) { return this.run(async () => {
    this.current(draft);
    const tx = this.draft;
    if (!tx || tx.id !== draft.id) throw new Error('Select the adjustment target again.');
    await selectAnnotation(this.entry, draft, true);
    this.current(draft);
    tx.changes = { styles: {} };
    await this.render(tx.node);
    const snapshot = await this.inspect(tx.node);
    await selectAnnotation(this.entry, draft, true);
    this.current(draft);
    return { values: snapshot.styles, text: snapshot.text, changes: structuredClone(tx.changes) };
  }); }
  cancel() { return this.run(async () => {
    const tx = this.draft; this.draft = null;
    if (tx) await this.render(tx.node);
  }); }
  commit(draft) { return this.run(async () => {
    this.current(draft);
    const tx = this.draft;
    if (!tx || tx.id !== draft.id) return {};
    return { adjustments: structuredClone(tx.changes), adjustmentKey: tx.node.key, adjustmentOrder: ++this.sequence };
  }); }
  saved() { this.draft = null; }
  remove(note) { return this.run(async () => {
    const node = this.nodes.get(note.adjustmentKey);
    if (this.draft?.selection.editId === note.id) this.draft = null;
    if (node) await this.render(node, note.id);
  }); }
  async render(node, excluded) {
    if (node.document !== this.entry.document || this.entry.content.webContents.isDestroyed()) { this.nodes.delete(node.key); return; }
    const tx = this.draft?.node === node ? this.draft : null;
    const layers = this.entry.annotations.filter(note => note.adjustmentKey === node.key && note.id !== excluded && note.id !== tx?.selection.editId)
      .sort((a, b) => a.adjustmentOrder - b.adjustmentOrder).map(note => note.adjustments);
    if (tx) layers.push(tx.changes);
    const styles = Object.assign({}, ...layers.map(layer => Object.fromEntries(Object.entries(layer.styles).map(([key, change]) => [key, change.after]))));
    const text = layers.filter(layer => layer.text).at(-1)?.text?.after;
    try {
      const result = await this.nodeCall(node, function (data) {
        if (!this.isConnected) return { gone: true };
        if (!this.style) throw new Error();
        if (data.text !== undefined || data.lastText !== undefined) {
          if (this.childElementCount || this.isContentEditable || this.matches('input,textarea,select,option,iframe,script,style')) throw new Error();
          for (let node = this; node; node = node.getRootNode()?.host) {
            if (node.closest?.('input,textarea,select,option,[contenteditable]')) throw new Error();
          }
        }
        const original = data.original;
        const last = {};
        for (const property of data.touched) {
          const current = { value: this.style.getPropertyValue(property), priority: this.style.getPropertyPriority(property) };
          const previous = data.last[property];
          const expected = previous || original[property];
          if (current.value !== expected.value || current.priority !== expected.priority) original[property] = current;
          if (property in data.styles) this.style.setProperty(property, data.styles[property], 'important');
          else if (original[property].value) this.style.setProperty(property, original[property].value, original[property].priority);
          else this.style.removeProperty(property);
          last[property] = { value: this.style.getPropertyValue(property), priority: this.style.getPropertyPriority(property) };
        }
        if (data.text !== undefined || data.lastText !== undefined) {
          if (data.lastText !== undefined && this.textContent !== data.lastText) data.originalText = this.textContent;
          this.textContent = data.text ?? data.originalText;
        }
        return { original, last, originalText: data.originalText, lastText: data.text };
      }, { original: node.original, touched: node.touched, last: node.last, styles, originalText: node.text, lastText: node.lastText, text });
      if (result.gone) { this.nodes.delete(node.key); return; }
      Object.assign(node, { original: result.original, last: result.last, text: result.originalText, lastText: result.lastText });
    } catch (error) { if (!gone(error)) throw error; this.nodes.delete(node.key); }
  }
}
module.exports = { PageAdjustments, hasAdjustments };
