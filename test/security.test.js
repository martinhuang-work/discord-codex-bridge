import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Contexts } from '../src/contexts.js';
import { Store } from '../src/store.js';
import { Bridge, parseMessage, answerPayload } from '../src/bridge.js';
import { configFrom, isAuthorized } from '../src/config.js';
import { codexArgs, codexEnvironment } from '../src/codex.js';
import { acquireLock } from '../src/lock.js';
import { publicMessage } from '../src/errors.js';

process.umask(0o077);
const user = '111111111111111111';
const guild = '222222222222222222';
const channel = '333333333333333333';
const bot = '444444444444444444';
const base = { DISCORD_BOT_TOKEN: 'example', DISCORD_ALLOWED_USER_IDS: user,
  DISCORD_ALLOWED_GUILD_IDS: guild, DISCORD_ALLOWED_CHANNEL_IDS: channel };

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'bridge-security-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function job(id = '1') {
  return { id, key: `${guild}_${channel}`, guildId: guild, channelId: channel,
    userId: user, text: 'hello', attachments: [], createdAt: Date.now(), status: 'queued' };
}

function fixture(t) {
  const store = new Store(join(directory(t), 'state.json'));
  const calls = [], answers = [];
  const runner = { async run(request) { calls.push(request); return { answer: 'ok' }; } };
  const transport = { async ack() { return 'reply'; }, async typing() {}, async answer(_, payload) { answers.push(payload); } };
  const config = configFrom(base);
  const bridge = new Bridge({ store, runner, transport, authorized: j => isAuthorized(j, config), logger: { log() {}, error() {} } });
  return { bridge, store, calls, answers, runner, transport, config };
}

test('all three access lists are required and malformed settings are rejected', () => {
  for (const key of ['DISCORD_ALLOWED_USER_IDS', 'DISCORD_ALLOWED_GUILD_IDS', 'DISCORD_ALLOWED_CHANNEL_IDS']) {
    assert.throws(() => configFrom({ ...base, [key]: '' }), /Empty allowlists/);
    assert.throws(() => configFrom({ ...base, [key]: 'everyone' }), /Discord IDs/);
  }
  for (const value of ['0', '-1', 'Infinity', '1.5', '3601']) assert.throws(() => configFrom({ ...base, CODEX_TIMEOUT_SECONDS: value }));
  assert.equal(configFrom(base).webSearch, 'disabled');
  assert.throws(() => configFrom({ ...base, CODEX_WEB_SEARCH: 'anything' }));
});

test('authorization covers the server and channel, including thread parents', () => {
  const config = configFrom(base);
  assert.ok(isAuthorized(job(), config));
  assert.ok(!isAuthorized({ ...job(), guildId: 'other' }, config));
  assert.ok(!isAuthorized({ ...job(), channelId: 'other' }, config));
  assert.ok(isAuthorized({ ...job(), channelId: 'thread', parentId: channel }, config));
  const message = { id: '1', guildId: 'other', channelId: channel, author: { id: user }, content: `<@${bot}> hello` };
  assert.equal(parseMessage(message, bot, config.allowedUsers, j => isAuthorized(j, config)), null);
});

test('revoked users and expired queued jobs never reach Codex or Discord', async t => {
  const f = fixture(t);
  f.bridge.enqueue(job());
  f.config.allowedUsers.clear();
  await f.bridge.pump();
  assert.equal(f.calls.length, 0);
  assert.equal(f.answers.length, 0);
  assert.equal(f.store.data.jobs['1'].text, undefined);
  f.config.allowedUsers.add(user);
  f.bridge.enqueue({ ...job('2'), createdAt: Date.now() - 86400001 });
  await f.bridge.pump();
  assert.equal(f.calls.length, 0);
});

test('queue and request limits prevent one user from filling the worker', async t => {
  const f = fixture(t);
  for (let id = 1; id <= 3; id++) f.bridge.enqueue(job(String(id)));
  assert.throws(() => f.bridge.enqueue(job('4')), /pending/);
  await f.bridge.pump();
  for (let id = 4; id <= 6; id++) f.bridge.enqueue(job(String(id)));
  await f.bridge.pump();
  assert.throws(() => f.bridge.enqueue(job('7')), /Request limit/);
  assert.throws(() => f.bridge.enqueue({ ...job('8'), text: 'x'.repeat(8001) }), /8,000/);
});

