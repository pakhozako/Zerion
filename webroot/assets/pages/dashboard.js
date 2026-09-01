// Dashboard — the visual/UX baseline of the WebUI.
//
// Priority order on the page: overall status -> problems (needs attention) ->
// module/device facts -> compile overview -> storage.  Detailed technical
// information lives in App Details / deeper pages, not here.

import { icon } from '../core/icons.js';
import { escapeHtml, formatBytes, formatBytesExact, formatDate, sdkLabel, reasonLabel, reasonTech, compilerFilterLabel, managerLabel } from '../core/format.js';
import { statusOf, worstStatus, statusBadge } from '../core/state.js';
import { collectDeviceInfo, collectModuleState, collectDexoptAll, summarizeDexopt, collectOatStorage, buildAppMeta, appLabel, primaryStatus, appHealth } from '../core/data.js';
import { runAction, shellAction } from '../core/actions.js';
import { section, card, emptySection } from '../components/section.js';
import { infoRow, wireRawToggles } from '../components/info-row.js';
import { appRow } from '../components/app-row.js';
import { loadingState, errorState, wireErrorState } from '../components/state-view.js';

const MODULE_DIR = '/data/adb/modules/zerion';

export async function mount(root) {
  root.innerHTML = loadingState('正在读取设备状态…');
  try {
    const [device, moduleState, packages, oat] = await Promise.all([
      collectDeviceInfo(),
      collectModuleState(),
      collectDexoptAll(),
      collectOatStorage(),
    ]);
    const summary = summarizeDexopt(packages);
    const meta = buildAppMeta(summary.attentionApps.map((a) => a.pkg.packageName));
    render(root, { device, moduleState, summary, oat, meta });
  } catch (err) {
    root.innerHTML = errorState({
      title: '无法读取设备状态',
      detail: err.message || String(err),
      raw: err.stderr || err.stdout || '',
      onRetry: () => mount(root),
    });
    wireErrorState(root, { onRetry: () => mount(root) });
  }
}

export function unmount() { /* nothing to clean up */ }

function overallStatus(summary, device) {
  if (!device || !device.sdk) return 'unknown';
  if (summary.total === 0) return 'unknown';
  if (summary.attention > 0) return 'warning';
  return 'healthy';
}

