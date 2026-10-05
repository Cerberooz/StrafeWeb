import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaynowDiscordHandler, validPaynowSignature, supporterMessage } from '../src/paynow-discord.js';
import { EventEmitter } from 'node:events';
import { startDiscordBot } from '../src/discord-bot.js';

const clock = 1_800_000_000_000;
const secret = 'test-only-signing-secret';
const linkSecret = 'test-only-discord-link-secret';
const linkedUserId = '123456789012345678';
const responseMessage = () => new Response(JSON.stringify({ id: '234567890123456789' }));
const event = () => ({
  event_id: '12345', event_type: 'ON_ORDER_COMPLETED',
  body: {
    id: '54321', store_id: '67890', status: 'completed',
    customer: { minecraft: { name: 'Cerberooz' } },
    lines: [{ product_name: 'Legend Rank', quantity: 1 }, { product_name: 'Keys', quantity: 3 }],
    billing_email: 'private@example.invalid', billing_name: 'Private Name', customer_ip: '192.0.2.1',
  },
});
const sign = (raw, timestamp = String(clock), key = secret) => createHmac('sha256', key).update(timestamp).update('.').update(raw).digest('base64');
function request(value, overrides = {}) {
  const raw = Buffer.from(JSON.stringify(value));
  const headers = { 'PayNow-Timestamp': String(clock), 'PayNow-Signature': sign(raw), ...overrides };
  return { body: raw, get: key => headers[key] };
}
async function invoke(handler, req) {
  const response = { code: 200, set() { return this; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; }, end() { return this; } };
  await handler(req, response);
  return response;
}
async function configuration(t) {
  const directory = await mkdtemp(join(tmpdir(), 'strafe-paynow-discord-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { PAYNOW_WEBHOOK_SECRET: secret, PAYNOW_STORE_ID: '67890',
    DISCORD_PURCHASE_WEBHOOK_URL: 'https://discord.com/api/webhooks/12345/test-only-token',
    PAYNOW_WEBHOOK_DATA_DIR: directory };
}
const options = env => ({ env, now: () => clock, logger: { error() {} } });

test('bot announcements inherit identity, retain mentions and edit their original channel after restart', async t => {
  const env = await configuration(t);
  delete env.DISCORD_PURCHASE_WEBHOOK_URL;
  env.DISCORD_PURCHASE_BOT_TOKEN = 'test-only-bot-token';
  env.DISCORD_PURCHASE_CHANNEL_ID = '345678901234567890';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init, message: JSON.parse(init.body) });
    return responseMessage();
  };
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  assert.equal((await invoke(handler, request(event()))).code, 204);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/345678901234567890/messages');
  assert.equal(calls[0].headers.Authorization, 'Bot test-only-bot-token');
  assert.equal(calls[0].message.username, undefined);
  assert.equal(calls[0].message.avatar_url, undefined);
  env.DISCORD_PURCHASE_CHANNEL_ID = '456789012345678901';
  const restarted = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  assert.equal((await invoke(restarted, request(event()))).code, 204);
  assert.equal((await invoke(restarted, request(linkEvent()))).code, 204);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, `${calls[0].url}/234567890123456789`);
  assert.equal(calls[1].message.content, `<@${linkedUserId}>`);
});

test('switching to bot mode preserves old webhook edits and uses the bot for new orders', async t => {
  const env = await configuration(t);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ...init }); return responseMessage(); };
  assert.equal((await invoke(createPaynowDiscordHandler({ ...options(env), fetchImpl }), request(event()))).code, 204);
  // Deployed receipts from before bot support have no transport field.
  const filename = (await readdir(env.PAYNOW_WEBHOOK_DATA_DIR)).find(name => name.endsWith('.sent'));
  const path = join(env.PAYNOW_WEBHOOK_DATA_DIR, filename);
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  delete receipt.transport;
  await writeFile(path, JSON.stringify(receipt));
  env.DISCORD_PURCHASE_BOT_TOKEN = 'test-only-bot-token';
  env.DISCORD_PURCHASE_CHANNEL_ID = '345678901234567890';
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  assert.equal((await invoke(handler, request(linkEvent()))).code, 204);
  assert.match(calls[1].url, /\/webhooks\/12345\/test-only-token\/messages\//);
  assert.equal(calls[1].headers.Authorization, undefined);
  const next = event(); next.body.id = '54322';
  assert.equal((await invoke(handler, request(next))).code, 204);
  assert.match(calls[2].url, /\/channels\/345678901234567890\/messages$/);
});

