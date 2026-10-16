import { resolve } from 'node:path';
import { PublicError } from './errors.js';

function ids(value, name) {
  const result = new Set((value ?? '').split(/[\s,]+/).filter(Boolean));
  if (!result.size || [...result].some(id => !/^\d{17,20}$/.test(id))) {
    throw new PublicError(`Set ${name} to comma-separated Discord IDs. Empty allowlists are not permitted.`);
  }
  return result;
}

function integer(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PublicError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function configFrom(env = process.env) {
  if (!env.DISCORD_BOT_TOKEN?.trim()) throw new PublicError('Set DISCORD_BOT_TOKEN in .env.');
  const webSearch = env.CODEX_WEB_SEARCH || 'disabled';
  if (!['disabled', 'cached', 'live'].includes(webSearch)) throw new PublicError('CODEX_WEB_SEARCH must be disabled, cached, or live.');
  return {
    token: env.DISCORD_BOT_TOKEN.trim(),
    allowedUsers: ids(env.DISCORD_ALLOWED_USER_IDS, 'DISCORD_ALLOWED_USER_IDS'),
    allowedGuilds: ids(env.DISCORD_ALLOWED_GUILD_IDS, 'DISCORD_ALLOWED_GUILD_IDS'),
    allowedChannels: ids(env.DISCORD_ALLOWED_CHANNEL_IDS, 'DISCORD_ALLOWED_CHANNEL_IDS'),
    timeoutMs: integer(env.CODEX_TIMEOUT_SECONDS, 600, 1, 3600, 'CODEX_TIMEOUT_SECONDS') * 1000,
    codexBin: env.CODEX_BIN || 'codex', model: env.CODEX_MODEL || undefined, webSearch,
    dataDir: resolve(env.BRIDGE_DATA_DIR || 'data'),
    maxPending: 20, maxPendingPerUser: 3, requestsPerMinute: 6,
  };
}

// Threads must be listed explicitly, or have an allowlisted parent channel.
// Queued work is checked again after a restart so revoked access stays revoked.
export function isAuthorized(job, config) {
  return config.allowedUsers.has(job.userId)
    && config.allowedGuilds.has(job.guildId)
    && (config.allowedChannels.has(job.channelId)
      || (job.parentId && config.allowedChannels.has(job.parentId)));
}
