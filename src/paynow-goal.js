// PayNow remains the source of module settings and revenue. No order ledger is
// stored locally, so retries / restarts cannot double-count goal contributions.
export function createPaynowGoalReader({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
  if (!env.PAYNOW_API_KEY || !/^\d{1,30}$/.test(env.PAYNOW_STORE_ID || '')) return async () => null;
  let cached = null, expires = 0, pending;
  async function request(path) {
    const response = await fetchImpl(`https://api.paynow.gg${path}`, {
      redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { Accept: 'application/json', Authorization: `APIKey ${env.PAYNOW_API_KEY}` },
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('PayNow goal unavailable'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing PayNow goal body');
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) { await reader.cancel(); throw new Error('PayNow goal body too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return async () => {
    if (expires > now()) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const modules = await request(`/v1/stores/${env.PAYNOW_STORE_ID}/webstore/modules`);
        const active = Array.isArray(modules) ? modules.filter(m => m?.enabled && m.type === 'payment_goal'
          && (!m.starts_at || Date.parse(m.starts_at) <= now())
          && (!m.ends_at || Date.parse(m.ends_at) > now())
          && (!env.PAYNOW_GOAL_MODULE_ID || m.id === env.PAYNOW_GOAL_MODULE_ID)) : [];
        if (active.length !== 1) throw new Error('Select one active payment goal');
        const module = active[0], settings = module.settings;
        if (!Number.isSafeInteger(settings?.goalTarget) || settings.goalTarget <= 0) throw new Error('Invalid goal target');
        // Native summary windows match daily, monthly and lifetime goals in UTC.
        const windows = { daily: ['today_revenue', 'today_order_count'], monthly: ['month_to_date_revenue', 'month_to_date_order_count'], all_time: ['lifetime_revenue', 'lifetime_order_count'], lifetime: ['lifetime_revenue', 'lifetime_order_count'] };
        const window = windows[settings.period];
        if (!window) throw new Error('Unsupported goal period');
        const summary = await request(`/v2/stores/${env.PAYNOW_STORE_ID}/stats/orders/summary?tz=UTC&revenue_basis=gross`);
        const money = summary[window[0]], count = summary[window[1]];
        const revenue = money?.amount_minor_units ?? (money === null && count === 0 ? 0 : NaN);
        if (!Number.isSafeInteger(revenue) || revenue < 0 || summary.revenue_basis !== 'gross') throw new Error('Invalid goal revenue');
        const percentage = revenue / settings.goalTarget * 100;
        cached = { percentage: settings.allowPercentageOverflow ? percentage : Math.min(percentage, 100), moduleId: module.id };
        expires = now() + 30_000;
        return cached;
      } catch {
        // Failure never suppresses paid-order announcements or implies zero revenue.
        cached = null; expires = now() + 15_000;
        logger.warn(JSON.stringify({ event: 'paynow_goal_unavailable' }));
        return null;
      } finally { pending = null; }
    })();
    return pending;
  };
}

export function goalProgress(goal) {
  if (!goal || !Number.isFinite(goal.percentage) || goal.percentage < 0) return 'Progress temporarily unavailable.';
  const filled = Math.floor(Math.min(goal.percentage, 100) / 10);
  return `${goal.percentage.toFixed(2)}% / 100% (${'■'.repeat(filled)}${'□'.repeat(10 - filled)})`;
}
