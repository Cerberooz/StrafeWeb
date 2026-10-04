import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.API_SERVER_BASE_URL = 'https://api.example.invalid';
process.env.API_SERVER_API_KEY = 'test-key';
const originalFetch = globalThis.fetch;
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const textureHash = 'ab'.repeat(32);

test('large boards retain every appearance while bounding API concurrency', async () => {
  let active = 0, peak = 0, calls = 0;
  globalThis.fetch = async url => {
    const query = new URL(url);
    assert.equal(query.searchParams.get('resolvePremium'), 'false');
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    const skins = Object.fromEntries(query.searchParams.get('ids').split(',').map(playerId => [playerId, {
      premium: false, linked: true, model: 'classic', textureUrl: `https://textures.minecraft.net/texture/${textureHash}`,
    }]));
    return new Response(JSON.stringify({ skins }));
  };
  try {
    const { accountPortraits } = await import('../src/portraits.js?large-board');
    const entries = Array.from({ length: 2505 }, (_, i) => ({ subjectId: id(i) }));
    const result = await accountPortraits(entries);
    assert.equal(calls, 26);
    assert.ok(peak <= 16);
    assert.ok(result.every(entry => entry.profilePortraitUrl === `https://render.crafty.gg/3d/bust/${textureHash}`));
    assert.ok(result.every(entry => entry.portraitUrl === entry.profilePortraitUrl));
    const priorCalls = calls;
    await accountPortraits([entries.at(-1)]);
    assert.equal(calls, priorCalls);
  } finally { globalThis.fetch = originalFetch; }
});

test('premium UUIDs override selected skins, and untrusted textures never reach HTML', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ skins: {
    [id(1)]: { premium: true, linked: false, model: 'classic', textureUrl: 'https://untrusted.invalid/texture.png' },
  } }));
  try {
    const { accountPortraits } = await import('../src/portraits.js?premium');
    const [premium] = await accountPortraits([{ subjectId: id(1) }]);
    assert.equal(premium.profilePortraitUrl, `https://render.crafty.gg/3d/bust/${id(1)}`);
    assert.equal(premium.portraitUrl, premium.profilePortraitUrl);
    globalThis.fetch = async () => new Response(JSON.stringify({ skins: {
      [id(2)]: { premium: false, linked: true, model: 'classic', textureUrl: 'https://untrusted.invalid/texture.png' },
    } }));
    const [untrusted] = await accountPortraits([{ subjectId: id(2) }]);
    assert.equal(untrusted.profilePortraitUrl, null);
    assert.equal(untrusted.portraitUrl, null);
  } finally { globalThis.fetch = originalFetch; }
});
