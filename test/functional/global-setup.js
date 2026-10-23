// globalSetup of jest.functional.config.js. The functional suite is opt-in: without
// KUNJ_FUNCTIONAL=1 (set by `npm run test:functional`) nothing is built and every file is skipped.
// With it, Docker must answer (else the suite is skipped with a message) and the CLI is built, so
// the tests drive the current sources through dist/index.js.
//
// Workers are started after this runs and inherit process.env: KUNJ_FUNCTIONAL_SKIP is how the test
// files (describeFunctional in harness.ts) learn that they must skip.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function globalSetup() {
  if (process.env.KUNJ_FUNCTIONAL !== '1') {
    process.env.KUNJ_FUNCTIONAL_SKIP = 'KUNJ_FUNCTIONAL is not set';
    process.stderr.write(
      '\nkunj functional tests are opt-in and were skipped: run them with `npm run test:functional` ' +
        '(they need Docker, take many minutes and create and remove containers).\n\n'
    );
    return;
  }

  try {
    const version = execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20000 }).trim();
    if (!version) throw new Error('no server version');
  } catch (err) {
    process.env.KUNJ_FUNCTIONAL_SKIP = 'Docker is not reachable';
    process.stderr.write(`\nkunj functional tests skipped: Docker is not reachable (docker info: ${err.message.split('\n')[0]}).\n\n`);
    return;
  }

  process.stderr.write('\nBuilding the CLI for the functional tests (npm run build)...\n');
  execFileSync('npm', ['run', 'build'], { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit' });
};
