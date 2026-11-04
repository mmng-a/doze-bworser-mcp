# Chrome DevTools MCP snapshot formatter

`SnapshotFormatter.mjs` is adapted from Chrome DevTools MCP 1.12.0,
`build/src/formatters/SnapshotFormatter.js` (Google LLC, Apache-2.0).
The license is included in `LICENSE`.

Source: https://github.com/ChromeDevTools/chrome-devtools-mcp

Only the text formatter is retained. JSON output and DevTools-panel selection
support are removed. Data URL truncation uses the Node.js standard library.
Accessibility data and element resolution come from Puppeteer's public APIs.
