#!/usr/bin/env node
// Generates the reference data the docs render (src/data/*.json) from the CLI's own
// definitions, so the command, settings and hook reference pages cannot drift from the code.
// Runs the TypeScript sources through ts-node from the repository root; needs `npm install` there.

const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = path.resolve(__dirname, '..', 'src', 'data');

// Help text and defaults mention the home directory; render it as ~ whoever builds the docs
const FAKE_HOME = '/__kunj_docs_home__';
process.env.HOME = FAKE_HOME;

require(require.resolve('ts-node', { paths: [repoRoot] })).register({
  transpileOnly: true,
  project: path.join(repoRoot, 'tsconfig.json'),
});

const stripAnsi = s => s.replace(/\u001b\[[0-9;]*m/g, '');

function commands() {
  const { getAllCommands } = require(path.join(repoRoot, 'src', 'commands'));
  return getAllCommands()
    .map(cmd => {
      const c = cmd.getConfig();
      const help = typeof c.helpText === 'function' ? c.helpText() : c.helpText;
      return {
        name: c.name.split(' ')[0],
        usage: c.name + (c.arguments ? ' ' + c.arguments : ''),
        description: c.description,
        arguments: c.arguments ?? null,
        aliases: c.aliases ?? [],
        options: [
          ...(c.options ?? []).map(o => ({
            flags: o.flags,
            description: o.description,
            default: o.defaultValue ?? null,
          })),
          { flags: '--json', description: 'Output result as JSON', default: null },
        ],
        helpText: help ? stripAnsi(help).trimEnd() : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function settings() {
  const { initializeSettings, settingsRegistry } = require(path.join(repoRoot, 'src', 'settings'));
  initializeSettings();
  return settingsRegistry.getAll().map(s => ({
    key: s.key,
    type: s.type,
    category: s.category ?? 'other',
    default: s.sensitive ? null : s.defaultValue ?? null,
    description: s.description,
    detailedDescription: s.detailedDescription ?? null,
    options: s.options ?? null,
    examples: s.examples ?? null,
    relatedSettings: s.relatedSettings ?? null,
    sensitive: !!s.sensitive,
  }));
}

function hooks() {
  const { HOOKS, argVariableName } = require(path.join(repoRoot, 'src', 'lib', 'hook-defs'));
  return HOOKS.map(h => ({
    name: h.name,
    description: h.description,
    args: h.args.map(a => ({ name: a, env: h.env[h.args.indexOf(a)], variable: argVariableName(a) })),
    abortsOnFailure: h.abortsOnFailure,
  }));
}

fs.mkdirSync(outDir, { recursive: true });
for (const [name, data] of Object.entries({ commands: commands(), settings: settings(), hooks: hooks() })) {
  const json = JSON.stringify(data, null, 2).split(FAKE_HOME).join('~');
  fs.writeFileSync(path.join(outDir, `${name}.json`), json + '\n');
  console.log(`wrote src/data/${name}.json (${data.length} entries)`);
}
