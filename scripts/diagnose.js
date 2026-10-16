// Report setup and permission counts. Do not fetch messages or print identities.
import { REST, Routes } from 'discord.js';
import { configFrom } from '../src/config.js';
import { publicMessage, errorCode } from '../src/errors.js';

try {
  const config = configFrom();
  const rest = new REST({ version: '10', timeout: 15000, retries: 1 }).setToken(config.token);
  await rest.get(Routes.user());
  let reachable = 0;
  for (const id of config.allowedChannels) {
    const channel = await rest.get(Routes.channel(id));
    if (config.allowedGuilds.has(channel.guild_id)) reachable++;
  }
  console.log(`Discord authentication passed. Reachable allowed channels: ${reachable}/${config.allowedChannels.size}.`);
  console.log('Check channel overrides in Discord if sending still fails. No messages were read or sent.');
} catch (error) {
  console.error(`Diagnostic failed: ${publicMessage(error)} (code=${errorCode(error)})`);
  process.exitCode = 1;
}
