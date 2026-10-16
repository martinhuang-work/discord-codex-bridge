import { REST, Routes } from 'discord.js';
import { configFrom } from './config.js';
import { checkLogin } from './codex.js';
import { publicMessage, errorCode } from './errors.js';

try {
  const config = configFrom();
  await checkLogin(config.codexBin);
  console.log('Codex authentication: ChatGPT.');
  const rest = new REST({ version: '10', timeout: 15000, retries: 1 }).setToken(config.token);
  await rest.get(Routes.user());
  const guilds = await rest.get(Routes.userGuilds());
  if (![...config.allowedGuilds].every(id => guilds.some(guild => guild.id === id))) throw new Error('Bot is missing from an allowed server.');
  console.log(`Discord token valid. Allowed users: ${config.allowedUsers.size}. Allowed servers: ${config.allowedGuilds.size}. Allowed channels: ${config.allowedChannels.size}.`);
} catch (error) {
  console.error(`Setup check failed: ${publicMessage(error)} (code=${errorCode(error)})`);
  process.exitCode = 1;
}
