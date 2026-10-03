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
async function comparisonCatalog() {
  if (!process.env.TEBEX_PUBLIC_TOKEN) return { categories: [], ready: false, unavailable: false };
  try {
    const categories = await cached('tebex', 60_000, async () => {
      const result = await jsonRequest(`https://headless.tebex.io/api/accounts/${encodeURIComponent(process.env.TEBEX_PUBLIC_TOKEN)}/categories?includePackages=1`);
      const flatten = items => items.flatMap(category => [{ id: String(category.id), name: String(category.name), slug: String(category.slug || ''), packages: (category.packages || []).map(p => normalize(p, category)) }, ...flatten(category.subcategories || [])]);
      return flatten(result.data || []);
    });
    return { categories, ready: true, unavailable: false };
  } catch { return { categories: [], ready: true, unavailable: true }; }
}
export function rankCategory(categories) {
  return process.env.RANK_CATEGORY_ID ? categories.find(category => category.id === process.env.RANK_CATEGORY_ID) : categories.find(category => category.slug.toLowerCase() === 'ranks' || /rank/i.test(category.name));
}
export async function catalog(ip, token) {
  const [tebexResult, productsResult] = await Promise.allSettled([comparisonCatalog(), paynowProducts(ip, token)]);
  const tebex = tebexResult.status === 'fulfilled' ? tebexResult.value : { categories: [], unavailable: true };
  const comparisonCategory = rankCategory(tebex.categories);
  const comparisonPackages = comparisonCategory?.packages || [];
  const rankId = comparisonCategory?.id || process.env.RANK_CATEGORY_ID || 'ranks';
  if (!paynowReady()) return { categories: [], ready: false, unavailable: false, comparisonPackages, comparisonUnavailable: tebex.unavailable, rankId };
  try {
    if (productsResult.status === 'rejected') throw productsResult.reason;
    const products = [...productsResult.value].sort((a,b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
    const categories = new Map();
    const mappedRanks = new Set(comparisonPackages.map(p => productId(p.id)).filter(Boolean));
    for (const product of products) {
      const tags = (product.tags || []).filter(t => t.slug);
      const isRank = mappedRanks.has(String(product.id)) || tags.some(t => t.slug === (process.env.PAYNOW_RANK_TAG || 'ranks'));
      const groups = isRank ? [{ id: rankId, slug: 'ranks', name: 'Ranks' }] : tags.length ? tags.map(t => ({ id: String(t.id), slug: t.slug, name: t.name })) : [{ id: 'store', slug: 'store', name: 'Store' }];
      for (const group of groups) {
        if (!categories.has(group.id)) categories.set(group.id, { ...group, packages: [] });
        const pkg = normalize({ ...product, total_price: Number(product.pricing?.price_final ?? product.price) / 100 }, group);
        pkg.paynowId = String(product.id);
        categories.get(group.id).packages.push(pkg);
      }
    }
    return { categories: [...categories.values()], ready: true, unavailable: false, comparisonPackages, comparisonUnavailable: tebex.unavailable, rankId };
  } catch { return { categories: [], ready: true, unavailable: true, comparisonPackages, comparisonUnavailable: tebex.unavailable, rankId }; }
}
export function productId(packageId) {
  try { const mapping = JSON.parse(process.env.PAYNOW_PRODUCT_MAP || '{}'); return typeof mapping[packageId] === 'string' && /^\d+$/.test(mapping[packageId]) ? mapping[packageId] : ''; } catch { return ''; }
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

    // Player boards need an authoritative moderation check for every render.
    // A zero TTL still coalesces concurrent requests without serving pre-ban rows.
    const loadPage = pageNumber => cached(`leaderboard:${mode}:${selected.id}:${pageNumber}`, mode === 'smp-solo' ? 0 : 15_000, async () => {
      const url = new URL(`/v1/leaderboards/${mode}`, apiBaseUrl);
      url.searchParams.set('limit', '6'); url.searchParams.set('offset', String((pageNumber - 1) * 6));
      url.searchParams.set('season', selected.id);
      const result = await jsonRequest(url, { headers });
      const entries = result.items || result.entries || result.data || [];
      const rows = Array.isArray(entries) ? entries : [];
      const totalKnown = Number.isSafeInteger(result.total) && result.total >= 0;
      const total = totalKnown ? result.total : rows.length;
      return { entries: rows, total, totalKnown, hasNext: result.nextOffset !== undefined ? result.nextOffset !== null : total > pageNumber * 6, ready: true, unavailable: false, updatedAt: result.updatedAt, seasons, season: result.season || selected.id, seasonName: result.seasonName || selected.name, currentSeason: result.currentSeason || currentSeason };
    });
    if (page === 1) return await loadPage(1);
    const firstPage = await loadPage(1);
    if (firstPage.totalKnown) {
      const lastPage = Math.max(1, Math.min(1667, Math.ceil(firstPage.total / 6)));
      if (page > lastPage) return { ...firstPage, entries: [], hasNext: false, redirectPage: lastPage };
    }
    return await loadPage(page);
  } catch { return { entries: [], unavailable: true, ready: true, total: 0, hasNext: false, seasons: [], season: null }; }
}

