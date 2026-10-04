import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';

export const rankImageHosts = Object.freeze([...new Set((process.env.RANK_IMAGE_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean))]);
if (rankImageHosts.length > 32 || rankImageHosts.some(host => host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))) throw new Error('RANK_IMAGE_HOSTS must contain at most 32 exact DNS hostnames, without schemes, paths, ports or wildcards.');
const approvedRankImageHosts = new Set(rankImageHosts);
export function rankImageUrl(value) {
  const source = String(value ?? '');
  // Inspect the original authority too: URL normalizes an explicit :443 away.
  const authority = /^https:\/\/([^/?#]+)/i.exec(source)?.[1];
  if (!authority || /[:@\\\s]/.test(authority)) return '';
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && approvedRankImageHosts.has(url.hostname) ? url.href : '';
  } catch { return ''; }
}
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function httpsUrl(value) {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
export function richHtml(value) {
  return sanitizeHtml(String(value ?? '').slice(0, 200_000), {
    allowedTags: ['p', 'ul', 'ol', 'li', 'br', 'strong', 'em', 'b', 'i', 'code', 'img', 'h2', 'h3', 'h4', 'span'],
    allowedAttributes: { img: ['src', 'width', 'height', 'alt'] },
    allowedSchemes: ['https'], allowProtocolRelative: false,
    transformTags: { img: (_, attrs) => ({ tagName: 'img', attribs: { ...(rankImageUrl(attrs.src) ? { src: rankImageUrl(attrs.src) } : {}), ...(attrs.alt ? { alt: attrs.alt.slice(0, 200) } : {}), ...(/^\d{1,4}$/.test(attrs.width || '') ? { width: attrs.width } : {}), ...(/^\d{1,4}$/.test(attrs.height || '') ? { height: attrs.height } : {}) } }) },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'svg', 'form']
  });
}
export function parseDescription(description) {
  const source = String(description ?? '').slice(0, 200_000);
  let $ = cheerio.load(source, {}, false);
  // PayNow can return markup entered in its editor as escaped text wrapped in
  // paragraphs (for example, &lt;perks&gt;). Decode that representation and
  // parse it as markup so the comparison table can read its sections.
  if (!$('perks').length) {
    const encodedMarkup = $.root().text();
    if (/<\s*perks(?:\s|>)/i.test(encodedMarkup)) $ = cheerio.load(encodedMarkup, {}, false);
  }
  const short = richHtml($('short-description').first().html());
  const sections = new Map();
  $('perks').each((_, block) => {
    const sectionNodes = $(block).find('section');
    const nodes = sectionNodes.length ? sectionNodes.toArray() : [block];
    for (const node of nodes) {
      const title = ($(node).attr('data-title') || $(node).find('h3').first().text() || 'Perks').trim().slice(0, 100);
      const rows = sections.get(title) || new Map();
      $(node).find('li[data-perk]').each((_, li) => {
        const key = ($(li).attr('data-perk') || '').trim().slice(0, 120);
        if (!key || rows.has(key)) return;
        const enabled = $(li).attr('data-enabled');
        const value = enabled !== undefined ? (enabled.toLowerCase() === 'true' ? '<span class="perk-check" aria-label="Included">✓</span>' : '<span class="muted" aria-label="Not included">—</span>') : richHtml($(li).find('value').first().html() ?? $(li).html());
        rows.set(key, value || '<span class="muted">—</span>');
      });
      if (rows.size) sections.set(title, rows);
    }
  });
  $('short-description, perks').remove();
  return { short, long: richHtml($.html()), sections };
}
export function comparison(packages) {
  const groups = new Map();
  for (const pkg of packages) for (const [title, perks] of pkg.markup.sections) {
    const group = groups.get(title) || new Map();
    for (const key of perks.keys()) if (!group.has(key)) group.set(key, packages.map(p => p.markup.sections.get(title)?.get(key) ?? '<span class="muted" aria-label="Not included">—</span>'));
    groups.set(title, group);
  }
  return [...groups].map(([title, rows]) => ({ title, rows: [...rows].map(([name, values]) => ({ name, values })) }));
}
