// How this CLI runs itself again (a detached forwarder, an agent under `kunj run` in tmux).

import * as path from 'path';

/**
 * The CLI entry to give node: argv[1] (dist/index.js, or the npm bin link to it). Under ts-node it is
 * a .ts file that plain node cannot run, so the package's built dist/index.js is used instead.
 */
export function kunjEntry(): string {
  const entry = process.argv[1] ?? '';
  return /\.ts$/.test(entry) ? path.resolve(__dirname, '../../dist/index.js') : entry;
}
