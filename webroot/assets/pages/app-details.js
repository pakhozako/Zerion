// App Details — the second designed page.
//
// Compile state diagnosis for one app: status, compiler filter, reason,
// primary ABI + location, artifact presence/sizes, secondary dex files, and
// explicit dexopt actions with full confirm -> running -> result feedback.

import { icon } from '../core/icons.js';
import { escapeHtml, formatBytes, reasonLabel, reasonTech, compilerFilterLabel, isaLabel } from '../core/format.js';
import { statusOf } from '../core/state.js';
import {
  collectDexoptApp, collectArtifacts, artifactHealth, primaryStatus,
  appHealth, buildAppMeta, appLabel, collectProfile,
} from '../core/data.js';
import { runAction, shellAction } from '../core/actions.js';
import { section, card } from '../components/section.js';
import { infoRow, wireRawToggles } from '../components/info-row.js';
import { skeletonState, errorState, wireErrorState } from '../components/state-view.js';

export async function mount(root, packageName) {
  root.innerHTML = skeletonState('details');
  let pkg;
  try {
    pkg = await collectDexoptApp(packageName);
    if (!pkg) {
      root.innerHTML = errorState({
        title: '未找到该应用',
        detail: `dumpsys package dexopt 未返回 ${packageName} 的编译状态。应用可能已卸载，或当前 Android 版本不支持该查询。`,
      });
      return;
    }
    const primary = primaryStatus(pkg);
    const artifacts = primary
      ? await collectArtifacts(primary.location || pkg.dexFiles.find((d) => d.isPrimary).path, primary.isa)
      : null;
    const profile = await collectProfile(packageName);
    const meta = buildAppMeta([packageName]);
    render(root, { pkg, primary, artifacts, profile, meta });
  } catch (err) {
    root.innerHTML = errorState({
      title: '无法读取编译状态',
      detail: err.message || String(err),
      raw: err.stderr || err.stdout || '',
      onRetry: () => mount(root, packageName),
    });
    wireErrorState(root, { onRetry: () => mount(root, packageName) });
  }
}

export function unmount() { /* nothing to clean up */ }

