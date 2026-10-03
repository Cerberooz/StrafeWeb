import { jsonRequest } from './data.js';

const apiBase = process.env.API_SERVER_BASE_URL || process.env.POINTS_API_BASE_URL;
const apiKey = process.env.API_SERVER_API_KEY || process.env.POINTS_API_KEY;
const production = process.env.NODE_ENV === 'production';
// A private HTTP API address cannot be used by visitors in production. A
// separate public origin is optional when the API connection already uses TLS.
const publicBase = process.env.API_SERVER_PUBLIC_BASE_URL || (apiBase && (!production || new URL(apiBase).protocol === 'https:') ? apiBase : null);
export const portraitOrigin = publicBase ? validatedOrigin(publicBase) : null;

function validatedOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production))) {
    throw new Error('API_SERVER_PUBLIC_BASE_URL must use HTTPS (localhost HTTP is allowed in development).');
  }
  return url.origin;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 45_000;
const MAX_CACHE = 2048;
const MAX_BATCHES = 16;
const cache = new Map();
const inFlight = new Map();
let activeBatches = 0;

function readPortrait(skin) {
  if (!skin || !['classic', 'slim'].includes(skin.model) || typeof skin.portraitUrl !== 'string' || typeof skin.textureUrl !== 'string') {
    throw new Error('Invalid account appearance');
  }
  const texture = new URL(skin.textureUrl);
  const portrait = new URL(skin.portraitUrl);
  const hash = /^\/texture\/([a-f0-9]{32,64})$/.exec(texture.pathname)?.[1];
  if (texture.origin !== 'https://textures.minecraft.net' || texture.username || texture.password || texture.search || texture.hash || !hash ||
      portrait.origin !== portraitOrigin || portrait.username || portrait.password || portrait.search || portrait.hash ||
      portrait.pathname !== `/v1/accounts/portraits/${hash}/${skin.model}.png`) {
    throw new Error('Untrusted account portrait');
  }
  return portrait.href;
}

function remember(id, portraitUrl) {
  cache.delete(id);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(id, { portraitUrl, refreshAt: Date.now() + TTL });
}

function loadBatch(ids) {
  activeBatches++;
  const url = new URL('/v1/accounts/skins', apiBase);
  url.searchParams.set('ids', ids.join(','));
  const request = jsonRequest(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    .then(result => {
      if (!result?.skins || typeof result.skins !== 'object' || Array.isArray(result.skins)) throw new Error('Invalid account appearances');
      // Validate the whole batch before replacing any cached skin.
      const values = ids.map(id => [id, Object.hasOwn(result.skins, id) ? readPortrait(result.skins[id]) : null]);
      for (const [id, portraitUrl] of values) remember(id, portraitUrl);
    })
    .catch(() => {
      // Preserve the last known portrait during an upstream failure, including
      // malformed responses. Back off missing profiles for the same short TTL.
      for (const id of ids) remember(id, cache.get(id)?.portraitUrl || null);
    })
    .finally(() => {
      activeBatches--;
      for (const id of ids) if (inFlight.get(id) === request) inFlight.delete(id);
    });
  for (const id of ids) inFlight.set(id, request);
  return request;
}

export async function accountPortraits(entries) {
  if (!apiBase || !apiKey || !portraitOrigin) return entries.map(entry => ({ ...entry, portraitUrl: null }));
  const ids = [...new Set(entries.map(entry => typeof entry.subjectId === 'string' && UUID.test(entry.subjectId) ? entry.subjectId.toLowerCase() : null).filter(Boolean))];
  const missing = ids.filter(id => !inFlight.has(id) && (!cache.has(id) || cache.get(id).refreshAt <= Date.now()));
  for (let offset = 0; offset < missing.length && activeBatches < MAX_BATCHES; offset += 100) loadBatch(missing.slice(offset, offset + 100));
  await Promise.all([...new Set(ids.map(id => inFlight.get(id)).filter(Boolean))]);
  return entries.map(entry => ({ ...entry, portraitUrl: typeof entry.subjectId === 'string' ? cache.get(entry.subjectId.toLowerCase())?.portraitUrl || null : null }));
}