function render(root, { device, moduleState, summary, oat, meta }) {
  const status = overallStatus(summary, device);
  const st = statusOf(status);

  const deviceRows = [
    ['型号', device.model || '', device.brand || ''],
    ['Android 版本', sdkLabel(device.sdk), `SDK ${device.sdk || '?'} · ${device.android || ''}`],
    ['安全补丁', device.securityPatch || ''],
    ['Root 管理器', moduleState.stateFile && moduleState.stateFile.manager ? managerLabel(moduleState.stateFile.manager) : 'KernelSU / APatch'],
  ].filter((r) => r[1] !== '');

  const state = moduleState.stateFile || {};
  const moduleRows = [
    ['模块版本', moduleState.info && moduleState.info.version ? moduleState.info.version : '未知'],
    ['目标 Android', state.target_android ? `Android ${state.target_android}` : ''],
    ['最近操作', state.last_action ? `${actionLabel(state.last_action)} · ${formatDate(state.last_action_at)}` : '暂无'],
  ].filter((r) => r[1] !== '');

  const filterChips = summary.byFilter.slice(0, 6).map(([filter, count]) => {
    const f = compilerFilterLabel(filter);
    return `<span class="z-metric"><div class="z-metric-value">${count}</div><div class="z-metric-label">${escapeHtml(f.human)}</div></span>`;
  }).join('');

  const attentionHtml = summary.attentionApps.length
    ? `<div class="z-list">${summary.attentionApps.slice(0, 8).map(({ pkg }) => {
        const p = primaryStatus(pkg);
        return appRow({
          packageName: pkg.packageName,
          label: appLabel(meta, pkg.packageName),
          status: appHealth(pkg),
          sub: p ? compilerFilterLabel(p.compilerFilter).human : '',
          href: `#/apps/${encodeURIComponent(pkg.packageName)}`,
        });
      }).join('')}</div>
       ${summary.attentionApps.length > 8 ? `<div class="z-card-footer"><a class="z-section-action" href="#/apps">查看全部 ${summary.attentionApps.length} 个应用</a></div>` : ''}`
    : emptySection('check_circle', '没有需要关注的应用', '已编译应用的状态均正常。');

  root.innerHTML = `
    <div class="z-metrics">
      <div class="z-metric"><div class="z-metric-value">${summary.total}</div><div class="z-metric-label">应用</div></div>
      <div class="z-metric"><div class="z-metric-value">${summary.attention}</div><div class="z-metric-label">需关注</div></div>
      <div class="z-metric"><div class="z-metric-value">${oat.oatKb != null ? formatBytes(oat.oatKb, 0) : '未知'}</div><div class="z-metric-label">OAT 体积</div></div>
    </div>

    ${section({ title: '编译状态', body: card({
      title: `<span class="z-status z-status--${st.key}">${icon(st.icon, 15)}${escapeHtml(st.label)}</span>`,
      body: `
        <div class="z-info-row"><div class="z-info-label">说明</div><div class="z-info-value">${statusExplanation(status)}</div></div>
        <div class="z-info-row"><div class="z-info-label">需关注应用</div><div class="z-info-value"><a href="#/apps">${summary.attention} 个</a> ${summary.attention ? `<span class="z-tech">可能是 verify / extract / run-from-apk 等未充分编译状态</span>` : ''}</div></div>`,
    }) })}

    ${section({ title: '模块', body: card({ body: moduleRows.map(([l, v, t]) => infoRow({ label: l, value: v, tech: t })).join('') }) })}

    ${section({
      title: '操作',
      body: card({
        body: `
          <div class="z-actions">
            <md-button color="tonal" data-act="apply">${icon('tune', 18)} 应用预期属性</md-button>
            <md-button color="outlined" data-act="reset">${icon('restart_alt', 18)} 恢复安装前原值</md-button>
          </div>
          <div class="z-body-small z-on-surface-variant" style="padding-top:8px;">应用后属性在系统下次 dexopt 或重启时消费；恢复原值会立即回写安装时快照的值。</div>`,
      }),
    })}

    ${section({ title: '设备', body: card({ body: deviceRows.map(([l, v, t]) => infoRow({ label: l, value: v, tech: t })).join('') }) })}

    ${section({ title: '编译概览', body: card({ body: `<div class="z-metrics">${filterChips || '<div class="z-on-surface-variant">暂无数据</div>'}</div>` }) })}

    ${section({ title: '需要关注', body: card({ body: attentionHtml }) })}

    ${section({ title: '存储', body: card({ body: infoRow({ label: 'OAT 产物', value: oat.oatKb != null ? formatBytes(oat.oatKb) : '未知', tech: oat.oatKb != null ? formatBytesExact(oat.oatKb) : '' }) }) })}
  `;

  wireRawToggles(root);
  wireActions(root);
}

function actionLabel(a) {
  const map = { apply: '应用属性', reset: '恢复原值', status: '查看状态', collect: '导出快照' };
  return map[a] || a;
}

function statusExplanation(status) {
  switch (status) {
    case 'healthy': return '系统编译状态正常，没有需要关注的应用。';
    case 'warning': return '有应用处于未充分编译状态（仅校验 / 仅提取等），可能影响启动与运行性能。';
    case 'unknown': return '无法确认编译状态：数据读取失败或当前系统不支持该查询。';
    default: return '状态未知。';
  }
}

function wireActions(root) {
  const applyBtn = root.querySelector('[data-act="apply"]');
  if (applyBtn) applyBtn.addEventListener('click', () => {
    runAction({
      title: '应用预期属性',
      description: '将模块生成的 dexopt 属性写入系统（resetprop）。属性在系统下次 dexopt 或重启后生效。',
      confirmLabel: '应用',
      risk: 'normal',
      runningText: '正在写入属性…',
      successMessage: '已应用预期属性',
      execute: shellAction('sh action.sh apply', { cwd: MODULE_DIR }),
    });
  });
  const resetBtn = root.querySelector('[data-act="reset"]');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    runAction({
      title: '恢复安装前原值',
      description: '把安装时快照的属性值写回系统，撤销 Zerion 的所有修改。',
      confirmLabel: '恢复',
      risk: 'danger',
      runningText: '正在恢复原值…',
      successMessage: '已恢复原值',
      failureTitle: '恢复失败',
      execute: shellAction('sh action.sh reset', { cwd: MODULE_DIR }),
    });
  });
}
