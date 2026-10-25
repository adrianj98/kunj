// start / list / stop / start (resume) / remove, the remove guard, and the container hooks,
// through the built CLI. Opt-in: npm run test:functional.
import { describe, it, expect } from '@jest/globals';
import * as path from 'path';
import type { ContainerListJson } from '../../src/lib/json-types';
import { describeFunctional, functionalRemote, readMarker, useFixture } from './harness';

describeFunctional('kunj ct (functional): lifecycle', () => {
  const ctx = useFixture('life');

  describe('start, list, stop, resume, remove', () => {
    it('start -c creates and seeds the container, list shows it, stop then start resumes the same one, remove --force leaves nothing', async () => {
      const { fx } = ctx;
      const branch = 'ft-life';
      const started = await fx.start(branch);
      expect(started).toMatchObject({ branch, created: true, seeded: true, firewall: 'default' });
      expect(started.names).toEqual(fx.names(branch));

      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.repo).toBe(fx.repoName);
      expect(list.backend.kind).toBe(functionalRemote ? 'remote' : 'docker');
      expect(Array.isArray(list.orphans)).toBe(true);
      const entry = list.containers.find(c => c.branch === branch);
      expect(entry).toMatchObject({
        name: started.names.container,
        id: started.containerId,
        state: 'running',
        firewall: 'default',
        dind: 'off',
        status: 'ok',
        agent: { running: false },
      });
      // Every field the extension and the macOS app read is there
      expect(Array.isArray(entry!.services)).toBe(true);
      expect(Array.isArray(entry!.ports)).toBe(true);
      expect(Array.isArray(entry!.bridges)).toBe(true);
      expect(entry!.workspace.head).toMatch(/^[0-9a-f]{7}$/);
      expect(entry!.workspace.dirty).toBe(false);

      // Something in the workspace that must survive the stop
      expect((await fx.sh(branch, 'echo kept > .git/ft-kept')).status).toBe(0);

      const stopped = await fx.kunjJson(['ct', 'stop', branch]);
      expect(stopped).toEqual({ success: true, branch, name: started.names.container });
      expect(fx.inspect<string>(started.names.container, '.State.Status')).not.toBe('running');
      const afterStop = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(afterStop.containers.find(c => c.branch === branch)?.state).not.toBe('running');

      const resumed = await fx.kunjJson(['ct', 'start', branch]);
      expect(resumed).toMatchObject({ branch, created: false, containerId: started.containerId });
      expect(fx.inspect<string>(started.names.container, '.State.Status')).toBe('running');
      expect(fx.inspect<string>(started.names.helper, '.State.Status')).toBe('running');
      const kept = await fx.sh(branch, 'cat .git/ft-kept');
      expect(kept.stdout.trim()).toBe('kept');

      const removed = await fx.kunjJson(['ct', 'remove', branch, '--force']);
      expect(removed).toEqual({ success: true, branch, name: started.names.container, keptVolumes: false });
      expect(fx.labelled(branch)).toEqual({ containers: [], volumes: [], networks: [] });
      const empty = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(empty.containers.find(c => c.branch === branch)).toBeUndefined();
    });
  });

  describe('remove guard', () => {
    it('remove refuses while the container has an unpushed commit, and succeeds once it is pushed', async () => {
      const { fx } = ctx;
      const branch = 'ft-guard';
      const started = await fx.start(branch);
      const commit = await fx.sh(branch, 'echo guard > guard.txt && git add guard.txt && git commit -qm guard && git rev-parse HEAD');
      expect(commit.status).toBe(0);
      const head = commit.stdout.trim().split('\n').pop();

      const refused = await fx.kunjJsonError(['ct', 'remove', branch]);
      expect(refused.message).toMatch(/origin does not have/);
      expect(refused.message).toMatch(/unpushed commits on ft-guard/);
      expect(fx.labelled(branch).containers).not.toHaveLength(0);
      expect(fx.inspect<string>(started.names.container, '.State.Status')).toBe('running');

      // push.autoSetupRemote: a plain push from inside reaches the throwaway origin
      expect((await fx.exec(branch, ['git', 'push', '-q'])).status).toBe(0);
      expect(fx.originHead(branch)).toBe(head);

      const removed = await fx.kunjJson(['ct', 'remove', branch]);
      expect(removed).toMatchObject({ success: true, branch });
      expect(fx.labelled(branch)).toEqual({ containers: [], volumes: [], networks: [] });
    });
  });

  describe('hooks', () => {
    it('pre-container-create and post-container-delete run with the branch, and only when creating and deleting', async () => {
      const { fx } = ctx;
      // A slash in the branch also checks the ${branch} quoting
      const branch = 'ft/hooks';
      const pre = path.join(fx.scratch, 'pre-create');
      const post = path.join(fx.scratch, 'post-delete');
      fx.writeConfig({
        hooks: {
          'pre-container-create': `printf '%s\\n' \${branch} >> ${pre}`,
          'post-container-delete': `printf '%s\\n' \${branch} >> ${post}`,
        },
      });

      await fx.start(branch);
      expect(readMarker(pre)).toBe(`${branch}\n`);
      expect(readMarker(post)).toBeNull();

      // Resuming creates nothing, so the create hook does not run again
      await fx.kunjJson(['ct', 'stop', branch]);
      await fx.kunjJson(['ct', 'start', branch]);
      expect(readMarker(pre)).toBe(`${branch}\n`);

      await fx.kunjJson(['ct', 'remove', branch, '--force']);
      expect(readMarker(post)).toBe(`${branch}\n`);
      expect(fx.labelled(branch)).toEqual({ containers: [], volumes: [], networks: [] });
    });
  });
});
