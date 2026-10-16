import { PublicError } from '../src/errors.js';
process.umask(0o077);
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Bridge, parseMessage, answerPayload } from '../src/bridge.js';
import { configFrom } from '../src/config.js';
import { codexEnvironment, codexArgs } from '../src/codex.js';
import { Contexts } from '../src/contexts.js';

const userId = '111111111111111111';
const botId = '222222222222222222';
const users = new Set([userId]);
function message(id = '1', content = `<@${botId}> hello`, channelId = 'channel') {
  return { id, content, channelId, guildId: 'guild', author: { id: userId, bot: false }, attachments: new Map() };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-bridge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'state.json'));
  const calls = [];
  const answers = [];
  const runner = { async run(job) {
    calls.push(job);
    const sessionId = job.sessionId || `session-${calls.length}`;
    job.onSession(sessionId);
    return { answer: `answer-${calls.length}`, sessionId };
  } };
  const transport = { async ack(j) { return `reply-${j.id}`; }, async typing() {}, async answer(j, payload) { answers.push({ id: j.id, channel: j.channelId, payload }); } };
  const contexts = new Contexts(join(dir, 'contexts'), 'live');
  const bridge = new Bridge({ store, runner, transport, contexts, limits: { maxPendingPerUser: 100, requestsPerMinute: 100 }, logger: { log() {}, error() {} } });
  return { store, calls, answers, bridge, transport, dir, contexts };
}

test('project context persists per channel, reloads edits, and does not echo the handoff on selection', async t => {
  const { bridge, store, calls, answers, contexts } = fixture(t);
  const path = join(contexts.directory, 'research.txt');
  writeFileSync(path, 'PRIVATE SUMMARY: search janitorial opportunities.');
  store.data.sessions.guild_channel = 'old-session';
  bridge.enqueue(parseMessage(message('select', `<@${botId}> !context research`), botId, users));
  await bridge.pump();
  assert.equal(calls.length, 0);
  assert.equal(store.data.sessions.guild_channel, undefined);
  assert.doesNotMatch(answers[0].payload.content, /PRIVATE SUMMARY|janitorial/);
  assert.equal(new Store(store.path).data.contexts.guild_channel, 'research');

  bridge.enqueue(parseMessage(message('first'), botId, users));
  await bridge.pump();
  assert.match(calls[0].prompt, /search janitorial opportunities/);
  assert.equal(calls[0].webSearch, 'live');

  writeFileSync(path, 'UPDATED SUMMARY: search landscaping opportunities.');
  bridge.enqueue(parseMessage(message('reselect', `<@${botId}> !context research`), botId, users));
  bridge.enqueue(parseMessage(message('second'), botId, users));
  bridge.enqueue(parseMessage(message('other', `<@${botId}> hello`, 'thread'), botId, users));
  await bridge.pump();
  assert.equal(calls[1].sessionId, 'session-1');
  assert.match(calls[1].prompt, /search landscaping opportunities/);
  assert.doesNotMatch(calls[1].prompt, /janitorial/);
  assert.equal(calls[2].sessionId, undefined);
  assert.equal(calls[2].webSearch, undefined);
  assert.doesNotMatch(calls[2].prompt, /SUMMARY|project_handoff/);
});

test('missing or empty handoffs block inference; invalid profile cannot replace the selection', async t => {
  const { bridge, store, calls, answers, contexts } = fixture(t);
  bridge.enqueue(parseMessage(message('select', `<@${botId}> !context research`), botId, users));
  bridge.enqueue(parseMessage(message('missing'), botId, users));
  await bridge.pump();
  assert.match(answers.at(-1).payload.content, /context file is missing/);
  writeFileSync(join(contexts.directory, 'research.txt'), ' \n');
  bridge.enqueue(parseMessage(message('empty'), botId, users));
  await bridge.pump();
  assert.match(answers.at(-1).payload.content, /context file is empty/);
  store.data.sessions.guild_channel = 'keep-session';
  bridge.enqueue(parseMessage(message('invalid', `<@${botId}> !context ../../.env`), botId, users));
  await bridge.pump();
  assert.match(answers.at(-1).payload.content, /Invalid context name/);
  assert.equal(calls.length, 0);
  assert.equal(store.data.contexts.guild_channel, 'research');
  assert.equal(store.data.sessions.guild_channel, 'keep-session');
});

