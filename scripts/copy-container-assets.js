#!/usr/bin/env node
// Copies the container image build contexts (src/container) next to the compiled code, where
// sandboxAssetsDir() finds them, and makes the scripts executable whatever the checkout did.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'container');
const dest = path.join(root, 'dist', 'container');

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

const walk = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.sh') || entry.name === 'git-credential-kunj' || entry.name === 'kunj-dind-start') fs.chmodSync(full, 0o755);
  }
};
walk(dest);