test('unexpected errors cannot expose library request bodies in replies', async t => {
  const f = fixture(t);
  f.runner.run = async () => { throw new Error('secret request body'); };
  f.bridge.enqueue(job());
  await f.bridge.pump();
  assert.doesNotMatch(f.answers[0].content, /secret request body/);
  assert.equal(publicMessage(new Error('secret')), f.answers[0].content);
});

test('retries preserve per-channel ordering and eventually remove pending content', async t => {
  const f = fixture(t);
  f.transport.ack = async () => { throw new Error('offline'); };
  f.bridge.enqueue(job('1'));
  f.bridge.enqueue(job('2'));
  await f.bridge.pump();
  assert.equal(f.store.data.jobs['2'].deliveryAttempts, undefined);
  f.store.data.jobs['1'].deliveryAttempts = 9;
  f.store.data.jobs['1'].retryAt = 0;
  await f.bridge.pump();
  assert.equal(f.store.data.jobs['1'].status, 'done');
  assert.equal(f.store.data.jobs['1'].text, undefined);
});

test('contexts reject traversal, symlinks, directories, and public permissions', t => {
  const dir = directory(t);
  const contexts = new Contexts(join(dir, 'contexts'));
  for (const name of ['../secret', '/etc/passwd', 'research.txt', '', 'OFF', '__proto__']) {
    assert.throws(() => contexts.load(name), /Invalid context/);
  }
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'private fixture', { mode: 0o600 });
  symlinkSync(outside, join(contexts.directory, 'linked.txt'));
  assert.throws(() => contexts.load('linked'), /Cannot read/);
  const publicFile = join(contexts.directory, 'public.txt');
  writeFileSync(publicFile, 'private fixture');
  chmodSync(publicFile, 0o644);
  assert.throws(() => contexts.load('public'), /0600/);
  symlinkSync(dir, join(contexts.directory, 'directory.txt'));
  assert.throws(() => contexts.load('directory'), /Cannot read/);
});

test('state saves are private and do not follow an existing temporary symlink', t => {
  const dir = directory(t);
  const statePath = join(dir, 'state.json');
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'unchanged');
  symlinkSync(outside, `${statePath}.tmp`);
  const store = new Store(statePath);
  store.save();
  assert.equal(readFileSync(outside, 'utf8'), 'unchanged');
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  writeFileSync(statePath, '{"version":1,"sessions":{},"jobs":{"__proto__":{}}}');
  assert.throws(() => new Store(statePath), /Unsupported/);
});

test('the process lock prevents two live workers and releases only its own lock', t => {
  const dir = directory(t);
  const release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /Another bot/);
  release();
  const next = acquireLock(dir);
  release();
  assert.throws(() => acquireLock(dir), /Another bot/);
  next();
});

test('Codex environment excludes unrelated secrets and injection variables', () => {
  const env = codexEnvironment({ HOME: '/home/example', PATH: '/usr/bin', HTTPS_PROXY: 'proxy', SSL_CERT_FILE: '/tmp/ca',
    AWS_SECRET_ACCESS_KEY: 'secret', GH_TOKEN: 'secret', NODE_OPTIONS: 'injected', LD_PRELOAD: 'injected',
    BASH_ENV: 'injected', SSH_AUTH_SOCK: 'secret', DISCORD_BOT_TOKEN: 'secret', OPENAI_API_KEY: 'secret' });
  assert.deepEqual(env, { HOME: '/home/example', PATH: '/usr/bin', HTTPS_PROXY: 'proxy', SSL_CERT_FILE: '/tmp/ca' });
  const args = codexArgs({ outputPath: '/tmp/result' });
  for (const setting of ['features.shell_tool=false', 'features.apps=false', 'features.hooks=false',
    'features.plugins=false', 'features.computer_use=false', 'features.multi_agent=false', 'web_search="disabled"']) assert.ok(args.includes(setting));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(!args.some(arg => arg.startsWith('sandbox_mode=')));
  assert.throws(() => codexArgs({ sessionId: '--help', outputPath: '/tmp/result' }), /Invalid saved session/);
  assert.throws(() => codexArgs({ outputPath: '/tmp/result', webSearch: 'invalid' }));
});

test('reply previews and mention pings are disabled', () => {
  const payload = answerPayload('hello @everyone https://example.com');
  assert.equal(payload.flags, 4);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
});