test('partial bot settings fail startup instead of silently using a webhook', async t => {
  const env = await configuration(t);
  env.DISCORD_PURCHASE_BOT_TOKEN = 'test-only-bot-token';
  assert.throws(() => createPaynowDiscordHandler(options(env)), /CHANNEL_ID together/);
  env.DISCORD_PURCHASE_CHANNEL_ID = '../invalid';
  assert.throws(() => createPaynowDiscordHandler(options(env)), /CHANNEL_ID together/);
});

test('online presence uses no privileged intents and login failure is sanitized and cleaned up', async () => {
  let instance;
  class FakeClient extends EventEmitter {
    constructor(settings) { super(); this.settings = settings; instance = this; }
    async login(token) { this.token = token; this.emit('clientReady'); }
    async destroy() { this.destroyed = true; }
  }
  const logs = [];
  const settings = { env: { DISCORD_PURCHASE_BOT_TOKEN: 'private-test-token' }, ClientClass: FakeClient,
    logger: { info: value => logs.push(value), error: value => logs.push(value) } };
  assert.equal(await startDiscordBot({ env: {} }), null);
  const client = await startDiscordBot(settings);
  assert.deepEqual(client.settings.intents, []);
  assert.equal(client.settings.presence.status, 'online');
  client.emit('error', new Error('private-test-token'));
  await client.destroy();
  FakeClient.prototype.login = async () => { throw new Error('private-test-token'); };
  assert.equal(await startDiscordBot(settings), null);
  assert.equal(instance.destroyed, true);
  assert.match(logs.join(' '), /discord_bot_online.*discord_bot_login_failed/);
  assert.doesNotMatch(logs.join(' '), /private-test-token/);
});

test('signature covers exact raw bytes and rejects altered, expired, future and malformed requests', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(validPaynowSignature(raw, String(clock), sign(raw), secret, clock), true);
  assert.equal(validPaynowSignature(Buffer.from('{ "a":1}'), String(clock), sign(raw), secret, clock), false);
  assert.equal(validPaynowSignature(raw, String(clock), sign(raw, String(clock), 'wrong'), secret, clock), false);
  for (const timestamp of [String(clock - 300_001), String(clock + 300_001), 'bad', undefined]) {
    assert.equal(validPaynowSignature(raw, timestamp, sign(raw, timestamp || 'bad'), secret, clock), false);
  }
  for (const signature of [undefined, '', 'bad', 'a'.repeat(44)]) assert.equal(validPaynowSignature(raw, String(clock), signature, secret, clock), false);
});

test('unsigned, wrong-store and malformed orders cannot send Discord messages; unrelated events are ignored', async t => {
  const env = await configuration(t);
  let calls = 0;
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async () => { calls++; throw new Error('Must not send'); } });
  assert.equal((await invoke(handler, request(event(), { 'PayNow-Signature': '' }))).code, 401);
  const wrongStore = event(); wrongStore.body.store_id = '111';
  assert.equal((await invoke(handler, request(wrongStore))).code, 403);
  for (const update of [order => { order.status = 'created'; }, order => { order.lines = []; }, order => { order.lines = [null]; }, order => { order.id = '../bad'; }]) {
    const invalid = event(); update(invalid.body);
    assert.equal((await invoke(handler, request(invalid))).code, 400);
  }
  const unrelated = event(); unrelated.event_type = 'ON_REFUND';
  assert.equal((await invoke(handler, request(unrelated))).code, 204);
  const invalidJSON = Buffer.from('{');
  assert.equal((await invoke(handler, { body: invalidJSON, get: name => name === 'PayNow-Timestamp' ? String(clock) : sign(invalidJSON) })).code, 400);
  assert.equal(calls, 0);
});