test('new keeps project context, while turning it off discards the contextual conversation', async t => {
  const { bridge, store, calls, contexts } = fixture(t);
  writeFileSync(join(contexts.directory, 'research.txt'), 'PRIVATE SUMMARY');
  store.data.contexts.guild_channel = 'research';
  store.data.contexts.guild_thread = 'research';
  store.data.sessions = { guild_channel: 'old-session', guild_thread: 'other-session' };
  bridge.enqueue(parseMessage(message('new', `<@${botId}> !new`), botId, users));
  bridge.enqueue(parseMessage(message('first'), botId, users));
  await bridge.pump();
  assert.equal(calls[0].sessionId, undefined);
  assert.match(calls[0].prompt, /PRIVATE SUMMARY/);
  bridge.enqueue(parseMessage(message('off', `<@${botId}> !context off`), botId, users));
  bridge.enqueue(parseMessage(message('second'), botId, users));
  await bridge.pump();
  assert.equal(calls[1].sessionId, undefined);
  assert.doesNotMatch(calls[1].prompt, /PRIVATE SUMMARY/);
  assert.equal(store.data.contexts.guild_channel, undefined);
  assert.equal(store.data.contexts.guild_thread, 'research');
  assert.equal(store.data.sessions.guild_thread, 'other-session');
});

test('old tool permissions do not carry into new sessions, and oversized handoffs are rejected', t => {
  const { store, contexts } = fixture(t);
  writeFileSync(store.path, JSON.stringify({ version: 1, sessions: { guild_channel: 'existing' }, jobs: {} }));
  const reopened = new Store(store.path);
  assert.equal(reopened.data.sessions.guild_channel, undefined);
  assert.deepEqual(reopened.data.contexts, {});
  writeFileSync(join(contexts.directory, 'research.txt'), 'x'.repeat(65537));
  assert.throws(() => contexts.load('research'), /exceeds 64 KiB/);
});

test('only allowed humans with an explicit bot mention trigger requests', () => {
  assert.equal(parseMessage(message('1', 'hello @everyone'), botId, users), null);
  assert.equal(parseMessage({ ...message(), author: { id: 'other', bot: false } }, botId, users), null);
  assert.equal(parseMessage({ ...message(), author: { id: userId, bot: true } }, botId, users), null);
  assert.equal(parseMessage({ ...message(), webhookId: 'webhook' }, botId, users), null);
  assert.equal(parseMessage({ ...message(), guildId: null }, botId, users), null);
  assert.equal(parseMessage(message('1', `hello <@!${botId}> world`), botId, users).text, 'hello  world');
});

test('follow-ups resume their session, threads remain separate, duplicates are ignored', async t => {
  const { store, calls, answers, bridge } = fixture(t);
  const first = parseMessage(message('1'), botId, users);
  assert.equal(bridge.enqueue(first), true);
  assert.equal(bridge.enqueue(first), false);
  bridge.enqueue(parseMessage(message('2'), botId, users));
  bridge.enqueue(parseMessage(message('3', `<@${botId}> another`, 'thread'), botId, users));
  await Promise.all([bridge.pump(), bridge.pump()]);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].sessionId, 'session-1');
  assert.equal(calls[2].sessionId, undefined);
  assert.deepEqual(answers.map(a => a.channel), ['channel', 'channel', 'thread']);
  assert.equal(bridge.enqueue(first), false);
  const reopened = new Store(store.path);
  assert.equal(reopened.data.sessions.guild_channel, 'session-1');
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
});

test('a bot role mention with hidden content gets instructions without inference', async t => {
  const { bridge, calls, answers } = fixture(t);
  const msg = { ...message('role', ''), mentions: { roles: new Map([
    ['role-id', { id: 'role-id', tags: { botId } }],
  ]) } };
  const job = parseMessage(msg, botId, users);
  assert.ok(job);
  bridge.enqueue(job);
  await bridge.pump();
  assert.equal(calls.length, 0);
  assert.match(answers[0].payload.content, /tagged my role/);
  assert.ok(answers[0].payload.content.includes(`<@${botId}>`));
  assert.equal(parseMessage({ ...msg, author: { id: 'other', bot: false } }, botId, users), null);
});

test('other roles are ignored, and a real user mention takes precedence', () => {
  const msg = { ...message('role', ''), mentions: { roles: new Map([
    ['role-id', { id: 'role-id', tags: { botId: 'another-bot' } }],
  ]) } };
  assert.equal(parseMessage(msg, botId, users), null);
  msg.mentions.roles.set('ours', { tags: { botId } });
  msg.content = `<@${botId}> question`;
  const job = parseMessage(msg, botId, users);
  assert.equal(job.mentionHelp, undefined);
  assert.equal(job.text, 'question');
});

