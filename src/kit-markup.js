import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';
import { httpsUrl } from './markup.js';

const icons = Object.freeze({
  netherite_chestplate: 'netherite_chestplate.png',
  tnt_minecart: 'tnt_minecart.png',
  end_crystal: 'end_crystal.png',
  mace: 'mace.png',
  clock: 'clock.png',
  heart: 'heart.png'
});
const kitClasses = ['kit-title', 'kit-subtitle', 'kit-section', 'kit-list', 'kit-label', 'kit-value', 'kit-screenshot'];

function imageSource(value) {
  const source = String(value ?? '').trim();
  if (/^\/assets\/(?:kits|minecraft)\/[a-zA-Z0-9_./-]+$/.test(source)
    && !source.split('/').includes('..')) return source;
  const remote = source.length <= 2048 ? httpsUrl(source) : '';
  // Keep image origins safe to interpolate into the response's CSP directive.
  return remote && /^[a-z0-9.-]+$/i.test(new URL(remote).hostname) ? remote : '';
}

/** Admin-authored season content: formatting only, never executable HTML. */
export function renderKitHtml(value, { imageUrl = '' } = {}) {
  const html = sanitizeHtml(String(value ?? '').slice(0, 20_000), {
    allowedTags: ['section', 'div', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'span', 'strong', 'em', 'b', 'i', 'br', 'hr', 'code', 'img'],
    allowedAttributes: {
      '*': ['class'],
      img: ['src', 'alt', 'class', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
      span: ['class', 'aria-hidden']
    },
    allowedClasses: { '*': kitClasses, img: [...kitClasses, 'kit-icon'], span: [...kitClasses, 'kit-icon', 'kit-icon-tipped-arrow'] },
    allowedSchemes: ['https'], allowProtocolRelative: false,
    transformTags: {
      'mc-icon': (_tag, attrs) => {
        if (attrs.name === 'tipped_arrow') return { tagName: 'span', attribs: { class: 'kit-icon kit-icon-tipped-arrow', 'aria-hidden': 'true' } };
        const file = Object.hasOwn(icons, attrs.name || '') ? icons[attrs.name] : '';
        return file ? {
          tagName: 'img', attribs: { class: 'kit-icon', src: `/assets/minecraft/${file}`, alt: '', width: '16', height: '16', loading: 'lazy', decoding: 'async' }
        } : { tagName: 'span', attribs: {}, text: '' };
      },
      'kit-image': (_tag, attrs) => ({
        tagName: 'img', attribs: { class: 'kit-screenshot', src: imageSource(imageUrl), alt: String(attrs.alt || 'Example kit inventory').slice(0, 200), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }
      }),
      img: (_tag, attrs) => ({
        tagName: 'img', attribs: { src: imageSource(attrs.src), alt: String(attrs.alt || '').slice(0, 200), class: attrs.class || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }
      })
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'iframe', 'svg', 'form', 'object', 'embed', 'template']
  });
  const $ = cheerio.load(html, {}, false);
  // Bound remote image fan-out; origins come only from the final sanitized HTML.
  $('img').slice(24).remove();
  const imageUrls = $('img').toArray().map(node => httpsUrl($(node).attr('src'))).filter(Boolean);
  const hasContent = Boolean($.root().text().trim() || $('img, .kit-icon-tipped-arrow').length);
  const content = hasContent ? $.html().trim() : '';
  return { html: content, imageUrls };
}
