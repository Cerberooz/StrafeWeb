import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const flake = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const discordId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const text = (value, limit) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);
// Keep player/product names from introducing Discord markdown or mentions.
const discordText = (value, limit) => text(value, limit).replace(/([\\`*_~|<>\[\]])/g, '\\$1').replace(/@/g, '@\u200b');

export function validPaynowSignature(raw, timestamp, signature, secret, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp)
    || Math.abs(now - Number(timestamp)) > 5 * 60_000
    || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update('.').update(raw).digest();
  const supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function supporterMessage(order, username, linkedUserId) {
  const player = discordText(order.customer?.minecraft?.name || order.customer?.profile?.name || order.customer?.name || 'A player', 100);
  const productNames = typeof order.product_names === 'string' && order.product_names.trim()
    ? order.product_names : order.lines.map(line => line.product_name || line.product?.name).join(', ');
  const products = discordText(productNames, 1000);
  return withDiscordMention({
    username,
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'Thank you for your support!',
      color: 0x8cde9f,
      description: `✦ **NEW STRAFEMC SUPPORTER**\n\n👤 **${player}**\n📦 **${products}**\n\nThank you for supporting **StrafeMC**.\nYour support helps us keep improving the network. 💙`,
    }],
  }, linkedUserId);
}

function withDiscordMention(message, linkedUserId) {
  // A mention in an embed doesn't ping. Put the verified user mention above it.
  return discordId(linkedUserId) ? {
    ...message, content: `<@${linkedUserId}>`, allowed_mentions: { parse: [], users: [linkedUserId] },
  } : message;
}

export function createPaynowDiscordHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
  const secret = env.PAYNOW_WEBHOOK_SECRET;
  const linkSecret = env.PAYNOW_DISCORD_WEBHOOK_SECRET || secret;
  const endpoint = env.DISCORD_PURCHASE_WEBHOOK_URL;
  const botToken = env.DISCORD_PURCHASE_BOT_TOKEN;
  const channelId = env.DISCORD_PURCHASE_CHANNEL_ID;
  if (!secret && !endpoint && !linkSecret && !botToken && !channelId) return async (_req, res) => res.status(503).json({ error: 'Notifications are not configured' });
  if ((botToken || channelId) && (!botToken || !discordId(channelId) || /\s/.test(botToken))) throw new Error('Set DISCORD_PURCHASE_BOT_TOKEN and a valid DISCORD_PURCHASE_CHANNEL_ID together.');
  if (!secret || (!endpoint && !botToken) || !flake(env.PAYNOW_STORE_ID)) throw new Error('Set PAYNOW_WEBHOOK_SECRET, PAYNOW_STORE_ID and a Discord webhook or bot destination together.');
  let url;
  if (endpoint) {
    try { url = new URL(endpoint); } catch { throw new Error('Invalid DISCORD_PURCHASE_WEBHOOK_URL.'); }
    if (url.origin !== 'https://discord.com' || !/^\/api(?:\/v\d+)?\/webhooks\/\d{1,30}\/[A-Za-z0-9_-]+$/.test(url.pathname)
    || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS discord.com webhook URL without query parameters.');
    url.searchParams.set('wait', 'true');
  }
  const transport = botToken ? { kind: 'bot', channelId } : { kind: 'webhook' };
  const username = text(env.DISCORD_PURCHASE_WEBHOOK_NAME || 'store.strafemc.net', 80).trim();
  if (!username || /clyde|discord/i.test(username)) throw new Error('Invalid DISCORD_PURCHASE_WEBHOOK_NAME.');
  const directory = resolve(env.PAYNOW_WEBHOOK_DATA_DIR || './data/paynow-discord');
  mkdirSync(directory, { recursive: true });
  accessSync(directory, constants.W_OK);
  const pending = new Map();

  async function readOptional(path) {
    try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }

  async function save(path, value) {
    // Replace records atomically so a restart cannot leave a truncated ID/receipt.
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async function discordRequest(message, messageId, sender = transport) {
    const headers = { 'Content-Type': 'application/json' };
    let destination;
    const payload = { ...message };
    if (sender.kind === 'bot') {
      if (!botToken || !discordId(sender.channelId)) throw new Error('Saved bot destination is not configured');
      destination = new URL(`https://discord.com/api/v10/channels/${sender.channelId}/messages`);
      headers.Authorization = `Bot ${botToken}`;
      delete payload.username;
      delete payload.avatar_url;
    } else if (sender.kind === 'webhook' && url) destination = new URL(url);
    else throw new Error('Saved webhook destination is not configured');
    if (messageId) {
      if (!discordId(messageId)) throw new Error('Invalid saved Discord message ID');
      destination.pathname += sender.kind === 'bot' ? `/${messageId}` : `/messages/${messageId}`;
      destination.search = '';
    }
    const response = await fetchImpl(destination.href, {
      method: messageId ? 'PATCH' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers,
      body: JSON.stringify(payload),
    });
    // Do not include Discord's URL/token or response body in logs.
    if (!response.ok || messageId) {
      try { await response.body?.cancel(); } catch { /* Request may have timed out. */ }
      if (!response.ok) { const error = new Error('Discord notification failed'); error.status = response.status; throw error; }
      return messageId;
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing Discord response');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64_000) { await reader.cancel(); throw new Error('Discord response is too large'); }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!discordId(result.id)) throw new Error('Invalid Discord response');
    return result.id;
  }

  async function send(order, key, linkedUserId) {
    const marker = resolve(directory, `${key}.sent`);
    if (linkedUserId) await save(resolve(directory, `${key}.discord`), linkedUserId);
    const saved = await readOptional(marker);
    const userId = linkedUserId || await readOptional(resolve(directory, `${key}.discord`));
    if (saved !== null) {
      // Earlier versions stored only a timestamp; retain their duplicate protection.
      if (/^\d+\s*$/.test(saved)) return;
      const receipt = JSON.parse(saved);
      if (!discordId(receipt.messageId) || !receipt.message || !Array.isArray(receipt.message.embeds)) throw new Error('Invalid saved notification receipt');
      if (discordId(userId) && receipt.discordUserId !== userId) {
        receipt.message = withDiscordMention(receipt.message, userId);
        // Older receipts belong to the original incoming webhook, not the bot.
        await discordRequest(receipt.message, receipt.messageId, receipt.transport || { kind: 'webhook' });
        receipt.discordUserId = userId;
        await save(marker, JSON.stringify(receipt));
      }
      return;
    }
    // Linking is not evidence of payment. Wait for the Order Completed webhook.
    if (!order) return;
    const message = supporterMessage(order, username, userId);
    if (botToken) delete message.username;
    const messageId = await discordRequest(message);
    await save(marker, JSON.stringify({ messageId, message, transport, discordUserId: discordId(userId) ? userId : null }));
  }

  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const orderSignature = validPaynowSignature(req.body, req.get('PayNow-Timestamp'), req.get('PayNow-Signature'), secret, now());
    const linkSignature = linkSecret === secret ? orderSignature
      : Boolean(linkSecret && validPaynowSignature(req.body, req.get('PayNow-Timestamp'), req.get('PayNow-Signature'), linkSecret, now()));
    if (!orderSignature && !linkSignature) {
      return res.status(401).json({ error: 'Invalid webhook signature or timestamp' });
    }
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!event || typeof event !== 'object' || !flake(event.event_id) || typeof event.event_type !== 'string') return res.status(400).json({ error: 'Invalid event' });
    const isLink = event.event_type === 'ON_DISCORD_ACCOUNT_LINKED_TO_CHECKOUT';
    if (!isLink && event.event_type !== 'ON_ORDER_COMPLETED') return res.status(204).end();
    if (isLink ? !linkSignature : !orderSignature) return res.status(401).json({ error: 'Invalid event signing secret' });
    const body = event.body;
    if (!body || body.store_id !== env.PAYNOW_STORE_ID) return res.status(403).json({ error: 'Wrong store' });
    const order = isLink ? null : body;
    if (isLink && (!flake(body.order_id) || !discordId(body.discord_user_id) || body.order?.id !== body.order_id || body.order?.store_id !== env.PAYNOW_STORE_ID)) {
      return res.status(400).json({ error: 'Invalid Discord link' });
    }
    if (!isLink && (!flake(order.id) || order.status !== 'completed' || !Array.isArray(order.lines) || !order.lines.length || order.lines.length > 100
      || order.lines.some(line => !line || typeof (line.product_name || line.product?.name) !== 'string' || !(line.product_name || line.product?.name).trim()))) {
      return res.status(400).json({ error: 'Invalid completed order' });
    }
    const key = createHash('sha256').update(`${body.store_id}:${isLink ? body.order_id : order.id}`).digest('hex');
    try {
      if (!pending.has(key) && pending.size >= 100) return res.status(503).json({ error: 'Notification capacity reached' });
      // Serialize completion and link events for one order, including duplicate retries.
      const previous = pending.get(key) || Promise.resolve();
      const promise = previous.catch(() => {}).then(() => send(order, key, isLink ? body.discord_user_id : null));
      pending.set(key, promise);
      promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); }).catch(() => {});
      await promise;
      return res.status(204).end();
    } catch (error) {
      logger.error(JSON.stringify({ event: 'paynow_discord_failed', errorType: error.name, status: Number.isInteger(error.status) ? error.status : undefined }));
      // PayNow retries non-2xx responses. Do not mark failed sends as delivered.
      return res.status(503).json({ error: 'Notification could not be sent; retry later' });
    }
  };
}