test('posts branded product summary, coalesces concurrent retries and retains deduplication after restart', async t => {
  const env = await configuration(t);
  let calls = 0, message;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('wait'), 'true');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    message = JSON.parse(init.body);
    await gate;
    return responseMessage();
  };
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  const first = invoke(handler, request(event()));
  const second = invoke(handler, request(event()));
  release();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.code), [204, 204]);
  assert.equal(calls, 1);
  assert.equal(message.username, 'store.strafemc.net');
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.match(message.embeds[0].description, /Cerberooz/);
  assert.match(message.embeds[0].description, /Legend Rank, Keys/);
  assert.doesNotMatch(JSON.stringify(message), /private@example|Private Name|192\.0\.2\.1|product\.name/);
  const restarted = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  const replay = event(); replay.event_id = '99999';
  assert.equal((await invoke(restarted, request(replay))).code, 204);
  assert.equal(calls, 1);
  const anotherOrder = event(); anotherOrder.body.id = '54322';
  assert.equal((await invoke(restarted, request(anotherOrder))).code, 204);
  assert.equal(calls, 2);
});

test('failed Discord send returns retryable status without recording success', async t => {
  const env = await configuration(t);
  let calls = 0;
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async () => ++calls === 1 ? new Response('{}', { status: 429 }) : responseMessage() });
  assert.equal((await invoke(handler, request(event()))).code, 503);
  assert.equal((await invoke(handler, request(event()))).code, 204);
  assert.equal(calls, 2);
  assert.equal((await invoke(handler, request(event()))).code, 204);
  assert.equal(calls, 2);
});

test('product/player names cannot inject markdown or ping users', async t => {
  const env = await configuration(t);
  let message;
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async (_url, init) => { message = JSON.parse(init.body); return responseMessage(); } });
  const malicious = event();
  malicious.body.customer.minecraft.name = '@everyone **name**';
  malicious.body.lines[0].product_name = '<@12345> [link](https://example.invalid)';
  assert.equal((await invoke(handler, request(malicious))).code, 204);
  assert.doesNotMatch(message.embeds[0].description, /@everyone|<@12345>/);
  assert.match(message.embeds[0].description, /\\\*\\\*name\\\*\\\*/);
});

test('configuration is optional but rejects partial setup and non-Discord destinations', async () => {
  assert.equal((await invoke(createPaynowDiscordHandler({ env: {} }), request(event()))).code, 503);
  assert.throws(() => createPaynowDiscordHandler({ env: { PAYNOW_WEBHOOK_SECRET: secret } }), /together/);
  assert.throws(() => createPaynowDiscordHandler({ env: { PAYNOW_WEBHOOK_SECRET: secret, PAYNOW_STORE_ID: '67890', DISCORD_PURCHASE_WEBHOOK_URL: 'https://example.invalid/api/webhooks/12345/token' } }), /discord.com/);
});

test('embed matches the requested title, text and sampled reference color', () => {
  const order = event().body;
  order.product_names = 'Legend Rank, Keys';
  const message = supporterMessage(order, 'store.strafemc.net');
  assert.equal(message.embeds[0].title, 'Thank you for your support!');
  assert.equal(message.embeds[0].color, 0xb3ecff);
  assert.equal(message.embeds[0].description,
    '✦ **NEW STRAFEMC SUPPORTER**\n\n👤 **Cerberooz**\n📦 **Legend Rank, Keys**\n\nThank you for supporting **StrafeMC**.\nYour support helps us keep improving the network. 💙');
  assert.equal(message.content, undefined);
  assert.equal(supporterMessage(order, 'store.strafemc.net', '@everyone').content, undefined);
});

function linkEvent(orderId = '54321') {
  return { event_id: '12346', event_type: 'ON_DISCORD_ACCOUNT_LINKED_TO_CHECKOUT', body: {
    store_id: '67890', order_id: orderId, discord_user_id: linkedUserId,
    order: { id: orderId, store_id: '67890', status: 'created' },
  } };
}
function linkRequest(value) {
  return request(value, { 'PayNow-Signature': sign(Buffer.from(JSON.stringify(value)), String(clock), linkSecret) });
}

