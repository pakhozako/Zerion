// Device-side data collection for the WebUI.
//
// Everything here runs through the ksu bridge as root.  Commands are
// deliberate and read-only except the explicit actions in actions.js.
// The dumpsys package dexopt parser follows the AOSP dump format
// (art/libartservice DumpHelper + frameworks PackageDexOptimizer);
// unparseable input degrades to UNKNOWN instead of guessing.

import { exec, execOk, moduleInfo, BridgeError } from './bridge.js';
import { analyzeOatBytes, hexDumpToBytes } from './oat.js';

// Mounted module directory on device (Magisk / KernelSU / APatch all mount
// modules here).  The WebUI runs the module's action.sh from this cwd.
export const MODULE_DIR = '/data/adb/modules/zerion';

// ---------------------------------------------------------------------------
// getprop helpers
// ---------------------------------------------------------------------------

async function getprop(name) {
  try {
    const r = await execOk(`getprop ${name}`);
    return r.stdout.trim();
  } catch {
    return '';
  }
}

export async function collectDeviceInfo() {
  const keys = [
    ['model', 'ro.product.model'],
    ['brand', 'ro.product.brand'],
    ['device', 'ro.product.device'],
    ['android', 'ro.build.version.release'],
    ['sdk', 'ro.build.version.sdk'],
    ['securityPatch', 'ro.build.version.security_patch'],
    ['fingerprint', 'ro.build.fingerprint'],
    ['abis', 'ro.product.cpu.abilist'],
    ['buildType', 'ro.build.type'],
    ['buildTags', 'ro.build.tags'],
  ];
  const out = {};
  const results = await Promise.all(keys.map(([key, prop]) =>
    getprop(prop).then((v) => (out[key] = v))));
  void results;
  return out;
}

// ---------------------------------------------------------------------------
// Module state (installed module facts + /data/adb/zerion/state.json)
// ---------------------------------------------------------------------------

export async function collectModuleState() {
  const info = moduleInfo();
  let stateFile = null;
  try {
    const r = await execOk('cat /data/adb/zerion/state.json 2>/dev/null');
    if (r.stdout.trim()) stateFile = JSON.parse(r.stdout);
  } catch {
    stateFile = null;
  }
  return { info, stateFile };
}

// ---------------------------------------------------------------------------
// dumpsys package dexopt parser (AOSP DumpHelper format)
// ---------------------------------------------------------------------------

// Package names are Java identifiers (letters/digits/_/.); this also keeps
// `[location is ...]` lines from being mistaken for package blocks.
const RE_PKG = /^\[([a-zA-Z][a-zA-Z0-9_.-]*)\]$/;
const RE_PATH = /^path: (.+)$/;
const RE_ISA = /^([A-Za-z0-9_]+): \[status=([^\]]+)\] \[reason=([^\]]+)\]( \[primary-abi\])?$/;
const RE_LOCATION = /^\[location is (.+)\]$/;
const RE_SEC_HEADER = /^known secondary dex files:$/;
const RE_SEC_PATH = /^(\S+?)( \((removed|public)\))?$/;
const RE_CLC = /^class loader context: (.+)$/;
const RE_USED = /^used by other apps: \[(.*)\]$/;

export function parseDexoptDump(text) {
  const packages = [];
  let cur = null;      // current package object
  let curDex = null;   // current dex file object
  let inSecondary = false;

  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const pkg = line.match(RE_PKG);
    if (pkg && !line.startsWith('  ')) {
      cur = { packageName: pkg[1], dexFiles: [] };
      packages.push(cur);
      curDex = null;
      inSecondary = false;
      continue;
    }
    if (!cur) continue;

    const path = line.match(RE_PATH);
    if (path) {
      curDex = { path: path[1], isPrimary: true, statuses: [], secondary: false };
      cur.dexFiles.push(curDex);
      continue;
    }

    if (RE_SEC_HEADER.test(line)) {
      inSecondary = true;
      continue;
    }

    if (inSecondary) {
      const sec = line.match(RE_SEC_PATH);
      if (sec && !RE_CLC.test(line) && !RE_ISA.test(line) && !RE_USED.test(line)) {
        curDex = {
          path: sec[1],
          isPrimary: false,
          statuses: [],
          secondary: true,
          removed: sec[3] === 'removed',
          isPublic: sec[3] === 'public',
        };
        cur.dexFiles.push(curDex);
        continue;
      }
    }

    const isa = line.match(RE_ISA);
    if (isa && curDex) {
      curDex.statuses.push({
        isa: isa[1],
        compilerFilter: isa[2],
        reason: isa[3],
        primaryAbi: Boolean(isa[4]),
      });
      continue;
    }

    const loc = line.match(RE_LOCATION);
    if (loc && curDex && curDex.statuses.length) {
      curDex.statuses[curDex.statuses.length - 1].location = loc[1];
      continue;
    }

    const clc = line.match(RE_CLC);
    if (clc && curDex) {
      (curDex.classLoaderContexts ||= []).push(clc[1]);
      continue;
    }

    const used = line.match(RE_USED);
    if (used && curDex) {
      curDex.usedByOtherApps = used[1];
      continue;
    }
    // Unknown lines are ignored (tolerant parser).
  }
  return packages;
}

