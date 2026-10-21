import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { publish, finishDocs, transfer, validateManifest } from './protocol.mjs';

const repo = 'owo10086/sni-panel';
const directory = '.release/candidate';
const manifest = JSON.parse(fs.readFileSync(`${directory}/manifest.json`));
validateManifest(manifest, directory);
const tag = `v${manifest.version}`;
const command = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${program}: ${result.stderr || result.error || result.status}`);
  return result.stdout;
};
assert.equal(process.env.GITHUB_REPOSITORY, repo, 'Only the sni-panel repository may publish');
assert.equal(process.env.GITHUB_REF_NAME, tag, 'Dispatch from the immutable version tag');
assert.equal(command('git', ['rev-parse', 'HEAD']).trim(), manifest.commit);
assert.equal(JSON.parse(await transfer(() => command('gh', ['api', `repos/${repo}/commits/${tag}`]))).sha, manifest.commit, 'Remote tag must resolve to the verified commit');
const stateFile = '.release/state.json';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
const save = value => {
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(stateFile + '.tmp', stateFile);
  console.log(`Release ${tag}: ${value.status}; completed: ${Object.keys(value.steps || {}).join(', ')}`);
};
async function getRelease(endpoint) {
  return transfer(() => {
    try {
      if (endpoint.startsWith('tags/')) {
        // gh handles both published REST lookup and authenticated draft lookup.
        const value = JSON.parse(command('gh', ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,tagName,assets']));
        return { draft: value.isDraft, tag_name: value.tagName, assets: value.assets };
      }
      return JSON.parse(command('gh', ['api', `repos/${repo}/releases/${endpoint}`]));
    } catch (error) {
      if (/HTTP 404|release not found/i.test(String(error))) return null;
      throw error;
    }
  });
}
let release;
const verifyRemote = async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardx-release-'));
  try {
    await transfer(() => command('gh', ['release', 'download', tag, '--repo', repo, '--dir', temp, '--clobber']));
    const remoteManifest = JSON.parse(fs.readFileSync(path.join(temp, 'manifest.json')));
    assert.deepEqual(remoteManifest, manifest, 'Remote candidate differs; never replace its manifest');
    validateManifest(remoteManifest, temp);
    const expected = [...manifest.artifacts.map(item => item.name), 'manifest.json'].sort();
    assert.deepEqual(fs.readdirSync(temp).sort(), expected, 'Unexpected/missing release attachment');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
};
const adapter = {
  async draft() {
    const latest = await getRelease('latest');
    if (latest) {
      const current = latest.tag_name.replace(/^v/, '').split('.').map(Number);
      const target = manifest.version.split('.').map(Number);
      const delta = target.map((n, i) => n - current[i]).find(n => n !== 0) || 0;
      assert.ok(delta >= 0, 'A newer release is already public; refusing to roll back latest');
    }
    release = await getRelease(`tags/${tag}`);
    if (!release) {
      await transfer(() => command('gh', ['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', tag, '--notes-file', `${directory}/RELEASE_NOTES.md`]));
      release = await getRelease(`tags/${tag}`);
    }
    assert.ok(release, 'Release not found after create');
    if (!release.draft) await verifyRemote();
    const existing = release.assets.find(asset => asset.name === 'manifest.json');
    if (existing && release.draft) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardx-manifest-'));
      try {
        await transfer(() => command('gh', ['release', 'download', tag, '--repo', repo, '--pattern', 'manifest.json', '--dir', temp, '--clobber']));
        assert.deepEqual(JSON.parse(fs.readFileSync(`${temp}/manifest.json`)), manifest, 'Different candidate already attached to this tag');
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    }
  },
  async upload() {
    if (!release.draft) return;
    // Upload identity first. A retry must reuse it, even after a partial upload.
    for (const name of ['manifest.json', ...manifest.artifacts.map(item => item.name)]) {
      await transfer(() => command('gh', ['release', 'upload', tag, `${directory}/${name}`, '--repo', repo, '--clobber']));
    }
  },
  verify: verifyRemote,
  async release() {
    await transfer(() => command('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']));
    const published = await getRelease(`tags/${tag}`);
    assert.equal(published?.draft, false);
  },
  async image() {
    const imageName = manifest.image.split('@')[0];
    const expected = manifest.image.split('@')[1];
    await transfer(() => command('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${imageName}:${tag}`, '--tag', `${imageName}:latest`, manifest.image]));
    for (const name of [tag, 'latest']) {
      const output = await transfer(() => command('docker', ['buildx', 'imagetools', 'inspect', `${imageName}:${name}`]));
      assert.equal(output.match(/^Digest:\s+(sha256:[a-f0-9]{64})/m)?.[1], expected, `Wrong digest: ${name}`);
    }
  },
};
if (process.argv[2] === 'finish-docs') {
  await finishDocs({ manifest, directory, state, save, verifyDocs: async () => {
    const url = new URL('build-info.json', process.env.DOCS_URL.replace(/\/?$/, '/'));
    url.searchParams.set('release', `${manifest.commit}-${Date.now()}`);
    const info = await transfer(async () => {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Docs HTTP ${response.status}`);
      return response.json();
    });
    assert.equal(info.commit, manifest.commit); assert.equal(info.version, manifest.version);
    await verifyRemote();
    await adapter.image();
  } });
} else {
  await publish({ manifest, directory, state, save, remote: adapter });
  console.log('Release and image reconciled. Publication remains INCOMPLETE until Pages verification succeeds.');
}
