import { SnapshotFormatter } from './vendor/SnapshotFormatter.mjs';

let nextSnapshot = 1;

/** Add page-local references to Puppeteer's accessibility tree. */
export async function inspect(record) {
  const root = await record.page.accessibility.snapshot({ includeIframes: true, interestingOnly: true });
  if (!root) throw new Error('Could not read the accessibility tree');
  const snapshot = nextSnapshot++;
  const nodes = new Map();
  const blocked = new Map((record.privacy?.redact || []).map(node => [`${node.loaderId}:${node.backendNodeId}`, node]));
  function assign(node) {
    const protectedNode = blocked.get(`${node.loaderId}:${node.backendNodeId}`);
    if (protectedNode?.kind === 'private' || record.privacy?.privateLoaders?.includes(node.loaderId)) {
      return { role: 'note', name: 'Protected content', children: [] };
    }
    const id = `${snapshot}_${nodes.size}`;
    nodes.set(id, node);
    if (protectedNode?.kind === 'password') {
      return { id, role: 'textbox', name: 'Password (protected)', passwordMode: protectedNode.masked ? 'masked' : 'plain-text', children: [] };
    }
    return { ...node, id, children: (node.children ?? []).map(assign) };
  }
  const tree = assign(root);
  const text = new SnapshotFormatter({ root: tree }).toString();
  record.nodes = nodes;
  return text;
}
