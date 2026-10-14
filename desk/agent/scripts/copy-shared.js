const fs = require('node:fs');
const path = require('node:path');

const agentDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(agentDir, '..');
const vendorDir = path.join(agentDir, 'vendor');

fs.rmSync(vendorDir, { recursive: true, force: true });
fs.mkdirSync(vendorDir, { recursive: true });
fs.cpSync(path.join(repoDir, 'shared'), path.join(vendorDir, 'shared'), { recursive: true });
fs.copyFileSync(path.join(repoDir, 'web', 'style.css'), path.join(vendorDir, 'web-style.css'));
