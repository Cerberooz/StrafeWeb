import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { catalog, rankCategory, leaderboard, paynowReady, paynowProducts, jsonRequest, paynowHeaders } from './data.js';
import { comparison, httpsUrl, rankImageHosts } from './markup.js';
import { accountPortraits, teamRosterPortraits, portraitOrigin } from './portraits.js';
import { serverStatus } from './server-status.js';
import { createPaynowDiscordHandler } from './paynow-discord.js';
import { startDiscordBot } from './discord-bot.js';

const app = express();
const production = process.env.NODE_ENV === 'production';
const secret = process.env.COOKIE_SECRET || randomBytes(32).toString('hex');
if (production && (!process.env.COOKIE_SECRET || process.env.COOKIE_SECRET.length < 32 || /^(replace|change|example)/i.test(process.env.COOKIE_SECRET))) throw new Error('Set COOKIE_SECRET to at least 32 random characters in production.');
const origin = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:5020');
if (production && origin.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
if (process.env.API_SERVER_BASE_URL || process.env.POINTS_API_BASE_URL) {
  const url = new URL(process.env.API_SERVER_BASE_URL || process.env.POINTS_API_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid POINTS_API_BASE_URL.');
  if (production && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use HTTPS for points API outside localhost.');
}
const baseDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(baseDir, basename(baseDir) === 'dist' ? 'public' : '../public');
const stylesheetVersion = createHash('sha256').update(readFileSync(resolve(publicDir, 'store.css'))).digest('hex').slice(0, 16);
app.locals.stylesheetVersion = stylesheetVersion;
app.locals.scriptVersion = createHash('sha256').update(readFileSync(resolve(publicDir, 'store.js'))).digest('hex').slice(0, 16);
const money = (amount,currency) => {
  const code = /^[A-Z]{3}$/.test(String(currency).toUpperCase()) ? String(currency).toUpperCase() : 'USD';
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return code === 'SGD' ? `S$${value.toFixed(2)}` : new Intl.NumberFormat('en',{style:'currency',currency:code}).format(value);
};
const regionNames = { AS: 'Asia', EU: 'Europe', NA: 'North America', SA: 'South America', OC: 'Oceania', AF: 'Africa' };
function tierColumns(entries) {
  const ranked = [...entries].sort((a, b) => Number(b.points || 0) - Number(a.points || 0) || String(a.displayName || '').localeCompare(String(b.displayName || '')));
  const count = ranked.length;
  const columns = [{ id: 'S', name: 'S Tier', top: 0.001 }, { id: 'A', name: 'A Tier', top: 0.01 }, { id: 'B', name: 'B Tier', top: 0.05 }, { id: 'C', name: 'C Tier', top: 0.2 }, { id: 'F', name: 'F Tier', top: 1 }].map(tier => ({ ...tier, entries: [] }));
  let start = 0;
  columns.forEach((tier, index) => {
    if (index === columns.length - 1) { tier.entries = ranked.slice(start); return; }
    if (count <= index) return;
    const minimumEnd = start + 1;
    const maximumEnd = Math.max(minimumEnd, count - (columns.length - index - 1));
    const targetEnd = Math.ceil(count * tier.top);
    const end = Math.min(maximumEnd, Math.max(minimumEnd, targetEnd));
    tier.entries = ranked.slice(start, end);
    start = end;
  });
  return columns;
}
app.disable('x-powered-by');
const trustProxyRaw = process.env.TRUST_PROXY_HOPS;
const trustProxyHops = trustProxyRaw === undefined || trustProxyRaw.trim() === '' ? 0 : Number(trustProxyRaw);
if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) {
  throw new Error('TRUST_PROXY_HOPS must be an exact integer from 0 to 10.');
}
app.set('trust proxy', trustProxyHops);
app.set('view engine', 'ejs'); app.set('views', resolve(baseDir, 'views'));
const markupImageSources = rankImageHosts.map(host => `https://${host}`);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", ...markupImageSources], scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"], frameSrc: ["'none'"], objectSrc: ["'none'"], formAction: ["'self'", 'https://paynow.gg', 'https://*.paynow.gg'], baseUri: ["'none'"], upgradeInsecureRequests: production ? [] : null } }, strictTransportSecurity: production ? undefined : false }));
app.use((req, res, next) => {
  const render = res.render;
  res.render = function (view, options = {}, callback) {
    // Product artwork comes from the trusted provider API, separately from HTML
    // descriptions. Permit only the specific origins used by this response.
    const images = [res.locals.heroImage, options.pkg?.image, options.kitImageUrl,
      ...(options.categories || []).flatMap(category => category.packages.map(pkg => pkg.image)),
      ...(options.comparisonPackages || []).map(pkg => pkg.image)];
    const sources = new Set(["'self'", ...markupImageSources]);
    if (view === 'tiers' && options.board?.entries.some(entry => entry.portraitUrl || entry.members?.some(member => member.portraitUrl)) && portraitOrigin) sources.add(portraitOrigin);
    for (const image of images) { const url = httpsUrl(image); if (url) sources.add(new URL(url).origin); }
    const policy = res.getHeader('Content-Security-Policy');
    if (typeof policy === 'string') res.setHeader('Content-Security-Policy', policy.replace(/(^|;)img-src[^;]*/, `$1img-src ${[...sources].join(' ')}`));
    return render.call(this, view, options, callback);
  };
  next();
});
// PayNow authenticates with an HMAC over the raw body, before browser sessions/CSRF.
app.post('/webhooks/paynow',
  rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
  express.raw({ type: 'application/json', limit: '256kb', inflate: false }),
  createPaynowDiscordHandler(),
  (error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid webhook body' })
);
app.use(cookieParser(secret));
app.use(express.urlencoded({ extended: false, limit: '12kb', parameterLimit: 30 }));
app.use('/assets', express.static(publicDir, { maxAge: production ? '1d' : 0, index: false }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', signed: true, path: '/', maxAge: 60 * 60 * 1000 };
const csrf = value => createHmac('sha256', secret).update(value).digest('hex');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const session = req.signedCookies.store_session || randomBytes(24).toString('hex');
  if (!req.signedCookies.store_session) res.cookie('store_session', session, cookieOptions);
  req.storeSession = session;
  res.locals = { path: req.path, csrf: csrf(session), minecraft: process.env.MINECRAFT_ADDRESS || 'play.strafemc.net', discord: httpsUrl(process.env.DISCORD_URL), heroImage: httpsUrl(process.env.HERO_IMAGE_URL), customerName: req.signedCookies.minecraft_name || '', pageTitle: 'StrafeMC', categories: [], regionNames, money };
  if (req.method === 'POST') {
    const given = Buffer.from(String(req.body._csrf || '')); const expected = Buffer.from(csrf(session));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      console.warn(JSON.stringify({ event: 'csrf_rejected', reason: req.signedCookies.store_session ? 'invalid_token' : 'missing_session', method: req.method, route: req.path, host: req.get('host') }));
      return res.status(403).render('message', { title: 'Request expired', message: 'Refresh the page and try again.', status: 'error' });
    }
  }
  next();
});
const authLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const checkoutLimit = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false });
const customerAuthentications = new Map();
const MAX_CUSTOMER_AUTHENTICATIONS = 10_000;
setInterval(() => { for (const [key, item] of customerAuthentications) if (item.expires <= Date.now()) customerAuthentications.delete(key); }, 60_000).unref();
const customerAuthenticationKey = (session, username, ip) => createHash('sha256').update(`${session}\0${username.toLowerCase()}\0${ip}`).digest('hex');
async function paynowCustomerToken(session, username, ip) {
  const key = customerAuthenticationKey(session, username, ip);
  const previous = customerAuthentications.get(key);
  if (previous && previous.expires > Date.now()) return previous.promise;
  if (customerAuthentications.size >= MAX_CUSTOMER_AUTHENTICATIONS) {
    for (const [authKey, item] of customerAuthentications) if (item.expires <= Date.now()) customerAuthentications.delete(authKey);
    if (customerAuthentications.size >= MAX_CUSTOMER_AUTHENTICATIONS) throw new Error('Customer authentication capacity reached');
  }
  const promise = jsonRequest('https://api.paynow.gg/v1/store/customer/auth', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paynow-store-id': process.env.PAYNOW_STORE_ID, 'x-paynow-customer-ip': ip }, body: JSON.stringify({ platform: 'minecraft', id: username }) })
    .then(auth => {
      if (typeof auth.customer_token !== 'string' || !auth.customer_token || auth.customer_token.length > 2500) throw new Error('Invalid auth response');
      return auth.customer_token;
    });
  customerAuthentications.set(key, { promise, expires: Date.now() + 2 * 60_000 });
  promise.catch(() => { if (customerAuthentications.get(key)?.promise === promise) customerAuthentications.delete(key); });
  return promise;
}
function invalidateCustomerAuthentication(session, username, ip, token) {
  const key = customerAuthenticationKey(session, username, ip);
  const entry = customerAuthentications.get(key);
  if (entry) entry.promise.then(cachedToken => { if (cachedToken === token && customerAuthentications.get(key) === entry) customerAuthentications.delete(key); }).catch(() => {});
}
app.get('/health', (_, res) => res.json({ status: 'ok' }));
app.get('/server-status', async (_, res) => res.json(await serverStatus()));
app.get('/', async (req, res) => { const store = await catalog(req.ip, req.signedCookies.paynow_customer); res.render('home', { store, categories: store.categories, ranks: rankCategory(store.categories)?.packages.slice(0, 3) || [] }); });
async function renderRanks(req, res) {
  const store = await catalog(req.ip, req.signedCookies.paynow_customer); const category = req.params.id ? store.categories.find(c => c.id === req.params.id) : rankCategory(store.categories);
  if (req.params.id && !category && store.ready && !store.unavailable) return res.status(404).render('message', { title: 'Category not found', message: 'This category is no longer available.', status: 'error' });
  const packages = category?.packages || [];
  const comparisonPackages = store.comparisonPackages;
  res.render('ranks', { pageTitle: category?.name || 'Ranks', store, category, categories: store.categories, packages, comparisonPackages, groups: comparison(comparisonPackages), isRanks: !req.params.id || req.params.id === store.rankId });
}
app.get('/ranks', renderRanks); app.get('/categories/:id', renderRanks);
app.get('/packages/:id', async (req, res) => {
  const store = await catalog(req.ip, req.signedCookies.paynow_customer); const pkg = store.categories.flatMap(c => c.packages).find(p => p.id === req.params.id);
  if (!pkg) return res.status(store.unavailable ? 503 : 404).render('message', { title: 'Package unavailable', message: 'Please return to the store and try again.', status: 'error' });
  res.render('package', { pageTitle: pkg.name, pkg, categories: store.categories });
});
app.get('/tiers', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const mode = ['smp-teams', 'smp-solo', 'pvp'].includes(req.query.mode) ? req.query.mode : 'smp-teams';
  const requestedSeason = typeof req.query.season === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(req.query.season)
    ? req.query.season
    : null;
  let board = await leaderboard(mode, 1, requestedSeason);
  if (mode === 'smp-solo' && board.entries.length) board = { ...board, entries: await accountPortraits(board.entries) };
  if (mode === 'smp-teams' && board.entries.length) board = { ...board, entries: await teamRosterPortraits(board.entries) };
  const columns = mode === 'pvp' ? [] : tierColumns(board.entries);
  const season = board.seasons?.find(item => item.id === board.season);
  const kitImageUrl = typeof season?.kitImageUrl === 'string' && season.kitImageUrl.length <= 2048
    ? httpsUrl(season.kitImageUrl) : '';
  res.render('tiers', { pageTitle: 'Tiers', mode, board, columns, kitImageUrl });
});
app.get('/checkout', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const store = await catalog(req.ip, req.signedCookies.paynow_customer); const pkg = store.categories.flatMap(c => c.packages).find(p => p.id === String(req.query.package || ''));
  let product; let unavailable = false;
  if (pkg && pkg.paynowId && paynowReady()) {
    try { product = (await paynowProducts(req.ip, req.signedCookies.paynow_customer)).find(p => String(p.id) === pkg.paynowId); } catch { unavailable = true; }
  }
  res.render('checkout', { pageTitle: 'Checkout', pkg, product, ready: Boolean(product), unavailable, error: ['auth', 'checkout', 'unavailable'].includes(req.query.error) ? req.query.error : '', subscription: req.query.subscription === 'true' });
});
app.post('/customer', authLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const username = String(req.body.username || '').trim();
  const destination = `/checkout?package=${encodeURIComponent(String(req.body.package || '').slice(0, 50))}`;
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username) || !paynowReady()) return res.redirect(303, `${destination}&error=auth`);
  try {
    const token = await paynowCustomerToken(req.storeSession, username, req.ip);
    res.cookie('paynow_customer', token, cookieOptions); res.cookie('minecraft_name', username, cookieOptions);
    res.redirect(303, destination);
  } catch { res.redirect(303, `${destination}&error=auth`); }
});
app.post('/customer/logout', (req, res) => { res.clearCookie('paynow_customer', cookieOptions); res.clearCookie('minecraft_name', cookieOptions); res.redirect(303, '/'); });
// Coalesce only concurrent requests. PayNow checkout URLs are single-use and short-lived.
const checkouts = new Map();
const MAX_CHECKOUTS = 10_000;
app.post('/checkout', checkoutLimit, authLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const packageId = String(req.body.package || '').slice(0, 50); const destination = `/checkout?package=${encodeURIComponent(packageId)}`;
  let token = req.signedCookies.paynow_customer;
  let authenticatedUsername = '';
  let usedSessionAuthentication = false;
  if (!paynowReady()) return res.redirect(303, `${destination}&error=auth`);
  if (!token) {
    const username = String(req.body.username || '').trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.redirect(303, `${destination}&error=auth`);
    try {
      token = await paynowCustomerToken(req.storeSession, username, req.ip);
      authenticatedUsername = username;
      usedSessionAuthentication = true;
      res.cookie('paynow_customer', token, cookieOptions); res.cookie('minecraft_name', username, cookieOptions);
    } catch { return res.redirect(303, `${destination}&error=auth`); }
  }
  const subscription = req.body.subscription === 'true'; const tokenHash = createHash('sha256').update(token).digest('hex');
  try {
    const store = await catalog(req.ip, token); const pkg = store.categories.flatMap(c => c.packages).find(p => p.id === packageId); const id = pkg?.paynowId;
    if (!pkg || !id) return res.redirect(303, `${destination}&error=unavailable`);
    const product = (await paynowProducts(req.ip, token, true)).find(p => String(p.id) === id);
    if (!product || (subscription ? !product.allow_subscription : !product.allow_one_time_purchase) || product.stock?.available_to_purchase === false) return res.redirect(303, `${destination}&error=unavailable`);
    const customVariables = {};
    for (const variable of product.custom_variables || []) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(variable.identifier)) throw new Error('Invalid product variable');
      const value = String(req.body[`var_${variable.identifier}`] || '').trim().slice(0, 256);
      if (!value || (variable.type === 'dropdown' && !variable.options.some(option => option.value === value)) || (variable.type === 'number' && (!/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))))) return res.redirect(303, `${destination}&error=unavailable`);
      customVariables[variable.identifier] = value;
    }
    const selectedServer = String(req.body.gameserver || '');
    if (product.single_game_server_only && !product.gameservers?.some(server => server.enabled && String(server.id) === selectedServer)) return res.redirect(303, `${destination}&error=unavailable`);
    const line = { product_id: id, quantity: 1, subscription, custom_variables: customVariables, ...(product.single_game_server_only ? { selected_gameserver_id: selectedServer } : {}) };
    const lineHash = createHash('sha256').update(JSON.stringify(line)).digest('hex');
    const key = `${req.storeSession}:${tokenHash}:${lineHash}`;
    let promise = checkouts.get(key) || null;
    if (!promise) {
      if (checkouts.size >= MAX_CHECKOUTS) throw new Error('Checkout capacity reached');
      promise = jsonRequest('https://api.paynow.gg/v1/checkouts', { method: 'POST', headers: { ...paynowHeaders(req.ip, token), 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [line], auto_redirect: true, return_url: `${origin.origin}/checkout/complete`, cancel_url: `${origin.origin}${destination}` }) });
      checkouts.set(key, promise);
      promise.then(
        () => { if (checkouts.get(key) === promise) checkouts.delete(key); },
        () => { if (checkouts.get(key) === promise) checkouts.delete(key); }
      );
    }
    const result = await promise; const url = new URL(result.url);
    if (url.protocol !== 'https:' || !(url.hostname === 'paynow.gg' || url.hostname.endsWith('.paynow.gg')) || url.username || url.password) throw new Error('Untrusted checkout redirect');
    console.info(JSON.stringify({ event: 'checkout_redirect', providerHost: url.hostname }));
    res.redirect(303, url.href);
  } catch (error) {
    console.error(JSON.stringify({ event: 'checkout_failed', errorType: error.name, status: Number.isInteger(error.status) ? error.status : undefined }));
    if ([401, 403].includes(error.status)) {
      if (usedSessionAuthentication) invalidateCustomerAuthentication(req.storeSession, authenticatedUsername, req.ip, token);
      res.clearCookie('paynow_customer', cookieOptions); res.clearCookie('minecraft_name', cookieOptions);
    }
    res.redirect(303, `${destination}&error=checkout`);
  }
});
app.get('/checkout/complete', (_, res) => { res.set('Cache-Control', 'no-store'); res.render('message', { title: 'Thanks for supporting StrafeMC', message: 'PayNow will deliver your purchase after payment is confirmed. Check your email for your receipt.', status: 'success' }); });
app.use((_, res) => res.status(404).render('message', { title: 'Page not found', message: 'Head back to the store to find what you need.', status: 'error' }));
app.use((error, req, res, next) => { console.error('Store request failed:', error.name); if (res.headersSent) return next(error); res.status(500).render('message', { title: 'Something went wrong', message: 'Please try again in a moment.', status: 'error' }); });
const port = Number(process.env.PORT || 5020);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const server = app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`StrafeMC SSR store listening on port ${port}`));
const discordBot = startDiscordBot().catch(() => { console.error(JSON.stringify({ event: 'discord_bot_start_failed' })); return null; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  const closed = new Promise(resolve => server.close(resolve));
  Promise.all([closed, discordBot.then(client => client?.destroy())]).then(() => process.exit(0), () => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
});

