const adjustmentGroups = [
  ['文字', [['text', 'テキスト', 'text'], ['color', '文字色', 'color'], ['font-family', 'フォント'], ['font-size', '文字サイズ', 'length'],
    ['font-weight', '太さ', ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900']],
    ['line-height', '行の高さ', 'length'], ['letter-spacing', '字間', 'length'], ['text-align', '揃え', ['start', 'left', 'center', 'right', 'justify', 'end']]]],
  ['色・形', [['background-color', '背景色', 'color'], ['opacity', '不透明度'], ['border-radius', '角丸', 'length']]],
  ['余白', [
    ['padding-top', '内側・上', 'length'], ['padding-right', '内側・右', 'length'], ['padding-bottom', '内側・下', 'length'], ['padding-left', '内側・左', 'length'],
    ['margin-top', '外側・上', 'length'], ['margin-right', '外側・右', 'length'], ['margin-bottom', '外側・下', 'length'], ['margin-left', '外側・左', 'length'], ['gap', '間隔', 'length']]],
  ['サイズ', [['width', '幅', 'length'], ['height', '高さ', 'length']]],
  ['配置', [['display', '表示', ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid']],
    ['flex-direction', '方向', ['row', 'column', 'row-reverse', 'column-reverse']],
    ['align-items', '交差軸', ['normal', 'stretch', 'start', 'end', 'center', 'baseline', 'flex-start', 'flex-end']],
    ['justify-content', '主軸', ['normal', 'start', 'end', 'center', 'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end']]]],
];
const adjustmentInputs = new Map();
const adjustmentDirty = new Map();
const adjustmentTimers = new Map();
const adjustmentErrors = new Set();
const adjustmentWidgets = new Map();
const adjustmentQueued = new Set();
let adjustmentQueue = Promise.resolve();
let adjustmentRevision = 0;
let adjustmentPending = 0;
let adjustmentDraftId;
let adjustmentExpanded = false;
let adjustmentScrub;
const adjustmentScrubHelp = '左右にドラッグして調整（Shiftで大きく、Alt/Optionで細かく）';

function setAdjustmentInput(input, value) {
  input.value = value;
  adjustmentWidgets.get(input.name)?.(value);
  input.dispatchEvent(new Event('input', {bubbles:true}));
  input.dispatchEvent(new Event('change', {bubbles:true}));
}
function stopAdjustmentScrub(revert = false) {
  const scrub = adjustmentScrub; adjustmentScrub = null;
  document.documentElement.classList.remove('adjust-scrubbing');
  if (!scrub) return;
  if (scrub.handle.hasPointerCapture(scrub.pointer)) scrub.handle.releasePointerCapture(scrub.pointer);
  if (revert && scrub.moved && annotationState?.draft?.id === scrub.draft) setAdjustmentInput(scrub.input, scrub.original);
}
function makeAdjustmentScrubbable(input, caption, key) {
  const start = event => {
    if (event.button !== 0 || (event.currentTarget === input && document.activeElement === input)) return;
    const original = adjustmentDirty.get(key) ?? annotationState?.draft?.adjust?.values[key];
    const match = original?.match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|em|rem|%|vw|vh)?$/);
    if (!match) return;
    adjustmentScrub = {input, handle:event.currentTarget, pointer:event.pointerId, x:event.clientX, original, value:Number(match[1]), unit:match[2]||'', draft:annotationState.draft.id, moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = event => {
    const scrub = adjustmentScrub;
    if (!scrub || scrub.handle !== event.currentTarget) return;
    const delta = event.clientX - scrub.x;
    if (!scrub.moved && Math.abs(delta) < 3) return;
    scrub.moved = true; event.preventDefault(); input.blur();
    document.documentElement.classList.add('adjust-scrubbing');
    const step = key === 'opacity' || ['em','rem'].includes(scrub.unit) ? .01 : 1;
    let value = scrub.value + delta * step * (event.shiftKey ? 10 : event.altKey ? .1 : 1);
    const minimum = key.startsWith('margin-') || key === 'letter-spacing' ? -10000 : 0;
    value = Math.max(minimum, Math.min(key === 'opacity' ? 1 : 10000, value));
    setAdjustmentInput(input, String(Math.round(value * 10000) / 10000) + scrub.unit);
  };
  for (const handle of [input,caption]) {
    handle.onpointerdown=start; handle.onpointermove=move;
    handle.onpointerup=()=>stopAdjustmentScrub();
    handle.onpointercancel=()=>stopAdjustmentScrub(true);
    handle.addEventListener('click',event=>{if(handle.dataset.scrubbed){delete handle.dataset.scrubbed;event.preventDefault();event.stopPropagation();}},true);
    handle.addEventListener('pointerup',()=>{if(adjustmentScrub?.moved)handle.dataset.scrubbed='true';},true);
  }
  caption.classList.add('adjust-scrub-label');
  input.dataset.scrub='true'; input.title=adjustmentScrubHelp;
}
document.addEventListener('keydown',event=>{
  if (event.key==='Escape' && adjustmentScrub) {event.preventDefault();event.stopImmediatePropagation();stopAdjustmentScrub(true);}
},true);

function hasDraftAdjustments(draft) { return !!draft?.adjustments && (Object.keys(draft.adjustments.styles || {}).length > 0 || !!draft.adjustments.text); }
function annotationSummary(note) {
  if (note.comment) return note.comment;
  const labels = adjustmentGroups.flatMap(([, fields]) => fields).filter(([key]) => key === 'text' ? note.adjustments?.text : note.adjustments?.styles?.[key]).map(([, label]) => label);
  return labels.length ? labels.slice(0, 2).join('・') + 'を調整' : '注釈';
}
function discardAdjustmentInputs() {
  stopAdjustmentScrub();
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
  const queueKey = revision + ':' + property;
  if (adjustmentQueued.has(queueKey)) return;
  adjustmentQueued.add(queueKey);
  adjustmentPending++;
  adjustSaveState();
  adjustmentQueue = adjustmentQueue.then(async () => {
    if (revision !== adjustmentRevision || annotationState?.draft?.id !== id) return;
    const ok = await annotationAction('annotation-adjust-change', { property, value });
    if (revision !== adjustmentRevision) return;
    if (ok) adjustmentErrors.delete(property); else adjustmentErrors.add(property);
    if (ok && adjustmentDirty.get(property) === value) adjustmentDirty.delete(property);
  }).finally(() => {
    adjustmentQueued.delete(queueKey);
    adjustmentPending--;
    adjustSaveState();
    if (revision === adjustmentRevision && annotationState?.draft?.id === id && adjustmentDirty.has(property) && adjustmentDirty.get(property) !== value) enqueueAdjustment(property);
  });
}
async function flushAdjustments() {
  for (const property of [...adjustmentTimers.keys()]) enqueueAdjustment(property);
  for (;;) { const queue = adjustmentQueue; await queue; if (queue === adjustmentQueue) break; }
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
  const display = adjustmentDirty.get('display') ?? draft?.adjust?.values.display ?? '';
  const flex = display.includes('flex');
  const layout = flex || display.includes('grid');
  const vertical = flex && (adjustmentDirty.get('flex-direction') ?? draft?.adjust?.values['flex-direction'] ?? '').startsWith('column');
  for (const [key, input] of adjustmentInputs) {
    const value = key === 'text' ? draft?.adjust?.text : draft?.adjust?.values[key];
    if (input.dataset.scrub) {
      input.dataset.scrubbable = String(/^-?[\d.]+(?:px|em|rem|%|vw|vh)?$/.test(value));
      input.title = value == null ? '' : value + (input.dataset.scrubbable === 'true' ? '\n' + adjustmentScrubHelp : '');
    }
    input.closest('label').hidden = (key === 'text' && value == null) || (key === 'flex-direction' && !flex) || (['align-items','justify-content','gap'].includes(key) && !layout);
    if (value != null) adjustmentWidgets.get(key)?.(adjustmentDirty.get(key) ?? value);
    if (key === 'align-items' || key === 'justify-content') for (const icon of input.closest('label').querySelectorAll('svg')) icon.style.transform = vertical ? 'rotate(90deg)' : '';
    if (value == null || adjustmentDirty.has(key) || document.activeElement === input) continue;
    if (input instanceof HTMLSelectElement && ![...input.options].some(option => option.value === value)) input.add(new Option(value, value));
    input.value = input.closest('.box-model-margin') && /^-?[\d.]+px$/.test(value) ? String(Math.round(parseFloat(value) * 100) / 100) : value;
  }
  adjustSaveState();
}
const adjustmentPanel = document.getElementById('adjust-controls');
const choiceLabels = {
  normal:'標準', bold:'太字', left:'左揃え', center:'中央', right:'右揃え', justify:'両端揃え', start:'開始位置', end:'終了位置',
  block:'ブロック', inline:'インライン', 'inline-block':'インラインブロック', flex:'横並び', 'inline-flex':'インラインの横並び', grid:'グリッド', 'inline-grid':'インラインのグリッド',
  row:'横方向', column:'縦方向', 'row-reverse':'横方向を反転', 'column-reverse':'縦方向を反転',
  stretch:'引き伸ばす', baseline:'文字の基準線', 'flex-start':'先頭', 'flex-end':'末尾',
  'space-between':'両端に広げる', 'space-around':'周囲に同じ余白', 'space-evenly':'すべて同じ間隔',
};
function choiceIcon(property, value) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, content] of Object.entries({viewBox:'0 0 24 24', width:'20', height:'20', fill:'none', stroke:'currentColor', 'stroke-width':'1.5', 'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true'})) svg.setAttribute(name, content);
  const shape = (tag, attrs) => { const node = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); svg.append(node); };
  if (property === 'text-align') {
    const offset = value === 'center' ? 3 : ['right', 'end'].includes(value) ? 6 : 0;
    shape('path', {d:`M4 5h16M${4+offset} 10h${value==='justify'?16:10}M4 15h16M${4+offset} 20h${value==='justify'?16:10}`});
    if (['start','end'].includes(value)) shape('path', {d:value==='start'?'m6 8-2 2 2 2':'m18 8 2 2-2 2'});
  } else if (property === 'flex-direction') {
    shape('path', {d:value==='row'?'M4 12h16m-4-4 4 4-4 4':value==='row-reverse'?'M20 12H4m4-4-4 4 4 4':value==='column'?'M12 4v16m-4-4 4 4 4-4':'M12 20V4m-4 4 4-4 4 4'});
  } else if (property === 'display') {
    const grid = value.includes('grid'); const horizontal = value.includes('flex');
    if (value.includes('inline')) { shape('path', {d:'M2 20h20'}); svg.setAttribute('stroke-dasharray','2 2'); }
    for (let i=0;i<(grid?4:3);i++) shape('rect', {x:grid?4+(i%2)*9:horizontal?3+i*7:4,y:grid?4+Math.floor(i/2)*9:horizontal?6:3+i*7,width:grid?6:horizontal?4:16,height:grid?6:horizontal?12:4,rx:1});
  } else {
    const vertical = property === 'align-items';
    shape('path', {d:vertical?'M3 3h18M3 21h18':'M3 3v18M21 3v18'});
    const centered = ['normal','center','space-around','space-evenly'].includes(value);
    const end = ['end','flex-end'].includes(value);
    for (let i=0;i<3;i++) {
      const size = vertical ? (value==='stretch'?14:5+i*3) : 3;
      const position = value==='space-between'?4+i*6:value==='space-evenly'?5+i*5:value==='space-around'?4+i*6:end?10+i*3:centered?6+i*4:4+i*3;
      shape('rect', {x:vertical?5+i*5:position,y:vertical?(end?20-size:centered?12-size/2:value==='baseline'?17-size:4):7,width:vertical?3:size,height:vertical?size:10,rx:.5});
    }
    if (value==='baseline') shape('path',{d:'M4 18h16'});
  }
  return svg;
}
const colorCanvas = document.createElement('canvas'); colorCanvas.width = colorCanvas.height = 1;
const colorContext = colorCanvas.getContext('2d', {willReadFrequently:true});
function enhanceAdjustment(input, key, kind, label) {
  const control = document.createElement('div'); control.className = 'adjust-control';
  const set = value => setAdjustmentInput(input,value);
  if (kind === 'color') {
    const picker = document.createElement('input'); picker.type = 'color'; picker.className = 'adjust-color-picker'; picker.setAttribute('aria-label', label + 'を選択');
    const swatch=document.createElement('span');swatch.className='adjust-color-swatch';
    const ink=document.createElement('span');ink.setAttribute('aria-hidden','true');swatch.append(ink,picker);
    picker.oninput = () => set(picker.value);
    control.append(swatch, input);
    adjustmentWidgets.set(key, value => {
      if (!CSS.supports('color', value)) return;
      colorContext.clearRect(0,0,1,1); colorContext.fillStyle = value; colorContext.fillRect(0,0,1,1);
      const [r,g,b] = colorContext.getImageData(0,0,1,1).data;
      picker.value = '#' + [r,g,b].map(value => value.toString(16).padStart(2,'0')).join('');
      ink.style.backgroundColor=value;
    });
  } else if (key === 'opacity') {
    const slider = document.createElement('input'); slider.type='range'; slider.min=0; slider.max=100; slider.step=1; slider.setAttribute('aria-label','不透明度を調整');
    slider.oninput=()=>set(String(Number(slider.value)/100));
    const preview = document.createElement('span'); preview.className='adjust-opacity-preview'; preview.setAttribute('aria-hidden','true');
    const ink = document.createElement('span'); preview.append(ink);
    input.classList.add('adjust-short'); control.append(preview, slider, input);
    adjustmentWidgets.set(key,value=>{if(Number.isFinite(Number(value))){slider.value=Number(value)*100;ink.style.opacity=value;slider.setAttribute('aria-valuetext',Math.round(Number(value)*100)+'%');}});
  } else if (['text-align','display','flex-direction','align-items','justify-content'].includes(key)) {
    const buttons=document.createElement('div'); buttons.className='adjust-choices'; buttons.style.setProperty('--choice-columns',key==='text-align'?6:key==='flex-direction'?4: key==='display'?4:5);
    buttons.setAttribute('role','group'); buttons.setAttribute('aria-label',label); input.hidden=true;
    const choices=[];
    for(const value of kind){const button=document.createElement('button');button.type='button';button.title=choiceLabels[value]||value;button.setAttribute('aria-label',button.title);button.append(choiceIcon(key,value));button.onclick=event=>{event.preventDefault();set(value);};buttons.append(button);choices.push([value,button]);}
    const current=document.createElement('span');current.className='adjust-choice-current';
    control.classList.add('adjust-choice-control');control.append(buttons,current,input);
    adjustmentWidgets.set(key,value=>{for(const [option,button] of choices)button.setAttribute('aria-pressed',String(option===value));current.textContent=choiceLabels[value]||value;});
  } else if (key === 'font-family') {
    const list=document.createElement('datalist');list.id='adjust-font-families';
    for(const font of ['system-ui','Arial','Helvetica Neue','Georgia','Times New Roman','ui-monospace, monospace']){const option=document.createElement('option');option.value=font;option.label=font==='system-ui'?'システム標準':font.includes('monospace')?'等幅':font;list.append(option);}
    input.setAttribute('list',list.id);control.append(input,list);
    adjustmentWidgets.set(key,value=>input.style.fontFamily=value);
  } else if (key === 'font-size' || key === 'border-radius') {
    const minus=document.createElement('button');const plus=document.createElement('button');
    minus.type=plus.type='button';minus.textContent='−';plus.textContent='+';minus.setAttribute('aria-label',label+'を小さく');plus.setAttribute('aria-label',label+'を大きく');
    const nudge=delta=>{const match=input.value.match(/^(-?[\d.]+)(px|em|rem|%|vw|vh)?$/);if(match)set(Math.max(0,Math.round((Number(match[1])+delta)*100)/100)+(match[2]||'px'));};
    minus.onclick=event=>{event.preventDefault();nudge(-1);};plus.onclick=event=>{event.preventDefault();nudge(1);};
    control.append(minus,input,plus);
    if(key==='border-radius'){const preview=document.createElement('span');preview.className='adjust-radius-preview';preview.setAttribute('aria-hidden','true');control.prepend(preview);adjustmentWidgets.set(key,value=>preview.style.borderRadius=value);}
  } else control.append(input);
  return control;
}
for (const [title, fields] of ['余白','サイズ','文字','色・形','配置'].map(title => adjustmentGroups.find(group => group[0] === title))) {
  const spacing = title === '余白';
  const group = document.createElement('details'); group.open = spacing || title === 'サイズ'; group.dataset.adjustGroup = title;
  const summary = document.createElement('summary'); summary.textContent = title; group.append(summary);
  const grid = document.createElement('div'); grid.className = 'adjust-grid';
  let margin, padding;
  if (spacing) {
    margin = document.createElement('div'); margin.className = 'box-model-margin adjust-wide';
    margin.setAttribute('role', 'group'); margin.setAttribute('aria-label', '外側と内側の余白。単位はpx');
    const unit = document.createElement('span'); unit.className = 'box-model-unit'; unit.textContent = 'px'; margin.append(unit);
    padding = document.createElement('div'); padding.className = 'box-model-padding';
    const content = document.createElement('div'); content.className = 'box-model-content';
    for (const [element, text] of [[margin, 'margin'], [padding, 'padding'], [content, '要素']]) {
      const tag = document.createElement('span'); tag.className = 'box-model-tag'; tag.textContent = text; element.append(tag);
    }
    padding.append(content); margin.append(padding); grid.append(margin);
  }
  for (const [key, title, kind] of fields) {
    const label = document.createElement('label'); const caption = document.createElement('span'); caption.textContent = title;
    const input = document.createElement(Array.isArray(kind) ? 'select' : kind === 'text' ? 'textarea' : 'input');
    input.id = 'adjust-' + key; input.name = key;
    input.setAttribute('aria-label',title);
    if (Array.isArray(kind)) for (const value of kind) {
      const weight = {'100':'極細','200':'細字','300':'細字','400':'標準','500':'中太','600':'やや太字','700':'太字','800':'極太','900':'極太'};
      const option=new Option(key==='font-weight'?`${weight[value]||choiceLabels[value]||value}${weight[value]?' '+value:''}`:choiceLabels[value]||value,value);if(key==='font-weight')option.style.fontWeight=value;input.add(option);
    }
    else { input.maxLength = kind === 'text' ? 4000 : 200; if (kind === 'length') input.placeholder = 'px'; }
    if (kind === 'text' || key === 'font-family' || ['text-align','display','flex-direction','align-items','justify-content','opacity'].includes(key)) label.className = 'adjust-wide';
    input.oninput = () => {
      let value = input.value;
      if (kind === 'length' && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) value += 'px';
      adjustmentDirty.set(key, value);
      clearTimeout(adjustmentTimers.get(key));
      adjustmentTimers.set(key, setTimeout(() => enqueueAdjustment(key), 180));
    };
    input.onchange = () => { if (adjustmentDirty.has(key)) enqueueAdjustment(key); };
    if (kind === 'length' || key === 'opacity') makeAdjustmentScrubbable(input,caption,key);
    label.append(caption, spacing ? input : enhanceAdjustment(input,key,kind,title));
    if (spacing && /^(margin|padding)-/.test(key)) {
      label.className = 'box-side box-' + key.split('-')[1]; label.title = title;
      (key.startsWith('margin-') ? margin : padding).append(label);
    } else grid.append(label);
    adjustmentInputs.set(key, input);
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
