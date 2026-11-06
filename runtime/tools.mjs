import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

const page_id = z.string().min(1);
const element = z.string().min(1);
const url = z.string().url().refine(value => value === 'about:blank' || ['http:', 'https:'].includes(new URL(value).protocol), 'Use HTTP(S) or about:blank');
const definitions = [
  ['open_page', 'Open your own page with saved project storage. Close all project pages before switching headed mode. headed is only for explicit joint viewing.', { url, headed: z.boolean().optional() }],
  ['list_pages', 'List your own pages without starting Chromium.', {}, true],
  ['inspect_page', 'Read the accessibility tree as DevTools text. Use fresh uid references for click and fill.', { page_id }, true],
  ['navigate_page', 'Navigate your page and wait for DOM readiness.', { page_id, url }],
  ['click', 'Click an element using its uid from inspect_page. May submit or change external state.', { page_id, element }],
  ['fill', 'Replace an editable value using its uid from inspect_page.', { page_id, element, value: z.string() }],
  ['press_key', 'Press a keyboard key on your page.', { page_id, key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Delete', 'Space']) }],
  ['scroll_page', 'Scroll your page to absolute coordinates.', { page_id, x: z.number().int().optional(), y: z.number().int() }],
  ['set_viewport', 'Set your page viewport without resizing a user window.', { page_id, width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000) }],
  ['take_screenshot', 'Return a PNG of your page.', { page_id, full_page: z.boolean().optional() }, true],
  ['evaluate_script', 'Evaluate a JavaScript expression and await its result. May change external state.', { page_id, expression: z.string() }],
  ['handle_dialog', 'Respond to the pending dialog and wait for the interrupted operation. Do not repeat it.', { page_id, accept: z.boolean() }],
  ['close_page', 'Close your page, interrupting any active operation.', { page_id }],
];

export function callerFromMeta(meta = {}, connection) {
  let metadata = meta['x-codex-turn-metadata'] ?? {};
  if (typeof metadata === 'string') metadata = JSON.parse(metadata);
  const thread = metadata.thread_id ?? meta.threadId ?? connection;
  let source = metadata.thread_source;
  if (typeof source === 'string' && source.trimStart().startsWith('{')) source = JSON.parse(source);
  const state = meta['codex/sandbox-state'];
  let cwd;
  if (state !== undefined) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid sandboxCwd metadata');
    if (state.sandboxCwd !== undefined) {
      try {
        if (typeof state.sandboxCwd !== 'string' || !state.sandboxCwd.startsWith('file://')) throw new Error();
        const uri = new URL(state.sandboxCwd);
        if (uri.search || uri.hash) throw new Error();
        cwd = fileURLToPath(uri);
      } catch { throw new Error('sandboxCwd must be an absolute file URL for this host'); }
    }
  }
  return { thread, parent: source?.subagent?.thread_spawn?.parent_thread_id, connection,
    cwd, codex: meta['x-codex-turn-metadata'] !== undefined || meta.threadId !== undefined };
}

/** Zod is the source for both tools/list schemas and runtime argument checks. */
export function createMcp(manager, connection) {
  const server = new McpServer({ name: 'doze-bworser-mcp', version: '0.1.0' }, {
    capabilities: { experimental: { 'codex/sandbox-state': {} } },
    instructions: 'Open your own page, pass page_id to every operation, and close it when finished. Project storage persists across threads and restarts; page ownership remains per thread. Close all project pages before switching headed mode. Different pages run concurrently. Calls wait for completion, except a pending dialog: use handle_dialog without repeating the interrupted operation. Use fresh inspect_page references. Headed mode requires explicit joint viewing. Formal project capture/check CLIs take precedence.',
  });
  for (const [name, description, shape, readOnly = false] of definitions) {
    server.registerTool(name, { description, inputSchema: z.strictObject(shape),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true } },
    async (args, ctx) => {
      try {
        const caller = callerFromMeta(ctx.mcpReq._meta, connection.id);
        manager.register(caller.thread, caller.parent);
        const value = await manager.call(caller, name, args, AbortSignal.any([ctx.mcpReq.signal, connection.signal]));
        if (name === 'take_screenshot') return { content: [{ type: 'image', data: value.image, mimeType: 'image/png' }] };
        return { content: [{ type: 'text', text: name !== 'evaluate_script' && typeof value === 'string' ? value : JSON.stringify(value) }] };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }] }; }
    });
  }
  return server;
}
