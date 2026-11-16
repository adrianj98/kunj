// The rules every MachineProvider keeps (docs/specs/cloud-machines.md, "The provider interface"),
// as one suite each provider's test runs against itself: FakeProvider directly, GceProvider through a
// simulated gcloud. A new provider passes this before anything above the interface may use it.

import { MachineError, MachineProvider, MachineSpec, machineLabels } from '../provider';

export interface ConformanceHarness {
  provider: MachineProvider;
  /** Puts a machine kunj did not create into the cloud */
  addForeign(name: string): void;
}

function spec(name: string, branch: string, over: Partial<MachineSpec> = {}): MachineSpec {
  return {
    name,
    labels: machineLabels('github.com/acme/App.Repo', branch, { 'kunj.version': '1.2.3', 'kunj.image': '', 'kunj.owner': 'laptop' }),
    size: 'medium',
    image: '',
    diskGb: 30,
    spot: false,
    selfSuspend: false,
    ...over,
  };
}

export function providerConformance(title: string, make: () => ConformanceHarness): void {
  describe(`${title}: provider conformance`, () => {
    let h: ConformanceHarness;
    beforeEach(() => {
      h = make();
    });

    it('creates a machine that is found by its exact labels, whatever characters the branch has', async () => {
      const s = spec('kunj-app-feature-x-abc123', 'Feature/X_y.2~weird');
      const created = await h.provider.create(s);
      expect(created.name).toBe(s.name);
      expect(created.labels).toEqual(s.labels);
      const found = await h.provider.list({ 'kunj.repo': 'github.com/acme/App.Repo', 'kunj.branch': 'Feature/X_y.2~weird' });
      expect(found.map(m => m.name)).toEqual([s.name]);
      expect(found[0].labels).toEqual(s.labels);
      expect((await h.provider.get(s.name))?.labels).toEqual(s.labels);
    });

    it('lists by exact match only', async () => {
      await h.provider.create(spec('kunj-app-a-111111', 'a'));
      await h.provider.create(spec('kunj-app-ab-222222', 'ab'));
      const found = await h.provider.list({ 'kunj.branch': 'a' });
      expect(found.map(m => m.name)).toEqual(['kunj-app-a-111111']);
      expect(await h.provider.list({ 'kunj.branch': 'nope' })).toEqual([]);
    });

    it('refuses to create a name twice', async () => {
      await h.provider.create(spec('kunj-app-a-111111', 'a'));
      await expect(h.provider.create(spec('kunj-app-a-111111', 'a'))).rejects.toMatchObject({ code: 'machine-exists' });
    });

    it('moves through suspend, resume, stop and start, idempotently', async () => {
      await h.provider.create(spec('kunj-app-a-111111', 'a'));
      await h.provider.suspend('kunj-app-a-111111');
      await h.provider.suspend('kunj-app-a-111111');
      expect((await h.provider.get('kunj-app-a-111111'))?.state).toBe(h.provider.features.suspend ? 'suspended' : 'stopped');
      await h.provider.resume('kunj-app-a-111111');
      await h.provider.resume('kunj-app-a-111111');
      expect((await h.provider.get('kunj-app-a-111111'))?.state).toBe('running');
      await h.provider.stop('kunj-app-a-111111');
      await h.provider.stop('kunj-app-a-111111');
      expect((await h.provider.get('kunj-app-a-111111'))?.state).toBe('stopped');
      await h.provider.start('kunj-app-a-111111');
      expect((await h.provider.get('kunj-app-a-111111'))?.state).toBe('running');
    });

    it('deletes, and deleting a missing machine is not an error', async () => {
      await h.provider.create(spec('kunj-app-a-111111', 'a'));
      await h.provider.delete('kunj-app-a-111111', { disks: true });
      expect(await h.provider.get('kunj-app-a-111111')).toBeNull();
      await h.provider.delete('kunj-app-a-111111', { disks: true });
      await h.provider.delete('never-there', { disks: true });
    });

    it('never touches a machine kunj did not create', async () => {
      h.addForeign('someone-elses-vm');
      for (const op of ['suspend', 'resume', 'stop', 'start'] as const) {
        await expect(h.provider[op]('someone-elses-vm')).rejects.toBeInstanceOf(MachineError);
        await expect(h.provider[op]('someone-elses-vm')).rejects.toMatchObject({ code: 'machine-not-kunj' });
      }
      await expect(h.provider.delete('someone-elses-vm', { disks: true })).rejects.toMatchObject({ code: 'machine-not-kunj' });
      expect(await h.provider.get('someone-elses-vm')).not.toBeNull();
      expect((await h.provider.list({ 'kunj.role': 'machine' })).map(m => m.name)).not.toContain('someone-elses-vm');
    });

    it('reports a missing machine as not found on every state change', async () => {
      for (const op of ['suspend', 'resume', 'stop', 'start'] as const) {
        await expect(h.provider[op]('never-there')).rejects.toMatchObject({ code: 'machine-not-found' });
      }
    });

    it('maps every size class to a shape and gives a reachable address or a tunnel', async () => {
      expect(h.provider.sizes().map(s => s.name)).toEqual(['small', 'medium', 'large']);
      const m = await h.provider.create(spec('kunj-app-a-111111', 'a'));
      const address = h.provider.address(m, 7433);
      const tunnel = h.provider.tunnel(m, 7433, 40001);
      expect(address === null || (typeof address.host === 'string' && address.port === 7433)).toBe(true);
      expect(tunnel.argv.length).toBeGreaterThan(0);
      expect(tunnel.argv.join(' ')).toContain('40001');
    });

    it('bakes, lists and deletes golden images with exact labels', async () => {
        if (!h.provider.features.images) return;
        const m = await h.provider.create(spec('kunj-app-a-111111', 'a'));
        const labels = { 'kunj.repo': 'github.com/acme/App.Repo', 'kunj.role': 'machine-image', 'kunj.blueprint': 'abc123def', 'kunj.version': '1.2.3' };
        await h.provider.images.createFrom(m, 'kunj-app-img-abc123', labels);
        const found = await h.provider.images.list({ 'kunj.repo': 'github.com/acme/App.Repo', 'kunj.role': 'machine-image' });
        expect(found.map(i => i.name)).toEqual(['kunj-app-img-abc123']);
        expect(found[0].labels).toEqual(labels);
        await h.provider.images.delete('kunj-app-img-abc123');
        expect(await h.provider.images.list({ 'kunj.role': 'machine-image' })).toEqual([]);
    });
  });
}
