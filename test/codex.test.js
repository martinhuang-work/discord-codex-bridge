import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRunner } from '../src/codex.js';

async function fakeRunner(t, body, timeoutMs = 5000) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'fake-codex');
  await writeFile(executable, `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return new CodexRunner({ dataDir: dir, codexBin: executable, timeoutMs });
}

test('runner captures final output and persists the specific session; input is not executed by a shell', async t => {
  const runner = await fakeRunner(t, `
    const fs = require('node:fs');
    let input = '';
    process.stdin.on('data', b => input += b);
    process.stdin.on('end', () => {
      if (!process.argv.includes('web_search="live"')) process.exit(2);
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'saved-session' }));
      fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], input);
      console.log(JSON.stringify({ type: 'turn.completed' }));
    });
  `);
  let session;
  const prompt = 'literal $(echo injected) `echo injected`';
  const result = await runner.run({ key: 'channel', prompt, webSearch: 'live', onSession: id => session = id });
  assert.equal(result.answer, prompt);
  assert.equal(session, 'saved-session');
});

test('exit zero without turn.completed is not treated as an answer', async t => {
  const runner = await fakeRunner(t, `process.stdin.resume(); console.log(JSON.stringify({type:'turn.failed'}));`);
  await assert.rejects(runner.run({ key: 'channel', prompt: 'test' }), /could not finish/);
});

test('timeout stops Codex instead of blocking the queue forever', async t => {
  const runner = await fakeRunner(t, `process.stdin.resume(); setInterval(() => {}, 1000);`, 100);
  await assert.rejects(runner.run({ key: 'channel', prompt: 'test' }), /timed out/);
  assert.equal(runner.active.size, 0);
});
