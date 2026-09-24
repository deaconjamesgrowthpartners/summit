// workspaces.brand -> CSS variables. Nothing about any client lives in CSS.
const COLOR = /^#[0-9a-f]{3,8}$/i;
const MAP = { head: '--head', accent: '--accent', bg: '--bg', panel: '--panel', muted: '--muted', surface: '--surface', ink: '--ink', ink2: '--ink2' };

export function applyBrand(brand = {}) {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(MAP)) {
    if (COLOR.test(brand[k] || '')) root.setProperty(v, brand[k]);
    else root.removeProperty(v);
  }
  if (COLOR.test(brand.accent || '')) root.setProperty('--brandAccent', brand.accent);
  const font = String(brand.font || '').replace(/[^A-Za-z0-9 ]/g, '').trim();
  if (font) {
    root.setProperty('--font', `"${font}",Arial,Helvetica,sans-serif`);
    const id = 'brand-font';
    let link = document.getElementById(id);
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
  } else {
    root.removeProperty('--font');
  }
  const meta = document.querySelector('meta[name=theme-color]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  meta.content = COLOR.test(brand.head || '') ? brand.head : '#2B2B2B';
}

export function safeLogo(url) {
  return typeof url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}
