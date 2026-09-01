// Unified status system for the whole WebUI.
//
// Every status-bearing surface (badges, rows, pages) uses these five states
// and their canonical icon + color mapping, so "未知" is never mistaken for
// "异常" and "已停用" is visually distinct from "正常".

export const STATUS = {
  healthy: { key: 'healthy', label: '正常', icon: 'check_circle' },
  warning: { key: 'warning', label: '需注意', icon: 'warning' },
  error: { key: 'error', label: '异常', icon: 'error' },
  unknown: { key: 'unknown', label: '未知', icon: 'help' },
  disabled: { key: 'disabled', label: '已停用', icon: 'block' },
};

export const STATUS_ORDER = ['healthy', 'warning', 'error', 'unknown', 'disabled'];
const SEVERITY = { healthy: 0, disabled: 1, unknown: 2, warning: 3, error: 4 };

export function statusOf(key) {
  return STATUS[key] || STATUS.unknown;
}

// Combine a list of statuses into the worst one (error > warning > unknown).
export function worstStatus(keys) {
  let worst = 'healthy';
  for (const k of keys) {
    const s = STATUS[k] ? k : 'unknown';
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return statusOf(worst);
}

export function statusBadge(key) {
  const s = statusOf(key);
  return `<span class="z-status z-status--${s.key}">${requireIcon(s.icon)}${escapeHtml(s.label)}</span>`;
}

// Local import to avoid a circular dependency at module scope.
import { icon } from './icons.js';
import { escapeHtml } from './format.js';
function requireIcon(name) { return icon(name, 15); }
