/** Map native key input to browser commands without intercepting text composition. */
function browserShortcut(input, platform) {
  if (input.type !== 'keyDown' || input.isComposing) return;
  const key = input.key.toLowerCase();
  const command = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (input.control && !input.meta && !input.alt && key === 'tab') return { action: 'cycle', value: input.shift ? -1 : 1 };
  if (command && !input.alt) {
    if (!input.shift && /^[1-9]$/.test(key)) return { action: 'tab', value: Number(key) };
    if (key === 'l' && !input.shift) return { action: 'url' };
    if (key === 'w') return { action: input.shift ? 'hide-window' : 'hide-tab' };
    if (key === 'r') return { action: input.shift ? 'reload-fresh' : 'reload' };
    if (key === '[' && !input.shift) return { action: 'back' };
    if (key === ']' && !input.shift) return { action: 'forward' };
    if (platform === 'darwin' && input.shift && ['[', '{', ']', '}'].includes(key)) return { action: 'cycle', value: ['[', '{'].includes(key) ? -1 : 1 };
    if (platform === 'darwin' && !input.shift && ['arrowleft', 'arrowright'].includes(key)) return { action: key === 'arrowleft' ? 'back' : 'forward' };
    if (['+', '=', '-', '0'].includes(key)) return { action: 'zoom', value: key === '0' ? 0 : key === '-' ? -1 : 1 };
  }
  if (platform !== 'darwin' && input.alt && !input.control && !input.meta && !input.shift && ['arrowleft', 'arrowright'].includes(key)) return { action: key === 'arrowleft' ? 'back' : 'forward' };
  if (!input.meta && !input.control && !input.alt) {
    if (key === 'f5') return { action: input.shift ? 'reload-fresh' : 'reload' };
    if (key === 'escape' && !input.shift) return { action: 'stop' };
  }
}
module.exports = { browserShortcut };