function render(root, { pkg, primary, artifacts, profile, meta }) {
  const label = appLabel(meta, pkg.packageName);
  const health = appHealth(pkg);
  const st = statusOf(health);
  const filter = primary ? compilerFilterLabel(primary.compilerFilter) : null;
  const reason = primary ? primary.reason : '';

  const stateRows = primary ? [
    infoRow({ label: '编译策略', value: filter.human, tech: filter.tech }),
    infoRow({ label: '编译原因', value: reasonLabel(reason), tech: reasonTech(reason) }),
    infoRow({ label: 'ABI', value: isaLabel(primary.isa), tech: primary.isa }),
    primary.location ? infoRow({ label: '位置', value: primary.location }) : '',
  ].join('') : '<div class="z-on-surface-variant">没有可用的编译状态数据。</div>';

  const artifactRows = artifacts && artifacts.files.length
    ? artifacts.files.map((f) => {
        const size = f.size != null ? formatBytes(Math.ceil(f.size / 1024)) : '未知';
        return infoRow({ label: f.name, value: size, tech: f.size != null ? `${f.size.toLocaleString('zh-CN')} B` : '' });
      }).join('')
    : '<div class="z-on-surface-variant">未读取到产物文件（可能没有 OAT 目录，或已从 APK 直接运行）。</div>';

  const artifactStatus = artifacts ? artifactHealth(artifacts) : 'unknown';

  const secondaryRows = pkg.dexFiles.filter((d) => d.secondary).map((d) => {
    const sts = d.statuses.map((s) => {
      const f = compilerFilterLabel(s.compilerFilter);
      return `${isaLabel(s.isa)} · ${f.human}`;
    }).join('<br>');
    return infoRow({
      label: d.path.split('/').pop() || d.path,
      value: d.removed ? '已移除' : (d.isPublic ? '公共' : '存在'),
      tech: sts,
      raw: [d.path, d.classLoaderContexts && d.classLoaderContexts.length ? 'class loader context: ' + d.classLoaderContexts.join('; ') : ''].filter(Boolean).join('\n'),
    });
  }).join('');

  const rawDump = renderRawDump(pkg);

  root.innerHTML = `
    <div class="z-state-row">
      <span class="z-app-avatar">${escapeHtml((label || '?').charAt(0).toUpperCase())}</span>
      <div>
        <div class="z-title-medium">${escapeHtml(label)}</div>
        <div class="z-body-small z-on-surface-variant">${escapeHtml(pkg.packageName)}</div>
      </div>
      <span class="z-status z-status--${st.key}" style="margin-left:auto;">${icon(st.icon, 15)}${escapeHtml(st.label)}</span>
    </div>
    ${humanSummary(health, filter) ? `<div class="z-app-summary z-body-medium z-on-surface-variant">${humanSummary(health, filter)}</div>` : ''}

    ${section({ title: '编译状态', body: card({ body: stateRows }) })}

    ${section({ title: '使用情况配置', body: card({ body: profileRows(profile) }) })}

    ${section({ title: '编译产物', body: card({
      body: `
        <div class="z-info-row"><div class="z-info-label">产物完整性</div><div class="z-info-value">${artifactStatusText(artifactStatus)}</div></div>
        ${artifactRows}`,
    }) })}

    ${pkg.dexFiles.some((d) => d.secondary)
      ? section({ title: '副 DEX', body: card({ body: secondaryRows }) })
      : ''}

    ${section({ title: '操作', body: card({ body: `
      <div class="z-actions">
        <md-button color="tonal" data-act="recompile">${icon('refresh', 18)} 重新编译（speed-profile）</md-button>
        <md-button color="outlined" data-act="reset-compile">${icon('restart_alt', 18)} 重置编译状态</md-button>
      </div>
      <div class="z-body-small z-on-surface-variant" style="padding-top:8px;">重新编译使用系统默认的 speed-profile 策略；重置后系统会按当前属性重新决定编译方式。操作可能需要数分钟。</div>` }) })}

    ${section({ title: '原始输出', body: card({ body: rawDump }) })}
  `;

  wireRawToggles(root);
  wireActions(root, pkg.packageName);
}

// One plain-language sentence about what this compile state means for the
// app.  The technical filter/reason stays expandable in the 编译状态 card.
function humanSummary(health, filter) {
  if (health === 'unknown' || !filter) return '无法确认此应用的编译状态：缺少可用的编译数据。';
  switch (filter.tech) {
    case 'verify': return '此应用目前仅做了校验（verify），没有生成优化代码；首次启动可能偏慢。';
    case 'extract': return '此应用仅提取了 DEX，未进行编译；首次启动可能偏慢。';
    case 'quicken': return '此应用使用快速编译（quicken），只优化了部分热点代码。';
    case 'assume-verified': return '此应用假定已校验（assume-verified），未做完整校验。';
    case 'run-from-apk': return '此应用没有 OAT 产物，直接从 APK 运行。';
    case 'run-from-vdex': return '此应用从 VDEX 运行，未生成完整的 OAT 产物。';
    case 'speed-profile': return '此应用已按使用情况优化：常用代码路径已预先编译，兼顾启动速度与空间占用。';
    case 'speed': return '此应用已全面编译（speed），启动与运行优先，占用空间较大。';
    case 'everything': return '此应用已全量编译（everything），运行性能优先，占用空间与编译时间最大。';
    case 'space-profile': return '此应用以节省空间为目标，只编译配置文件命中的代码。';
    case 'space': return '此应用以节省空间为目标，只做最小编译。';
    default: return '';
  }
}

