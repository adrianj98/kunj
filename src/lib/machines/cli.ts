// How a provider runs its cloud's CLI: argv only (execFile, never a shell), output captured, a
// missing binary turned into `provider-cli-missing`. Providers take a CliRunner so tests never reach
// a real cloud.

import { execFile } from 'child_process';
import { MachineError } from './provider';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (cmd: string, args: string[]) => Promise<CliResult>;

/** 10 minutes: creating an image from a disk is the slowest call a provider makes. */
const TIMEOUT_MS = 10 * 60 * 1000;

export const execRunner: CliRunner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS, env: process.env }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      if (e && e.code === 'ENOENT') {
        reject(new MachineError(`${cmd} is not installed (or not on PATH). Install it and log in, then try again.`, 'provider-cli-missing'));
        return;
      }
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The first non-empty line of a CLI's stderr, without its "ERROR: (gcloud.x)" style prefix. */
export function firstErrorLine(stderr: string): string {
  const line = stderr.split('\n').map(l => l.trim()).find(l => l) ?? '';
  return line.replace(/^ERROR:\s*(\([^)]*\)\s*)?/, '');
}
