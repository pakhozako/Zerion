// Device-side data collection for the WebUI.
//
// Everything here runs through the ksu bridge as root.  Commands are
// deliberate and read-only except the explicit actions in actions.js.
// The dumpsys package dexopt parser follows the AOSP dump format
// (art/libartservice DumpHelper + frameworks PackageDexOptimizer);
// unparseable input degrades to UNKNOWN instead of guessing.

import { exec, execOk, moduleInfo, BridgeError } from './bridge.js';
import { analyzeOatBytes, hexDumpToBytes } from './oat.js';

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

export async function collectArtifacts(dexPath, isa) {
  if (!dexPath || !isa) return { files: [], oatDir: '', error: null };
  // /data/app/~~hash==/com.example/base.apk -> /data/app/~~hash==/com.example/oat/<isa>/
  const oatDir = dexPath.replace(/\/[^/]+$/, '') + '/oat/' + isa + '/';
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
// the file is read via od (toybox) and parsed by core/oat.js (port of the
// host oatfile.py).  Unreadable / unknown versions degrade to UNKNOWN.
// ---------------------------------------------------------------------------

export async function collectOatHeader(filePath) {
  try {
    const r = await execOk(`od -An -tx1 -N 65536 "${filePath}" 2>/dev/null`);
    const bytes = hexDumpToBytes(r.stdout);
    if (!bytes) return { bytes: null, error: 'od 输出无法解析' };
    return { bytes, error: null };
  } catch (e) {
    return { bytes: null, error: e.message || String(e) };
  }
}

export async function collectOatArtifactMeta(artifacts, primary) {
  const odex = artifacts && artifacts.files.find((f) => f.name === 'base.odex');
  if (!odex) return null; // no OAT artifact for the primary dex
  const path = (primary && primary.location) || (artifacts.oatDir + 'base.odex');
  const { bytes, error } = await collectOatHeader(path);
  if (!bytes) return { kind: 'unreadable', error, filter: null, reason: null, isa: null, android: null, version: null, warnings: [] };
  const a = analyzeOatBytes(bytes);
  return {
    kind: 'oat',
    status: a.status,
    filter: a.compilerFilter,
    reason: a.compilationReason,
    isa: a.instructionSet,
    android: a.android,
    version: a.versionRaw,
    warnings: a.warnings,
  };
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
// Artifact recency (OAT file mtime as "last compiled" proxy)
//
// toybox provides both `stat -c %Y` (Mod unix time) and `date -r FILE +%s`
// (verified in AOSP external/toybox toys/other/stat.c and toys/posix/date.c);
// we try stat first and fall back to date.  A missing/unknown value degrades
// to null (shown as 无法确认), never guessed.
// ---------------------------------------------------------------------------

export async function collectArtifactAge(filePath) {
  const cmd = `(stat -c %Y "${filePath}" 2>/dev/null || date -r "${filePath}" +%s 2>/dev/null) || echo -n`;
  try {
    const r = await execOk(cmd);
    const epoch = parseInt(r.stdout.trim(), 10);
    return { epoch: Number.isFinite(epoch) && epoch > 0 ? epoch : null, error: null };
  } catch (e) {
    return { epoch: null, error: e.message || String(e) };
  }
}

// Collect mtime for every primary OAT artifact: "path epoch" lines.
export async function collectRecentlyCompiled() {
  const cmd = `for f in /data/app/*/oat/*/base.odex; do [ -f "$f" ] || continue; m=$(stat -c %Y "$f" 2>/dev/null); [ -n "$m" ] || m=$(date -r "$f" +%s 2>/dev/null); [ -n "$m" ] && echo "$m $f"; done`;
  try {
    const r = await execOk(cmd);
    const byPath = new Map();
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf(' ');
      if (i < 0) continue;
      const epoch = parseInt(line.slice(0, i), 10);
      const path = line.slice(i + 1).trim();
      if (Number.isFinite(epoch) && path) byPath.set(path, epoch);
    }
    return { byPath, error: null };
  } catch (e) {
    return { byPath: new Map(), error: e.message || String(e) };
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
