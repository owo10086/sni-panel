import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const version = JSON.parse(fs.readFileSync('package.json')).version;
const directory = '.release/candidate';
fs.mkdirSync(directory, { recursive: true });
// No source rebuilds here: only outputs from the successful verification jobs.
execFileSync('tar', ['-czf', `${directory}/forwardx-panel-v${version}.tar.gz`, 'dist/index.js', 'dist/index.js.map', 'dist/migrate-legacy.js', 'dist/migrate-legacy.js.map', 'dist/reset-admin-password.js', 'dist/reset-admin-password.js.map', 'dist/management', 'dist/geo', ...['forwardx-agent-linux-amd64', 'forwardx-fxp-linux-amd64', 'forwardx-runtime-linux-amd64', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md'].map(name => `dist/agent/${name}`), 'client/dist', 'drizzle', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'THIRD_PARTY_NOTICES.md', 'scripts/install-panel-local.sh', 'scripts/install-panel-docker.sh', 'scripts/migrate-agent-legacy.sh']);
for (const name of ['forwardx-agent-linux-amd64', 'forwardx-fxp-linux-amd64', 'forwardx-runtime-linux-amd64', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(`dist/agent/${name}`, `${directory}/${name}`);
execFileSync('tar', ['-czf', `${directory}/forwardx-docs-v${version}.tar.gz`, '-C', 'docs/.vitepress/dist', '.']);
fs.writeFileSync(`${directory}/RELEASE_NOTES.md`, execFileSync(process.execPath, ['scripts/extract-release-notes.mjs', version]));
