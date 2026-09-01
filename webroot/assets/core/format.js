// Human-first formatting: labels with the technical value available to
// expand.  Compiler filters and compilation reasons are grounded in AOSP
// (ReasonMapping / CompilerFilter) — see Zerion word android-research.

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(s) {
  return escapeHtml(s);
}

const FILTER_LABELS = {
  'assume-verified': ['假定已校验', 'assume-verified'],
  extract: ['仅提取', 'extract'],
  verify: ['仅校验', 'verify'],
  quicken: ['快速编译', 'quicken'],
  'space-profile': ['省空间 + 配置文件', 'space-profile'],
  space: ['省空间', 'space'],
  'speed-profile': ['按使用情况优化', 'speed-profile'],
  speed: ['全面优化', 'speed'],
  everything: ['全量编译', 'everything'],
  'run-from-apk': ['直接从 APK 运行', 'run-from-apk'],
  'run-from-vdex': ['从 VDEX 运行', 'run-from-vdex'],
  noop: ['不执行操作', 'noop'],
  skip: ['跳过', 'skip'],
};

export function compilerFilterLabel(filter) {
  const f = String(filter || '').trim();
  const hit = FILTER_LABELS[f];
  if (hit) return { human: hit[0], tech: hit[1] };
  return { human: f ? `未知（${f}）` : '未知', tech: f };
}

// Verified compilation reasons (AOSP PMS REASON_STRINGS / art ReasonMapping).
const REASON_LABELS = {
  'first-boot': '首次开机',
  boot: '开机',
  'boot-after-ota': 'OTA 后开机',
  'boot-after-mainline-update': 'Mainline 更新后开机',
  'bg-dexopt': '后台优化',
  install: '安装时',
  'install-fast': '快速安装',
  'install-bulk': '批量安装',
  'install-bulk-downgraded': '批量安装（降级）',
  'install-bulk-secondary': '批量安装（副 DEX）',
  'install-bulk-secondary-downgraded': '批量安装（副 DEX，降级）',
  'post-boot': '开机后',
  shared: '共享库',
  'ab-ota': 'A/B OTA',
  inactive: '未使用应用',
  cmdline: '命令行指定',
  'pre-reboot': '重启前优化',
  error: '异常',
  unknown: '未知',
};

export function reasonLabel(reason) {
  const r = String(reason || '').trim();
  return REASON_LABELS[r] || (r ? `未知（${r}）` : '未知');
}

export function reasonTech(reason) {
  return String(reason || '').trim();
}

export function formatBytes(kb, digits = 1) {
  const n = Number(kb);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1024) return `${n.toFixed(0)} KB`;
  const mb = n / 1024;
  if (mb < 1024) return `${mb.toFixed(digits)} MB`;
  return `${(mb / 1024).toFixed(digits)} GB`;
}

export function formatBytesExact(kb) {
  const n = Number(kb);
  if (!Number.isFinite(n) || n < 0) return '未知';
  return `${n.toLocaleString('zh-CN')} KB`;
}

// Human relative time ("x 分钟前 / x 小时前 / x 天前"), falling back to an
// absolute date for old timestamps.  Used for artifact / compile recency.
export function formatRelative(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - n);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return formatDate(n);
}

export function formatDate(ts) {
  if (!ts) return '未知';
  const d = new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return String(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sdkLabel(sdk) {
  const n = Number(sdk);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  const map = {
    28: 'Android 9', 29: 'Android 10', 30: 'Android 11', 31: 'Android 12',
    32: 'Android 12L', 33: 'Android 13', 34: 'Android 14', 35: 'Android 15',
    36: 'Android 16', 37: 'Android 17',
  };
  return map[n] || `Android ${n}`;
}

export function managerLabel(id) {
  const map = {
    ksu: 'KernelSU', apatch: 'APatch', magisk: 'Magisk',
    kernelsu: 'KernelSU', kernelsu_next: 'KernelSU Next',
  };
  return map[String(id || '').toLowerCase()] || '未知';
}

export function isaLabel(isa) {
  const map = {
    arm64: 'ARM64', arm: 'ARM', x86_64: 'x86-64', x86: 'x86',
    riscv64: 'RISC-V 64', riscv: 'RISC-V',
  };
  return map[String(isa || '')] || String(isa || '未知');
}

// On-device event log (events.jsonl) human labels.
const EVENT_LABELS = {
  install: '安装模块',
  apply: '应用配置',
  reset: '重置配置',
  recompile: '重新编译',
  'reset-compile': '重置编译状态',
  update: '更新模块',
  uninstall: '卸载模块',
};

export function eventTypeLabel(type) {
  const t = String(type || '').trim();
  return EVENT_LABELS[t] || (t ? `未知操作（${t}）` : '未知操作');
}

// Result chip for an event line: success / failure / unknown.
export function eventResultChip(result) {
  const r = String(result || '').trim();
  if (r === 'ok') return '<span class="z-status z-status--healthy">成功</span>';
  if (r === 'fail') return '<span class="z-status z-status--error">失败</span>';
  return '<span class="z-status z-status--unknown">未知</span>';
}

// Icon name (from core/icons.js) for an event type row.
export function eventTypeIcon(type) {
  switch (String(type || '').trim()) {
    case 'apply': return 'tune';
    case 'reset':
    case 'reset-compile': return 'restart_alt';
    case 'recompile': return 'build';
    case 'install':
    case 'update': return 'update';
    case 'uninstall': return 'delete';
    default: return 'history';
  }
}

// Timeline day bucket: 今天 / 昨天 / M月D日 / YYYY年M月D日.  Compared by local
// calendar date (not raw 86400s) so DST / midnight boundaries stay correct.
export function dayLabel(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return '未知';
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return '未知';
  const now = new Date();
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return '今天';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (same(d, yest)) return '昨天';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`;
}
