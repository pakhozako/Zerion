// Loading / empty / error / unsupported states.  Never a bare "Something went
// wrong": each state explains what happened and what to do next.
import { icon } from '../core/icons.js';
import { escapeHtml } from '../core/format.js';

export function loadingState(text = '正在读取…') {
  return `
    <div class="z-state">
      <md-loading size="40" color="var(--md-sys-color-primary)"></md-loading>
      <div class="z-state-detail">${escapeHtml(text)}</div>
    </div>`;
}

export function errorState({ title = '读取失败', detail, raw, retryLabel = '重试', onRetry }) {
  const rawHtml = raw
    ? `<button type="button" class="z-raw-toggle" data-raw-toggle aria-expanded="false">${icon('expand_more', 16)}<span>查看输出</span></button>
       <pre class="z-raw" data-raw hidden>${escapeHtml(raw)}</pre>`
    : '';
  const retryHtml = onRetry ? `<md-button color="tonal" data-retry>${escapeHtml(retryLabel)}</md-button>` : '';
  return `
    <div class="z-state">
      ${icon('error', 40)}
      <div class="z-state-title">${escapeHtml(title)}</div>
      ${detail ? `<div class="z-state-detail">${escapeHtml(detail)}</div>` : ''}
      ${rawHtml}
      ${retryHtml}
    </div>`;
}

export function wireErrorState(container, { onRetry } = {}) {
  container.querySelectorAll('[data-raw-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.parentElement.querySelector('[data-raw]');
      if (!pre) return;
      const open = pre.hidden;
      pre.hidden = !open;
      pre.dataset.open = open ? 'true' : 'false';
    });
  });
  const retry = container.querySelector('[data-retry]');
  if (retry && onRetry) retry.addEventListener('click', onRetry);
}

export function emptyState({ title = '暂无数据', detail, iconName = 'inventory_2' }) {
  return `
    <div class="z-state">
      ${icon(iconName, 40)}
      <div class="z-state-title">${escapeHtml(title)}</div>
      ${detail ? `<div class="z-state-detail">${escapeHtml(detail)}</div>` : ''}
    </div>`;
}

export function bridgeUnavailableState() {
  return `
    <div class="z-state z-state-full">
      ${icon('lock', 48)}
      <div class="z-state-title">需要 Root 管理器环境</div>
      <div class="z-state-detail">Zerion WebUI 需要 KernelSU 或 APatch 提供的 root 桥接。请通过模块管理器打开本页面；Magisk 环境请使用设备端 action.sh。</div>
    </div>`;
}
