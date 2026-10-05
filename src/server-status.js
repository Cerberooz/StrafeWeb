// One shared, bounded request per cache interval; visitors never choose the target.
const address = process.env.SERVER_STATUS_ADDRESS || process.env.MINECRAFT_ADDRESS || 'strafemc.net';
if (!/^[a-zA-Z0-9.:[\]-]{1,255}$/.test(address)) throw new Error('Invalid SERVER_STATUS_ADDRESS.');
let cached = { state: 'unavailable', players: null };
let expires = 0;
let pending;

export function serverStatus() {
  if (Date.now() < expires) return Promise.resolve(cached);
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(address)}`, {
        headers: { 'User-Agent': 'StrafeMC-Website/1.0 (Minecraft network status)' },
        signal: AbortSignal.timeout(5000), redirect: 'error'
      });
      if (!response.ok) throw new Error('Status provider unavailable');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1048576) throw new Error('Status response too large');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof data.online !== 'boolean') throw new Error('Invalid status response');
      const players = data.players?.online;
      if (data.online && (!Number.isSafeInteger(players) || players < 0)) throw new Error('Invalid player count');
      cached = { state: data.online ? 'online' : 'offline', players: data.online ? players : null };
      expires = Date.now() + 300000;
    } catch {
      cached = { state: 'unavailable', players: null };
      expires = Date.now() + 30000;
    }
    return cached;
  })().finally(() => { pending = null; });
  return pending;
}
