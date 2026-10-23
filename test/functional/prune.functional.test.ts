// kunj ct prune: containers of branches deleted on origin, unpushed work kept, orphans, through the
// built CLI. Opt-in: npm run test:functional.
//
// `prune --yes` also removes kunj's own images of other versions that no container uses, on the
// whole daemon (not only this repository's). So the steps that apply a prune run only when the dry
// run plans no image removal, or with KUNJ_FUNCTIONAL_PRUNE_IMAGES=1; otherwise they are reported
// and skipped, and only the dry run is checked.
//
// An orphan younger than ORPHAN_GRACE_MS (10 minutes) is taken to be starting and is not reported, so
// the test of an orphan volume kept without --force waits that long; it runs only with
// KUNJ_FUNCTIONAL_SLOW=1. Without it the grace period itself is checked.
import { describe, it, expect } from '@jest/globals';
import { KEPT_VOLUME, ORPHAN_GRACE_MS } from '../../src/lib/container/prune';
import type { ContainerListJson } from '../../src/lib/json-types';
import { PruneJson, describeFunctional, docker, useFixture } from './harness';

const slow = process.env.KUNJ_FUNCTIONAL_SLOW === '1';
const pruneImages = process.env.KUNJ_FUNCTIONAL_PRUNE_IMAGES === '1';

describeFunctional('kunj ct (functional): prune', () => {
  const ctx = useFixture('prune');

  /** Whether `prune --yes` may run: it would remove no image, or the run allows it. */
  function mayApply(dry: PruneJson): boolean {
    if (dry.plan.images.length === 0 || pruneImages) return true;
    process.stderr.write(
      `prune: not applying, it would also remove kunj images on this daemon (${dry.plan.images.join(', ')}); ` +
        'set KUNJ_FUNCTIONAL_PRUNE_IMAGES=1 to allow it\n'
    );
    return false;
  }

  describe('branches gone from origin', () => {
    it('a container of a deleted branch with clean work is listed by --dry-run and removed by --yes', async () => {
      const { fx } = ctx;
      const branch = 'ft-gone';
      const started = await fx.start(branch);
      // On origin, then deleted there (merged, say): the clone knows origin had it
      expect((await fx.sh(branch, 'git commit -q --allow-empty -m gone && git push -q')).status).toBe(0);
      fx.deleteOnOrigin(branch);

      const dry = await fx.kunjJson<PruneJson>(['ct', 'prune', '--dry-run']);
      expect(dry.dryRun).toBe(true);
      expect(dry.removed).toEqual([]);
      const planned = dry.plan.containers.find(c => c.branch === branch);
      expect(planned).toMatchObject({ branch, reason: 'branch-gone' });
      expect(planned?.kept).toBeUndefined();
      expect(fx.inspect<string>(started.names.container, '.State.Status')).toBe('running');

      // --json without --yes is a dry run too
      const implicit = await fx.kunjJson<PruneJson>(['ct', 'prune']);
      expect(implicit.dryRun).toBe(true);
      expect(fx.labelled(branch).containers).not.toHaveLength(0);

      if (!mayApply(dry)) return;
      const applied = await fx.kunjJson<PruneJson>(['ct', 'prune', '--yes']);
      expect(applied).toMatchObject({ success: true, dryRun: false, failed: [] });
      expect(applied.removed.join('\n')).toContain(started.names.container);
      expect(fx.labelled(branch)).toEqual({ containers: [], volumes: [], networks: [] });
    });

    it('a container of a deleted branch with unpushed work is kept', async () => {
      const { fx } = ctx;
      const branch = 'ft-wip';
      const started = await fx.start(branch);
      expect((await fx.sh(branch, 'git commit -q --allow-empty -m pushed && git push -q')).status).toBe(0);
      expect((await fx.sh(branch, 'echo wip > wip.txt && git add wip.txt && git commit -qm wip')).status).toBe(0);
      fx.deleteOnOrigin(branch);

      const dry = await fx.kunjJson<PruneJson>(['ct', 'prune', '--dry-run']);
      const planned = dry.plan.containers.find(c => c.branch === branch);
      expect(planned).toMatchObject({ branch, reason: 'branch-gone', kept: expect.stringMatching(/unpushed commits/) });

      if (!mayApply(dry)) return;
      const applied = await fx.kunjJson<PruneJson>(['ct', 'prune', '--yes']);
      expect(applied.removed.join('\n')).not.toContain(started.names.container);
      expect(fx.inspect<string>(started.names.container, '.State.Status')).toBe('running');
    });
  });

  describe('orphans', () => {
    // The branch container goes behind kunj's back: its helper, volumes and network are left
    async function orphan(branch: string) {
      const { fx } = ctx;
      const started = await fx.start(branch);
      docker(['rm', '-f', started.names.container]);
      return started.names;
    }

    (slow ? it.skip : it)('are not reported while they may still be starting (younger than the grace period)', async () => {
      const { fx } = ctx;
      const names = await orphan('ft-young');
      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.orphans.filter(o => o.name.startsWith(names.container))).toEqual([]);
      const dry = await fx.kunjJson<PruneJson>(['ct', 'prune', '--dry-run']);
      expect(dry.plan.orphans.filter(o => o.name.startsWith(names.container))).toEqual([]);
    });

    (slow ? it : it.skip)(
      'an orphan volume is kept without --force and removed with it; its helper and network go',
      async () => {
        const { fx } = ctx;
        const names = await orphan('ft-orphan');
        await new Promise(r => setTimeout(r, ORPHAN_GRACE_MS + 30_000));

        const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
        expect(list.orphans).toEqual(expect.arrayContaining([
          { kind: 'container', name: names.helper },
          { kind: 'volume', name: names.workspaceVolume },
          { kind: 'network', name: names.network },
        ]));
        const dry = await fx.kunjJson<PruneJson>(['ct', 'prune', '--dry-run']);
        expect(dry.plan.orphans).toEqual(expect.arrayContaining([
          { kind: 'container', name: names.helper },
          { kind: 'volume', name: names.workspaceVolume, kept: KEPT_VOLUME },
          { kind: 'volume', name: names.homeVolume, kept: KEPT_VOLUME },
          { kind: 'network', name: names.network },
        ]));

        if (!mayApply(dry)) return;
        await fx.kunjJson<PruneJson>(['ct', 'prune', '--yes']);
        // `docker volume ls -q` prints names
        expect(fx.labelled('ft-orphan').volumes.sort()).toEqual([names.homeVolume, names.workspaceVolume].sort());
        expect(fx.labelled('ft-orphan').containers).toEqual([]);
        expect(fx.labelled('ft-orphan').networks).toEqual([]);

        await fx.kunjJson<PruneJson>(['ct', 'prune', '--yes', '--force']);
        expect(fx.labelled('ft-orphan')).toEqual({ containers: [], volumes: [], networks: [] });
      },
      ORPHAN_GRACE_MS + 10 * 60 * 1000
    );
  });
});