test('Discord linking before payment adds only the linked user mention when the order completes', async t => {
  const env = await configuration(t); env.PAYNOW_DISCORD_WEBHOOK_SECRET = linkSecret;
  let calls = 0, message;
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async (_url, init) => { calls++; message = JSON.parse(init.body); return responseMessage(); } });
  assert.equal((await invoke(handler, linkRequest(linkEvent()))).code, 204);
  assert.equal(calls, 0);
  const restarted = createPaynowDiscordHandler({ ...options(env), fetchImpl: async (_url, init) => { calls++; message = JSON.parse(init.body); return responseMessage(); } });
  assert.equal((await invoke(restarted, request(event()))).code, 204);
  assert.equal(message.content, `<@${linkedUserId}>`);
  assert.deepEqual(message.allowed_mentions, { parse: [], users: [linkedUserId] });
  assert.equal(calls, 1);
  assert.equal((await invoke(restarted, linkRequest(linkEvent()))).code, 204);
  assert.equal(calls, 1);
});

test('Discord linking after payment edits the saved message and retries failed edits without new posts', async t => {
  const env = await configuration(t); env.PAYNOW_DISCORD_WEBHOOK_SECRET = linkSecret;
  const calls = [];
  let failEdit = true;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, message: JSON.parse(init.body) });
    if (init.method === 'PATCH' && failEdit) return new Response('{}', { status: 429 });
    return responseMessage();
  };
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  assert.equal((await invoke(handler, request(event()))).code, 204);
  const restarted = createPaynowDiscordHandler({ ...options(env), fetchImpl });
  assert.equal((await invoke(restarted, linkRequest(linkEvent()))).code, 503);
  failEdit = false;
  assert.equal((await invoke(restarted, linkRequest(linkEvent()))).code, 204);
  assert.deepEqual(calls.map(call => call.method), ['POST', 'PATCH', 'PATCH']);
  assert.match(calls[2].url, /\/messages\/234567890123456789$/);
  assert.equal(calls[2].message.content, `<@${linkedUserId}>`);
  assert.deepEqual(calls[2].message.embeds, calls[0].message.embeds);
  assert.equal((await invoke(restarted, linkRequest(linkEvent()))).code, 204);
  assert.equal(calls.length, 3);
});

test('simultaneous completion and link events produce one post with the mention', async t => {
  const env = await configuration(t); env.PAYNOW_DISCORD_WEBHOOK_SECRET = linkSecret;
  const methods = [];
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async (_url, init) => { methods.push(init.method); return responseMessage(); } });
  const results = await Promise.all([invoke(handler, request(event())), invoke(handler, linkRequest(linkEvent()))]);
  assert.deepEqual(results.map(result => result.code), [204, 204]);
  assert.deepEqual(methods, ['POST', 'PATCH']);
});

test('a separate link secret override requires the matching signature, store/order and valid user ID', async t => {
  const env = await configuration(t); env.PAYNOW_DISCORD_WEBHOOK_SECRET = linkSecret;
  let calls = 0;
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async () => { calls++; return responseMessage(); } });
  assert.equal((await invoke(handler, request(linkEvent()))).code, 401);
  assert.equal((await invoke(handler, linkRequest(event()))).code, 401);
  for (const update of [body => { body.discord_user_id = '@everyone'; }, body => { body.order.id = '555'; }, body => { body.order.store_id = '111'; }]) {
    const invalid = linkEvent(); update(invalid.body);
    assert.equal((await invoke(handler, linkRequest(invalid))).code, 400);
  }
  const wrongStore = linkEvent(); wrongStore.body.store_id = '111';
  assert.equal((await invoke(handler, linkRequest(wrongStore))).code, 403);
  assert.equal(calls, 0);
});

test('one PayNow signing secret authenticates both completion and Discord link events by default', async t => {
  const env = await configuration(t);
  const messages = [];
  const handler = createPaynowDiscordHandler({ ...options(env), fetchImpl: async (_url, init) => { messages.push(JSON.parse(init.body)); return responseMessage(); } });
  assert.equal((await invoke(handler, request(linkEvent()))).code, 204);
  assert.equal((await invoke(handler, request(event()))).code, 204);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, `<@${linkedUserId}>`);
  assert.deepEqual(messages[0].allowed_mentions, { parse: [], users: [linkedUserId] });
  assert.equal((await invoke(handler, request(linkEvent('54322'), { 'PayNow-Signature': sign(Buffer.from(JSON.stringify(linkEvent('54322'))), String(clock), 'wrong') }))).code, 401);
  assert.equal(messages.length, 1);
});
