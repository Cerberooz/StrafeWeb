import { parseDescription, httpsUrl } from './markup.js';
import { createHash } from 'node:crypto';

const cache = new Map();
const inFlight = new Map();
export async function cached(key, ttl, load) {
  const prior = cache.get(key);
  if (prior && prior.expires > Date.now()) return prior.value;
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = load().then(value => { if (cache.size >= 256) cache.delete(cache.keys().next().value); cache.set(key, { value, expires: Date.now() + ttl }); return value; }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
export async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(7000), headers: { Accept: 'application/json', ...options.headers } });
  if (!response.ok) {
    // Discard failed responses without reading or exposing provider error content.
    try { await response.body?.cancel(); } catch { /* Cancellation can race the request timeout. */ }
    const error = new Error('Upstream request failed'); error.status = response.status; throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing upstream response');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4_000_000) { await reader.cancel(); throw new Error('Upstream response is too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export const paynowReady = () => Boolean(process.env.PAYNOW_STORE_ID && process.env.PAYNOW_API_KEY);
export function paynowHeaders(ip, token) {
  return { 'x-paynow-store-id': process.env.PAYNOW_STORE_ID, 'x-paynow-customer-ip': ip, Authorization: token ? `Customer ${token}` : `APIKey ${process.env.PAYNOW_API_KEY}` };
}
export async function paynowProducts(ip, token, fresh = false) {
  if (!paynowReady()) return [];
  // Cache partitions include IP and a token digest so customer pricing never crosses sessions.
  const load = async () => { const data = await jsonRequest('https://api.paynow.gg/v1/store/products', { headers: paynowHeaders(ip, token) }); return Array.isArray(data) ? data.filter(p => !p.hidden) : []; };
  const partition = createHash('sha256').update(`${ip}:${token || 'anonymous'}`).digest('hex');
  return fresh ? load() : cached(`paynow:${partition}`, 15_000, load);
}
function normalize(pkg, category) {
  return { id: String(pkg.id), name: String(pkg.name || ''), description: String(pkg.description || ''), image: httpsUrl(pkg.image?.url || pkg.image || pkg.image_url), price: Number(pkg.total_price ?? pkg.base_price ?? 0), currency: String(pkg.currency || 'USD').toUpperCase(), category: String(category.id), markup: parseDescription(pkg.description) };
}
export function rankCategory(categories) {
  return categories.find(category => category.slug.toLowerCase() === 'ranks' || /rank/i.test(category.name));
}
export async function catalog(ip, token) {
  const rankId = process.env.PAYNOW_RANK_TAG || 'ranks';
  if (!paynowReady()) return { categories: [], ready: false, unavailable: false, comparisonPackages: [], comparisonUnavailable: false, rankId };
  try {
    const products = [...await paynowProducts(ip, token)].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
    const categories = new Map();
    const comparisonPackages = [];
    const rankTag = rankId.toLowerCase();
    for (const product of products) {
      const tags = (product.tags || []).filter(tag => typeof tag.slug === 'string' && tag.slug);
      const isRank = tags.some(tag => tag.slug.toLowerCase() === rankTag);
      const groups = isRank ? [{ id: rankId, slug: 'ranks', name: 'Ranks' }]
        : tags.length ? tags.map(tag => ({ id: String(tag.id), slug: tag.slug, name: tag.name }))
          : [{ id: 'store', slug: 'store', name: 'Store' }];
      for (const group of groups) {
        if (!categories.has(group.id)) categories.set(group.id, { ...group, packages: [] });
        const pkg = normalize({ ...product, total_price: Number(product.pricing?.price_final ?? product.price) / 100 }, group);
        pkg.paynowId = String(product.id);
        categories.get(group.id).packages.push(pkg);
        if (isRank) comparisonPackages.push({ ...pkg, checkoutId: pkg.id });
      }
    }
    return { categories: [...categories.values()], ready: true, unavailable: false, comparisonPackages, comparisonUnavailable: false, rankId };
  } catch {
    return { categories: [], ready: true, unavailable: true, comparisonPackages: [], comparisonUnavailable: true, rankId };
  }
}
export async function leaderboard(mode, page, requestedSeason = null) {
  const apiBaseUrl = process.env.API_SERVER_BASE_URL || process.env.POINTS_API_BASE_URL;
  const apiKey = process.env.API_SERVER_API_KEY || process.env.POINTS_API_KEY;
  if (mode === 'pvp') return { entries: [], unavailable: false, ready: true, total: 0, hasNext: false, seasons: [] };
  if (!apiBaseUrl || !apiKey) return { entries: [], unavailable: false, ready: false, total: 0, hasNext: false, seasons: [], season: null };
  try {
    const headers = { Authorization: `Bearer ${apiKey}` };
    // Keep the allowlist in its own short cache. Resolve untrusted query values
    // against it before constructing a leaderboard cache key.
    const seasonResult = await cached('leaderboard:seasons', 15_000, async () => {
      const seasonsUrl = new URL('/v1/leaderboards/seasons', apiBaseUrl);
      const result = await jsonRequest(seasonsUrl, { headers });
      const seasons = Array.isArray(result.seasons)
        ? result.seasons.filter(item => item && typeof item.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.id) && typeof item.name === 'string')
        : [];
      return {
        seasons,
        currentSeason: typeof result.currentSeason === 'string' && seasons.some(item => item.id === result.currentSeason)
          ? result.currentSeason
          : null
      };
    });
    const { seasons, currentSeason } = seasonResult;
    const selected = seasons.find(item => item.id === requestedSeason)
      || seasons.find(item => item.id === currentSeason)
      || seasons[0]
      || null;
    if (!selected) return { entries: [], unavailable: false, ready: true, total: 0, hasNext: false, seasons, season: null, currentSeason };

    // Tiers are population based, so load the full season board before assigning
    // bands. Solo results use no stale cache so moderation changes take effect at once.
    const pageSize = 100;
    const loadPage = offset => cached(`leaderboard:${mode}:${selected.id}:${offset}`, mode === 'smp-solo' ? 0 : 15_000, async () => {
      const url = new URL(`/v1/leaderboards/${mode}`, apiBaseUrl);
      url.searchParams.set('limit', String(pageSize)); url.searchParams.set('offset', String(offset));
      url.searchParams.set('season', selected.id);
      const result = await jsonRequest(url, { headers });
      const entries = result.items || result.entries || result.data || [];
      const rows = Array.isArray(entries) ? entries : [];
      const totalKnown = Number.isSafeInteger(result.total) && result.total >= 0;
      const total = totalKnown ? result.total : rows.length;
      return { entries: rows, total, totalKnown, hasNext: result.nextOffset !== undefined ? result.nextOffset !== null : total > offset + rows.length, ready: true, unavailable: false, updatedAt: result.updatedAt, seasons, season: result.season || selected.id, seasonName: result.seasonName || selected.name, currentSeason: result.currentSeason || currentSeason };
    });
    const first = await loadPage(0);
    if (first.unavailable) return first;
    const total = Math.min(first.total, 10_000);
    const offsets = [];
    for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);
    const pages = [first];
    // Bound fan-out to keep the API and Supabase workload predictable.
    for (let index = 0; index < offsets.length; index += 5) {
      pages.push(...await Promise.all(offsets.slice(index, index + 5).map(loadPage)));
    }
    const entries = pages.flatMap(result => result.entries).slice(0, total);
    // Metadata has its own TTL; a cached board page must not prolong old kit URLs.
    return { ...first, seasons, entries, total: first.total, hasNext: false, truncated: first.total > total };
  } catch { return { entries: [], unavailable: true, ready: true, total: 0, hasNext: false, seasons: [], season: null }; }
}
