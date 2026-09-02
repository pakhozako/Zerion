// App Details — the second designed page.
//
// Compile state diagnosis for one app: status, compiler filter, reason,
// primary ABI + location, artifact presence/sizes, secondary dex files, and
// explicit dexopt actions with full confirm -> running -> result feedback.

import { icon } from '../core/icons.js';
import { escapeHtml, formatBytes, formatDate, formatRelative, reasonLabel, reasonTech, compilerFilterLabel, isaLabel, eventTypeLabel, eventResultChip } from '../core/format.js';
import { statusOf } from '../core/state.js';
import {
  collectDexoptApp, collectArtifacts, artifactHealth, primaryStatus,
  appHealth, buildAppMeta, appLabel, collectProfile, collectPrimaryOatEvidence,
  collectOatDirAge, collectEvents, appendEvent, collectReasonContext, oatDirForIsa,
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
    const primaryDex = pkg.dexFiles.find((d) => d.isPrimary);
    // collectArtifacts takes the dex (APK) path, never the debug-only
    // `[location is ...]` string (see android-research/dumpsys-dexopt-format.md).
    const artifacts = primary && primaryDex
      ? await collectArtifacts(primaryDex.path, primary.isa)
      : null;
    const profile = await collectProfile(packageName);
    const oatMetaAll = primary ? await collectPrimaryOatEvidence(pkg) : [];
    // "最近编译" = newest mtime across the primary OAT dir's artifacts
    // (odex/vdex/art).  Verified on Android 9: recompiling rewrites base.vdex
    // while base.odex keeps its install-time mtime, so a single-file stat is
    // misleading.  See core/data.js collectOatDirAge.
    const oatDir = primary && primaryDex ? oatDirForIsa(primaryDex.path, primary.isa) : null;
    const age = oatDir ? await collectOatDirAge(oatDir) : null;
    const meta = buildAppMeta([packageName]);
    const events = await collectEvents(50);
    const appEvents = events.filter((ev) => ev.pkg === packageName).slice(0, 10);
    const reasonCtx = primary ? await collectReasonContext(pkg) : null;
    render(root, { pkg, primary, artifacts, oatMetaAll, age, profile, meta, appEvents, reasonCtx });
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

function render(root, { pkg, primary, artifacts, oatMetaAll, age, profile, meta, appEvents, reasonCtx }) {
  const label = appLabel(meta, pkg.packageName);
  const health = appHealth(pkg);
  const st = statusOf(health);
  const filter = primary ? compilerFilterLabel(primary.compilerFilter) : null;
  const reason = primary ? primary.reason : '';

  // Additional ISA variants of the primary dex (e.g. arm64 + arm), so the
  // diagnosis is complete on multi-ABI installs instead of showing only the
  // primary-ABI status.
  const primaryDex = pkg.dexFiles.find((d) => d.isPrimary);
  const extraIsaRows = primary && primaryDex
    ? primaryDex.statuses.filter((s) => s.isa !== primary.isa).map((s) => infoRow({
        label: isaLabel(s.isa),
        value: compilerFilterLabel(s.compilerFilter).human,
        tech: `${s.compilerFilter} · ${reasonLabel(s.reason)}`,
      })).join('')
    : '';

  const stateRows = primary ? [
    infoRow({ label: '编译策略', value: filter.human, tech: filter.tech }),
    infoRow({ label: '编译原因', value: reasonLabel(reason), tech: reasonTech(reason) }),
    infoRow({ label: 'ABI', value: isaLabel(primary.isa), tech: primary.isa }),
    extraIsaRows,
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

  const appEventsRows = (appEvents || []).map((ev) => `
    <div class="z-info-row">
      <div class="z-info-label">${escapeHtml(eventTypeLabel(ev.type))}</div>
      <div class="z-info-value">
        <div>${formatRelative(ev.t)} ${eventResultChip(ev.result)}</div>
        ${ev.detail ? `<span class="z-tech">${escapeHtml(ev.detail)}</span>` : ''}
      </div>
    </div>`).join('');

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

    ${section({ title: '编译状态', body: card({ body: stateRows + reasonContextHtml(reasonCtx) }) })}

    ${section({ title: '使用情况配置', body: card({ body: profileRows(profile) }) })}

    ${section({ title: '编译产物', body: card({
      body: `
        <div class="z-info-row"><div class="z-info-label">产物完整性</div><div class="z-info-value">${artifactStatusText(artifactStatus)}</div></div>
        ${ageRow(age)}
        ${oatMetaRowsAll(oatMetaAll, pkg)}
        ${artifactRows}`,
    }) })}

    ${pkg.dexFiles.some((d) => d.secondary)
      ? section({ title: '副 DEX', body: card({ body: secondaryRows + `
          <div class="z-body-small z-on-surface-variant" style="padding:8px 4px 0;">应用运行时额外加载的 DEX 文件（插件 / 热更新 / 动态加载代码），与主 APK 分开编译。class loader context（CLC）记录该 DEX 由哪些类加载器加载；加载方式变化时，已编译产物可能失效并被重新编译。</div>` }) })
      : ''}

    ${appEventsRows ? section({ title: '操作记录', body: card({ body: appEventsRows }) }) : ''}

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

// Expandable "why this result": the dumpsys reason -> the pm.dexopt.*
// property that governs it -> current / module-expected / install-time
// original values.  Grounded in the host reasonmap (AOSP REASON_STRINGS).
function reasonContextHtml(ctx) {
  if (!ctx) return '';
  if (!ctx.reason) return '';
  const btn = `<button type="button" class="z-raw-toggle" data-raw-toggle aria-expanded="false">${icon('help_outline', 16)}<span>为什么是这个结果</span></button>`;
  if (ctx.property) {
    const current = ctx.current || '';
    const expected = ctx.expected || '';
    const original = ctx.original || '';
    const chip = current && current === expected
      ? '<span class="z-status z-status--healthy">一致</span>'
      : (current && current !== expected
          ? '<span class="z-status z-status--warning">不一致</span>'
          : '');
    const currentLabel = current || '未设置（使用系统默认）';
    const tech = [
      expected ? `模块预期 ${expected}` : '模块未包含该属性',
      original ? `安装时原值 ${original}` : '',
    ].filter(Boolean).join(' · ');
    return `${btn}
      <div class="z-reason-context" data-raw hidden>
        <div class="z-info-row"><div class="z-info-label">对应属性</div><div class="z-info-value">${escapeHtml(ctx.property)}<span class="z-tech">决定 ${escapeHtml(ctx.reason)} 编译策略的系统属性</span></div></div>
        <div class="z-info-row"><div class="z-info-label">当前值</div><div class="z-info-value">${escapeHtml(currentLabel)} ${chip}<span class="z-tech">${escapeHtml(tech)}</span></div></div>
        <div class="z-body-small z-on-surface-variant" style="padding:8px 4px 0;">dex2oat 按该属性决定此原因的编译策略；实际结果还可能受使用情况配置（profile）与降级策略影响。</div>
      </div>`;
  }
  return `${btn}
    <div class="z-reason-context" data-raw hidden>
      <div class="z-info-row"><div class="z-info-label">对应属性</div><div class="z-info-value">无${ctx.cmdline ? '<span class="z-tech">命令行指定</span>' : ''}</div></div>
      <div class="z-body-small z-on-surface-variant" style="padding:8px 4px 0;">${escapeHtml(ctx.note || '无法确认该原因对应的系统属性。')}</div>
    </div>`;
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
// OAT artifact-level evidence: what dex2oat actually wrote into the OAT
// header (compiler-filter / compilation-reason), plus a consistency check
// against the package-manager record.  Everything here degrades to
// "无法确认" instead of guessing.
// "Last compiled" proxy: the OAT artifact's file mtime (written by dex2oat).
function ageRow(age) {
  if (!age || !age.epoch) {
    return `<div class="z-info-row"><div class="z-info-label">最近编译</div><div class="z-info-value">无法确认<span class="z-tech">${age && age.error ? escapeHtml(age.error) : '没有可用的产物时间'}</span></div></div>`;
  }
  return `<div class="z-info-row"><div class="z-info-label">最近编译</div><div class="z-info-value">${escapeHtml(formatRelative(age.epoch))}<span class="z-tech">按 OAT 产物目录最新文件时间估算 · ${escapeHtml(formatDate(age.epoch))}</span></div></div>`;
}

// Per-ISA artifact-level evidence: one compact row per ISA showing the actual
// compiler filter / reason dex2oat wrote into that ISA's OAT header, plus a
// consistency chip against that ISA's system record.  All-ISA raw details stay
// behind one expandable toggle.
function oatMetaRowsAll(metas, pkg) {
  if (!metas || !metas.length) return '';
  const primary = pkg.dexFiles.find((d) => d.isPrimary);
  const oat = metas.filter((m) => m.kind === 'oat');
  const unreadable = metas.filter((m) => m.kind === 'unreadable');
  if (!oat.length) {
    const detail = unreadable.map((m) => `${isaLabel(m.isa)}：${m.error || '读取失败'}`).join('；');
    return `<div class="z-info-row"><div class="z-info-label">产物实际编译</div><div class="z-info-value">无法确认<span class="z-tech">${escapeHtml(detail)}</span></div></div>`;
  }
  const rows = oat.map((meta) => {
    const st = primary && primary.statuses.find((s) => s.isa === meta.isa);
    const filter = compilerFilterLabel(meta.filter);
    const chip = oatConsistencyChip(st, meta);
    const tech = [
      st && st.compilerFilter ? `系统记录 ${st.compilerFilter}` : '',
      meta.filter ? `产物 ${meta.filter}` : '',
      meta.version ? `OAT v${meta.version}` : '',
      meta.android ? `Android ${meta.android}` : '',
      meta.isaArt ? isaLabel(meta.isaArt) : '',
    ].filter(Boolean).join(' · ');
    return `<div class="z-info-row">
      <div class="z-info-label">实际编译 · ${isaLabel(meta.isa)}</div>
      <div class="z-info-value"><div>${filter.human} · ${reasonLabel(meta.reason)} ${chip}</div><span class="z-tech">${escapeHtml(tech)}</span></div>
    </div>`;
  }).join('');
  const statusRows = oat.filter((m) => m.status !== 'ok').map((m) => `
    <div class="z-info-row"><div class="z-info-label">解析状态 · ${isaLabel(m.isa)}</div><div class="z-info-value">${oatStatusText(m.status)}</div></div>`).join('');
  const unreadableRows = unreadable.map((m) => `
    <div class="z-info-row"><div class="z-info-label">实际编译 · ${isaLabel(m.isa)}</div><div class="z-info-value">无法确认<span class="z-tech">${escapeHtml(m.error || '读取失败')}</span></div></div>`).join('');
  const raw = oat.map((m) => [
    `== ${isaLabel(m.isa)} (OAT v${m.version || '?'}${m.android ? `, Android ${m.android}` : ''}) ==`,
    `compiler-filter=${m.filter || ''}`,
    `compilation-reason=${m.reason || ''}`,
    m.warnings && m.warnings.length ? 'warnings:\n' + m.warnings.join('\n') : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  return `
    ${statusRows}
    ${rows}
    ${unreadableRows}
    <button type="button" class="z-raw-toggle" data-raw-toggle aria-expanded="false">${icon('expand_more', 16)}<span>OAT 头详情</span></button>
    <pre class="z-raw" data-raw hidden>${escapeHtml(raw)}</pre>`;
}

// Consistency between one ISA's system record (dumpsys) and its OAT artifact.
function oatConsistencyChip(st, meta) {
  const sys = st && st.compilerFilter;
  const art = meta.filter;
  if (!sys || !art) return '';
  const same = sys === art;
  return same
    ? '<span class="z-status z-status--healthy">一致</span>'
    : '<span class="z-status z-status--warning">不一致</span>';
}

function oatStatusText(status) {
  switch (status) {
    case 'unknown_version': return '<span class="z-status z-status--unknown">OAT 版本未知</span>';
    case 'truncated': return '<span class="z-status z-status--unknown">产物数据不完整</span>';
    case 'bad_kv': return '<span class="z-status z-status--warning">产物元数据异常</span>';
    case 'not_oat': return '<span class="z-status z-status--unknown">不是 OAT 产物</span>';
    default: return '<span class="z-status z-status--unknown">无法确认</span>';
  }
}

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
    }).then((r) => {
      if (!r.cancelled) appendEvent({ type: 'recompile', pkg: packageName, result: r.ok ? 'ok' : 'fail', detail: r.error ? (r.error.message || String(r.error)) : '' });
      if (r.ok) refresh(root, packageName);
    });
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
    }).then((r) => {
      if (!r.cancelled) appendEvent({ type: 'reset-compile', pkg: packageName, result: r.ok ? 'ok' : 'fail', detail: r.error ? (r.error.message || String(r.error)) : '' });
      if (r.ok) refresh(root, packageName);
    });
  });
}

async function refresh(root, packageName) {
  const y = window.scrollY;
  await mount(root, packageName);
  // mount() swaps in a skeleton first (page shrinks and clamps scroll), so
  // restore the previous position after the new content is in place.
  requestAnimationFrame(() => window.scrollTo(0, y));
}
