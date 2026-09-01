// 操作记录 — a day-grouped timeline of what Zerion did on the device.
//
// Scope honesty: the device-side log (events.jsonl, written by action.sh
// log-event) only records Zerion's own operations (apply / reset / recompile /
// reset-compile / install …).  System-initiated dexopt is NOT in this log; the
// dashboard's "最近编译" section is the proxy for that.  The page says so in
// its lead-in instead of pretending to be a full system event feed.
//
// Layout follows the shared template: lead-in -> filter chips -> count ->
// day-grouped list.  Rows reuse the Settings-style row pattern (icon + main +
// end); rows that belong to an app drill into App Details.

import { escapeHtml, eventTypeLabel, eventTypeIcon, eventResultChip, formatRelative, dayLabel } from '../core/format.js';
import { collectEvents, buildAppMeta, appLabel } from '../core/data.js';
import { skeletonState, errorState, wireErrorState, emptyState } from '../components/state-view.js';
import { icon } from '../core/icons.js';

// Type filters are user-facing groups over the raw event types; unknown types
// only appear under 全部 (and never get dropped silently).
const TYPE_GROUPS = {
  compile: { label: '编译', types: ['recompile', 'reset-compile'] },
  config: { label: '配置', types: ['apply', 'reset'] },
  module: { label: '模块', types: ['install', 'update', 'uninstall'] },
};

let state = { events: [], meta: new Map(), type: 'all', result: 'all', loaded: false };
let listEl = null;

export async function mount(root) {
  if (!state.loaded) {
    root.innerHTML = skeletonState('list');
    try {
      state.events = await collectEvents(200);
      const pkgs = [...new Set(state.events.map((e) => e.pkg).filter(Boolean))];
      state.meta = buildAppMeta(pkgs);
      state.loaded = true;
    } catch (err) {
      root.innerHTML = errorState({
        title: '无法读取操作记录',
        detail: err.message || String(err),
        raw: err.stderr || err.stdout || '',
        onRetry: () => mount(root),
      });
      wireErrorState(root, { onRetry: () => mount(root) });
      return;
    }
  }
  renderChrome(root);
}

export function unmount() {
  state.loaded = false; // data may be stale; refresh on next visit
}

function chip(kind, value, label, selected) {
  return `<md-chip type="filter" ${selected ? 'selected' : ''} data-filter="${kind}:${value}">${label}</md-chip>`;
}

function renderChrome(root) {
  root.innerHTML = `
    <div class="z-body-medium z-on-surface-variant" style="padding:6px 4px 10px;">这里记录 Zerion 在设备端执行的操作。系统自动触发的 dexopt 不在此列，应用最近编译时间请在仪表盘查看。</div>
    <div class="z-chip-row">
      ${chip('type', 'all', '全部', state.type === 'all')}
      ${Object.entries(TYPE_GROUPS).map(([k, g]) => chip('type', k, g.label, state.type === k)).join('')}
    </div>
    <div class="z-chip-row">
      ${chip('result', 'all', '全部结果', state.result === 'all')}
      ${chip('result', 'ok', '成功', state.result === 'ok')}
      ${chip('result', 'fail', '失败', state.result === 'fail')}
    </div>
    <div class="z-body-small z-on-surface-variant" style="padding:10px 4px 2px;" data-count></div>
    <div data-list></div>
  `;
  listEl = root.querySelector('[data-list]');
  root.querySelectorAll('[data-filter]').forEach((c) => {
    c.addEventListener('click', () => {
      const [kind, value] = c.dataset.filter.split(':');
      if (state[kind] === value) return;
      state[kind] = value;
      renderChrome(root);
    });
  });
  renderList(root.querySelector('[data-count]'));
}

function matches(ev) {
  if (state.result !== 'all' && String(ev.result || '').trim() !== state.result) return false;
  if (state.type === 'all') return true;
  const g = TYPE_GROUPS[state.type];
  return !!g && g.types.includes(String(ev.type || '').trim());
}

function renderList(countEl) {
  if (!listEl) return;
  const visible = state.events.filter(matches);
  if (countEl) {
    const filtered = state.type !== 'all' || state.result !== 'all';
    countEl.textContent = filtered
      ? `共 ${state.events.length} 条记录，显示 ${visible.length} 条`
      : `共 ${state.events.length} 条记录`;
  }
  if (!state.events.length) {
    listEl.innerHTML = emptyState({
      title: '还没有操作记录',
      detail: '在仪表盘应用配置，或在应用详情执行重新编译后，操作会显示在这里。',
      iconName: 'history',
    });
    return;
  }
  if (!visible.length) {
    listEl.innerHTML = emptyState({
      title: '没有匹配的记录',
      detail: '换个筛选条件试试。',
      iconName: 'search',
    });
    return;
  }
  listEl.innerHTML = groupByDay(visible).map((g) => `
    <div class="z-day-group">
      <div class="z-day-header">
        <span class="z-label-medium">${escapeHtml(g.label)}</span>
        <span class="z-body-small z-on-surface-variant">${g.events.length} 条</span>
      </div>
      <div class="z-list">${g.events.map(eventRow).join('')}</div>
    </div>`).join('');
}

// Newest-first input; groups keep that order (today/yesterday/…).
function groupByDay(events) {
  const groups = [];
  const byLabel = new Map();
  for (const ev of events) {
    const label = dayLabel(ev.t);
    let g = byLabel.get(label);
    if (!g) {
      g = { label, events: [] };
      byLabel.set(label, g);
      groups.push(g);
    }
    g.events.push(ev);
  }
  return groups;
}

function eventRow(ev) {
  const subParts = [];
  if (ev.pkg) {
    const label = appLabel(state.meta, ev.pkg);
    subParts.push(label === ev.pkg ? ev.pkg : `${label} · ${ev.pkg}`);
  }
  if (ev.detail) subParts.push(ev.detail);
  const inner = `
    <span class="z-event-icon">${icon(eventTypeIcon(ev.type), 20)}</span>
    <span class="z-event-main">
      <span class="z-event-title">${escapeHtml(eventTypeLabel(ev.type))}</span>
      ${subParts.length ? `<span class="z-event-sub">${escapeHtml(subParts.join(' · '))}</span>` : ''}
    </span>
    <span class="z-event-end">
      <span class="z-event-time">${escapeHtml(formatRelative(ev.t))}</span>
      ${eventResultChip(ev.result)}
    </span>`;
  return ev.pkg
    ? `<a class="z-event-row" href="#/apps/${encodeURIComponent(ev.pkg)}" data-pkg="${escapeHtml(ev.pkg)}">${inner}</a>`
    : `<div class="z-event-row">${inner}</div>`;
}
