import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseFiles, scanRelease } from '../scripts/release-files.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'release-files.json'), JSON.stringify(['README.md', '.env.example']));
  writeFileSync(join(dir, 'README.md'), 'Example project.');
  writeFileSync(join(dir, '.env.example'), 'DISCORD_BOT_TOKEN=""\n');
  return dir;
}

test('release selection excludes local data and refuses forbidden paths or links', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, '.env'), 'private value');
  assert.deepEqual(releaseFiles(dir), ['README.md', '.env.example']);
  assert.deepEqual(scanRelease(dir, releaseFiles(dir), {}), []);
  for (const entry of ['.env', '.env.backup', 'data/state.json', '../outside', 'src/../../outside']) {
    writeFileSync(join(dir, 'release-files.json'), JSON.stringify([entry]));
    assert.throws(() => releaseFiles(dir), /forbidden/);
  }
  symlinkSync(join(dir, '.env'), join(dir, 'secret.js'));
  writeFileSync(join(dir, 'release-files.json'), JSON.stringify(['secret.js']));
  assert.throws(() => releaseFiles(dir), /without symlinks/);
});

test('release findings identify files and categories without printing secret values', t => {
  const dir = fixture(t);
  const secret = ['private', 'runtime', 'value'].join('-');
  writeFileSync(join(dir, 'README.md'), `Accidental value: ${secret}`);
  const findings = scanRelease(dir, releaseFiles(dir), { DISCORD_BOT_TOKEN: secret });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /configured private value/);
  assert.ok(!findings.join().includes(secret));
});

test('the scanner catches populated examples and credential formats', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, '.env.example'), 'DISCORD_BOT_TOKEN="populated"\n');
  assert.match(scanRelease(dir, releaseFiles(dir), {}).join(), /populated Discord setting/);
  writeFileSync(join(dir, 'README.md'), ['sk-', 'p'.repeat(40)].join(''));
  assert.match(scanRelease(dir, releaseFiles(dir), {}).join(), /API credential/);
  writeFileSync(join(dir, 'README.md'), ['-----BEGIN ', 'PRIVATE KEY-----'].join(''));
  assert.match(scanRelease(dir, releaseFiles(dir), {}).join(), /private key/);
});
