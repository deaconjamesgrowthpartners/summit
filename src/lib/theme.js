// workspaces.brand -> design tokens. Nothing about any client lives in CSS.
// The tokens go in a stylesheet, not inline styles, so dark mode can
// replace every one of them. Inline values would beat the media query
// and leave light text on a light page.
import { palette, css } from './palette.js';

export function applyBrand(brand = {}) {
  let tag = document.getElementById('brand-tokens');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'brand-tokens';
    document.head.appendChild(tag);
  }
  const p = palette(brand);
  tag.textContent = css(p);

  const root = document.documentElement.style;
  const font = String(brand.font || '').replace(/[^A-Za-z0-9 ]/g, '').trim();
  if (font) {
    root.setProperty('--font', `"${font}",Arial,Helvetica,sans-serif`);
    let link = document.getElementById('brand-font');
    if (!link) {
      link = document.createElement('link');
      link.id = 'brand-font';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
  } else {
    root.removeProperty('--font');
  }
  const meta = document.querySelector('meta[name=theme-color]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  meta.content = p.light.head;
}

export function safeLogo(url) {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}
