import { SnapshotFormatter } from './vendor/SnapshotFormatter.mjs';

let nextSnapshot = 1;

/** Add page-local references to Puppeteer's accessibility tree. */
export async function inspect(record) {
  const root = await record.page.accessibility.snapshot({ includeIframes: true, interestingOnly: true });
  if (!root) throw new Error('Could not read the accessibility tree');
  const snapshot = nextSnapshot++;
  const nodes = new Map();
  const blocked = new Map((record.privacy?.redact || []).map(node => [`${node.loaderId}:${node.backendNodeId}`, node.kind]));
  function assign(node) {
    const kind = blocked.get(`${node.loaderId}:${node.backendNodeId}`);
    if (kind || record.privacy?.privateLoaders?.includes(node.loaderId)) return { role: kind === 'password' ? 'textbox' : 'note', name: kind === 'password' ? 'Password (protected)' : 'Protected content', children: [] };
    const id = `${snapshot}_${nodes.size}`;
    nodes.set(id, node);
    return { ...node, id, children: (node.children ?? []).map(assign) };
  }
  const tree = assign(root);
  const text = new SnapshotFormatter({ root: tree }).toString();
  record.nodes = nodes;
  return text;
}