// ---------------------------------------------------------------------------
// Dexopt overview / per-app queries
// ---------------------------------------------------------------------------

export async function collectDexoptAll() {
  const r = await execOk('dumpsys package dexopt 2>/dev/null');
  return parseDexoptDump(r.stdout);
}

export async function collectDexoptApp(packageName) {
  const r = await execOk(`dumpsys package dexopt ${packageName} 2>/dev/null`);
  const parsed = parseDexoptDump(r.stdout);
  return parsed.find((p) => p.packageName === packageName) || null;
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

// Compiler filters that mean "not meaningfully compiled to native code".
const NEEDS_ATTENTION_FILTERS = new Set([
  'verify', 'extract', 'quicken', 'assume-verified', 'run-from-apk',
]);

export function primaryStatus(pkg) {
  const primary = pkg.dexFiles.find((d) => d.isPrimary);
  if (!primary) return null;
  return primary.statuses.find((s) => s.primaryAbi) || primary.statuses[0] || null;
}

export function appHealth(pkg) {
  const st = primaryStatus(pkg);
  if (!st) return 'unknown';
  if (NEEDS_ATTENTION_FILTERS.has(st.compilerFilter)) return 'warning';
  return 'healthy';
}

export function summarizeDexopt(packages) {
  const total = packages.length;
  const byFilter = new Map();
  const byReason = new Map();
  let attention = 0;
  const attentionApps = [];
  for (const pkg of packages) {
    const st = primaryStatus(pkg);
    const filter = st ? st.compilerFilter : '(none)';
    const reason = st && st.reason ? st.reason : '(none)';
    byFilter.set(filter, (byFilter.get(filter) || 0) + 1);
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
    const health = appHealth(pkg);
    if (health === 'warning') {
      attention += 1;
      attentionApps.push({ pkg, status: st });
    }
  }
  const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return { total, byFilter: sortDesc(byFilter), byReason: sortDesc(byReason), attention, attentionApps };
}

// ---------------------------------------------------------------------------
// Artifacts (OAT/VDEX/ART + APK presence and sizes)
// ---------------------------------------------------------------------------

const ARTIFACT_NAMES = ['base.odex', 'base.vdex', 'base.art', 'base.odex.crc', 'base.vdex.crc'];

// Documented ART odex path derivation (AOSP runtime/oat_file_assistant.cc,
// DexLocationToOdexFilename): <dex-dir>/oat/<isa>/<base>.odex.  Used instead of
// the dumpsys `[location is ...]` string, which AOSP documents as debug-only
// and not stable across versions (see android-research/dumpsys-dexopt-format.md).
export function oatDirForIsa(dexPath, isa) {
  if (!dexPath || !isa) return null;
  const dir = dexPath.replace(/\/[^/]+$/, '');
  return dir + '/oat/' + isa + '/';
}

export function oatPathForIsa(dexPath, isa) {
  const dir = oatDirForIsa(dexPath, isa);
  return dir ? dir + 'base.odex' : null;
}

export async function collectArtifacts(dexPath, isa) {
  if (!dexPath || !isa) return { files: [], oatDir: '', error: null };
  // /data/app/~~hash==/com.example/base.apk -> /data/app/~~hash==/com.example/oat/<isa>/
  const oatDir = oatDirForIsa(dexPath, isa);
  if (!oatDir) return { files: [], oatDir: '', error: null };
  try {
    const r = await execOk(`ls -l ${oatDir} 2>/dev/null; ls -l ${dexPath} 2>/dev/null`);
    const files = parseLs(r.stdout);
    const apkEntry = files.find((f) => f.name === dexPath.split('/').pop());
    return { files, oatDir, apk: apkEntry || null, error: null };
  } catch (e) {
    return { files: [], oatDir, apk: null, error: e.message || String(e) };
  }
}

function parseLs(text) {
  const files = [];
  for (const line of String(text || '').split('\n')) {
    // -rw-r--r-- 1 root root 12345 Jan  1 00:00 base.odex
    if (!/^[-dl]/.test(line)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 8) continue;
    const size = Number(parts[4]);
    const name = parts[parts.length - 1];
    files.push({ name, size: Number.isFinite(size) ? size : null, raw: line });
  }
  return files;
}

// ---------------------------------------------------------------------------
// OAT artifact-level evidence (compiler-filter / compilation-reason written
// by dex2oat into the OAT header key-value store).  Read-only; the head of
// the file is read via od (toybox, `-v` so repeated lines are not collapsed
// into `*`, verified on Android 16's toybox 0.8.12) and parsed by core/oat.js
// (port of the host oatfile.py).  Unreadable / unknown versions degrade to
// UNKNOWN.
// ---------------------------------------------------------------------------

export async function collectOatHeader(filePath) {
  try {
    const r = await execOk(`od -An -tx1 -v -N 65536 "${filePath}" 2>/dev/null`);
    const bytes = hexDumpToBytes(r.stdout);
    if (!bytes) return { bytes: null, error: 'od 输出无法解析' };
    return { bytes, error: null };
  } catch (e) {
    return { bytes: null, error: e.message || String(e) };
  }
}

// Per-ISA artifact evidence for the primary dex: read each ISA's own
// oat/<isa>/base.odex header and parse the actual compiler-filter /
// compilation-reason dex2oat wrote.  One entry per ISA, in dumpsys order.
// The OAT path is derived from the dex (APK) path + ISA (documented
// algorithm), never from the debug-only `[location is ...]` string.
export async function collectPrimaryOatEvidence(pkg) {
  const primary = pkg.dexFiles.find((d) => d.isPrimary);
  if (!primary || !primary.statuses.length) return [];
  const out = [];
  for (const st of primary.statuses) {
    const path = oatPathForIsa(primary.path, st.isa);
    if (!path) continue;
    const { bytes, error } = await collectOatHeader(path);
    if (!bytes) {
      out.push({
        isa: st.isa, path, kind: 'unreadable', status: null, error,
        filter: null, reason: null, isaArt: null, android: null, version: null, warnings: [],
      });
      continue;
    }
    const a = analyzeOatBytes(bytes);
    out.push({
      isa: st.isa,
      path,
      kind: 'oat',
      status: a.status,
      filter: a.compilerFilter,
      reason: a.compilationReason,
      isaArt: a.instructionSet,
      android: a.android,
      version: a.versionRaw,
      warnings: a.warnings,
    });
  }
  return out;
}

export function artifactHealth(artifacts, apk) {
  const names = new Set((artifacts.files || []).map((f) => f.name));
  const hasOdex = names.has('base.odex');
  const hasVdex = names.has('base.vdex');
  if (!hasOdex && !hasVdex) return 'unknown';
  if (hasOdex && !hasVdex) return 'warning';
  return 'healthy';
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function collectStorage() {
  try {
    const r = await execOk('du -sk /data/app 2>/dev/null');
    const total = parseInt((r.stdout.trim().split(/\s+/)[0] || ''), 10);
    return { totalAppKb: Number.isFinite(total) ? total : null, error: null };
  } catch (e) {
    return { totalAppKb: null, error: e.message || String(e) };
  }
}

export async function collectOatStorage() {
  try {
    const r = await execOk('du -sk /data/app/*/oat 2>/dev/null');
    let kb = 0;
    let count = 0;
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const v = parseInt(parts[0] || '', 10);
      if (Number.isFinite(v)) { kb += v; count += 1; }
    }
    return { oatKb: kb, oatDirs: count, error: null };
  } catch (e) {
    return { oatKb: null, oatDirs: null, error: e.message || String(e) };
  }
}

// Top apps by OAT artifact directory size (per-app `du -sk` on each
// /data/app/*/oat dir).  Read-only; a failed read yields [] (section hidden).
export async function collectOatStorageTop(limit = 5) {
  try {
    // Android 12+ nests apps as /data/app/~~hash==/<pkg>-<suffix>/ (two levels
    // before oat/), while older versions use /data/app/<pkg>-<suffix>/oat.
    // Both globs are needed (verified: single glob returns nothing on API 36).
    const r = await execOk('du -sk /data/app/*/oat /data/app/*/*/oat 2>/dev/null');
    const rows = [];
    for (const line of r.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const kb = parseInt(parts[0] || '', 10);
      const path = parts.slice(1).join(' ');
      if (!Number.isFinite(kb) || !path) continue;
      const m = path.match(/\/data\/app\/~~[^/]+\/([^/]+)\/oat$/);
      rows.push({ kb, path, pkg: m ? m[1] : null });
    }
    rows.sort((a, b) => b.kb - a.kb);
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Runtime profiles (current-user usage profiles)
//
// AOSP: PrimaryDexUtils.getCurProfiles() builds one profile path per installed
// user via AidlUtils.buildProfilePathForPrimaryCur(userId, packageName,
// "primary") -> /data/misc/profiles/cur/<userId>/<pkg>/primary.prof; artd
// resolves the ProfilePath to the filesystem.  JIT writes these continuously
// and dexopt (speed-profile) merges them to decide what to AOT-compile.
// A missing profile is a normal state (app rarely used / JIT has not written
// yet), not an error.
// ---------------------------------------------------------------------------

export async function collectProfile(packageName) {
  const cmd = `for f in /data/misc/profiles/cur/*/${packageName}/primary.prof; do [ -f "$f" ] && { printf '%s ' "$f"; wc -c < "$f"; }; done`;
  try {
    const r = await execOk(cmd);
    const files = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(\d+)$/);
      if (m) files.push({ path: m[1], size: Number(m[2]) });
    }
    return { files, error: null };
  } catch (e) {
    return { files: [], error: e.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Artifact recency ("recently compiled" proxy)
//
// We use the newest mtime across a primary OAT directory's artifacts
// (base.odex / base.vdex / base.art) as the "last compile activity" proxy,
// NOT the odex mtime alone.  Verified on an Android 9 (API 28) userdebug
// emulator: after `cmd package compile -f -m everything`, base.odex keeps its
// install-time mtime while base.vdex is rewritten (new mtime), so stat'ing
// only base.odex reports stale times.  Which artifact a given Android version
// rewrites differs by version; taking the newest artifact is correct for both
// old and new behavior.  This is still a proxy: a newest-artifact timestamp
// does not prove a dexopt run finished successfully.
//
// toybox provides `stat -c %Y` (verified in AOSP external/toybox
// toys/other/stat.c).  `date -r FILE +%s` is NOT available on Android 9's
// toybox (verified on the emulator), so we only rely on stat.  A
// missing/unknown value degrades to null (shown as 无法确认), never guessed.
// ---------------------------------------------------------------------------

export async function collectOatDirAge(oatDir) {
  const cmd = `m=0; for f in "${oatDir}"base.odex "${oatDir}"base.vdex "${oatDir}"base.art; do [ -f "$f" ] || continue; t=$(stat -c %Y "$f" 2>/dev/null); [ -n "$t" ] && [ "$t" -gt "$m" ] && m=$t; done; [ "$m" -gt 0 ] && echo "$m"`;
  try {
    const r = await execOk(cmd);
    const epoch = parseInt(r.stdout.trim(), 10);
    return { epoch: Number.isFinite(epoch) && epoch > 0 ? epoch : null, error: null };
  } catch (e) {
    return { epoch: null, error: e.message || String(e) };
  }
}

// Newest artifact mtime for every primary OAT directory: "<epoch> <oat-dir>"
// lines.  Keyed by oat dir (not odex path) so apps whose dexopt wrote only a
// vdex (e.g. `verify` compiles) are still reported.
export async function collectRecentlyCompiled() {
  // Both layouts: Android <=11 /data/app/<pkg>-<suffix>/oat/<isa>/, Android
  // 12+ /data/app/~~hash==/<pkg>-<suffix>/oat/<isa>/.  A single glob matches
  // only one layout (verified on API 28 and API 36 emulators).
  const cmd = `for d in /data/app/*/oat/*/ /data/app/*/*/oat/*/; do [ -d "$d" ] || continue; m=0; for f in "$d"base.odex "$d"base.vdex "$d"base.art; do [ -f "$f" ] || continue; t=$(stat -c %Y "$f" 2>/dev/null); [ -n "$t" ] && [ "$t" -gt "$m" ] && m=$t; done; [ "$m" -gt 0 ] && echo "$m $d"; done`;
  try {
    const r = await execOk(cmd);
    const byDir = new Map();
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf(' ');
      if (i < 0) continue;
      const epoch = parseInt(line.slice(0, i), 10);
      const dir = line.slice(i + 1).trim();
      if (Number.isFinite(epoch) && dir) byDir.set(dir, epoch);
    }
    return { byDir, error: null };
  } catch (e) {
    return { byDir: new Map(), error: e.message || String(e) };
  }
}

// ---------------------------------------------------------------------------
// Compilation-reason context ("why this result")
//
// Maps a dumpsys compilation reason to the pm.dexopt.* property that governs
// it, version-aware.  Port of host/zerion_host/reasonmap.py (reason_map.json,
// SOURCE_VERIFIED against PMS PackageManagerServiceCompilerMapping
// REASON_STRINGS and ART Service ReasonMapping).  "cmdline" has no property:
// the filter came from pm compile / an explicit dex2oat flag.  Reasons whose
// version range excludes the current Android map to nothing (shown honestly
// instead of guessed).
// ---------------------------------------------------------------------------

const REASON_PROPERTIES = {
  'first-boot': { property: 'pm.dexopt.first-boot', ranges: [[9, null]] },
  boot: { property: 'pm.dexopt.boot', ranges: [[9, 11]] },
  'boot-after-ota': { property: 'pm.dexopt.boot-after-ota', ranges: [[12, null]] },
  'boot-after-mainline-update': { property: 'pm.dexopt.boot-after-mainline-update', ranges: [[14, null]] },
  'post-boot': { property: 'pm.dexopt.post-boot', ranges: [[12, 13]] },
  install: { property: 'pm.dexopt.install', ranges: [[9, null]] },
  'install-fast': { property: 'pm.dexopt.install-fast', ranges: [[12, null]] },
  'install-bulk': { property: 'pm.dexopt.install-bulk', ranges: [[12, null]] },
  'install-bulk-secondary': { property: 'pm.dexopt.install-bulk-secondary', ranges: [[12, null]] },
  'install-bulk-downgraded': { property: 'pm.dexopt.install-bulk-downgraded', ranges: [[12, null]] },
  'install-bulk-secondary-downgraded': { property: 'pm.dexopt.install-bulk-secondary-downgraded', ranges: [[12, null]] },
  'bg-dexopt': { property: 'pm.dexopt.bg-dexopt', ranges: [[9, null]] },
  'ab-ota': { property: 'pm.dexopt.ab-ota', ranges: [[9, 13], [15, null]] },
  inactive: { property: 'pm.dexopt.inactive', ranges: [[9, null]] },
  shared: { property: 'pm.dexopt.shared', ranges: [[9, null]] },
};
const CMDLINE_REASONS = new Set(['cmdline']);

function inRanges(android, ranges) {
  return ranges.some(([lo, hi]) => android >= lo && (hi === null || android <= hi));
}

function rangeText(ranges) {
  return ranges.map(([lo, hi]) => (hi === null ? `Android ${lo} 及以上` : (lo === hi ? `Android ${lo}` : `Android ${lo}–${hi}`))).join(' / ');
}

async function readExpectedProp(property) {
  try {
    const r = await execOk('cat /data/adb/modules/zerion/expected.props 2>/dev/null');
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === property) return line.slice(i + 1).trim();
    }
    return null; // property not in the module's expected set
  } catch {
    return null;
  }
}

async function readOriginalProp(property) {
  try {
    const r = await execOk('cat /data/adb/zerion/originals.json 2>/dev/null');
    const obj = JSON.parse(r.stdout);
    return typeof obj[property] === 'string' ? obj[property] : null;
  } catch {
    return null;
  }
}

// Structured "why this result" context for the primary dex's primary ABI.
// Every unconfirmable branch degrades to an explicit note, never a guess.
export async function collectReasonContext(pkg) {
  const primary = pkg.dexFiles.find((d) => d.isPrimary);
  const st = primary && (primary.statuses.find((x) => x.primaryAbi) || primary.statuses[0]);
  const reason = (st && st.reason) || '';
  const base = { reason, filter: (st && st.compilerFilter) || null };
  if (!reason) return { ...base, property: null, note: '没有可用的编译原因。' };
  const rel = await getprop('ro.build.version.release');
  const android = parseInt(rel, 10);
  if (!Number.isFinite(android)) return { ...base, android: null, property: null, note: '无法确认 Android 版本，无法映射对应属性。' };
  base.android = android;
  if (CMDLINE_REASONS.has(reason)) {
    return { ...base, property: null, cmdline: true, note: '该应用由命令行指定编译（pm compile / dex2oat 参数），没有对应的 pm.dexopt.* 属性。' };
  }
  const rec = REASON_PROPERTIES[reason];
  if (!rec) {
    return { ...base, property: null, note: `该编译原因没有已确认的系统属性（${reason}）。` };
  }
  if (!inRanges(android, rec.ranges)) {
    return { ...base, property: null, note: `该原因在 Android ${android} 没有对应属性（仅存在于 ${rangeText(rec.ranges)}）。` };
  }
  const property = rec.property;
  const [current, expected, original] = await Promise.all([
    getprop(property),
    readExpectedProp(property),
    readOriginalProp(property),
  ]);
  return { ...base, android, property, current, expected, original };
}

// ---------------------------------------------------------------------------
// On-device event log (events.jsonl)
//
// Events are appended through the module's shared writer
// (`action.sh log-event`, which sources state-common.sh::log_event) so the
// escaping and bounded trimming are identical for WebUI (KSU/APatch) and CLI
// (Magisk) actions.  The log lives in /data/adb/zerion/events.jsonl; the
// file is a proxy for "what Zerion did", NOT a record of system-initiated
// dexopt (that stays the OAT-mtime proxy).  Logging is best-effort: a
// failure to append must never break the action itself.
// ---------------------------------------------------------------------------

// POSIX single-quote escaping for one shell argument.
function shq(v) {
  return "'" + String(v == null ? '' : v).replace(/'/g, `'\''`) + "'";
}

export async function appendEvent({ type, pkg = '', detail = '', result = 'ok' }) {
  if (!type) return;
  const cmd = `sh action.sh log-event ${shq(type)} ${shq(pkg)} ${shq(detail)} ${shq(result)}`;
  try {
    await execOk(cmd, { cwd: MODULE_DIR });
  } catch { /* best-effort: never break the calling action */ }
}

// Newest-first event list, capped at `limit`.  Malformed lines are skipped
// (tolerant reader); a missing/unreadable log yields [] (no events).
export async function collectEvents(limit = 20) {
  try {
    const r = await execOk('tail -n 200 /data/adb/zerion/events.jsonl 2>/dev/null');
    const events = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
    return events.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Third-party package list (for Apps list filter)
// ---------------------------------------------------------------------------

export async function collectThirdPartyPackages() {
  try {
    const r = await execOk('pm list packages -3 2>/dev/null');
    const set = new Set();
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^package:(.+)$/);
      if (m) set.add(m[1]);
    }
    return set;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// App labels / system flag via the manager's package cache (best-effort;
// falls back to the package name when the manager has no info).
// ---------------------------------------------------------------------------

export function getPackagesInfo(packageNames) {
  try {
    if (typeof window.ksu?.getPackagesInfo !== 'function') return null;
    const raw = window.ksu.getPackagesInfo(JSON.stringify(packageNames));
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return null;
    const map = new Map();
    for (const it of arr) {
      if (it && it.packageName && !it.error) map.set(it.packageName, it);
    }
    return map;
  } catch {
    return null;
  }
}

export function buildAppMeta(packageNames) {
  const info = getPackagesInfo(packageNames);
  const meta = new Map();
  if (info) {
    for (const [pkg, it] of info) {
      meta.set(pkg, {
        label: it.appLabel || pkg,
        isSystem: it.isSystem === true,
        versionName: it.versionName || '',
      });
    }
  }
  return meta;
}

export function appLabel(meta, pkg) {
  const m = meta.get(pkg);
  return (m && m.label) ? m.label : pkg;
}

export function isSystemApp(meta, pkg) {
  const m = meta.get(pkg);
  return m ? m.isSystem : null;
}
