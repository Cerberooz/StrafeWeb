// The Gateway connection supplies online presence; purchase messages use REST.
// No member, presence, or message-content subscriptions/caches are needed.
export async function startDiscordBot({ env = process.env, logger = console, ClientClass } = {}) {
  if (!env.DISCORD_PURCHASE_BOT_TOKEN) return null;
  const Client = ClientClass || (await import('discord.js')).Client;
  const client = new Client({ intents: [], presence: { status: 'online', activities: [] } });
  const report = event => logger.error(JSON.stringify({ event }));
  client.on('error', () => report('discord_bot_connection_error'));
  client.on('shardError', () => report('discord_bot_connection_error'));
  client.on('shardDisconnect', () => report('discord_bot_disconnected'));
  client.on('clientReady', () => logger.info(JSON.stringify({ event: 'discord_bot_online' })));
  try {
    await client.login(env.DISCORD_PURCHASE_BOT_TOKEN);
    return client;
  } catch {
    // Never log errors containing credentials or request bodies.
    report('discord_bot_login_failed');
    await client.destroy();
    return null;
  }
}
