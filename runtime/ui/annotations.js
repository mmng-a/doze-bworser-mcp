const annotationElement = id => document.getElementById(id);
let annotationState;
let annotationDraft;
let annotationStart;
let annotationBusy = false;

async function annotationAction(action, args) {
  try {
    annotationElement('annotation-error').textContent = '';
    await window.doze.act(action, args);
    return true;
  } catch (error) {
    const message = error.message;
    annotationElement('annotation-error').textContent = /protected|reserved for the user/.test(message)
      ? 'パスワード入力中や、保護された表示への注釈はできません。'
      : /changed|no longer available|again/.test(message) ? 'ページが変わりました。場所を選び直してください。'
        : /visible element|Invalid annotation/.test(message) ? '画面内の要素か範囲を選択してください。'
          : '注釈の操作に失敗しました。もう一度お試しください。';
    return false;
  }
}
function selectionBox(rect) {
  const box = annotationElement('annotation-selection');
  box.hidden = !rect;
  if (rect) Object.assign(box.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
}
function areaBetween(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
function contentPoint(event) {
  return { x: Math.max(0, Math.min(innerWidth - 1, event.clientX)), y: Math.max(0, Math.min(innerHeight - 49, event.clientY - 48)) };
}
function positionAnnotationPanel() {
  const panel = annotationElement('annotation-panel');
  const draft = annotationState?.draft;
  if (!draft) { panel.style.left = ''; panel.style.top = ''; panel.style.right = ''; return; }
  const rect = Object.fromEntries(Object.entries(draft.rect).map(([key, value]) => [key, value * annotationState.zoom]));
  const margin = 12;
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const maxX = Math.max(margin, layer.clientWidth - width - margin);
  const maxY = Math.max(margin, layer.clientHeight - height - margin);
  let x = rect.x;
  let y = rect.y + rect.height + margin;
  if (y > maxY) y = rect.y - height - margin;
  if (y < margin) {
    x = rect.x + rect.width + margin;
    if (x > maxX) x = rect.x - width - margin;
    y = rect.y;
  }
  Object.assign(panel.style, { right: 'auto', left: Math.max(margin, Math.min(maxX, x)) + 'px', top: Math.max(margin, Math.min(maxY, y)) + 'px' });
}
annotationElement('annotate').onclick = () => annotationAction('annotation-toggle');
annotationElement('annotation-close').onclick = () => annotationAction('annotation-toggle');
annotationElement('annotation-cancel').onclick = () => annotationAction('annotation-cancel');
annotationElement('annotation-form').onsubmit = async event => {
  event.preventDefault();
  if (annotationBusy) return;
  annotationBusy = true;
  event.submitter.disabled = true;
  try { await annotationAction('annotation-save', { comment: annotationElement('annotation-comment').value }); }
  finally { event.submitter.disabled = false; annotationBusy = false; }
};
const layer = annotationElement('annotation-layer');
window.doze.saveAnnotation(() => {
  if (annotationState?.active && annotationState.draft && !annotationBusy) {
    const form = annotationElement('annotation-form');
    form.requestSubmit(form.querySelector('button[type="submit"]'));
  }
});
new ResizeObserver(positionAnnotationPanel).observe(annotationElement('annotation-panel'));
layer.addEventListener('wheel', event => { if (!event.target.closest('#annotation-panel')) event.preventDefault(); }, { passive: false });
layer.onpointerdown = event => {
  if (event.button !== 0 || annotationBusy || event.target.closest('#annotation-panel')) return;
  annotationStart = contentPoint(event);
  layer.setPointerCapture(event.pointerId);
  selectionBox(null);
};
layer.onpointermove = event => {
  if (annotationStart) selectionBox(areaBetween(annotationStart, contentPoint(event)));
};
layer.onpointercancel = () => { annotationStart = null; selectionBox(null); };
layer.onpointerup = async event => {
  if (!annotationStart) return;
  layer.releasePointerCapture(event.pointerId);
  const start = annotationStart;
  const rect = areaBetween(start, contentPoint(event));
  annotationStart = null;
  annotationBusy = true;
  const area = Math.hypot(rect.width, rect.height) >= 6;
  try {
    if (!await annotationAction('annotation-select', area ? { kind: 'area', ...rect } : { kind: 'element', ...start, width: 0, height: 0 })) selectionBox(null);
  } finally { annotationBusy = false; }
};
document.addEventListener('keydown', event => {
  if (!annotationState?.active || event.isComposing || event.key !== 'Escape') return;
  event.preventDefault();
  void annotationAction(annotationState.draft ? 'annotation-cancel' : 'annotation-toggle');
});
window.doze.subscribe(next => {
  const annotation = next.annotation;
  annotationState = annotation;
  const active = !!annotation?.active;
  document.documentElement.classList.toggle('annotating', active);
  annotationElement('annotate').disabled = !annotation?.available;
  annotationElement('annotate').setAttribute('aria-pressed', String(active));
  annotationElement('annotation-form').querySelector('button[type="submit"]').title = next.mac ? '⌘Enterで保存' : 'Ctrl+Enterで保存';
  layer.hidden = !active;
  if (!active) { annotationDraft = null; annotationStart = null; selectionBox(null); return; }
  const draft = annotation.draft;
  annotationElement('annotation-form').hidden = !draft;
  annotationElement('annotation-help').hidden = !!draft;
  annotationElement('annotation-list').hidden = !!draft;
  selectionBox(draft ? Object.fromEntries(Object.entries(draft.rect).map(([key, value]) => [key, value * annotation.zoom])) : null);
  if (draft && annotationDraft !== draft.id) {
    annotationElement('annotation-comment').value = '';
    annotationElement('annotation-comment').focus({ preventScroll: true });
  }
  annotationDraft = draft?.id;
  const list = annotationElement('annotation-list');
  const pins = annotationElement('annotation-pins');
  list.replaceChildren(); pins.replaceChildren();
  for (let index = 0; index < annotation.notes.length; index++) {
    const note = annotation.notes[index];
    const item = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×'; remove.title = '注釈を削除'; remove.setAttribute('aria-label', `${index + 1}番の注釈を削除`);
    remove.onclick = () => annotationAction('annotation-delete', { id: note.id });
    item.append(remove, document.createTextNode(note.comment));
    if (!note.current) { const previous = document.createElement('small'); previous.textContent = '（以前のページ）'; item.append(previous); }
    list.append(item);
    if (!note.current || note.viewport.width !== annotation.viewport?.width || note.viewport.height !== annotation.viewport?.height) continue;
    const pin = document.createElement('span'); pin.className = 'annotation-pin'; pin.textContent = String(index + 1);
    pin.style.left = ((note.rect.x + note.viewport.scrollX - annotation.viewport.scrollX) * annotation.zoom) + 'px';
    pin.style.top = ((note.rect.y + note.viewport.scrollY - annotation.viewport.scrollY) * annotation.zoom) + 'px';
    pins.append(pin);
  }
  positionAnnotationPanel();
});