test('Discord delivery failure retries the saved answer without rerunning Codex', async t => {
  const { bridge, calls, store, transport } = fixture(t);
  let attempts = 0;
  transport.answer = async () => { if (++attempts === 1) throw Object.assign(new Error(), { code: 502 }); };
  bridge.enqueue(parseMessage(message(), botId, users));
  await bridge.pump();
  assert.equal(store.data.jobs['1'].status, 'answer');
  store.data.jobs['1'].retryAt = 0;
  await bridge.pump();
  assert.equal(calls.length, 1);
  assert.equal(attempts, 2);
  assert.equal(store.data.jobs['1'].status, 'done');
});

test('failed acknowledgments do not spend Codex usage', async t => {
  const { bridge, calls, store, transport } = fixture(t);
  transport.ack = async () => { throw new Error('no permission'); };
  bridge.enqueue(parseMessage(message(), botId, users));
  await bridge.pump();
  assert.equal(calls.length, 0);
  assert.equal(store.data.jobs['1'].status, 'queued');
});

test('new command resets only that channel; session command uses no inference', async t => {
  const { bridge, calls, store, answers } = fixture(t);
  store.data.sessions = { guild_channel: 'old', guild_thread: 'thread-session' };
  bridge.enqueue(parseMessage(message('1', `<@${botId}> !new`), botId, users));
  bridge.enqueue(parseMessage(message('2', `<@${botId}> !session`, 'thread'), botId, users));
  await bridge.pump();
  assert.equal(calls.length, 0);
  assert.equal(store.data.sessions.guild_channel, undefined);
  assert.equal(store.data.sessions.guild_thread, 'thread-session');
  assert.match(answers[1].payload.content, /thread-session/);
});

test('a restart reports interrupted work instead of silently submitting it twice', async t => {
  const { bridge, store, calls, answers } = fixture(t);
  bridge.enqueue(parseMessage(message(), botId, users));
  store.data.jobs['1'].status = 'running';
  store.data.jobs['1'].replyId = 'existing';
  bridge.recover();
  await bridge.pump();
  assert.equal(calls.length, 0);
  assert.match(answers[0].payload.content, /restarted/);
});

test('Codex failure is reported and does not prevent the next request', async t => {
  const f = fixture(t);
  let calls = 0;
  f.bridge.runner.run = async () => { if (++calls === 1) throw new PublicError('Unavailable'); return { answer: 'Recovered' }; };
  f.bridge.enqueue(parseMessage(message('1'), botId, users));
  f.bridge.enqueue(parseMessage(message('2'), botId, users));
  await f.bridge.pump();
  assert.deepEqual(f.answers.map(a => a.payload.content), ['Unavailable', 'Recovered']);
});

test('long Unicode answers are delivered intact and mentions never ping users', () => {
  const text = '🙂'.repeat(3000) + '\n@everyone';
  const payload = answerPayload(text);
  assert.equal(payload.files[0].attachment.toString('utf8'), text);
  assert.ok(payload.content.length < 2000);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(answerPayload('short').content, 'short');
});

test('configuration refuses an empty allowlist and supports multiple user IDs', () => {
  assert.throws(() => configFrom({ DISCORD_BOT_TOKEN: 'secret' }), /ALLOWED/);
  assert.throws(() => configFrom({ DISCORD_BOT_TOKEN: 'secret', DISCORD_ALLOWED_USER_IDS: 'abc' }), /ALLOWED/);
  assert.equal(configFrom({ DISCORD_BOT_TOKEN: 'secret', DISCORD_ALLOWED_USER_IDS: `${userId}, ${botId}`, DISCORD_ALLOWED_GUILD_IDS: userId, DISCORD_ALLOWED_CHANNEL_IDS: botId }).allowedUsers.size, 2);
});

test('Codex uses ChatGPT login, receives no bot token or API key, and prompts use stdin', () => {
  const env = codexEnvironment({ HOME: '/home/test', HTTPS_PROXY: 'proxy', DISCORD_BOT_TOKEN: 'secret', OPENAI_API_KEY: 'api', CODEX_API_KEY: 'api2', CODEX_ACCESS_TOKEN: 'access', PATH: '/bin' });
  assert.deepEqual(env, { HOME: '/home/test', HTTPS_PROXY: 'proxy', PATH: '/bin' });
  const args = codexArgs({ sessionId: 'specific-session', outputPath: '/tmp/output' });
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'specific-session']);
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(!args.includes('--last'));
  assert.equal(args.at(-1), '-');
});
