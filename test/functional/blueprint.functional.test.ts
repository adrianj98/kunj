// A blueprint's snapshot built by the first start and reused by the next, through the built CLI.
// Opt-in: npm run test:functional.
import { describe, it, expect } from '@jest/globals';
import { LABEL } from '../../src/lib/container/names';
import { describeFunctional, docker, useFixture } from './harness';

interface BlueprintStatusJson {
  source: string | null;
  path?: string;
  hash?: string | null;
  snapshot?: { tag: string; createdAt: string; sizeBytes: number } | null;
  stale?: boolean | null;
  others?: string[];
  notes?: string | null;
}

// setup and maintain append to ignored files in /workspace, so a count of lines says how often each ran
const BLUEPRINT = {
  setup: ['echo setup >> ft-setup.txt'],
  maintain: ['echo maintain >> ft-maintain.txt'],
  notes: 'functional test blueprint',
};

describeFunctional('kunj ct (functional): blueprint', () => {
  const ctx = useFixture('bp', {
    files: {
      '.kunj/blueprint.json': JSON.stringify(BLUEPRINT, null, 2) + '\n',
      '.gitignore': 'ft-*.txt\n',
    },
  });

  describe('snapshot', () => {
    it('the first start builds the snapshot, a second branch starts from it: setup ran once, maintain on each start', async () => {
      const { fx } = ctx;

      const before = await fx.kunjJson<BlueprintStatusJson>(['ct', 'blueprint', 'status']);
      expect(before).toMatchObject({ source: 'worktree', snapshot: null, notes: BLUEPRINT.notes });
      expect(before.hash).toMatch(/^[0-9a-f]+$/);

      const first = await fx.start('ft-bp-a');
      expect(first.blueprint).toMatchObject({ hash: before.hash, stale: false, setupRan: false, maintainRan: true });
      const tag = first.blueprint!.snapshot!;
      expect(tag).toBeTruthy();
      expect(first.image).toBe(tag);

      const status = await fx.kunjJson<BlueprintStatusJson>(['ct', 'blueprint', 'status']);
      expect(status).toMatchObject({ source: 'worktree', hash: before.hash, stale: false });
      expect(status.snapshot?.tag).toBe(tag);
      // The snapshot is labelled as this repository's (that is how cleanup and prune find it)
      const labels = JSON.parse(docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', tag])) as Record<string, string>;
      expect(labels[LABEL.repo]).toBe(fx.repoId);
      expect(labels[LABEL.blueprintHash]).toBe(before.hash);

      const second = await fx.start('ft-bp-b');
      expect(second.blueprint).toMatchObject({ snapshot: tag, hash: before.hash, setupRan: false, maintainRan: true });
      expect(second.image).toBe(tag);
      // setup's marker came from the snapshot (one line: not run again); maintain ran once in this container
      const markers = await fx.sh('ft-bp-b', 'cat ft-setup.txt; echo ---; cat ft-maintain.txt; echo ---; git rev-parse --abbrev-ref HEAD');
      expect(markers.status).toBe(0);
      expect(markers.stdout.trim().split('\n')).toEqual(['setup', '---', 'maintain', '---', 'ft-bp-b']);

      const list = await fx.kunjJson(['ct', 'list']);
      const entry = list.containers.find((c: { branch: string }) => c.branch === 'ft-bp-b');
      expect(entry).toMatchObject({ imageInfo: { tag, kind: 'blueprint' }, blueprint: { hash: before.hash, stale: false } });
    });
  });
});