// Runtime profile status for the current users.  A missing profile is a
// normal state (JIT has not written usage data yet), shown as such rather
// than as an error or "未知".
function profileRows(profile) {
  if (profile && profile.error) {
    return `<div class="z-info-row"><div class="z-info-label">运行时 Profile</div><div class="z-info-value">未知<span class="z-tech">${escapeHtml(profile.error)}</span></div></div>`;
  }
  const files = (profile && profile.files) || [];
  if (!files.length) {
    return `
      <div class="z-info-row"><div class="z-info-label">运行时 Profile</div><div class="z-info-value">尚未生成<span class="z-tech">JIT 会在使用中持续写入，供 speed-profile 编译参考</span></div></div>`;
  }
  return files.map((f) => infoRow({
    label: f.path.split('/').pop() || 'primary.prof',
    value: '存在 · ' + formatBytes(Math.ceil(f.size / 1024)),
    tech: f.path,
  })).join('') + `
    <div class="z-body-small z-on-surface-variant" style="padding:8px 4px 0;">JIT 会在使用中写入使用情况配置；speed-profile 编译会参考它决定预先编译哪些代码。</div>`;
}

function artifactStatusText(health) {
  switch (health) {
    case 'healthy': return '<span class="z-status z-status--healthy">产物完整</span>';
    case 'warning': return '<span class="z-status z-status--warning">产物不完整</span>';
    default: return '<span class="z-status z-status--unknown">无法确认</span>';
  }
}

function renderRawDump(pkg) {
  const lines = [`[${pkg.packageName}]`];
  for (const d of pkg.dexFiles) {
    lines.push(`  path: ${d.path}`);
    for (const s of d.statuses) {
      lines.push(`    ${s.isa}: [status=${s.compilerFilter}] [reason=${s.reason}]${s.primaryAbi ? ' [primary-abi]' : ''}`);
      if (s.location) lines.push(`      [location is ${s.location}]`);
    }
    if (d.classLoaderContexts) {
      for (const c of d.classLoaderContexts) lines.push(`      class loader context: ${c}`);
    }
  }
  return `
    <button type="button" class="z-raw-toggle" data-raw-toggle aria-expanded="false">${icon('expand_more', 16)}<span>查看 dumpsys 原始输出</span></button>
    <pre class="z-raw" data-raw hidden>${escapeHtml(lines.join('\n'))}</pre>`;
}

function wireActions(root, packageName) {
  const recompile = root.querySelector('[data-act="recompile"]');
  if (recompile) recompile.addEventListener('click', () => {
    runAction({
      title: '重新编译',
      description: `使用系统默认 speed-profile 策略重新编译 ${packageName}。编译期间应用可能变慢，完成后立即生效。`,
      confirmLabel: '开始编译',
      risk: 'normal',
      runningText: '正在编译（可能需要几分钟）…',
      successMessage: '重新编译完成',
      failureTitle: '编译失败',
      execute: shellAction(`cmd package compile -m speed-profile -f ${packageName}`),
    }).then((r) => { if (r.ok) refresh(root, packageName); });
  });
  const reset = root.querySelector('[data-act="reset-compile"]');
  if (reset) reset.addEventListener('click', () => {
    runAction({
      title: '重置编译状态',
      description: `清除 ${packageName} 当前编译状态，系统将按当前属性重新决定编译方式。已生成的产物会被失效并可能重新编译。`,
      confirmLabel: '重置',
      risk: 'danger',
      runningText: '正在重置…',
      successMessage: '已重置编译状态',
      failureTitle: '重置失败',
      execute: shellAction(`cmd package compile --reset ${packageName}`),
    }).then((r) => { if (r.ok) refresh(root, packageName); });
  });
}

async function refresh(root, packageName) {
  const y = window.scrollY;
  await mount(root, packageName);
  // mount() swaps in a skeleton first (page shrinks and clamps scroll), so
  // restore the previous position after the new content is in place.
  requestAnimationFrame(() => window.scrollTo(0, y));
}
