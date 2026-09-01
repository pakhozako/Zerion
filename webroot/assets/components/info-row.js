// Label / value row with an optional expandable technical detail.
// "人话优先，技术细节可展开"：value 展示人话，tech 展示底层原始值。
import { icon } from '../core/icons.js';
import { escapeHtml } from '../core/format.js';

export function infoRow({ label, value, tech, raw, status }) {
  const statusHtml = status ? `<span class="z-status z-status--${status.key}">${icon(status.icon, 15)}${escapeHtml(status.label)}</span>` : '';
  const valueHtml = value != null ? escapeHtml(value) : '<span class="z-on-surface-variant">未知</span>';
  const techHtml = tech ? `<span class="z-tech">${escapeHtml(tech)}</span>` : '';
  const rawHtml = raw
    ? `
      <button type="button" class="z-raw-toggle" data-raw-toggle aria-expanded="false">${icon('expand_more', 16)}<span>详情</span></button>
      <pre class="z-raw" data-raw hidden>${escapeHtml(raw)}</pre>`
    : '';
  return `
    <div class="z-info-row">
      <div class="z-info-label">${escapeHtml(label)}</div>
      <div class="z-info-value">
        ${statusHtml ? `<div>${statusHtml}</div>` : ''}
        <div>${valueHtml}${techHtml}</div>
        ${rawHtml}
      </div>
    </div>`;
}

export function wireRawToggles(container) {
  container.querySelectorAll('[data-raw-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.parentElement.querySelector('[data-raw]');
      if (!pre) return;
      const open = pre.hidden;
      pre.hidden = !open;
      pre.dataset.open = open ? 'true' : 'false';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const svg = btn.querySelector('svg');
      if (svg) svg.style.transform = open ? 'rotate(180deg)' : '';
    });
  });
}
