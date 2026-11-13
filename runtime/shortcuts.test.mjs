import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserShortcut } from './shortcuts.cjs';

test('browser shortcuts use platform modifiers and preserve unrelated or composing input', () => {
  for (const platform of ['darwin', 'linux']) {
    const modifier = platform === 'darwin' ? { meta: true } : { control: true };
    const input = (key, extra = {}) => ({ type: 'keyDown', key, ...modifier, ...extra });
    for (let digit = 1; digit <= 9; digit++) assert.deepEqual(browserShortcut(input(String(digit)), platform), { action: 'tab', value: digit });
    for (const [key, action] of [['l', 'url'], ['[', 'back'], [']', 'forward'], ['r', 'reload'], ['w', 'hide-tab']]) assert.deepEqual(browserShortcut(input(key), platform), { action });
    assert.deepEqual(browserShortcut(input('R', { shift: true }), platform), { action: 'reload-fresh' });
    assert.deepEqual(browserShortcut(input('W', { shift: true }), platform), { action: 'hide-window' });
    for (const [key, value] of [['=', 1], ['+', 1], ['-', -1], ['0', 0]]) assert.deepEqual(browserShortcut(input(key), platform), { action: 'zoom', value });
    for (const key of ['r', 'l', 'w', '1', '[']) {
      assert.equal(browserShortcut(input(key, { isComposing: true }), platform), undefined);
      assert.equal(browserShortcut(input(key, { type: 'keyUp' }), platform), undefined);
      assert.equal(browserShortcut(input(key, { alt: true }), platform), undefined);
      assert.equal(browserShortcut({ type: 'keyDown', key }, platform), undefined);
    }
    for (const key of ['c', 'v', 'x', 'a', 'z', 't', 'n']) assert.equal(browserShortcut(input(key), platform), undefined);
    for (const shift of [false, true]) assert.deepEqual(browserShortcut({ type: 'keyDown', key: 'Tab', control: true, shift }, platform), { action: 'cycle', value: shift ? -1 : 1 });
    assert.equal(browserShortcut({ type: 'keyDown', key: 'Tab', control: true, alt: true }, platform), undefined);
  }
  for (const [key, value] of [['{', -1], ['[', -1], ['}', 1], [']', 1]]) assert.deepEqual(browserShortcut({ type: 'keyDown', key, meta: true, shift: true }, 'darwin'), { action: 'cycle', value });
  assert.equal(browserShortcut({ type: 'keyDown', key: 'l', control: true }, 'darwin'), undefined);
  assert.equal(browserShortcut({ type: 'keyDown', key: 'l', meta: true }, 'linux'), undefined);
  assert.deepEqual(browserShortcut({ type: 'keyDown', key: 'ArrowLeft', alt: true }, 'linux'), { action: 'back' });
  assert.deepEqual(browserShortcut({ type: 'keyDown', key: 'ArrowRight', meta: true }, 'darwin'), { action: 'forward' });
});
