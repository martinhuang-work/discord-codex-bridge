import { Client, Events, GatewayIntentBits, Options } from 'discord.js';
import { join } from 'node:path';
import { configFrom, isAuthorized } from './config.js';
import { Store } from './store.js';
import { CodexRunner, checkLogin } from './codex.js';
import { Bridge, parseMessage, noMentions } from './bridge.js';
import { Contexts } from './contexts.js';
import { privateDirectory } from './private-files.js';
import { acquireLock } from './lock.js';
import { PublicError, publicMessage, errorCode } from './errors.js';

process.umask(0o077);
const config = configFrom();
await checkLogin(config.codexBin);
privateDirectory(config.dataDir);
privateDirectory(join(config.dataDir, 'workspaces'));
const releaseLock = acquireLock(config.dataDir);
process.on('exit', releaseLock);

const store = new Store(join(config.dataDir, 'state.json'));
const runner = new CodexRunner(config);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  allowedMentions: noMentions,
  makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
  rest: { timeout: 15000, retries: 2 },
});
async function channelFor(job) {
  const channel = await client.channels.fetch(job.channelId);
  if (!channel?.isSendable() || channel.guildId !== job.guildId
    || !isAuthorized({ ...job, parentId: channel.isThread() ? channel.parentId : undefined }, config)) {
    throw Object.assign(new Error('Discord channel is unavailable.'), { code: 50001 });
  }
  return channel;
}
const transport = {
  async ack(job) {
    const channel = await channelFor(job);
    const reply = await channel.send({ content: 'Working on it...', allowedMentions: noMentions,
      reply: { messageReference: job.id, failIfNotExists: false } });
    return reply.id;
  },
  async typing(job) { await (await channelFor(job)).sendTyping(); },
  async answer(job, payload) {
    const channel = await channelFor(job);
    try { await channel.messages.edit(job.replyId, payload); }
    catch (error) {
      if (error.code !== 10008) throw error;
      // A deleted placeholder can be replaced without repeating the Codex task.
      const sent = await channel.send({ ...payload, reply: { messageReference: job.id, failIfNotExists: false } });
      job.replyId = sent.id;
    }
  },
};
const contexts = new Contexts(join(config.dataDir, 'contexts'), config.webSearch);
const authorized = job => isAuthorized(job, config);
const bridge = new Bridge({ store, runner, transport, contexts, authorized, limits: config });
let ready = false;
const retryTimer = setInterval(() => { if (ready) bridge.pump().catch(fatal); }, 5000);
function fatal(error) {
  console.error(`Bridge stopped; code=${errorCode(error)}.`);
  shutdown(1);
}
client.once(Events.ClientReady, () => {
  console.log(`Discord connected. Allowed users: ${config.allowedUsers.size}. Authentication: ChatGPT.`);
  ready = true;
  try { bridge.recover(); } catch (error) { fatal(error); return; }
  bridge.pump().catch(fatal);
});
const lastNotice = new Map();
client.on(Events.MessageCreate, message => {
  const job = parseMessage(message, client.user.id, config.allowedUsers, authorized);
  if (!job) return;
  try {
    if (bridge.enqueue(job)) console.log('Queued a Discord request.');
  }
  catch (error) {
    if (!(error instanceof PublicError)) { fatal(error); return; }
    if ((lastNotice.get(job.userId) ?? 0) < Date.now() - 10000) {
      lastNotice.set(job.userId, Date.now());
      message.reply({ content: publicMessage(error), allowedMentions: noMentions }).catch(() => {});
    }
    return;
  }
  bridge.pump().catch(fatal);
});
client.on(Events.Error, error => console.error(`Discord connection error; code=${errorCode(error)}.`));
client.on(Events.ShardError, error => console.error(`Discord gateway error; code=${errorCode(error)}.`));
function shutdown(code = 0) {
  if (bridge.stopping) return;
  bridge.stopping = true;
  clearInterval(retryTimer);
  runner.stopAll();
  client.destroy();
  // Allow child groups to terminate before exiting; persist interrupted jobs.
  setTimeout(() => process.exit(code), 5500);
}
process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
process.once('unhandledRejection', fatal);
process.once('uncaughtException', fatal);
try { await client.login(config.token); }
catch (error) { fatal(error); }
