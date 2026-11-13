const $ = id => document.getElementById(id);
let state;
let dialogId;
let editingId;
const tabs = new Map();
async function act(action, args) {
  try { $('error').textContent = ''; await window.doze.act(action, args); return true; }
  catch (error) { $('error').textContent = error.message; return false; }
}
for (const action of ['back', 'forward', 'reload']) $(action).onclick = () => act(action);
$('overflow').onchange = event => { void act('switch', { page: event.target.value }); event.target.value = ''; };
$('answer').onsubmit = event => { event.preventDefault(); void answer(true); };
$('cancel').onclick = () => answer(false);
async function answer(accept) { if (state?.dialog) await act('answer', { dialog: state.dialog.id, accept, text: $('prompt').value }); }
function endEdit() {
  if (editingId) tabs.get(editingId)?.classList.remove('editing');
  editingId = null;
}
function editURL() {
  if (!state?.id || state.dialog) return;
  endEdit();
  const tab = tabs.get(state.id);
  if (!tab) return;
  editingId = state.id;
  tab.classList.add('editing');
  const input = tab.querySelector('input');
  input.setCustomValidity(''); input.value = state.url; input.focus(); input.select();
}
function createTab(page) {
  const tab = $('tab-template').content.firstElementChild.cloneNode(true);
  tab.dataset.page = page.id;
  tab.querySelector('.tab-select').onclick = () => { if (state.id === page.id) editURL(); else void act('switch', { page: page.id }); };
  tab.querySelector('.tab-hide').onclick = () => act('hide-tab', { page: page.id });
  const input = tab.querySelector('input');
  input.onblur = () => { if (editingId === page.id) endEdit(); };
  input.oninput = () => input.setCustomValidity('');
  tab.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (await act('navigate', { url: input.value })) endEdit();
    else { input.setCustomValidity($('error').textContent); input.reportValidity(); }
  };
  const image = tab.querySelector('img');
  image.onerror = () => { image.hidden = true; tab.querySelector('.fallback').hidden = false; };
  tabs.set(page.id, tab);
  return tab;
}
function renderTabs() {
  if (!state) return;
  const pages = state.pages;
  const active = pages.findIndex(page => page.id === state.id);
  const capacity = Math.max(1, Math.min(4, 1 + Math.floor(($('tabs').clientWidth - 188) / 62)));
  const start = Math.max(0, Math.min(active - Math.floor((capacity - 1) / 2), pages.length - capacity));
  const visible = pages.slice(start, start + capacity);
  const shown = new Set(visible.map(page => page.id));
  for (const [id, tab] of tabs) if (!shown.has(id)) { tab.remove(); tabs.delete(id); }
  for (let index = 0; index < visible.length; index++) {
    const page = visible[index];
    const tab = tabs.get(page.id) || createTab(page);
    const selected = page.id === state.id;
    if (!selected && editingId === page.id) endEdit();
    tab.classList.toggle('active', selected);
    const select = tab.querySelector('.tab-select');
    const name = page.title || page.url || '新しいページ';
    select.setAttribute('aria-label', name);
    select.setAttribute('aria-selected', String(selected));
    select.tabIndex = selected ? 0 : -1;
    select.title = page.url || name;
    tab.querySelector('.page-title').textContent = name;
    let domain = '';
    try { domain = new URL(page.url).host; } catch {}
    tab.querySelector('.domain').textContent = domain;
    tab.querySelector('.tab-hide').setAttribute('aria-label', `${name}を隠す`);
    const image = tab.querySelector('img');
    const fallback = tab.querySelector('.fallback');
    fallback.textContent = name.trim().slice(0, 1).toUpperCase() || '•';
    if (image.dataset.source !== page.favicon) {
      image.dataset.source = page.favicon;
      image.hidden = !page.favicon; fallback.hidden = !!page.favicon;
      if (page.favicon) image.src = page.favicon; else image.removeAttribute('src');
    }
    const input = tab.querySelector('input');
    if (selected) { input.id = 'url'; tab.querySelector('form').id = 'navigate'; }
    else { input.removeAttribute('id'); tab.querySelector('form').removeAttribute('id'); }
    if (editingId !== page.id) input.value = page.url;
    if ($('tabs').children[index] !== tab) $('tabs').insertBefore(tab, $('tabs').children[index] || null);
  }
  const hidden = pages.filter(page => !shown.has(page.id));
  $('overflow').hidden = !hidden.length;
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '⋯'; placeholder.disabled = true; placeholder.selected = true;
  $('overflow').replaceChildren(placeholder, ...hidden.map(page => { const option = document.createElement('option'); option.value = page.id; option.textContent = page.title || page.url || '新しいページ'; return option; }));
}
$('tabs').onkeydown = event => {
  if (!event.target.matches('.tab-select') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = state.pages.findIndex(page => page.id === state.id);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.pages.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + state.pages.length) % state.pages.length;
  void act('switch', { page: state.pages[next].id }).then(() => tabs.get(state.id)?.querySelector('.tab-select').focus());
};
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (state?.dialog && event.key === 'Tab') { const items = [...$('modal').querySelectorAll('input,button')].filter(e => !e.hidden); const first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
  if (event.key === 'Escape') {
    if (state?.dialog) { event.preventDefault(); void answer(false); }
    else if (editingId) { event.preventDefault(); endEdit(); tabs.get(state.id)?.querySelector('.tab-select').focus(); }
  }
});
window.doze.focusURL(editURL);
new ResizeObserver(renderTabs).observe($('tabs'));
window.doze.subscribe(next => {
  const focusWasInTabs = $('tabs').contains(document.activeElement);
  if (state?.id !== next.id) endEdit();
  state = next;
  document.documentElement.classList.toggle('mac', next.mac);
  $('back').disabled = !next.back; $('forward').disabled = !next.forward;
  renderTabs();
  if (focusWasInTabs && document.activeElement === document.body) tabs.get(next.id)?.querySelector('.tab-select').focus();
  $('modal').hidden = !next.dialog;
  document.querySelector('header').inert = !!next.dialog;
  if (next.dialog && dialogId !== next.dialog.id) {
    endEdit(); dialogId = next.dialog.id;
    $('dialog-title').textContent = next.dialog.type === 'prompt' ? '入力' : next.dialog.type === 'alert' ? 'メッセージ' : '確認';
    $('message').textContent = next.dialog.message;
    $('origin').textContent = next.dialog.origin || next.origin;
    $('prompt').hidden = next.dialog.type !== 'prompt'; $('prompt').value = next.dialog.defaultValue || '';
    $('cancel').hidden = next.dialog.type === 'alert';
    if (next.dialog.type === 'prompt') { $('prompt').focus(); $('prompt').select(); } else $('answer').querySelector('button[type=submit]').focus();
  }
  if (!next.dialog) dialogId = null;
});
void act('ready');
