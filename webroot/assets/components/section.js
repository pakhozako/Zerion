// Settings-style section: title row + optional action + body.
import { icon } from '../core/icons.js';

export function section({ title, action, actionHref, body, id }) {
  const actionHtml = actionHref
    ? `<a class="z-section-action" href="${actionHref}">${action || ''}</a>`
    : action ? `<span class="z-section-action">${action}</span>` : '';
  return `
    <section class="z-section" id="${id || ''}">
      <div class="z-section-header">
        <h2 class="z-section-title">${title}</h2>
        ${actionHtml}
      </div>
      ${body}
    </section>`;
}

export function card({ title, body, footer }) {
  return `
    <md-card type="elevated" class="z-card">
      ${title ? `<div class="z-card-title">${title}</div>` : ''}
      <div class="z-card-body">${body}</div>
      ${footer ? `<div class="z-card-footer">${footer}</div>` : ''}
    </md-card>`;
}

export function emptySection(iconName, title, detail) {
  return `
    <div class="z-state">
      ${icon(iconName, 40)}
      <div class="z-state-title">${title}</div>
      ${detail ? `<div class="z-state-detail">${detail}</div>` : ''}
    </div>`;
}
