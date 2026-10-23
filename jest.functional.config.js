/**
 * The opt-in functional suite: the built CLI against the real Docker daemon (test/functional).
 * Run it only with `npm run test:functional`; without KUNJ_FUNCTIONAL=1 every file is skipped.
 * `npm test` and `npm run test:docker` never see these files: their roots are src/.
 * @type {import('jest').Config}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/functional'],
  testMatch: ['**/*.functional.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/functional/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/test/functional/global-setup.js',
  // One test at a time: they share the Docker daemon, build images and bind host ports
  maxWorkers: 1,
  testTimeout: 10 * 60 * 1000,
  verbose: true,
};
