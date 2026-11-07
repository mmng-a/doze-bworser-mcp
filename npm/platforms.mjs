/** Native targets supported by the pinned Chrome for Testing release. */
export const platforms = [
  { key: 'darwin-arm64', os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin' },
  { key: 'darwin-x64', os: 'darwin', cpu: 'x64', target: 'x86_64-apple-darwin' },
  { key: 'win32-x64', os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc' },
  { key: 'linux-x64', os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-gnu' },
];
