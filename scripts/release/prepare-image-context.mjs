import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { digest } from './protocol.mjs';
const version = JSON.parse(fs.readFileSync('package.json')).version;
const bundle = `.release/candidate/forwardx-panel-v${version}.tar.gz`;
const context = '.release/image-context';
const listing = execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' }).trim().split('\n');
assert.ok(listing.every(name => !name.startsWith('/') && !name.split('/').includes('..')), 'Unsafe package path');
fs.rmSync(context, { recursive: true, force: true }); fs.mkdirSync(context, { recursive: true });
execFileSync('tar', ['-xzf', bundle, '-C', context]);
assert.equal(JSON.parse(fs.readFileSync(`${context}/package.json`)).version, version);
for (const name of ['forwardx-agent-linux-amd64', 'forwardx-fxp-linux-amd64', 'forwardx-runtime-linux-amd64', 'THIRD_PARTY_NOTICES.md', 'SHA256SUMS']) {
  assert.equal(digest(fs.readFileSync(`${context}/dist/agent/${name}`)), digest(fs.readFileSync(`.release/candidate/${name}`)), `Bundled ${name} differs from standalone download`);
}
execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: `${context}/dist/agent`, stdio: 'inherit' });
console.log(`Verified actual package payload and shared binary identity: ${bundle}`);
