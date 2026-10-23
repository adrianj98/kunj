// Copies Monaco's AMD build (min/vs) into the app's resources (Resources/web/vs, ignored by git).
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'node_modules/monaco-editor/min/vs');
const dst = path.join(__dirname, '../Resources/web/vs');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`copied ${path.relative(process.cwd(), src)} -> ${path.relative(process.cwd(), dst)}`);
