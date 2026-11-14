const annotationElement = id => document.getElementById(id);
let annotationState;
let annotationDraft;
let annotationStart;
let annotationBusy = false;
let hoverTimer;
let hoverPoint;
let hoverSequence = 0;
let hoverTask = Promise.resolve();
let hoverBusy = false;
let annotationMenuTimer;

function showAnnotationMenu(show) {
  clearTimeout(annotationMenuTimer);
  const menu = annotationElement('annotation-menu');
  menu.hidden = !show || !annotationState?.active;
  annotationElement('annotate').setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) {
    clearAnnotationHover();
    const button = annotationElement('annotate').getBoundingClientRect();
    menu.style.left = Math.max(12, Math.min(innerWidth - menu.offsetWidth - 12, button.right - menu.offsetWidth)) + 'px';
  }
}
function hideAnnotationMenuSoon() {
  clearTimeout(annotationMenuTimer);
  annotationMenuTimer = setTimeout(() => showAnnotationMenu(false), 180);
}

function clearAnnotationHover() {
  hoverSequence++;
  clearTimeout(hoverTimer); hoverTimer = null; hoverPoint = null;
  annotationElement('annotation-hover').hidden = true;
}
function queueAnnotationHover(point) {
  hoverPoint = point;
  if (hoverTimer || hoverBusy) return;
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    const point = hoverPoint;
    const sequence = hoverSequence;
    if (!point || !annotationState?.active || annotationState.draft || annotationStart || annotationBusy) return;
    hoverBusy = true;
    hoverTask = window.doze.act('annotation-hover', point).then(result => {
      if (sequence !== hoverSequence || annotationState?.draft || !annotationState?.active) return;
      const box = annotationElement('annotation-hover');
      Object.assign(box.style, Object.fromEntries(Object.entries(result.rect).map(([key, value]) => [({x:'left',y:'top'})[key] || key, value * result.zoom + 'px'])));
      box.querySelector('span').textContent = result.tag;
      box.hidden = false;
    }).catch(() => { annotationElement('annotation-hover').hidden = true; }).finally(() => {
      hoverBusy = false;
      if (hoverPoint && hoverPoint !== point) queueAnnotationHover(hoverPoint);
    });
  }, 80);
}

