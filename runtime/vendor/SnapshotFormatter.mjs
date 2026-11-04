/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// Adapted from Chrome DevTools MCP 1.12.0; see README.md in this directory.
function truncateUrl(url) {
    if (url.length <= 255) return url;
    let prefix = '';
    for (const { segment } of new Intl.Segmenter().segment(url)) {
        if (prefix.length + segment.length > 255) break;
        prefix += segment;
    }
    return prefix + '... <truncated>';
}
export class SnapshotFormatter {
    #snapshot;
    constructor(snapshot) {
        this.#snapshot = snapshot;
    }
    toString() {
        const chunks = [];
        const root = this.#snapshot.root;
        chunks.push(this.#formatNode(root, 0));
        return chunks.join('');
    }
    #formatNode(node, depth = 0) {
        const chunks = [];
        const attributes = this.#getAttributes(node);
        const line = ' '.repeat(depth * 2) +
            attributes.join(' ') +
            '\n';
        chunks.push(line);
        if (!this.#hasRedundantTextChildren(node)) {
            for (const child of node.children) {
                chunks.push(this.#formatNode(child, depth + 1));
            }
        }
        return chunks.join('');
    }
    #hasRedundantTextChildren(node) {
        if (this.#snapshot.verbose || !node.name || node.children.length === 0) {
            return false;
        }
        let text = '';
        for (const child of node.children) {
            if (child.role !== 'StaticText' ||
                child.children.length !== 0 ||
                child.id === this.#snapshot.selectedElementUid) {
                return false;
            }
            text += child.name ?? '';
        }
        return stripWhitespace(text) === stripWhitespace(node.name);
    }
    #getAttributes(serializedAXNodeRoot) {
        const attributes = [];
        if (serializedAXNodeRoot.id) {
            attributes.push(`uid=${serializedAXNodeRoot.id}`);
        }
        if (serializedAXNodeRoot.role &&
            serializedAXNodeRoot.role !== 'StaticText') {
            attributes.push(serializedAXNodeRoot.role === 'none'
                ? 'ignored'
                : serializedAXNodeRoot.role);
        }
        if (serializedAXNodeRoot.name) {
            attributes.push(`"${serializedAXNodeRoot.name}"`);
        }
        const simpleAttrs = this.#extractedAttributes(serializedAXNodeRoot);
        const isOption = serializedAXNodeRoot.role === 'option';
        for (const attr of Object.keys(serializedAXNodeRoot).sort()) {
            if (excludedAttributes.has(attr)) {
                continue;
            }
            const mapped = booleanPropertyMap[attr];
            if (mapped &&
                simpleAttrs[mapped] &&
                !(isOption && mapped === 'selectable')) {
                attributes.push(mapped);
            }
            const val = simpleAttrs[attr];
            if (isOption && attr === 'value' && val === serializedAXNodeRoot.name) {
                continue;
            }
            if (val === true) {
                attributes.push(attr);
            }
            else if (typeof val === 'string' || typeof val === 'number') {
                attributes.push(`${attr}="${val}"`);
            }
        }
        return attributes;
    }
    #extractedAttributes(node) {
        const result = {};
        for (const attr of Object.keys(node).sort()) {
            if (excludedAttributes.has(attr)) {
                continue;
            }
            const value = node[attr];
            if (typeof value === 'boolean') {
                if (booleanPropertyMap[attr]) {
                    result[booleanPropertyMap[attr]] = true;
                }
                if (value) {
                    result[attr] = true;
                }
            }
            else if (attr === 'url' && typeof value === 'string') {
                // Keep other URLs whole: the snapshot is their only full copy.
                result[attr] = value.startsWith('data:') ? truncateUrl(value) : value;
            }
            else if (typeof value === 'string' || typeof value === 'number') {
                result[attr] = value;
            }
        }
        return result;
    }
}
const booleanPropertyMap = {
    disabled: 'disableable',
    expanded: 'expandable',
    focused: 'focusable',
    selected: 'selectable',
};
const excludedAttributes = new Set([
    'id',
    'role',
    'name',
    'elementHandle',
    'children',
    'backendNodeId',
    'loaderId',
]);
function stripWhitespace(text) {
    return text.replace(/\s+/g, '');
}
