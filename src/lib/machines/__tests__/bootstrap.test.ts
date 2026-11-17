import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootstrapScript, defaultKunjPackage } from '../bootstrap';
import { GceProvider } from '../providers/gce';
import { machineLabels } from '../provider';

describe('bootstrapScript', () => {
  it('is valid bash that installs the package and starts kunj serve with pairing on the internal address', () => {
    const script = bootstrapScript({ kunjPackage: 'kunj@1.4.0', port: 7433, pairWindowMinutes: 10 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-bs-'));
    try {
      const file = path.join(dir, 's.sh');
      fs.writeFileSync(file, script);
      execFileSync('bash', ['-n', file]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(script).toContain("KUNJ_PACKAGE='kunj@1.4.0'");
    expect(script).toContain('serve --listen $IP:$PORT --allow-remote-listen --allow-pairing --pair-window $PAIR_WINDOW');
    expect(script).toContain('User=kunj');
    expect(script).not.toMatch(/token/i);
  });

  it('refuses a package that is not an npm version of kunj or a GitHub ref', () => {
    for (const bad of ['', 'left-pad@1', "kunj@1'; rm -rf /", 'github:a/b', 'github:a/b#x y', 'github:../x#main', 'https://evil/x.tgz']) {
      expect(() => bootstrapScript({ kunjPackage: bad, port: 7433, pairWindowMinutes: 10 })).toThrow(/kunjPackage/);
    }
    expect(() => bootstrapScript({ kunjPackage: 'github:adrianj98/kunj#feature/x', port: 7433, pairWindowMinutes: 10 })).not.toThrow();
    expect(() => bootstrapScript({ kunjPackage: 'kunj@1.4.0', port: 0, pairWindowMinutes: 10 })).toThrow(/port/);
  });

  it('defaults to this version from npm, and to main from GitHub for a development build', () => {
    expect(defaultKunjPackage('1.4.2')).toBe('kunj@1.4.2');
    expect(defaultKunjPackage('1.0.0')).toBe('github:adrianj98/kunj#main');
  });
});

describe('GceProvider startup script', () => {
  it('passes the script by file, readable while gcloud runs and removed afterwards', async () => {
    let seen = '';
    let file = '';
    const p = new GceProvider({ project: 'my-proj-123', zone: 'us-central1-a' }, {
      run: async (_cmd, args) => {
        const i = args.indexOf('--metadata-from-file');
        expect(i).toBeGreaterThan(0);
        file = args[i + 1].replace(/^startup-script=/, '');
        seen = fs.readFileSync(file, 'utf8');
        return { code: 0, stdout: JSON.stringify([{ name: 'kunj-a-1', status: 'RUNNING' }]), stderr: '' };
      },
    });
    await p.create({ name: 'kunj-a-1', labels: machineLabels('r', 'b'), size: 'small', image: '', diskGb: 30, spot: false, selfSuspend: false, startupScript: '#!/bin/bash\necho hi\n' });
    expect(seen).toBe('#!/bin/bash\necho hi\n');
    expect(fs.existsSync(file)).toBe(false);
  });
});
