import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bootstrapScript, defaultKunjPackage } from '../bootstrap';
import { GceProvider } from '../providers/gce';
import { machineLabels } from '../provider';

describe('bootstrapScript', () => {
  it('installs the provider\'s self-suspend script and gives serve the idle flags, only when asked', () => {
    const provider = new GceProvider({ project: 'my-proj-123', zone: 'us-central1-a' });
    const suspend = provider.selfSuspendScript();
    const script = bootstrapScript({ kunjPackage: 'kunj@1.4.0', port: 7433, pairWindowMinutes: 10, selfSuspend: { script: suspend, minutes: 45 } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-bs-'));
    try {
      fs.writeFileSync(path.join(dir, 's.sh'), script);
      execFileSync('bash', ['-n', path.join(dir, 's.sh')]);
      fs.writeFileSync(path.join(dir, 'suspend.sh'), suspend);
      execFileSync('sh', ['-n', path.join(dir, 'suspend.sh')]);
      // the token is cut out of the metadata server's JSON by the script's own sed
      const sed = /sed -n '([^']+)'/.exec(suspend)![1];
      expect(execFileSync('sed', ['-n', sed], { input: '{"access_token":"ya29.abc-DEF_1","expires_in":3599,"token_type":"Bearer"}' }).toString().trim()).toBe('ya29.abc-DEF_1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(script).toContain(`<<'KUNJ_SELF_SUSPEND_EOF'\n${suspend}KUNJ_SELF_SUSPEND_EOF`);
    expect(script).toContain("IDLE_FLAGS='--idle-suspend 45 --idle-command /usr/local/bin/kunj-self-suspend'");
    expect(script).toContain('--pair-window $PAIR_WINDOW $IDLE_FLAGS');
    expect(suspend).toContain('https://compute.googleapis.com/compute/v1/$ZONE/instances/$NAME/suspend');

    const without = bootstrapScript({ kunjPackage: 'kunj@1.4.0', port: 7433, pairWindowMinutes: 10 });
    expect(without).toContain("IDLE_FLAGS=''");
    expect(without).toContain('rm -f /usr/local/bin/kunj-self-suspend');
  });

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
    // no secret: the only mention of a token is the file it deletes on a machine booted from an image
    expect(script.replace(/^#.*$/gm, '').replace(/^\s*rm -f \/home\/kunj\/\.kunj\/serve\/token$/m, '')).not.toMatch(/token/i);
    // a ref may be a commit: fetched and checked out, never `clone --branch`
    expect(script).toContain('git fetch -q --depth 1 "https://github.com/$repo.git" "$ref"');
    expect(script).not.toContain('--branch');
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

  it('drops a baked-in serve token when the machine is not the one that wrote it', () => {
    const script = bootstrapScript({ kunjPackage: 'kunj@1.2.3', port: 7433, pairWindowMinutes: 10 });
    const reset = script.indexOf('rm -f /home/kunj/.kunj/serve/token');
    expect(reset).toBeGreaterThan(-1);
    expect(script).toContain('!= "$ME"');
    expect(reset).toBeLessThan(script.indexOf('systemctl restart kunj-serve'));
  });
});
