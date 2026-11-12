const $ = id => document.getElementById(id);
let state;
let dialogId;
async function act(action, args) {
  try { $('error').textContent = ''; await window.doze.act(action, args); }
  catch (error) { $('error').textContent = error.message; }
}
for (const action of ['back', 'forward', 'reload', 'hide']) $(action).onclick = () => act(action);
$('navigate').onsubmit = event => { event.preventDefault(); const url = $('url').value; $('url').blur(); void act('navigate', { url }); };
$('pages').onchange = () => act('switch', { page: $('pages').value });
$('answer').onsubmit = event => { event.preventDefault(); void answer(true); };
$('cancel').onclick = () => answer(false);
async function answer(accept) { if (state?.dialog) await act('answer', { dialog: state.dialog.id, accept, text: $('prompt').value }); }
document.addEventListener('keydown', event => {
  if (state?.dialog && event.key === 'Tab') { const items = [...$('modal').querySelectorAll('input,button')].filter(e => !e.hidden); const first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
  if (state?.dialog && event.key === 'Escape') { event.preventDefault(); void answer(false); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); $('url').focus(); $('url').select(); }
});
window.doze.focusURL(() => { $('url').focus(); $('url').select(); });
window.doze.subscribe(next => {
  state = next;
  document.documentElement.classList.toggle('mac', next.mac);
  if (document.activeElement !== $('url')) $('url').value = next.url;
  $('back').disabled = !next.back;
  $('forward').disabled = !next.forward;
  $('pages').replaceChildren(...next.pages.map(page => { const option = document.createElement('option'); option.value = page.id; option.textContent = page.title || page.url || '新しいページ'; option.selected = page.id === next.id; return option; }));
  $('modal').hidden = !next.dialog;
  document.querySelector('header').inert = !!next.dialog;
  if (next.dialog && dialogId !== next.dialog.id) {
    dialogId = next.dialog.id;
    $('dialog-title').textContent = next.dialog.type === 'prompt' ? '入力' : next.dialog.type === 'alert' ? 'メッセージ' : '確認';
    $('message').textContent = next.dialog.message;
    $('origin').textContent = next.origin;
    $('prompt').hidden = next.dialog.type !== 'prompt';
    $('prompt').value = next.dialog.defaultValue || '';
    $('cancel').hidden = next.dialog.type === 'alert';
    if (next.dialog.type === 'prompt') { $('prompt').focus(); $('prompt').select(); } else $('answer').querySelector('button[type=submit]').focus();
  }
  if (!next.dialog) dialogId = null;
});
void act('ready');
