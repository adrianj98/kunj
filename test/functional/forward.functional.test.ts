// Port forwarding (explicit and --auto), the agent's tmux session and its detached forwarder, and
// open, through the built CLI. Opt-in: npm run test:functional.
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { attachedContainerUri } from '../../src/lib/container/editor';
import type { ContainerListJson } from '../../src/lib/json-types';
import { USER, canConnect, describeFunctional, docker, hasScript, useFixture, waitFor } from './harness';

// A node http server in the container, left running in the background
function serverScript(port: number, body: string, host = '0.0.0.0', pidFile = '/tmp/ft-server.pid'): string {
  return `nohup node -e 'require("http").createServer((q,s)=>s.end("${body}")).listen(${port},"${host}")' >/dev/null 2>&1 & echo $! > ${pidFile}`;
}

describeFunctional('kunj ct (functional): forward, agent and open', () => {
  const ctx = useFixture('fwd');

  describe('forward', () => {
    it('forwards a port to a server bound to localhost in the container, and list shows it as a forward', async () => {
      const { fx } = ctx;
      const branch = 'ft-fwd';
      await fx.start(branch);
      expect((await fx.sh(branch, serverScript(8123, 'hi', '127.0.0.1'))).status).toBe(0);
      await waitFor(async () => (await fx.exec(branch, ['curl', '-s', 'http://127.0.0.1:8123/'])).stdout === 'hi', 'the server in the container', 20_000);

      const fwd = fx.spawn(['ct', 'forward', branch, '8123', '--json']);
      const { forwards } = await fwd.json<{ forwards: Array<{ container: number; host: number }> }>('the forward');
      expect(forwards).toEqual([{ container: 8123, host: expect.any(Number) }]);
      const hostPort = forwards[0].host;

      const res = await fetch(`http://127.0.0.1:${hostPort}/`);
      expect(await res.text()).toBe('hi');

      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      const ports = list.containers.find(c => c.branch === branch)?.ports;
      expect(ports).toContainEqual({ container: 8123, host: hostPort, kind: 'forward', pid: fwd.pid });

      await fwd.stop();
      await waitFor(async () => !(await canConnect(hostPort)), 'the forward to close', 10_000);
      const after = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(after.containers.find(c => c.branch === branch)?.ports.filter(p => p.kind === 'forward')).toEqual([]);
    });

    it('forward --auto picks up a server started late and drops it when it stops', async () => {
      const { fx } = ctx;
      const branch = 'ft-auto';
      await fx.start(branch);

      const auto = fx.spawn(['ct', 'forward', branch, '--auto', '--json']);
      // Let it poll a few times with nothing listening
      await new Promise(r => setTimeout(r, 3000));
      expect(auto.jsonLines().filter(c => c.port === 18765)).toEqual([]);

      expect((await fx.sh(branch, serverScript(18765, 'auto', '0.0.0.0', '/tmp/auto.pid'))).status).toBe(0);
      const addLine = await auto.line(l => l.includes('"add"') && l.includes('18765'), 'the forward to appear', 30_000);
      const add = JSON.parse(addLine) as { event: string; port: number; hostPort: number };
      expect(add).toMatchObject({ event: 'add', port: 18765 });
      const res = await fetch(`http://127.0.0.1:${add.hostPort}/`);
      expect(await res.text()).toBe('auto');

      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.containers.find(c => c.branch === branch)?.ports).toContainEqual({ container: 18765, host: add.hostPort, kind: 'forward', pid: auto.pid });

      expect((await fx.sh(branch, 'kill $(cat /tmp/auto.pid)')).status).toBe(0);
      const removeLine = await auto.line(l => l.includes('"remove"') && l.includes('18765'), 'the forward to be dropped', 30_000);
      expect(JSON.parse(removeLine)).toEqual({ event: 'remove', port: 18765, hostPort: add.hostPort });
      expect(await canConnect(add.hostPort)).toBe(false);
    });
  });

  describe('agent', () => {
    // agent and attach need a terminal: they run under `script`
    (hasScript ? it : it.skip)('agent runs the command in a tmux session that outlives the client, attach reattaches, and the auto-forwarder is registered', async () => {
      const { fx } = ctx;
      const branch = 'ft-agent';
      // `env` + the arguments after `--`: the agent command is shell text, the arguments are quoted
      fx.writeConfig({ container: { agentCommand: 'env' } });
      const started = await fx.start(branch);
      const container = started.names.container;
      const hasSession = () => {
        try {
          docker(['exec', '-u', USER, container, 'tmux', 'has-session', '-t', 'agent']);
          return true;
        } catch {
          return false;
        }
      };

      const agent = fx.spawn(['ct', 'agent', branch, '--', 'sh', '-c', 'echo ft-agent-hi; sleep 600'], { pty: true });
      await waitFor(hasSession, 'the agent tmux session', 60_000);
      const pane = docker(['exec', '-u', USER, container, 'tmux', 'capture-pane', '-p', '-t', 'agent']);
      expect(pane).toContain('ft-agent-hi');

      // The detached forwarder `agent` started: registered under its own pid (port 0 marks the forwarder)
      await waitFor(() => fx.forwardRecords().some(r => r.container === container && r.port === 0 && r.pid !== agent.pid), 'the auto-forwarder record', 10_000);
      const forwarder = fx.forwardRecords().find(r => r.container === container && r.port === 0)!;
      expect(fx.registeredPids()).toContain(forwarder.pid);

      // Leaving the client (the terminal goes away) keeps the session
      await agent.stop();
      expect(hasSession()).toBe(true);
      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.containers.find(c => c.branch === branch)?.agent).toMatchObject({ running: true, sessions: [{ session: 'agent', id: null }] });

      const attach = fx.spawn(['ct', 'attach', branch], { pty: true });
      await waitFor(() => attach.stdout.includes('ft-agent-hi'), 'attach to show the session', 30_000);
      await attach.stop();
      expect(hasSession()).toBe(true);
    });
  });

  describe('open', () => {
    it('with a non-VS Code editor prints how to exec into the container', async () => {
      const { fx } = ctx;
      const branch = 'ft-open';
      fx.writeConfig({ worktree: { editorCommand: 'true' } });
      const started = await fx.start(branch);

      const out = await fx.kunjJson(['ct', 'open', branch]);
      expect(out).toMatchObject({ success: true, branch, name: started.names.container, editor: 'true', uri: null });
      expect(out.exec).toEqual(expect.stringContaining('docker'));
      expect(out.exec).toContain(`exec -it -u ${USER} -w /workspace ${started.names.container}`);
    });

    it('with code attaches it to the container by its folder URI, and warns about credentials', async () => {
      const { fx } = ctx;
      const branch = 'ft-open-code';
      // A fake `code` that records its arguments
      const bin = path.join(fx.scratch, 'bin');
      const argvFile = path.join(fx.scratch, 'code-argv');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}.tmp' && mv '${argvFile}.tmp' '${argvFile}'\n`, { mode: 0o755 });
      fx.writeConfig({ worktree: { editorCommand: 'code' } });
      const env = { PATH: `${bin}:${process.env.PATH}` };
      const started = await fx.start(branch, [], { env });

      const out = await fx.kunjJson(['ct', 'open', branch], { env });
      const uri = attachedContainerUri(started.names.container, '/workspace');
      expect(uri).toMatch(/^vscode-remote:\/\/attached-container\+[0-9a-f]+\/workspace$/);
      expect(out).toMatchObject({ success: true, branch, name: started.names.container, editor: 'code', uri });
      expect(typeof out.warning).toBe('string');
      expect(out.warning.length).toBeGreaterThan(0);

      await waitFor(() => fs.existsSync(argvFile), 'the editor to be run', 10_000);
      const argv = fs.readFileSync(argvFile, 'utf8').trim().split('\n');
      expect(argv).toEqual(expect.arrayContaining(['--folder-uri', uri]));
      expect(argv[argv.indexOf('--folder-uri') + 1]).toBe(uri);
    });
  });
});
