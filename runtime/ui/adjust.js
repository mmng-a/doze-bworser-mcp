const adjustmentGroups = [
  ['文字', [['text', 'テキスト', 'text'], ['font-family', 'フォント'], ['font-size', '文字サイズ', 'length'],
    ['font-weight', '太さ', ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900']],
    ['line-height', '行の高さ', 'length'], ['letter-spacing', '字間', 'length'], ['text-align', '揃え', ['start', 'left', 'center', 'right', 'justify', 'end']]]],
  ['色・形', [['color', '文字色', 'color'], ['background-color', '背景色', 'color'], ['opacity', '不透明度'], ['border-radius', '角丸', 'length']]],
  ['サイズ・余白', [['width', '幅', 'length'], ['height', '高さ', 'length'],
    ['padding-top', '内側・上', 'length'], ['padding-right', '内側・右', 'length'], ['padding-bottom', '内側・下', 'length'], ['padding-left', '内側・左', 'length'],
    ['margin-top', '外側・上', 'length'], ['margin-right', '外側・右', 'length'], ['margin-bottom', '外側・下', 'length'], ['margin-left', '外側・左', 'length'], ['gap', '間隔', 'length']]],
  ['配置', [['display', '表示', ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid']],
    ['flex-direction', '方向', ['row', 'column', 'row-reverse', 'column-reverse']],
    ['align-items', '交差軸', ['normal', 'stretch', 'start', 'end', 'center', 'baseline', 'flex-start', 'flex-end']],
    ['justify-content', '主軸', ['normal', 'start', 'end', 'center', 'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end']]]],
];
const adjustmentInputs = new Map();
const adjustmentDirty = new Map();
const adjustmentTimers = new Map();
const adjustmentErrors = new Set();
let adjustmentQueue = Promise.resolve();
let adjustmentRevision = 0;
let adjustmentPending = 0;
let adjustmentDraftId;
let adjustmentExpanded = false;

function hasDraftAdjustments(draft) { return !!draft?.adjustments && (Object.keys(draft.adjustments.styles || {}).length > 0 || !!draft.adjustments.text); }
function annotationSummary(note) {
  if (note.comment) return note.comment;
  const labels = adjustmentGroups.flatMap(([, fields]) => fields).filter(([key]) => key === 'text' ? note.adjustments?.text : note.adjustments?.styles?.[key]).map(([, label]) => label);
  return labels.length ? labels.slice(0, 2).join('・') + 'を調整' : '注釈';
}
function discardAdjustmentInputs() {
  adjustmentRevision++;
  for (const timer of adjustmentTimers.values()) clearTimeout(timer);
  adjustmentTimers.clear(); adjustmentDirty.clear(); adjustmentErrors.clear();
}
function adjustSaveState() {
  const form = document.getElementById('annotation-form');
  form.querySelector('[type="submit"]').disabled = adjustmentPending > 0;
  document.getElementById('annotation-comment').required = !hasDraftAdjustments(annotationState?.draft);
}
function enqueueAdjustment(property) {
  clearTimeout(adjustmentTimers.get(property)); adjustmentTimers.delete(property);
  const value = adjustmentDirty.get(property);
  const id = adjustmentDraftId;
  const revision = adjustmentRevision;
  adjustmentPending++;
  adjustSaveState();
  adjustmentQueue = adjustmentQueue.then(async () => {
    if (revision !== adjustmentRevision || annotationState?.draft?.id !== id) return;
    const ok = await annotationAction('annotation-adjust-change', { property, value });
    if (revision !== adjustmentRevision) return;
    if (ok) adjustmentErrors.delete(property); else adjustmentErrors.add(property);
    if (ok && adjustmentDirty.get(property) === value) adjustmentDirty.delete(property);
  }).finally(() => {
    adjustmentPending--;
    adjustSaveState();
  });
}
async function flushAdjustments() {
  for (const property of [...adjustmentTimers.keys()]) enqueueAdjustment(property);
  await adjustmentQueue;
  return adjustmentErrors.size === 0;
}
function renderAdjust(draft) {
  if (adjustmentDraftId !== draft?.id) {
    discardAdjustmentInputs(); adjustmentDraftId = draft?.id; adjustmentExpanded = false;
  }
  const button = document.getElementById('annotation-adjust');
  button.hidden = draft?.kind !== 'element';
  button.setAttribute('aria-expanded', String(adjustmentExpanded));
  document.getElementById('adjust-controls').hidden = !draft?.adjust || !adjustmentExpanded;
  for (const [key, input] of adjustmentInputs) {
    const value = key === 'text' ? draft?.adjust?.text : draft?.adjust?.values[key];
    input.closest('label').hidden = key === 'text' && value == null;
    if (value == null || adjustmentDirty.has(key) || document.activeElement === input) continue;
    if (input instanceof HTMLSelectElement && ![...input.options].some(option => option.value === value)) input.add(new Option(value, value));
    input.value = value;
    if (key === 'color' || key === 'background-color') input.style.borderLeftColor = CSS.supports('color', value) ? value : '';
  }
  adjustSaveState();
}
const adjustmentPanel = document.getElementById('adjust-controls');
for (const [title, fields] of adjustmentGroups) {
  const group = document.createElement('details'); group.open = title === '文字';
  const summary = document.createElement('summary'); summary.textContent = title; group.append(summary);
  const grid = document.createElement('div'); grid.className = 'adjust-grid';
  for (const [key, title, kind] of fields) {
    const label = document.createElement('label'); const caption = document.createElement('span'); caption.textContent = title;
    const input = document.createElement(Array.isArray(kind) ? 'select' : kind === 'text' ? 'textarea' : 'input');
    input.id = 'adjust-' + key; input.name = key;
    if (Array.isArray(kind)) for (const value of kind) input.add(new Option(value, value));
    else { input.maxLength = kind === 'text' ? 4000 : 200; if (kind === 'length') input.placeholder = 'px'; }
    if (kind === 'text' || key === 'font-family') label.className = 'adjust-wide';
    if (kind === 'color') input.className = 'adjust-color';
    input.oninput = () => {
      let value = input.value;
      if (kind === 'length' && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) value += 'px';
      adjustmentDirty.set(key, value);
      clearTimeout(adjustmentTimers.get(key));
      adjustmentTimers.set(key, setTimeout(() => enqueueAdjustment(key), 180));
    };
    input.onchange = () => { if (adjustmentDirty.has(key)) enqueueAdjustment(key); };
    label.append(caption, input); grid.append(label); adjustmentInputs.set(key, input);
  }
  group.append(grid); adjustmentPanel.append(group);
}
const adjustmentReset = document.createElement('button'); adjustmentReset.id = 'adjust-reset'; adjustmentReset.type = 'button'; adjustmentReset.textContent = '調整をリセット';
adjustmentReset.onclick = async () => { discardAdjustmentInputs(); await annotationAction('annotation-adjust-reset'); };
adjustmentPanel.append(adjustmentReset);
document.getElementById('annotation-adjust').onclick = async () => {
  if (!annotationState?.draft) return;
  if (!annotationState.draft.adjust && !await annotationAction('annotation-adjust-open')) return;
  adjustmentExpanded = !adjustmentExpanded;
  renderAdjust(annotationState.draft);
  positionAnnotationPanel();
};
