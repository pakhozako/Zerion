// ksu bridge wrapper (KernelSU / APatch module WebUI).
//
// The manager injects a global `ksu` object (WebViewInterface).  Its async
// exec() takes a global callback *function name* string and invokes
// callback(errno, stdout, stderr); we mirror the official `kernelsu` npm
// package pattern: register a uniquely named global, call through, clean up.
//
// Magisk has no WebUI bridge; the module keeps working through action.sh.

export class BridgeError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
    this.stdout = (detail && detail.stdout) || '';
    this.stderr = (detail && detail.stderr) || '';
  }
}

let seq = 0;
function uniqueName(prefix) {
  return `__zerion_${prefix}_${Date.now()}_${seq++}`;
}

export function hasBridge() {
  return typeof window !== 'undefined' && typeof window.ksu === 'object' &&
    window.ksu !== null && typeof window.ksu.exec === 'function';
}

export function exec(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (!hasBridge()) {
      reject(new BridgeError('ROOT_BRIDGE_UNAVAILABLE', '未检测到 Root 管理器桥接（ksu）。请在 KernelSU / APatch 中打开本页面。'));
      return;
    }
    const name = uniqueName('exec');
    const cleanup = () => { try { delete window[name]; } catch { /* ignore */ } };
    window[name] = (errno, stdout, stderr) => {
      cleanup();
      resolve({ errno, stdout: stdout || '', stderr: stderr || '' });
    };
    try {
      window.ksu.exec(command, JSON.stringify(options), name);
    } catch (e) {
      cleanup();
      reject(new BridgeError('EXEC_FAILED', String(e && e.message || e)));
    }
  });
}

export async function execOk(command, options = {}) {
  const r = await exec(command, options);
  if (r.errno !== 0) {
    throw new BridgeError(`EXIT_${r.errno}`, r.stderr || `命令退出码 ${r.errno}`, r);
  }
  return r;
}

export function toast(message) {
  try {
    if (typeof window.ksu?.toast === 'function') window.ksu.toast(message);
  } catch { /* ignore */ }
}

export function moduleInfo() {
  try {
    if (typeof window.ksu?.moduleInfo !== 'function') return null;
    const raw = window.ksu.moduleInfo();
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}
