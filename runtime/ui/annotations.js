const annotationElement = id => document.getElementById(id);
const pagePointerButtons = ['left', 'middle', 'right', 'back', 'forward'];
let annotationState;
let annotationMac;
let annotationDraft;
let annotationStart;
let pagePointer;
let annotationBusy = false;
let hoverTimer;
let hoverPoint;
let hoverSequence = 0;
let hoverTask = Promise.resolve();
let hoverBusy = false;
let annotationPanelAnchor;
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
    if (action !== 'annotation-page-pointer') annotationElement('annotation-error').textContent = '';
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
  if (!rect) { box.hidden = true; return; }
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(layer.clientWidth, rect.x + rect.width) - x;
  const height = Math.min(layer.clientHeight, rect.y + rect.height) - y;
  box.hidden = width < 0 || height < 0;
  if (!box.hidden) Object.assign(box.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
}
function areaBetween(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
function contentPoint(event) {
  const { x, y } = pagePoint(event);
  return { x: Math.max(0, Math.min(innerWidth - 1, x)), y: Math.max(0, Math.min(innerHeight - 49, y)) };
}
function pagePoint(event) {
  return { x: event.clientX, y: event.clientY - 48 };
}
function overAnnotationControls(event) {
  return event.target.closest('#annotation-panel, #annotation-menu');
}
function wantsPagePointer(event) {
  return (annotationMac ? event.metaKey : event.ctrlKey) && !overAnnotationControls(event);
}
function forwardPagePointer(type, event, extra = {}) {
  // The mode modifier belongs to the annotation UI, not the page.
  const modifiers = (event.altKey ? 1 : 0) | (annotationMac && event.ctrlKey ? 2 : 0) |
    (!annotationMac && event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  void annotationAction('annotation-page-pointer', {
    type, ...pagePoint(event), modifiers, buttons: event.buttons, ...extra, token: annotationState.token,
  });
}
function viewportRect(rect, viewport) {
  const current = annotationState.viewport || viewport;
  return Object.fromEntries(Object.entries({
    ...rect, x: rect.x + viewport.scrollX - current.scrollX, y: rect.y + viewport.scrollY - current.scrollY,
  }).map(([key, value]) => [key, value * annotationState.zoom]));
}
function positionAnnotationPanel() {
  const panel = annotationElement('annotation-panel');
  const draft = annotationState?.draft;
  if (!draft) { annotationPanelAnchor = null; panel.style.left = ''; panel.style.top = ''; panel.style.right = ''; return; }
  if (annotationPanelAnchor?.id === draft.id) {
    Object.assign(panel.style, { right:'auto', left:annotationPanelAnchor.x+'px', top:annotationPanelAnchor.y+'px' }); return;
  }
  const rect = Object.fromEntries(Object.entries(draft.rect).map(([key, value]) => [key, value * annotationState.zoom]));
  const margin = 12;
  const width = panel.offsetWidth;
  const controls = getComputedStyle(annotationElement('adjust-controls'));
  const reserved = draft.kind === 'element' ? parseFloat(controls.maxHeight) + parseFloat(controls.marginTop) + parseFloat(controls.borderTopWidth) : 0;
  const height = Math.min(layer.clientHeight - 2 * margin, panel.offsetHeight + reserved);
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
  annotationPanelAnchor = { id:draft.id, x:Math.max(margin,Math.min(maxX,x)), y:Math.max(margin,Math.min(maxY,y)) };
  Object.assign(panel.style, { right: 'auto', left: annotationPanelAnchor.x + 'px', top: annotationPanelAnchor.y + 'px' });
}
annotationElement('annotate').onclick = () => annotationAction('annotation-toggle');
window.doze.toggleAnnotation(() => annotationAction('annotation-toggle'));
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
layer.addEventListener('wheel', event => {
  if (overAnnotationControls(event)) return;
  event.preventDefault();
  if (annotationStart || !wantsPagePointer(event)) return;
  clearAnnotationHover();
  forwardPagePointer('mouseWheel', event, { deltaX: event.deltaX, deltaY: event.deltaY });
}, { passive: false });
layer.onmousedown = event => {
  if (pagePointer === undefined) return;
  event.preventDefault();
  forwardPagePointer('mousePressed', event, { button: pagePointerButtons[event.button], clickCount: event.detail });
};
layer.onmouseup = event => {
  if (pagePointer === undefined) return;
  forwardPagePointer('mouseReleased', event, { button: pagePointerButtons[event.button], clickCount: event.detail });
  if (!event.buttons) pagePointer = undefined;
};
layer.oncontextmenu = event => { if (wantsPagePointer(event)) event.preventDefault(); };
layer.onpointerdown = event => {
  if (event.pointerType === 'mouse' && !annotationStart && wantsPagePointer(event)) {
    pagePointer = event.pointerId;
    layer.setPointerCapture(event.pointerId);
    layer.classList.add('page-pointer');
    showAnnotationMenu(false);
    clearAnnotationHover();
    annotationElement('annotation-preview').hidden = true;
    return;
  }
  layer.classList.remove('page-pointer');
  if (event.button !== 0 || annotationBusy || event.target.closest('#annotation-panel, #annotation-menu, .annotation-pin')) return;
  showAnnotationMenu(false);
  if (annotationState?.draft && (annotationElement('annotation-comment').value.trim() || hasDraftAdjustments(annotationState.draft) || adjustmentDirty.size)) { annotationElement('annotation-comment').focus(); return; }
  clearAnnotationHover();
  annotationStart = contentPoint(event);
  layer.setPointerCapture(event.pointerId);
  selectionBox(null);
};
layer.onpointermove = event => {
  const passThrough = pagePointer === event.pointerId ||
    (event.pointerType === 'mouse' && !event.buttons && !annotationStart && wantsPagePointer(event));
  layer.classList.toggle('page-pointer', passThrough);
  if (passThrough) {
    clearAnnotationHover();
    forwardPagePointer('mouseMoved', event);
  } else if (annotationStart) selectionBox(areaBetween(annotationStart, contentPoint(event)));
  else if (!event.target.closest('#annotation-panel, #annotation-menu, .annotation-pin') && !annotationState?.draft) queueAnnotationHover(contentPoint(event));
  else clearAnnotationHover();
};
layer.onpointerleave = () => { layer.classList.remove('page-pointer'); clearAnnotationHover(); };
layer.onpointercancel = () => { pagePointer = undefined; annotationStart = null; selectionBox(null); };
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
  annotationMac = next.mac;
  const active = !!annotation?.active;
  document.documentElement.classList.toggle('annotating', active);
  annotationElement('annotate').disabled = !annotation?.available;
  annotationElement('annotate').setAttribute('aria-pressed', String(active));
  annotationElement('annotation-status').hidden = !active;
  const shortcut = next.mac ? '⌃⌘A' : 'Ctrl+Alt+A';
  annotationElement('annotate').title = active ? `注釈を終了（${shortcut}、ホバーで一覧）` : `注釈を付ける（${shortcut}）`;
  annotationElement('annotation-panel').hidden = !annotation?.draft;
  renderAdjust(annotation?.draft);
  annotationElement('annotation-empty').hidden = !!annotation?.notes.length;
  annotationElement('annotation-form').querySelector('button[type="submit"]').title = next.mac ? '⌘Enterで保存' : 'Ctrl+Enterで保存';
  layer.hidden = !active;
  annotationElement('annotation-preview').hidden = true;
  if (!active) {
    showAnnotationMenu(false); annotationDraft = null; annotationStart = null; pagePointer = undefined;
    layer.classList.remove('page-pointer'); clearAnnotationHover(); selectionBox(null); return;
  }
  const draft = annotation.draft;
  if (draft) clearAnnotationHover();
  annotationElement('annotation-form').hidden = !draft;
  if (draft && annotationDraft !== draft.id) showAnnotationMenu(false);
  if (!annotationStart) selectionBox(draft ? viewportRect(draft.rect, draft.viewport) : null);
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
    const { x, y } = viewportRect(note.rect, note.viewport);
    pin.style.left = x + 'px';
    pin.style.top = y + 'px';
    pin.onpointerenter = event => {
      if (annotationState?.draft || wantsPagePointer(event)) return;
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
