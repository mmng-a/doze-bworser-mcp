import { SnapshotFormatter } from './vendor/SnapshotFormatter.mjs';

let nextSnapshot = 1;

/** Add page-local references to Puppeteer's accessibility tree. */
export async function inspect(record) {
  const root = await record.page.accessibility.snapshot({ includeIframes: true, interestingOnly: true });
  if (!root) throw new Error('Could not read the accessibility tree');
  const snapshot = nextSnapshot++;
  const nodes = new Map();
  function assign(node) {
    const id = `${snapshot}_${nodes.size}`;
    nodes.set(id, node);
    return { ...node, id, children: (node.children ?? []).map(assign) };
  }
  const tree = assign(root);
  const text = new SnapshotFormatter({ root: tree }).toString();
  record.nodes = nodes;
  return text;
}
