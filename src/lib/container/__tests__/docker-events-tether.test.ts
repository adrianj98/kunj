// The `docker events` child of a long-lived kunj (kunj events) must end with it, however it ends:
// an aborted watch, a TERM to the tether, and kunj killed with SIGKILL, which runs no handler at all.
// A fake docker stands in (it records its pid and sleeps), so no Docker daemon is needed.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalDockerBackend } from '../docker';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return check();
}

describeUnix('docker events is tethered to kunj', () => {
  let dir: string;
  let docker: string;
  let pidFile: string;
  const pid = () => Number(fs.readFileSync(pidFile, 'utf8').trim());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-tether-'));
    pidFile = path.join(dir, 'pid');
    docker = path.join(dir, 'docker');
    fs.writeFileSync(docker, `#!/bin/sh\necho $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'\nexec sleep 600\n`, { mode: 0o755 });
  });

  afterEach(() => {
    if (fs.existsSync(pidFile) && alive(pid())) process.kill(pid(), 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ends docker when the watch is aborted, and when the tether is sent TERM (killChildren)', async () => {
    const backend = new LocalDockerBackend({ dockerPath: docker });
    const controller = new AbortController();
    const done = backend.events({ 'kunj.repo': '' }, () => {}, controller.signal);
    expect(await until(() => fs.existsSync(pidFile))).toBe(true);
    const first = pid();
    expect(alive(first)).toBe(true);
    controller.abort();
    await done;
    expect(await until(() => !alive(first))).toBe(true);

    fs.rmSync(pidFile);
    const second = backend.events({}, () => {}, new AbortController().signal).catch(err => err);
    expect(await until(() => fs.existsSync(pidFile))).toBe(true);
    const docker2 = pid();
    backend.killChildren();
    expect(await second).toBeInstanceOf(Error);
    expect(await until(() => !alive(docker2))).toBe(true);
  });

  it('ends docker when kunj is killed with SIGKILL', async () => {
    const script = `
      const { LocalDockerBackend } = require(${JSON.stringify(path.join(__dirname, '..', 'docker'))});
      new LocalDockerBackend({ dockerPath: ${JSON.stringify(docker)} }).events({}, () => {}, new AbortController().signal).catch(() => {});
      setInterval(() => {}, 1000);
    `;
    const kunj = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], { stdio: 'ignore', cwd: path.join(__dirname, '..', '..', '..', '..') });
    try {
      expect(await until(() => fs.existsSync(pidFile), 30_000)).toBe(true);
      const dockerPid = pid();
      expect(alive(dockerPid)).toBe(true);
      kunj.kill('SIGKILL');
      expect(await until(() => !alive(dockerPid))).toBe(true);
    } finally {
      if (kunj.exitCode === null) kunj.kill('SIGKILL');
    }
  }, 45_000);
});
