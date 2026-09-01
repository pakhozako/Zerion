// OAT / VDEX header analysis for the WebUI.
//
// Port of host/zerion_host/oatfile.py (data: android-research/oat-vdex-format.md,
// SOURCE_VERIFIED).  The parser never guesses a layout: an OAT version not in
// the table is reported as unknown_version, matching the host behavior.
//
// Layout (little-endian, magic 'o','a','t','\n'):
//   magic[4] + version[4] (ASCII digits + NUL)
//   + <fixed u32 fields, count depends on OAT version>
//   + key_value_store_size_ (u32)
//   + key_value_store_ ("key\0value\0" repeated)
// The compiler-filter / compilation-reason keys are written by dex2oat and are
// direct artifact-level evidence of what was actually compiled.

export const STATUS = {
  OK: 'ok',
  NOT_OAT: 'not_oat',
  UNKNOWN_VERSION: 'unknown_version',
  TRUNCATED: 'truncated',
  BAD_KV: 'bad_kv',
};

// OAT version -> { android, fields }  (fields = u32 count before kv_size)
export const OAT_VERSIONS = {
  138: { android: 9, fields: 17 },
  170: { android: 10, fields: 12 },
  183: { android: 11, fields: 13 },
  195: { android: 12, fields: 14 },
  225: { android: 13, fields: 15 },
  230: { android: 14, fields: 15 },
  244: { android: 15, fields: 15 },
  259: { android: 16, fields: 16 },
  275: { android: 17, fields: 16 },
};

// instruction_set_ numeric maps by version group (see oat-vdex-format.md).
const ISA_GROUPS = {
  a9_a10: { 0: 'none', 1: 'arm', 2: 'arm64', 3: 'thumb2', 4: 'x86', 5: 'x86_64', 6: 'mips', 7: 'mips64' },
  a11_a15: { 0: 'none', 1: 'arm', 2: 'arm64', 3: 'thumb2', 4: 'x86', 5: 'x86_64' },
  a16_plus: { 0: 'none', 1: 'arm', 2: 'arm64', 3: 'thumb2', 4: 'riscv64', 5: 'x86', 6: 'x86_64' },
};
const ISA_GROUP_BY_VERSION = {
  138: 'a9_a10', 170: 'a9_a10',
  183: 'a11_a15', 195: 'a11_a15', 225: 'a11_a15', 230: 'a11_a15', 244: 'a11_a15',
  259: 'a16_plus', 275: 'a16_plus',
};

const OAT_MAGIC = [0x6f, 0x61, 0x74, 0x0a]; // "oat\n"
const VDEX_MAGIC = [0x76, 0x64, 0x65, 0x78]; // "vdex"

function u32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function ascii(bytes, start, end) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// Parse "key\0value\0" pairs within [off, off+size).  Returns { pairs, warnings }.
function parseKvStore(bytes, off, size) {
  const end = off + size;
  const pairs = {};
  const warnings = [];
  let pos = off;
  while (pos < end) {
    let nul = bytes.indexOf(0, pos);
    if (nul < 0 || nul >= end) {
      warnings.push('unterminated kv entry at offset ' + pos);
      break;
    }
    const key = ascii(bytes, pos, nul);
    pos = nul + 1;
    nul = bytes.indexOf(0, pos);
    if (nul < 0 || nul >= end) {
      warnings.push('unterminated value for key ' + JSON.stringify(key));
      break;
    }
    const value = ascii(bytes, pos, nul);
    pairs[key] = value;
    pos = nul + 1;
  }
  if (pos < end) warnings.push((end - pos) + ' stray bytes at end of kv store');
  return { pairs, warnings };
}

export function identify(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const head = Array.from(bytes.slice(0, 4));
  if (head.every((b, i) => b === OAT_MAGIC[i])) return 'oat';
  if (head.every((b, i) => b === VDEX_MAGIC[i])) return 'vdex';
  return null;
}

export function analyzeOatBytes(bytes) {
  const result = {
    kind: 'oat',
    status: STATUS.NOT_OAT,
    magicOk: false,
    versionRaw: null,
    versionKnown: false,
    android: null,
    fields: {},
    kvSize: null,
    kv: {},
    compilerFilter: null,
    compilationReason: null,
    instructionSet: null,
    instructionSetKnown: false,
    dexFileCount: null,
    headerSize: null,
    warnings: [],
  };
  if (!bytes || bytes.length < 8 || identify(bytes) !== 'oat') return result;
  result.magicOk = true;
  const versionRaw = ascii(bytes, 4, 8).replace(/[\0 ]+$/, '');
  result.versionRaw = versionRaw;
  const version = parseInt(versionRaw, 10);
  const rec = OAT_VERSIONS[version];
  if (!rec) {
    result.status = STATUS.UNKNOWN_VERSION;
    return result;
  }
  result.versionKnown = true;
  result.android = rec.android;

  const fixedSize = 8 + 4 * rec.fields;
  if (bytes.length < fixedSize + 4) {
    result.status = STATUS.TRUNCATED;
    result.warnings.push('need ' + (fixedSize + 4) + ' bytes, have ' + bytes.length);
    return result;
  }
  // field index 1 = instruction_set_ (all layouts: checksum, instruction_set, ...)
  const isaNum = u32(bytes, 12);
  const isaMap = ISA_GROUPS[ISA_GROUP_BY_VERSION[version]];
  if (isaMap && isaNum in isaMap) {
    result.instructionSet = isaMap[isaNum];
    result.instructionSetKnown = true;
  }
  const dexFileCount = u32(bytes, 20); // field index 3
  result.dexFileCount = dexFileCount;
  result.fields = { instruction_set: isaNum, dex_file_count: dexFileCount };

  const kvSize = u32(bytes, fixedSize);
  result.kvSize = kvSize;
  const kvStart = fixedSize + 4;
  result.headerSize = kvStart + kvSize;
  if (bytes.length < kvStart + kvSize) {
    result.status = STATUS.TRUNCATED;
    result.warnings.push('kv store extends past end of read data');
    return result;
  }
  const { pairs, warnings } = parseKvStore(bytes, kvStart, kvSize);
  result.kv = pairs;
  result.warnings = warnings;
  result.compilerFilter = pairs['compiler-filter'] || null;
  result.compilationReason = pairs['compilation-reason'] || null;
  result.status = warnings.length ? STATUS.BAD_KV : STATUS.OK;
  return result;
}

export function analyzeVdexBytes(bytes) {
  const result = {
    kind: 'vdex',
    status: STATUS.NOT_OAT,
    magicOk: false,
    versionRaw: null,
    android: null,
    warnings: [],
  };
  if (!bytes || bytes.length < 8 || identify(bytes) !== 'vdex') return result;
  result.magicOk = true;
  result.status = STATUS.OK;
  result.versionRaw = ascii(bytes, 4, 8).replace(/[\0 ]+$/, '');
  // VDEX carries no compiler-filter; version -> Android mapping is not needed
  // for the UI (we only identify the artifact family).
  return result;
}

// Convert `od -An -tx1` output (whitespace-separated 2-hex-digit bytes) to bytes.
export function hexDumpToBytes(text) {
  const out = [];
  for (const tok of String(text || '').split(/\s+/)) {
    if (!tok) continue;
    if (!/^[0-9a-fA-F]{2}$/.test(tok)) return null;
    out.push(parseInt(tok, 16));
  }
  return Uint8Array.from(out);
}
