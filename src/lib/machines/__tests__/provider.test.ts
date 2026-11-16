import { FakeProvider } from './fake-provider';
import { providerConformance } from './conformance';
import { MachineError, isKunjMachine, labelsInclude, machineLabels, machineName, shapeOf } from '../provider';
import { createProvider, providerNames, registerProvider, unregisterProvider } from '../providers';

providerConformance('FakeProvider', () => {
  const provider = new FakeProvider();
  return { provider, addForeign: name => provider.addForeign(name) };
});

describe('machineName', () => {
  it('is the container name as a lowercase DNS label, hash kept', () => {
    const name = machineName('My_Repo', 'github.com/acme/my_repo', 'Feature/Big.Thing');
    expect(name).toMatch(/^[a-z]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.startsWith('kunj-my-repo-feature-big-thing-')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it('keeps branches that differ only by case or punctuation apart', () => {
    const a = machineName('r', 'id', 'feature/x');
    const b = machineName('r', 'id', 'feature-x');
    const c = machineName('r', 'id', 'Feature/X');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('clips a long branch but keeps the hash', () => {
    const name = machineName('repo', 'id', 'x'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/-[0-9a-f]{6}$/);
  });
});

describe('labels', () => {
  it('marks kunj machines and matches filters exactly', () => {
    const labels = machineLabels('r', 'b', { 'kunj.owner': 'me' });
    expect(isKunjMachine({ labels })).toBe(true);
    expect(isKunjMachine({ labels: { 'kunj.repo': 'r' } })).toBe(false);
    expect(labelsInclude(labels, { 'kunj.repo': 'r', 'kunj.branch': 'b' })).toBe(true);
    expect(labelsInclude(labels, { 'kunj.branch': 'bb' })).toBe(false);
  });

  it('maps a size class to its shape and passes a shape through', () => {
    const p = new FakeProvider();
    expect(shapeOf(p, 'medium')).toBe('fake-8');
    expect(shapeOf(p, 'n2-highmem-8')).toBe('n2-highmem-8');
  });
});

describe('provider registry', () => {
  afterEach(() => unregisterProvider('fake'));

  it('creates a registered provider and explains an unknown or missing one', async () => {
    registerProvider('fake', async () => new FakeProvider());
    expect(providerNames()).toEqual(expect.arrayContaining(['fake', 'gce']));
    expect((await createProvider('fake')).name).toBe('fake');
    await expect(createProvider('nope')).rejects.toMatchObject({ code: 'machine-provider' });
    await expect(createProvider('')).rejects.toBeInstanceOf(MachineError);
  });
});
