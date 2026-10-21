import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { digest, transfer } from './protocol.mjs';
const image = process.env.RELEASE_IMAGE;
assert.match(image, /^(?:ghcr\.io\/owo10086\/sni-panel@)?sha256:[a-f0-9]{64}$/);
const version = JSON.parse(fs.readFileSync('package.json')).version;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const run = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
// Local development can inspect a content-addressed image ID without a push.
// seal.mjs still requires the official GHCR repository digest for publication.
if (!image.startsWith('sha256:')) await transfer(() => run(['pull', '--platform', 'linux/amd64', image]));
const inspect = JSON.parse(run(['image', 'inspect', image]))[0];
assert.equal(inspect.Architecture, 'amd64');
assert.equal(inspect.Config.Labels['org.opencontainers.image.version'], version);
assert.equal(inspect.Config.Labels['org.opencontainers.image.revision'], commit);
run(['run', '--platform', 'linux/amd64', '--rm', '--entrypoint', 'node', image, '-e', `
  const assert = require('node:assert/strict');
  const Database = require('better-sqlite3'); const db = new Database(':memory:');
  assert.equal(db.prepare('select 1').pluck().get(), 1); db.close();
  assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v22.23.3');
  assert.equal(require('./package.json').version, '${version}');
`]);
const container = run(['run', '--platform', 'linux/amd64', '-d', '--tmpfs', '/data', '-e', 'DATABASE_TYPE=sqlite', image]);
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = spawnSync('docker', ['exec', container, 'node', '-e', `fetch('http://127.0.0.1:3000/').then(async r => {if (!r.ok || !(await r.text()).includes('<!doctype html')) process.exit(1)}).catch(()=>process.exit(1))`], { encoding: 'utf8' });
    if (probe.status === 0) { ready = true; break; }
    if (run(['inspect', '-f', '{{.State.Running}}', container]) !== 'true') break;
    await setTimeout(1000);
  }
  assert.ok(ready, `Packaged runtime did not start:\n${run(['logs', container])}`);
  for (const name of ['forwardx-agent-linux-amd64', 'forwardx-fxp-linux-amd64', 'forwardx-runtime-linux-amd64']) {
    const expected = digest(fs.readFileSync(`.release/candidate/${name}`));
    assert.equal(run(['exec', container, 'sha256sum', `/app/dist/agent/${name}`]).split(' ')[0], expected);
  }
} finally { run(['logs', container]); run(['rm', '-f', '-v', container]); }
fs.mkdirSync('.release/checks', { recursive: true });
for (const group of ['bundle', 'image']) fs.writeFileSync(`.release/checks/${group}.json`, JSON.stringify({ group, status: 'passed', commit, image, package: `forwardx-panel-v${version}.tar.gz` }, null, 2) + '\n');
console.log(`Verified package startup, native dependencies and image by digest: ${image}`);
