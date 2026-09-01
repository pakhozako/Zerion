// Action flow: confirm -> running -> success / failure -> result.
//
// Every state-changing operation in the WebUI goes through runAction() so the
// feedback is always the same: a modal confirm (risk-styled) -> indeterminate
// progress while executing -> success snackbar or an error dialog with
// expandable raw output.  Danger-level operations use the error color.
//
// The confirm step and the running/failure step share ONE md-dialog that stays
// open across the transition.  Reusing a dialog as open -> close -> open races
// with M3E's async close animation (the native <dialog> is still open while
// animating, so the second show() becomes a no-op) and the "running" step would
// never be visible.  Keeping it open and swapping content avoids that entirely.

import { escapeHtml } from './format.js';
import { icon } from './icons.js';

function createDialog(id) {
  const dlg = document.createElement('md-dialog');
  if (id) dlg.id = id;
  document.body.append(dlg);
  return dlg;
}

// Close (with animation) then remove.  If the dialog was never opened, remove
// immediately; a fallback timeout guarantees no detached-but-open element leaks.
function closeAndRemove(dlg) {
  if (!dlg.isConnected) return;
  if (dlg.open === false && !dlg.hasAttribute('open')) {
    dlg.remove();
    return;
  }
  dlg.addEventListener('closed', () => dlg.remove(), { once: true });
  dlg.open = false;
  setTimeout(() => { if (dlg.isConnected) dlg.remove(); }, 1500);
}

// Fresh element each time: avoids a stale auto-close timer from a previous
// snackbar cutting a new one short.
export function showSnackbar(message) {
  const old = document.getElementById('app-snackbar');
  if (old) old.remove();
  const sb = document.createElement('md-snackbar');
  sb.id = 'app-snackbar';
  sb.message = message;
  document.body.append(sb);
  // The M3E snackbar hardcodes bottom:30px inside its shadow root, which
  // collides with the app's bottom navigation bar on phones.  Lift it above
  // the nav via an adopted stylesheet (keeps the real component, only the
  // shadow placement changes).
  const root = sb.shadowRoot;
  if (root && typeof CSSStyleSheet !== 'undefined' && !sb.__z_positioned) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`#snackbar { bottom: calc(84px + var(--z-inset-bottom, 0px)) !important; }`);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      sb.__z_positioned = true;
    } catch { /* shadow placement is best-effort */ }
  }
  sb.show();
}

export function toastMessage(message) {
  showSnackbar(message);
}

// Resolve true when the user confirms.  On confirm the dialog is deliberately
// left open so runAction() can swap in the running view without a close/reopen
// race.  Cancel / scrim / ESC resolves false and closes the dialog.
export function confirmAction({ title, description, confirmLabel = '确定', cancelLabel = '取消', risk = 'normal' }) {
  return new Promise((resolve) => {
    const dlg = createDialog('z-action-dialog');
    const confirmClass = risk === 'danger' ? 'z-danger-button' : '';
    const confirmColor = risk === 'danger' ? 'filled' : 'tonal';
    dlg.innerHTML = `
      <div slot="headline">${escapeHtml(title)}</div>
      <div slot="content">
        <div class="z-body-medium">${description || ''}</div>
      </div>
      <div slot="actions">
        <md-button color="text" data-act="cancel">${escapeHtml(cancelLabel)}</md-button>
        <md-button color="${confirmColor}" class="${confirmClass}" data-act="confirm">${escapeHtml(confirmLabel)}</md-button>
      </div>`;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('cancel', onCancel);
      if (value) {
        resolve(true); // dialog stays open; runAction swaps content
      } else {
        closeAndRemove(dlg);
        resolve(false);
      }
    };
    const onClick = (e) => {
      const btn = e.target.closest('md-button');
      if (!btn || !btn.dataset.act) return;
      finish(btn.dataset.act === 'confirm');
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
    dlg.open = true;
  });
}

function renderRunning(dlg, title, statusText) {
  dlg.innerHTML = `
    <div slot="headline">${escapeHtml(title)}</div>
    <div slot="content">
      <div class="z-body-medium">${escapeHtml(statusText || '正在执行…')}</div>
      <md-progress type="linear" indeterminate class="z-dialog-progress"></md-progress>
    </div>`;
}

function renderFailure(dlg, title, message, stdout, stderr) {
  const raw = [stderr, stdout].filter(Boolean).join('\n').trim();
  dlg.innerHTML = `
    <div slot="headline">${escapeHtml(title)}</div>
    <div slot="content">
      <p class="z-body-medium" style="color:var(--md-sys-color-error);margin:0 0 8px;">${escapeHtml(message)}</p>
      ${raw ? `
        <button type="button" class="z-raw-toggle" data-raw-toggle aria-expanded="false">${icon('expand_more', 16)}<span>查看输出</span></button>
        <pre class="z-raw" data-raw hidden>${escapeHtml(raw)}</pre>` : ''}
    </div>
    <div slot="actions">
      <md-button color="text" data-act="close">关闭</md-button>
    </div>`;
  const toggle = dlg.querySelector('[data-raw-toggle]');
  const pre = dlg.querySelector('[data-raw]');
  if (toggle && pre) {
    toggle.addEventListener('click', () => {
      const open = pre.getAttribute('hidden') !== null;
      pre.hidden = !open;
      pre.dataset.open = open ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.querySelector('svg').style.transform = open ? 'rotate(180deg)' : '';
    });
  }
}

export async function runAction({
  title,
  description = '',
  confirmLabel = '执行',
  risk = 'normal',
  execute,
  successMessage = '操作完成',
  runningText = '正在执行…',
  failureTitle = '操作失败',
}) {
  const confirmed = await confirmAction({ title, description, confirmLabel, risk });
  if (!confirmed) return { cancelled: true };

  const dlg = document.getElementById('z-action-dialog');
  if (!dlg) return { cancelled: true, ok: false, error: new Error('对话框已关闭') };

  // Block dismissal (scrim click / ESC) while executing.
  const onCancel = (e) => { e.preventDefault(); };
  dlg.addEventListener('cancel', onCancel);

  renderRunning(dlg, title, runningText);

  try {
    const result = await execute();
    dlg.removeEventListener('cancel', onCancel);
    closeAndRemove(dlg);
    showSnackbar(successMessage);
    return { cancelled: false, ok: true, result };
  } catch (err) {
    dlg.removeEventListener('cancel', onCancel);
    renderFailure(dlg, failureTitle, err.message || String(err), err.stdout || '', err.stderr || '');
    const onClick = (e) => {
      const btn = e.target.closest('md-button');
      if (btn && btn.dataset.act === 'close') {
        dlg.removeEventListener('click', onClick);
        closeAndRemove(dlg);
      }
    };
    dlg.addEventListener('click', onClick);
    return { cancelled: false, ok: false, error: err };
  }
}

// Bridge-aware command action: runs a shell command, treats non-zero exit as
// failure, captures stdout/stderr for the error dialog.
export function shellAction(command, options) {
  return async () => {
    const { execOk } = await import('./bridge.js');
    return execOk(command, options);
  };
}
