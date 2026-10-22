import { describe, it, expect } from '@jest/globals';
import { parseJsonc, parseDevcontainer, DEVCONTAINER_PATHS } from '../devcontainer';

const FILE = '.devcontainer/devcontainer.json';

describe('devcontainer', () => {
  describe('parseJsonc', () => {
    it('parses comments and trailing commas', () => {
      const text = `{
        // line comment
        "a": "x // not a comment", /* block */
        "b": [1, 2,],
        "c": "/* nor this */",
      }`;
      expect(parseJsonc(text)).toEqual({ a: 'x // not a comment', b: [1, 2], c: '/* nor this */' });
    });

    it('keeps escaped quotes inside strings', () => {
      expect(parseJsonc('{"a": "q\\" // still string", }')).toEqual({ a: 'q" // still string' });
    });
  });

  describe('parseDevcontainer', () => {
    it('exposes the search paths', () => {
      expect(DEVCONTAINER_PATHS).toEqual(['.devcontainer/devcontainer.json', '.devcontainer.json']);
    });

    it('resolves build paths relative to the json file', () => {
      const spec = parseDevcontainer('{"build":{"dockerfile":"Dockerfile"}}', FILE);
      expect(spec.build).toEqual({ dockerfile: '.devcontainer/Dockerfile', context: '.devcontainer', args: {} });
      const up = parseDevcontainer('{"build":{"dockerfile":"Dockerfile","context":".."}}', FILE);
      expect(up.build).toEqual({ dockerfile: '.devcontainer/Dockerfile', context: '.', args: {} });
    });

    it('uses the repo root for a root-level devcontainer.json', () => {
      const spec = parseDevcontainer('{"build":{"dockerfile":"Dockerfile","args":{"A":"1"}}}', '.devcontainer.json');
      expect(spec.build).toEqual({ dockerfile: 'Dockerfile', context: '.', args: { A: '1' } });
    });

    it('refuses build paths that leave the repository', () => {
      expect(() => parseDevcontainer('{"build":{"dockerfile":"D","context":".."}}', '.devcontainer.json')).toThrow(
        '.devcontainer.json: build.context must stay inside the repository (got "..")'
      );
      expect(() => parseDevcontainer('{"build":{"dockerfile":"../../x"}}', FILE)).toThrow(
        `${FILE}: build.dockerfile must stay inside the repository (got "../../x")`
      );
      expect(() => parseDevcontainer('{"build":{"dockerfile":"/etc/Dockerfile"}}', FILE)).toThrow(
        'build.dockerfile must stay inside the repository'
      );
    });

    it('refuses remoteUser root', () => {
      for (const u of ['root', '0', '00', 'Root', ' root ', 'root:root', '0:0']) {
        expect(() => parseDevcontainer(JSON.stringify({ remoteUser: u }), FILE)).toThrow(
          `remoteUser must be a non-root user (got "${u}")`
        );
      }
      expect(() => parseDevcontainer('{"remoteUser":0}', FILE)).toThrow('remoteUser must be a non-root user');
    });

    it('accepts a normal remoteUser and leaves a missing one undefined', () => {
      expect(parseDevcontainer('{"remoteUser":"node"}', FILE).remoteUser).toBe('node');
      expect(parseDevcontainer('{"remoteUser":"1000"}', FILE).remoteUser).toBe('1000');
      expect(parseDevcontainer('{}', FILE).remoteUser).toBeUndefined();
    });

    it('joins array postCreateCommand', () => {
      const spec = parseDevcontainer('{"postCreateCommand":["npm","ci"],"postStartCommand":"echo hi"}', FILE);
      expect(spec.postCreateCommand).toBe('npm ci');
      expect(spec.postStartCommand).toBe('echo hi');
    });

    it('ignores object commands and reports the key', () => {
      const spec = parseDevcontainer('{"postCreateCommand":{"a":"x","b":"y"}}', FILE);
      expect(spec.postCreateCommand).toBeUndefined();
      expect(spec.ignoredKeys).toEqual(['postCreateCommand']);
    });

    it('records ignored keys', () => {
      const spec = parseDevcontainer(
        '{"image":"node:20","features":{},"customizations":{},"mounts":[],"workspaceMount":"x","dockerComposeFile":"c.yml"}',
        FILE
      );
      expect(spec.ignoredKeys).toEqual(['customizations', 'features', 'mounts', 'workspaceMount']);
      expect(spec.hasComposeFile).toBe(true);
      expect(spec.image).toBe('node:20');
    });

    it('keeps numeric forwardPorts and string env only', () => {
      const spec = parseDevcontainer('{"forwardPorts":[3000,"db:5432"],"containerEnv":{"A":"1","B":2}}', FILE);
      expect(spec.forwardPorts).toEqual([3000]);
      expect(spec.containerEnv).toEqual({ A: '1' });
      const empty = parseDevcontainer('{}', FILE);
      expect(empty.containerEnv).toEqual({});
      expect(empty.forwardPorts).toEqual([]);
      expect(empty.hasComposeFile).toBe(false);
    });

    it('rejects a non-object document', () => {
      expect(() => parseDevcontainer('[1]', FILE)).toThrow(`${FILE}: expected a JSON object`);
    });
  });
});
