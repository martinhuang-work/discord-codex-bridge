import { PublicError, publicMessage, errorCode } from './errors.js';
import { finishJob } from './store.js';

export const noMentions = { parse: [], repliedUser: false };

export function parseMessage(message, botId, allowedUsers, authorized = () => true) {
  if (!message.guildId || message.author.bot || message.webhookId || !allowedUsers.has(message.author.id)) return null;
  const identity = { guildId: message.guildId, channelId: message.channelId, userId: message.author.id,
    parentId: message.channel?.isThread?.() ? message.channel.parentId : undefined };
  if (!authorized(identity)) return null;
  // Require a literal mention. A reply notification or @everyone is not a request.
  const mention = new RegExp(`<@!?${botId}>`, 'g');
  const directMention = mention.test(message.content);
  // Discord still supplies role metadata when it withholds message content.
  // A bot's integration role and its user often have identical display names.
  const botRoleMention = [...(message.mentions?.roles?.values() ?? [])]
    .some(role => role.tags?.botId === botId);
  if (!directMention && !botRoleMention) return null;
  const text = message.content.replace(mention, '').trim();
  const attachments = [...(message.attachments?.values() ?? [])].slice(0, 10).map(a => a.url).filter(url => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname)
        && !parsed.username && !parsed.password && url.length <= 2048;
    } catch { return false; }
  });
  return {
    ...identity, id: message.id, key: `${message.guildId}_${message.channelId}`,
    text, attachments, status: 'queued', createdAt: Date.now(),
    ...(directMention ? {} : { mentionHelp: `You tagged my role. To send me a question, mention my bot account instead. Copy this and send it as a new message:\n\n\`<@${botId}> your question here\`` }),
  };
}

export function answerPayload(answer) {
  if (answer.length <= 1900) return { content: answer, flags: 4, allowedMentions: noMentions, attachments: [] };
  return {
    content: 'The answer is attached because it exceeds Discord’s message limit.',
    files: [{ attachment: Buffer.from(answer, 'utf8'), name: 'codex-answer.txt' }],
    attachments: [], flags: 4, allowedMentions: noMentions,
  };
}

const help = 'Mention me with a question. Follow-ups in this channel or thread use the same Codex conversation.\n`@bot !new` starts a fresh conversation here.\n`@bot !session` shows this conversation’s Codex session ID.\n`@bot !context research` selects research.txt from the private context directory.\n`@bot !context` checks its status; `@bot !context off` removes it and starts fresh.';

export class Bridge {
  constructor({ store, runner, transport, contexts, authorized = () => true, limits = {}, logger = console }) {
    Object.assign(this, { store, runner, transport, contexts, authorized, logger });
    this.limits = { maxPending: 20, maxPendingPerUser: 3, requestsPerMinute: 6, ...limits };
    this.busy = false;
    this.stopping = false;
  }

  recover() {
    for (const job of Object.values(this.store.data.jobs)) {
      if (job.status === 'running') {
        job.answer = 'The bot restarted while Codex was working. Its conversation was saved. Please mention me again to continue.';
        job.status = 'answer';
      }
    }
    this.store.save();
  }

  enqueue(job) {
    if (this.stopping || !this.authorized(job) || this.store.data.jobs[job.id]) return false;
    if (job.text.length > 8000) throw new PublicError('Please keep each request under 8,000 characters.');
    const waiting = Object.values(this.store.data.jobs).filter(j => j.status !== 'done');
    if (waiting.length >= this.limits.maxPending) throw new PublicError('The bot’s queue is full. Please try again shortly.');
    if (waiting.filter(j => j.userId === job.userId).length >= this.limits.maxPendingPerUser) {
      throw new PublicError('Please wait for your pending requests to finish.');
    }
    const recent = Object.values(this.store.data.jobs).filter(j => j.userId === job.userId && j.createdAt > Date.now() - 60000);
    if (recent.length >= this.limits.requestsPerMinute) throw new PublicError('Request limit reached. Please wait a minute.');
    this.store.data.jobs[job.id] = job;
    this.store.save();
    return true;
  }

