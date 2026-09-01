// App list row: avatar (first letter), label + package, status badge.
import { icon } from '../core/icons.js';
import { escapeHtml } from '../core/format.js';
import { statusOf } from '../core/state.js';

export function appRow({ packageName, label, status, sub, href }) {
  const s = statusOf(status);
  const letter = (label || packageName || '?').trim().charAt(0).toUpperCase() || '?';
  return `
    <a class="z-app-row" href="${escapeHtml(href)}" data-pkg="${escapeHtml(packageName)}">
      <span class="z-app-avatar">${escapeHtml(letter)}</span>
      <span class="z-app-main">
        <span class="z-app-name">${escapeHtml(label || packageName)}</span>
        <span class="z-app-sub">${escapeHtml(packageName)}${sub ? ' · ' + escapeHtml(sub) : ''}</span>
      </span>
      <span class="z-app-end">
        <span class="z-status z-status--${s.key}">${icon(s.icon, 15)}${escapeHtml(s.label)}</span>
        ${icon('chevron_right', 20)}
      </span>
    </a>`;
}
