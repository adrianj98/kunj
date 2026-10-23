// Shared by the Docker suites (integration.docker.test.ts, in process) and the functional suite
// (test/functional, the built CLI): a throwaway origin the containers can reach, plus small helpers.
//
// Origin is a bare repository on the host served by `git daemon`; containers reach it as
// git://host.docker.internal:<port>/<repo>.git. The host cannot resolve host.docker.internal, so
// host-side git that must talk to origin goes through a core.gitProxy that connects to the daemon on
// 127.0.0.1 instead, leaving the URL itself unchanged (writeGitProxy).
//
// Not a test file (no Jest imports), so it is never collected as one.
import { ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

/** Committer identity for the test repositories, on top of the caller's environment. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'kunj test',
  GIT_AUTHOR_EMAIL: 'test@kunj.invalid',
  GIT_COMMITTER_NAME: 'kunj test',
  GIT_COMMITTER_EMAIL: 'test@kunj.invalid',
};

export function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

export function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
}

export async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
}

export function canConnect(p: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(p, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** `git daemon` exporting every repository under basePath, push enabled, on a free port. */
export async function startGitDaemon(basePath: string): Promise<{ port: number; daemon: ChildProcess }> {
  const port = await freePort();
  const daemon = spawn(
    'git',
    ['daemon', '--export-all', `--base-path=${basePath}`, `--port=${port}`, '--enable=receive-pack', '--reuseaddr', basePath],
    { stdio: 'ignore' }
  );
  await waitFor(() => canConnect(port), 'git daemon');
  return { port, daemon };
}

/** origin's URL as the containers see it. */
export function containerOriginUrl(port: number, repoName: string): string {
  return `git://host.docker.internal:${port}/${repoName}.git`;
}

/** Writes an executable core.gitProxy that connects git:// to the daemon on 127.0.0.1 (git passes host and port). */
export function writeGitProxy(file: string): string {
  fs.writeFileSync(
    file,
    '#!/bin/sh\nexec node -e \'const s = require("net").connect(+process.argv[1], "127.0.0.1"); ' +
      'process.stdin.pipe(s); s.pipe(process.stdout); s.on("close", () => process.exit(0))\' "$2"\n',
    { mode: 0o755 }
  );
  return file;
}
