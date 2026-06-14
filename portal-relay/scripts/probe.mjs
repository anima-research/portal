// Read-only probe: log in with a token file, list guilds + text channels, exit.
// No writes. Usage: node scripts/probe.mjs /path/to/discord_token
import { readFileSync } from 'node:fs';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';

const tokenPath = process.argv[2];
if (!tokenPath) {
  console.error('usage: node scripts/probe.mjs <token-file>');
  process.exit(1);
}
const token = readFileSync(tokenPath, 'utf8').trim();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`logged in as: ${client.user.tag} (${client.user.id})`);
  for (const guild of client.guilds.cache.values()) {
    console.log(`\nGUILD ${guild.name}  id=${guild.id}`);
    try {
      const chans = await guild.channels.fetch();
      for (const c of chans.values()) {
        if (!c) continue;
        if (c.type === ChannelType.GuildText || c.type === ChannelType.GuildForum) {
          console.log(`  #${c.name}  id=${c.id}  type=${c.type}`);
        }
      }
    } catch (e) {
      console.log(`  (could not fetch channels: ${e.message})`);
    }
  }
  await client.destroy();
  process.exit(0);
});

client.on('error', (e) => console.error('client error:', e.message));
client.login(token).catch((e) => {
  console.error('login failed:', e.message);
  process.exit(1);
});