  async pump() {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      while (!this.stopping) {
        const blockedChannels = new Set();
        const job = Object.values(this.store.data.jobs).find(j => {
          if (j.status === 'done' || blockedChannels.has(j.key)) return false;
          blockedChannels.add(j.key);
          return !j.retryAt || j.retryAt <= Date.now();
        });
        if (!job) break;
        if (!this.authorized(job) || job.createdAt < Date.now() - 24 * 60 * 60 * 1000) {
          finishJob(job);
          this.store.save();
          continue;
        }
        try {
          await this.process(job);
        } catch (error) {
          // Keep the completed answer for delivery retries; never rerun Codex
          // because a Discord send failed.
          job.deliveryAttempts = (job.deliveryAttempts ?? 0) + 1;
          if ([10003, 50001, 50013].includes(error.code) || job.deliveryAttempts >= 10) finishJob(job);
          else job.retryAt = Date.now() + Math.min(300000, 30000 * job.deliveryAttempts);
          this.store.save();
          this.logger.error(`Discord delivery failed; code=${errorCode(error)}; retained=${job.status !== 'done'}.`);
        }
      }
    } finally { this.busy = false; }
  }

  async process(job) {
    if (!job.replyId) {
      job.replyId = await this.transport.ack(job);
      this.store.save();
    }
    if (job.status === 'queued') {
      job.status = 'running';
      this.store.save();
      const command = job.text.toLowerCase();
      if (job.mentionHelp) {
        job.answer = job.mentionHelp;
      } else if (/^!context(?:\s|$)/.test(command)) {
        job.answer = this.contextCommand(job, command);
      } else if (command === '!new') {
        delete this.store.data.sessions[job.key];
        job.answer = 'A new Codex conversation will start with your next mention.'
          + (this.store.data.contexts[job.key] ? ' Your selected project context is kept.' : '');
      } else if (command === '!session') {
        const session = this.store.data.sessions[job.key];
        job.answer = session ? `Codex session: \`${session}\`` : 'No Codex session yet. Mention me with a question to start one.';
      } else if (command === '!help' || (!job.text && !job.attachments.length)) {
        job.answer = help;
      } else {
        const timer = setInterval(() => { this.transport.typing(job).catch(() => {}); }, 8000);
        this.transport.typing(job).catch(() => {});
        try {
          const contextName = this.store.data.contexts[job.key];
          const context = contextName ? this.contexts.load(contextName) : undefined;
          const prompt = (context?.prompt ?? '')
            + `This request was sent through a Discord bot. Reply directly to the user. Your final answer will be posted in the originating channel or thread.\n\n${job.text}`
            + (job.attachments.length ? `\n\nAttached file URLs (file contents have not been uploaded to Codex):\n${job.attachments.join('\n')}` : '');
          const result = await this.runner.run({
            sessionId: this.store.data.sessions[job.key], key: job.key, prompt,
            webSearch: context?.webSearch,
            onSession: id => { this.store.data.sessions[job.key] = id; this.store.save(); },
          });
          job.answer = result.answer;
        } catch (error) {
          job.answer = publicMessage(error);
          this.logger.error(`Codex request failed; code=${errorCode(error)}.`);
        } finally { clearInterval(timer); }
      }
      job.status = 'answer';
      this.store.save();
    }
    await this.transport.answer(job, answerPayload(job.answer));
    finishJob(job);
    this.store.save();
    this.logger.log('Answered a Discord request.');
  }

  contextCommand(job, command) {
    if (!this.contexts) return 'Project contexts are not configured on this bot.';
    const name = command.slice('!context'.length).trim();
    const previous = this.store.data.contexts[job.key];
    if (!name) return previous ? this.contexts.status(previous) : 'No project context selected here. Use `!context research` after mentioning me.';
    if (name === 'off') {
      if (!previous) return 'No project context is selected here.';
      delete this.store.data.contexts[job.key];
      delete this.store.data.sessions[job.key];
      return 'Project context removed here. Your next question starts a fresh conversation.';
    }
    try { this.contexts.profile(name); }
    catch (error) { return publicMessage(error); }
    if (previous !== name) delete this.store.data.sessions[job.key];
    this.store.data.contexts[job.key] = name;
    return `Context selected for this channel or thread. ${this.contexts.status(name)}`;
  }
}