async function annotationAction(action, args) {
  try {
    annotationElement('annotation-error').textContent = '';
    await window.doze.act(action, args);
    return true;
  } catch (error) {
    const message = error.message;
    annotationElement('annotation-error').textContent = /protected|reserved for the user/.test(message)
      ? 'パスワード入力中や、保護された表示への注釈はできません。'
      : /Invalid adjustment/.test(message) ? '調整する値の形式を確認してください。'
        : /Text adjustment/.test(message) ? 'この要素の文字は直接編集できません。'
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
annotationElement('annotate').onpointerenter = () => showAnnotationMenu(true);
annotationElement('annotate').onpointerleave = hideAnnotationMenuSoon;
annotationElement('annotate').onfocus = () => showAnnotationMenu(true);
annotationElement('annotate').onblur = hideAnnotationMenuSoon;
annotationElement('annotation-menu').onpointerenter = () => showAnnotationMenu(true);
annotationElement('annotation-menu').onpointerleave = hideAnnotationMenuSoon;
annotationElement('annotation-menu').onfocusin = () => showAnnotationMenu(true);
annotationElement('annotation-menu').onfocusout = hideAnnotationMenuSoon;
annotationElement('annotation-cancel').onclick = () => { discardAdjustmentInputs(); void annotationAction('annotation-cancel'); };
annotationElement('annotation-delete').onclick = () => annotationAction('annotation-delete', { id: annotationState?.draft?.editId });
annotationElement('annotation-form').onsubmit = async event => {
  event.preventDefault();
  if (annotationBusy) return;
  annotationBusy = true;
  event.submitter.disabled = true;
  try { if (await flushAdjustments()) await annotationAction('annotation-save', { comment: annotationElement('annotation-comment').value }); }
  finally { event.submitter.disabled = false; annotationBusy = false; }
};
const layer = annotationElement('annotation-layer');
window.doze.adjustError(message => { annotationElement('annotation-error').textContent = /protected|reserved for the user/.test(message) ? '保護された表示への調整はできません。' : '調整を元に戻せませんでした。ページの状態を確認してください。'; });
window.doze.saveAnnotation(async () => {
  if (annotationState?.active && annotationState.draft && !annotationBusy) {
    if (!await flushAdjustments()) return;
    const form = annotationElement('annotation-form');
    form.requestSubmit(form.querySelector('button[type="submit"]'));
  }
});
new ResizeObserver(positionAnnotationPanel).observe(annotationElement('annotation-panel'));
layer.addEventListener('wheel', event => { if (!event.target.closest('#annotation-panel, #annotation-menu')) event.preventDefault(); }, { passive: false });
layer.onpointerdown = event => {
  if (event.button !== 0 || annotationBusy || event.target.closest('#annotation-panel, #annotation-menu, .annotation-pin')) return;
  showAnnotationMenu(false);
  if (annotationState?.draft && (annotationElement('annotation-comment').value.trim() || hasDraftAdjustments(annotationState.draft) || adjustmentDirty.size)) { annotationElement('annotation-comment').focus(); return; }
  clearAnnotationHover();
  annotationStart = contentPoint(event);
  layer.setPointerCapture(event.pointerId);
  selectionBox(null);
};
layer.onpointermove = event => {
  if (annotationStart) selectionBox(areaBetween(annotationStart, contentPoint(event)));
  else if (!event.target.closest('#annotation-panel, #annotation-menu, .annotation-pin') && !annotationState?.draft) queueAnnotationHover(contentPoint(event));
  else clearAnnotationHover();
};
layer.onpointerleave = clearAnnotationHover;
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
    await hoverTask;
    if (!await annotationAction('annotation-select', area ? { kind: 'area', ...rect } : { kind: 'element', ...start, width: 0, height: 0 })) selectionBox(null);
  } finally { annotationBusy = false; }
};
document.addEventListener('keydown', event => {
  if (!annotationState?.active || event.isComposing || event.key !== 'Escape') return;
  event.preventDefault();
  if (annotationState.draft) discardAdjustmentInputs();
  void annotationAction(annotationState.draft ? 'annotation-cancel' : 'annotation-toggle');
});
window.doze.subscribe(next => {
  const annotation = next.annotation;
  annotationState = annotation;
  const active = !!annotation?.active;
  document.documentElement.classList.toggle('annotating', active);
  annotationElement('annotate').disabled = !annotation?.available;
  annotationElement('annotate').setAttribute('aria-pressed', String(active));
  annotationElement('annotation-status').hidden = !active;
  annotationElement('annotate').title = active ? '注釈を終了（ホバーで一覧）' : '注釈を付ける';
  annotationElement('annotation-panel').hidden = !annotation?.draft;
  renderAdjust(annotation?.draft);
  annotationElement('annotation-empty').hidden = !!annotation?.notes.length;
  annotationElement('annotation-form').querySelector('button[type="submit"]').title = next.mac ? '⌘Enterで保存' : 'Ctrl+Enterで保存';
  layer.hidden = !active;
  annotationElement('annotation-preview').hidden = true;
  if (!active) { showAnnotationMenu(false); annotationDraft = null; annotationStart = null; clearAnnotationHover(); selectionBox(null); return; }
  const draft = annotation.draft;
  if (draft) clearAnnotationHover();
  annotationElement('annotation-form').hidden = !draft;
  if (draft && annotationDraft !== draft.id) showAnnotationMenu(false);
  selectionBox(draft ? Object.fromEntries(Object.entries(draft.rect).map(([key, value]) => [key, value * annotation.zoom])) : null);
  if (draft && annotationDraft !== draft.id) {
    annotationElement('annotation-comment').value = draft.comment || '';
    annotationElement('annotation-comment').focus({ preventScroll: true });
  }
  annotationElement('annotation-target').textContent = draft?.target?.tag || '範囲';
  annotationElement('annotation-delete').hidden = !draft?.editId;
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
    const edit = () => {
      clearAnnotationHover();
      if (annotationState?.draft && (annotationElement('annotation-comment').value.trim() || hasDraftAdjustments(annotationState.draft) || adjustmentDirty.size)) { annotationElement('annotation-comment').focus(); return; }
      void annotationAction('annotation-edit', { id: note.id });
    };
    if (note.current) {
      const comment = document.createElement('button'); comment.type = 'button'; comment.className = 'annotation-note'; comment.textContent = annotationSummary(note); comment.title = '注釈を編集'; comment.onclick = edit;
      item.append(remove, comment);
    } else item.append(remove, document.createTextNode(annotationSummary(note)));
    if (!note.current) { const previous = document.createElement('small'); previous.textContent = '（以前のページ）'; item.append(previous); }
    list.append(item);
    if (!note.current || note.viewport.width !== annotation.viewport?.width || note.viewport.height !== annotation.viewport?.height) continue;
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'annotation-pin'; pin.textContent = String(index + 1); pin.setAttribute('aria-label', `${index + 1}番の注釈を編集`); pin.onclick = edit;
    pin.style.left = ((note.rect.x + note.viewport.scrollX - annotation.viewport.scrollX) * annotation.zoom) + 'px';
    pin.style.top = ((note.rect.y + note.viewport.scrollY - annotation.viewport.scrollY) * annotation.zoom) + 'px';
    pin.onpointerenter = () => {
      if (annotationState?.draft) return;
      clearAnnotationHover();
      const preview = annotationElement('annotation-preview'); preview.textContent = annotationSummary(note); preview.hidden = false;
      const x = parseFloat(pin.style.left) + 32;
      const y = parseFloat(pin.style.top);
      Object.assign(preview.style, { left: Math.max(12, Math.min(layer.clientWidth - preview.offsetWidth - 12, x)) + 'px', top: Math.max(12, Math.min(layer.clientHeight - preview.offsetHeight - 12, y)) + 'px' });
    };
    pin.onpointerleave = () => { annotationElement('annotation-preview').hidden = true; };
    pins.append(pin);
  }
  if (!annotationElement('annotation-menu').hidden || annotationElement('annotate').matches(':hover')) showAnnotationMenu(true);
  positionAnnotationPanel();
});
