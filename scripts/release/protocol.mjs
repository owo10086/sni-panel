import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { baseline, groups } from '../verify.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const requiredFiles = version => [`forwardx-panel-v${version}.tar.gz`, 'forwardx-agent-linux-amd64', 'forwardx-fxp-linux-amd64', 'forwardx-runtime-linux-amd64', 'SHA256SUMS', 'THIRD_PARTY_NOTICES.md', `forwardx-docs-v${version}.tar.gz`, 'verification.tar.gz', 'RELEASE_NOTES.md'];
export function validateEvidence(records, commit, image) {
  for (const name of [...Object.keys(groups), 'bundle', 'image']) {
    const record = records.find(item => item.group === name);
    assert.ok(record, `Missing check: ${name}`);
    assert.equal(record.commit, commit, `${name}: wrong commit`);
    assert.equal(record.status, 'passed', `${name}: failed check`);
    if (groups[name]) {
      assert.equal(record.sourceClean, true, `${name}: source checkout was dirty`);
      assert.equal(record.environment.node, baseline.node);
      assert.equal(record.environment.pnpm, baseline.pnpm);
      assert.ok(record.environment.go.includes(baseline.go + ' '));
      assert.ok(record.environment.os.includes('VERSION_ID="24.04"') && record.environment.os.includes('ID=ubuntu'));
      assert.deepEqual(record.commands.map(item => item.args), groups[name], `${name}: incomplete check list`);
      assert.ok(record.commands.every(item => item.status === 0 && !item.signal));
    }
    if (name === 'image') assert.equal(record.image, image);
  }
}
export function createManifest(directory, identity, records) {
  assert.match(identity.commit, /^[0-9a-f]{40}$/);
  assert.match(identity.version, /^\d+\.\d+\.\d+$/);
  assert.match(identity.agentVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(identity.fxpVersion, identity.agentVersion);
  assert.match(identity.image, /^ghcr\.io\/owo10086\/sni-panel@sha256:[0-9a-f]{64}$/);
  validateEvidence(records, identity.commit, identity.image);
  const artifacts = requiredFiles(identity.version).map(name => {
    const file = fs.readFileSync(path.join(directory, name));
    assert.ok(file.length, `Empty asset: ${name}`);
    return { name, bytes: file.length, sha256: digest(file) };
  });
  return { schema: 1, ...identity, baseline, checks: records, artifacts };
}
export function validateManifest(manifest, directory) {
  assert.equal(manifest.schema, 1);
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.image, /^ghcr\.io\/owo10086\/sni-panel@sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.fxpVersion, manifest.agentVersion);
  validateEvidence(manifest.checks, manifest.commit, manifest.image);
  assert.deepEqual(manifest.artifacts.map(item => item.name).sort(), requiredFiles(manifest.version).sort());
  for (const item of manifest.artifacts) {
    assert.equal(path.basename(item.name), item.name);
    const bytes = fs.readFileSync(path.join(directory, item.name));
    assert.equal(bytes.length, item.bytes, `Wrong size: ${item.name}`);
    assert.equal(digest(bytes), item.sha256, `Wrong checksum: ${item.name}`);
  }
  return digest(JSON.stringify(manifest));
}
// Transfers only; failed business assertions never enter this retry loop.
export async function transfer(operation, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt === 2) throw error;
      await sleep([5000, 15000][attempt]);
    }
  }
}
export async function publish({ manifest, directory, state, save, remote }) {
  const manifestHash = validateManifest(manifest, directory);
  if (state.manifestHash) assert.equal(state.manifestHash, manifestHash, 'Cannot resume different commit/artifacts');
  Object.assign(state, { manifestHash, commit: manifest.commit, version: manifest.version, status: 'incomplete' });
  state.steps ||= {};
  save(state);
  // Reconcile remote state on every run, including after a process dies between
  // a remote success and saving the local checkpoint. Adapters are idempotent.
  for (const step of ['draft', 'upload', 'verify', 'release', 'image']) {
    try {
      await remote[step](manifest, directory);
      state.steps[step] = 'complete';
      delete state.error;
      save(state);
    } catch (error) {
      state.error = { step, message: String(error.message || error) }; save(state); throw error;
    }
  }
  return state;
}
export async function finishDocs({ manifest, directory, state, save, verifyDocs }) {
  assert.equal(state.manifestHash, validateManifest(manifest, directory));
  assert.ok(['draft', 'upload', 'verify', 'release', 'image'].every(step => state.steps?.[step] === 'complete'));
  try {
    await verifyDocs(manifest);
    state.steps.docs = 'complete'; state.status = 'complete'; delete state.error; save(state);
  } catch (error) { state.status = 'incomplete'; state.error = { step: 'docs', message: String(error) }; save(state); throw error; }
}
