import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from './snapshot.mjs';

test('inspection preserves DevTools attributes and replaces old element references', async () => {
  const child = { role: 'textbox', name: 'Name', value: 'Example', focused: false, required: true, elementHandle: async () => null };
  const record = { page: { accessibility: { snapshot: async () => ({ role: 'RootWebArea', name: 'Fixture', children: [child] }) } } };
  const text = await inspect(record);
  assert.match(text, /^uid=\d+_0 RootWebArea "Fixture"\n  uid=\d+_1 textbox "Name" focusable required value="Example"\n$/);
  const old = [...record.nodes.keys()][1];
  assert.equal(record.nodes.get(old), child);
  await inspect(record);
  assert.equal(record.nodes.has(old), false);
});
