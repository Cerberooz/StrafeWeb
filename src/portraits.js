import { jsonRequest } from './data.js';

const apiBase = process.env.API_SERVER_BASE_URL || process.env.POINTS_API_BASE_URL;
const apiKey = process.env.API_SERVER_API_KEY || process.env.POINTS_API_KEY;
// Trusted renderer origins; no account-controlled URL is embedded in a page.
export const portraitOrigin = 'https://render.crafty.gg';
export const portraitOrigins = [portraitOrigin];
if (apiBase) {
  try {
    const configured = new URL(apiBase);
    if (['https:', 'http:'].includes(configured.protocol)) portraitOrigins.push(configured.origin);
  } catch { /* Invalid API configuration is handled by the appearance lookup. */ }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 45_000;
const MAX_CACHE = 2048;
const MAX_BATCHES = 16;
const cache = new Map();
const inFlight = new Map();
let activeBatches = 0;

function readPortrait(skin, playerId) {
  // Premium skins follow the verified Mojang UUID. Cracked players use only the
  // canonical texture synchronized from proxy SkinsRestorer, never an offline UUID or name.
  if (!skin || (skin.premium !== true && (!['classic', 'slim'].includes(skin.model) || typeof skin.textureUrl !== 'string'))) {
    throw new Error('Invalid account appearance');
  }
  if (skin.premium !== true) {
    const texture = new URL(skin.textureUrl);
    const hash = /^\/texture\/([a-f0-9]{40,64})$/.exec(texture.pathname)?.[1];
    if (texture.origin !== 'https://textures.minecraft.net' || texture.username || texture.password || texture.search || texture.hash || !hash) {
      throw new Error('Untrusted account texture');
    }
    // Render canonical cracked skins on our API. The external renderer may reject
    // texture-hash requests with 403 even though the saved Mojang texture is valid.
    const bustUrl = new URL(`/v1/accounts/portraits/${hash}/${skin.model}.png`, apiBase).href;
    return { portraitUrl: bustUrl, profilePortraitUrl: bustUrl };
  }
  // Share the exact bust URL so rows and profiles reuse the browser's CDN cache.
  const bustUrl = `${portraitOrigin}/3d/bust/${playerId}`;
  return { portraitUrl: bustUrl, profilePortraitUrl: bustUrl };
}

function remember(id, appearance) {
  cache.delete(id);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(id, { ...appearance, refreshAt: Date.now() + TTL });
}

function loadBatch(ids) {
  activeBatches++;
  const url = new URL('/v1/accounts/skins', apiBase);
  url.searchParams.set('ids', ids.join(','));
  // The CDN resolves official premium skins; avoid serial Mojang requests during SSR.
  url.searchParams.set('resolvePremium', 'false');
  const request = jsonRequest(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    .then(result => {
      if (!result?.skins || typeof result.skins !== 'object' || Array.isArray(result.skins)) throw new Error('Invalid account appearances');
      // Validate canonical skin inputs before replacing any cached appearance.
      const values = ids.map(id => {
        const skin = result.skins[id];
        let portraits = { portraitUrl: null, profilePortraitUrl: null };
        try {
          if (skin && (skin.premium === true || typeof skin.textureUrl === 'string')) portraits = readPortrait(skin, id);
        } catch {
          const previous = cache.get(id);
          if (previous) portraits = { portraitUrl: previous.portraitUrl, profilePortraitUrl: previous.profilePortraitUrl };
        }
        return [id, { ...portraits, premium: skin?.premium === true, linked: skin?.linked === true }];
      });
      for (const [id, appearance] of values) remember(id, appearance);
      return values;
    })
    .catch(() => {
      // Preserve the last known portrait during an upstream failure, including
      // malformed responses. Back off missing profiles for the same short TTL.
      const values = ids.map(id => {
        const previous = cache.get(id);
        const appearance = previous ? { portraitUrl: previous.portraitUrl, profilePortraitUrl: previous.profilePortraitUrl, premium: previous.premium, linked: previous.linked } : { portraitUrl: null, profilePortraitUrl: null, premium: false, linked: false };
        remember(id, appearance);
        return [id, appearance];
      });
      return values;
    })
    .finally(() => {
      activeBatches--;
      for (const id of ids) if (inFlight.get(id) === request) inFlight.delete(id);
    });
  for (const id of ids) inFlight.set(id, request);
  return request;
}

export async function accountPortraits(entries) {
  if (!apiBase || !apiKey) return entries.map(entry => ({ ...entry, portraitUrl: null, profilePortraitUrl: null, premium: false, linked: false }));
  const ids = [...new Set(entries.map(entry => typeof entry.subjectId === 'string' && UUID.test(entry.subjectId) ? entry.subjectId.toLowerCase() : null).filter(Boolean))];
  // Keep this response's appearances separately from the bounded shared cache.
  // Large boards must still retain their first rows when later batches evict them.
  const appearances = new Map();
  const requests = new Set();
  const missing = [];
  for (const id of ids) {
    const appearance = cache.get(id);
    if (appearance && appearance.refreshAt > Date.now()) appearances.set(id, appearance);
    else if (inFlight.has(id)) requests.add(inFlight.get(id));
    else missing.push(id);
  }
  for (let offset = 0; offset < missing.length; offset += 100) {
    while (activeBatches >= MAX_BATCHES) await Promise.race([...new Set(inFlight.values())]);
    const batch = missing.slice(offset, offset + 100).filter(id => {
      const appearance = cache.get(id);
      if (appearance && appearance.refreshAt > Date.now()) { appearances.set(id, appearance); return false; }
      if (inFlight.has(id)) { requests.add(inFlight.get(id)); return false; }
      return true;
    });
    if (batch.length) requests.add(loadBatch(batch));
  }
  for (const values of await Promise.all(requests)) for (const [id, appearance] of values) appearances.set(id, appearance);
  return entries.map(entry => {
    const appearance = typeof entry.subjectId === 'string' ? appearances.get(entry.subjectId.toLowerCase()) : null;
    return { ...entry, portraitUrl: appearance?.portraitUrl || null, profilePortraitUrl: appearance?.profilePortraitUrl || null, premium: appearance?.premium === true, linked: appearance?.linked === true };
  });
}

// Enrich only the published season roster, batching shared players across teams.
export async function teamRosterPortraits(entries) {
  const members = entries.flatMap(entry => Array.isArray(entry.members) ? entry.members : []);
  const portraits = await accountPortraits(members.map(member => ({ ...member, subjectId: member.playerId })));
  let offset = 0;
  return entries.map(entry => {
    const count = Array.isArray(entry.members) ? entry.members.length : 0;
    const roster = portraits.slice(offset, offset + count);
    offset += count;
    return { ...entry, members: roster };
  });
}
