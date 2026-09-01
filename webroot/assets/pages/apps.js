// Apps list — a thin Settings-style list over the dexopt dump, with search
// and status filters.  The designed pages are Dashboard and App Details; this
// page only reuses shared components to make App Details reachable.
//
// The search field and filter chips are rendered once; typing updates only
// the list container, so focus and the typed value are preserved.

import { escapeHtml, compilerFilterLabel } from '../core/format.js';
import { collectDexoptAll, buildAppMeta, appLabel, isSystemApp, primaryStatus, appHealth } from '../core/data.js';
import { appRow } from '../components/app-row.js';
import { loadingState, errorState, wireErrorState, emptyState } from '../components/state-view.js';
import { icon } from '../core/icons.js';

let state = {
  packages: [],
  meta: new Map(),
  query: '',
  filter: 'all', // all | attention | user | system
  loaded: false,
};

let listEl = null;

export async function mount(root) {
  if (!state.loaded) {
    root.innerHTML = loadingState('正在读取应用列表…');
    try {
      state.packages = await collectDexoptAll();
      state.meta = buildAppMeta(state.packages.map((p) => p.packageName));
      state.loaded = true;
    } catch (err) {
      root.innerHTML = errorState({
        title: '无法读取应用列表',
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

function renderChrome(root) {
  const chip = (key, label) =>
    `<md-chip type="filter" ${state.filter === key ? 'selected' : ''} data-filter="${key}">${label}</md-chip>`;

  root.innerHTML = `
    <div style="padding:4px 0 8px;">
      <md-text-field class="z-search-field" label="搜索应用" data-search value="${escapeHtml(state.query)}">
        <md-icon slot="leading-icon">${icon('search')}</md-icon>
      </md-text-field>
    </div>
    <div class="z-chip-row">
      ${chip('all', '全部')}
      ${chip('attention', '需关注')}
      ${chip('user', '第三方')}
      ${chip('system', '系统')}
    </div>
    <div class="z-body-small z-on-surface-variant" style="padding:8px 4px 4px;" data-count></div>
    <div data-list></div>
  `;

  listEl = root.querySelector('[data-list]');
  const countEl = root.querySelector('[data-count]');

  const field = root.querySelector('[data-search]');
  if (field) {
    field.addEventListener('input', () => {
      state.query = field.value || '';
      renderList(countEl);
    });
  }

  root.querySelectorAll('[data-filter]').forEach((c) => {
    c.addEventListener('click', () => {
      if (state.filter === c.dataset.filter) return;
      state.filter = c.dataset.filter;
      renderChrome(root);
    });
  });

  renderList(countEl);
}

function renderList(countEl) {
  if (!listEl) return;
  const visible = state.packages.filter(matches);
  const sorted = [...visible].sort((a, b) => {
    const ha = appHealth(a) === 'warning' ? 0 : 1;
    const hb = appHealth(b) === 'warning' ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return appLabel(state.meta, a.packageName).localeCompare(appLabel(state.meta, b.packageName), 'zh');
  });

  listEl.innerHTML = sorted.length
    ? `<div class="z-list">${sorted.map((pkg) => {
        const p = primaryStatus(pkg);
        return appRow({
          packageName: pkg.packageName,
          label: appLabel(state.meta, pkg.packageName),
          status: appHealth(pkg),
          sub: p ? compilerFilterLabel(p.compilerFilter).human : '',
          href: `#/apps/${encodeURIComponent(pkg.packageName)}`,
        });
      }).join('')}</div>`
    : emptyState({ title: '没有匹配的应用', detail: '换个关键词或筛选条件试试。', iconName: 'search' });

  if (countEl) {
    countEl.textContent = `共 ${state.packages.length} 个应用，显示 ${sorted.length} 个`;
  }
}

function matches(pkg) {
  const label = appLabel(state.meta, pkg.packageName);
  const q = state.query.trim().toLowerCase();
  if (q && !label.toLowerCase().includes(q) && !pkg.packageName.toLowerCase().includes(q)) return false;
  const isSystem = isSystemApp(state.meta, pkg.packageName);
  if (state.filter === 'user' && isSystem !== false) return false;
  if (state.filter === 'system' && isSystem !== true) return false;
  if (state.filter === 'attention' && appHealth(pkg) !== 'warning') return false;
  return true;
}
