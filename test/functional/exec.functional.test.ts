// shell and exec, the container's own clone, pushing to origin, forwarded secrets, and the firewall,
// through the built CLI. Opt-in: npm run test:functional.
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { describeFunctional, freePort, useFixture } from './harness';

describeFunctional('kunj ct (functional): exec, shell and the workspace', () => {
  const ctx = useFixture('exec');

  describe('exec and shell', () => {
    it('exec runs in the branch checkout in /workspace, and shell reads commands from stdin', async () => {
      const { fx } = ctx;
      const branch = 'ft-exec';
      await fx.start(branch);

      const head = await fx.exec(branch, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(head.status).toBe(0);
      expect(head.stdout.trim()).toBe(branch);
      expect((await fx.exec(branch, ['pwd'])).stdout.trim()).toBe('/workspace');
      expect((await fx.exec(branch, ['id', '-un'])).stdout.trim()).toBe('dev');

      // The exit code of the command is kunj's
      expect((await fx.exec(branch, ['sh', '-c', 'exit 7'])).status).toBe(7);

      const shell = await fx.kunj(['ct', 'shell', branch], { input: 'git rev-parse --abbrev-ref HEAD\nexit\n' });
      expect(shell.status).toBe(0);
      expect(shell.stdout).toContain(branch);
    });

    it('the workspace is the container\'s own clone of origin: volumes only, no bind mount of the host', async () => {
      const { fx } = ctx;
      const branch = 'ft-clone';
      const started = await fx.start(branch);

      const mounts = fx.inspect<Array<{ Type: string; Name?: string; Source: string; Destination: string }>>(started.names.container, '.Mounts');
      expect(mounts.length).toBeGreaterThan(0);
      expect(mounts.filter(m => m.Type !== 'volume')).toEqual([]);
      expect(mounts.find(m => m.Destination === '/workspace')?.Name).toBe(started.names.workspaceVolume);
      expect(mounts.some(m => m.Source.startsWith(fx.tmp))).toBe(false);

      const origin = await fx.exec(branch, ['git', 'remote', 'get-url', 'origin']);
      expect(origin.stdout.trim()).toBe(fx.originUrl);
      // A file written on the host does not appear in the container
      fs.writeFileSync(path.join(fx.clone, 'host-only.txt'), 'host\n');
      expect((await fx.exec(branch, ['test', '-e', 'host-only.txt'])).status).not.toBe(0);
      fs.rmSync(path.join(fx.clone, 'host-only.txt'));
    });

    it('git push from inside reaches the throwaway origin', async () => {
      const { fx } = ctx;
      const branch = 'ft-push';
      await fx.start(branch);
      expect(fx.originHead(branch)).toBe('');

      const r = await fx.sh(branch, 'echo pushed > pushed.txt && git add pushed.txt && git commit -qm pushed && git push -q && git rev-parse HEAD');
      expect(r.status).toBe(0);
      expect(fx.originHead(branch)).toBe(r.stdout.trim().split('\n').pop());
    });
  });

  describe('secrets', () => {
    it('a forwarded variable is in the container but never in its labels or on a docker command line', async () => {
      const { fx } = ctx;
      const branch = 'ft-secret';
      const secret = `ft-secret-${Math.random().toString(36).slice(2)}`;
      fx.writeConfig({ container: { env: ['KUNJ_FT_SECRET'] } });

      // A docker on PATH that records every command line kunj runs, then runs the real one
      const realDocker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
      const bin = path.join(fx.scratch, 'bin');
      const log = path.join(fx.scratch, 'docker-argv.log');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realDocker}' "$@"\n`, { mode: 0o755 });
      const env = { KUNJ_FT_SECRET: secret, PATH: `${bin}:${process.env.PATH}` };

      const started = await fx.start(branch, [], { env });
      const seen = await fx.sh(branch, 'printf %s "$KUNJ_FT_SECRET"', { env });
      expect(seen.stdout).toBe(secret);

      const labels = fx.inspect<Record<string, string>>(started.names.container, '.Config.Labels');
      expect(JSON.stringify(labels)).not.toContain(secret);
      const helperLabels = fx.inspect<Record<string, string>>(started.names.helper, '.Config.Labels');
      expect(JSON.stringify(helperLabels)).not.toContain(secret);
      // The network helper gets none of the forwarded environment
      expect(JSON.stringify(fx.inspect(started.names.helper, '.Config.Env'))).not.toContain(secret);

      const argv = fs.readFileSync(log, 'utf8');
      expect(argv).toMatch(/(^|\n)run /);
      expect(argv).toMatch(/(^|\n)exec /);
      expect(argv).not.toContain(secret);
    });
  });

  describe('firewall', () => {
    it('blocks the host gateway and private addresses by default, and lets origin through', async () => {
      const { fx } = ctx;
      const branch = 'ft-fw';
      // A server on the host that would answer if the firewall let the container through
      const server = http.createServer((_q, res) => res.end('open'));
      const port = await freePort();
      await new Promise<void>(resolve => server.listen(port, '0.0.0.0', resolve));
      try {
        const started = await fx.start(branch);
        expect(started.firewall).toBe('default');

        // origin, on the host, is reachable: ls-remote from inside works
        expect((await fx.exec(branch, ['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'])).status).toBe(0);

        // The host by name: refused (7) or timed out (28), never answered
        const viaName = await fx.exec(branch, ['curl', '-s', '--max-time', '5', `http://host.docker.internal:${port}/`]);
        expect([7, 28]).toContain(viaName.status);
        expect(viaName.stdout).not.toContain('open');

        // The branch network's gateway (an RFC1918 address of the host side)
        const ipam = fx.inspect<{ Config: Array<{ Gateway?: string }> }>(started.names.network, '.IPAM');
        const gateway = ipam.Config.find(c => c.Gateway)?.Gateway;
        expect(gateway).toMatch(/^(10|172|192)\./);
        const viaGateway = await fx.exec(branch, ['curl', '-s', '--max-time', '5', `http://${gateway}:${port}/`]);
        expect([7, 28]).toContain(viaGateway.status);
        expect(viaGateway.stdout).not.toContain('open');

        // Another private range
        const lan = await fx.exec(branch, ['curl', '-s', '-o', '/dev/null', '--max-time', '5', 'http://10.255.255.1/']);
        expect(lan.status).not.toBe(0);
      } finally {
        server.close();
      }
    });
  });
});
