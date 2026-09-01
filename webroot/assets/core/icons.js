// Icon helper: inline Material Symbols SVG paths (offline, no font download).
// Paths come from the official google/material-design-icons repo and are
// baked into src/generated/icons.js by scripts/build.mjs.
import { ICONS } from '../generated/icons.js';

const FALLBACK = 'help';

export function icon(name, size = 24) {
  const it = ICONS[name] || ICONS[FALLBACK] || { vb: '0 0 24 24', d: '' };
  return `<svg viewBox="${it.vb}" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${it.d}"/></svg>`;
}

export function hasIcon(name) {
  return Boolean(ICONS[name]);
}
