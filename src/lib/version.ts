// The release workflow rewrites package.json *after* the build, so the version
// has to be read at runtime -- anything inlined at compile time is stale.
export function getVersion(): string {
  try {
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}
