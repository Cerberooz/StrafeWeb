import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPaynowGoalReader, goalProgress } from './paynow-goal.js';
import { accountPortraits } from './portraits.js';

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

export function supporterMessage(order, linkedUserId, { goal = null, portraitUrl } = {}) {
  const player = discordText(order.customer?.minecraft?.name || order.customer?.profile?.name || order.customer?.name || 'A player', 100);
  const productNames = typeof order.product_names === 'string' && order.product_names.trim()
    ? order.product_names : order.lines.map(line => line.product_name || line.product?.name).join(', ');
  const products = discordText(productNames, 1000);
  const name = order.customer?.minecraft?.name;
  const fallbackPortrait = `https://render.crafty.gg/2d/head/${typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name) ? name : 'MHF_Steve'}?size=128`;
  return withoutUserPing({
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'New Purchase Received!',
      color: 0x8cde9f,
      description: `**${player}** has just shown their support to **StrafeMC**!\n\nThank you for helping us grow our community and keep the StrafeMC experience thriving. **We appreciate you!** <:mstar:1549078330844643411>\n\n<:event:1546137196778627072> **Supporter**\n${player}\n\n<:strafe2_icon:1549760947269410897> **Purchase**\n${products}\n\n<:store:1545793616742449195> **Store**\n[Visit our store](https://store.strafemc.net/)\n\n<:hura:1546137558855974933> **Community Goal**\n${goalProgress(goal)}`,
      thumbnail: { url: portraitUrl || fallbackPortrait },
      footer: { text: 'StrafeMC . The Only Competitive Network You Need.' },
    }],
  });
}

function withoutUserPing(message) {
  // Also clear historical mention content when an existing receipt is edited.
  return { ...message, content: '', allowed_mentions: { parse: [] } };
}

export function createPaynowDiscordHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
  const secret = env.PAYNOW_WEBHOOK_SECRET;
  const linkSecret = env.PAYNOW_DISCORD_WEBHOOK_SECRET || secret;
  const botToken = env.DISCORD_PURCHASE_BOT_TOKEN;
  const channelId = env.DISCORD_PURCHASE_CHANNEL_ID;
  if (!secret && !linkSecret && !botToken && !channelId) return async (_req, res) => res.status(503).json({ error: 'Notifications are not configured' });
  if ((botToken || channelId) && (!botToken || !discordId(channelId) || /\s/.test(botToken))) throw new Error('Set DISCORD_PURCHASE_BOT_TOKEN and a valid DISCORD_PURCHASE_CHANNEL_ID together.');
  if (!secret || !botToken || !flake(env.PAYNOW_STORE_ID)) throw new Error('Set PAYNOW_WEBHOOK_SECRET, PAYNOW_STORE_ID and Discord bot settings together.');
  const directory = resolve(env.PAYNOW_WEBHOOK_DATA_DIR || './data/paynow-discord');
  mkdirSync(directory, { recursive: true });
  accessSync(directory, constants.W_OK);
  const pending = new Map();
  const readGoal = createPaynowGoalReader({ env, fetchImpl, now, logger });

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

  async function discordRequest(message, messageId, savedChannelId = channelId) {
    if (!discordId(savedChannelId)) throw new Error('Invalid saved bot channel');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` };
    const destination = new URL(`https://discord.com/api/v10/channels/${savedChannelId}/messages`);
    const payload = withoutUserPing(message);
    // Discard historical sender overrides in stored messages.
    delete payload.username;
    delete payload.avatar_url;
    if (messageId) {
      // Sender identity belongs to the original message and cannot be edited.
      delete payload.username;
      delete payload.avatar_url;
      if (!discordId(messageId)) throw new Error('Invalid saved Discord message ID');
      destination.pathname += `/${messageId}`;
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
        receipt.message = withoutUserPing(receipt.message);
        const savedChannelId = receipt.channelId || (receipt.transport?.kind === 'bot' ? receipt.transport.channelId : null);
        // Legacy delivery records remain dedupe markers; retired sender messages
        // cannot be edited by this bot. Acknowledge late links without reposting.
        if (savedChannelId) await discordRequest(receipt.message, receipt.messageId, savedChannelId);
        receipt.discordUserId = userId;
        await save(marker, JSON.stringify(receipt));
      }
      return;
    }
    // Linking is not evidence of payment. Wait for the Order Completed webhook.
    if (!order) return;
    const rawPlayerId = order.customer?.minecraft?.id;
    const playerId = typeof rawPlayerId === 'string' && /^[a-f0-9]{32}$/i.test(rawPlayerId)
      ? rawPlayerId.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5') : rawPlayerId;
    const [goal, appearances] = await Promise.all([
      readGoal(),
      accountPortraits([{ subjectId: playerId }]).catch(() => []),
    ]);
    // Canonical premium UUID / cracked texture from Strafe, using the existing cache.
    const portraitUrl = appearances[0]?.portraitUrl?.replace('/3d/bust/', '/2d/head/');
    const message = supporterMessage(order, userId, { goal, portraitUrl });
    const messageId = await discordRequest(message);
    await save(marker, JSON.stringify({ messageId, message, channelId, discordUserId: discordId(userId) ? userId : null }));
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
