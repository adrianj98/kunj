// Copies Monaco's AMD build (min/vs) into the app's resources.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'node_modules/monaco-editor/min/vs');
const dst = path.join(__dirname, '../Resources/web/vs');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`copied ${src} -> ${dst}`);
