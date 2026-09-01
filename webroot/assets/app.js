// Zerion WebUI shell: header + router + bottom navigation.
//
// Navigation model mirrors Android Settings: two top-level destinations
// (仪表盘 / 应用) via a bottom Navigation Bar; App Details is a drilled-down
// page with a back button and no bottom bar.

import 'material/buttons/button.js';
import 'material/buttons/fab.js';
import 'material/buttons/icon-button.js';
import 'material/card/card.js';
import 'material/chips/chip.js';
import 'material/chips/chip-set.js';
import 'material/dialog/dialog.js';
import 'material/divider/divider.js';
import 'material/icon/icon.js';
import 'material/indicators/progress.js';
import 'material/indicators/loading.js';
import 'material/list/list.js';
import 'material/list/list-item.js';
import 'material/nav/bar.js';
import 'material/nav/item.js';
import 'material/snackbar/snackbar.js';
import 'material/text/text-field.js';

import { icon } from './core/icons.js';
import { hasBridge } from './core/bridge.js';
import { bridgeUnavailableState } from './components/state-view.js';
import * as dashboard from './pages/dashboard.js';
import * as apps from './pages/apps.js';
import * as appDetails from './pages/app-details.js';

const headerEl = document.getElementById('app-header');
const mainEl = document.getElementById('app-main');
const navEl = document.getElementById('app-nav');

// Subtle page-level transition (fade + slight lift).  Reduced motion is
// handled globally in base.css; this only re-triggers the animation once per
// route change.
function fadeInPage(el) {
  el.classList.remove('z-page-enter');
  void el.offsetWidth; // force reflow so the animation re-runs
  el.classList.add('z-page-enter');
}

function parseHash() {
  const h = location.hash || '#/';
  if (h === '#/' || h === '#' || h === '') return { page: 'dashboard' };
  if (h === '#/apps') return { page: 'apps' };
  if (h.startsWith('#/apps?')) {
    const params = new URLSearchParams(h.replace(/^#\/apps\?/, ''));
    const filter = params.get('filter');
    return { page: 'apps', filter: ['all', 'attention', 'user', 'system'].includes(filter) ? filter : undefined };
  }
  const m = h.match(/^#\/apps\/(.+)$/);
  if (m) return { page: 'app-details', packageName: decodeURIComponent(m[1]) };
  return { page: 'dashboard' };
}

let current = null;

function renderHeader(route) {
  if (route.page === 'dashboard') {
    headerEl.className = 'z-header--dashboard';
    headerEl.innerHTML = `
      <div class="z-header-row">
        <div class="z-header-title">
          <h1 class="z-title-large">Zerion</h1>
          <div class="z-header-subtitle z-body-small">Dexopt / ART 编译状态</div>
        </div>
      </div>`;
  } else if (route.page === 'apps') {
    headerEl.className = 'z-header--page';
    headerEl.innerHTML = `
      <div class="z-header-row">
        <h1 class="z-title-medium z-header-title">应用</h1>
      </div>`;
  } else {
    headerEl.className = 'z-header--page';
    headerEl.innerHTML = `
      <div class="z-header-row">
        <md-icon-button data-back aria-label="返回">${icon('arrow_back')}</md-icon-button>
        <h1 class="z-title-medium z-header-title">应用详情</h1>
      </div>`;
    const back = headerEl.querySelector('[data-back]');
    if (back) back.addEventListener('click', () => { location.hash = '#/apps'; });
  }
}

function renderNav(route) {
  navEl.innerHTML = '';
  if (route.page === 'app-details') return;
  // Build the bar + items in JS before insertion: M3E's md-nav-bar reads its
  // slotted items during firstUpdated, so the items must already be present.
  const bar = document.createElement('md-nav-bar');
  const destinations = [
    { key: 'dashboard', label: '仪表盘', hash: '#/', iconName: 'space_dashboard' },
    { key: 'apps', label: '应用', hash: '#/apps', iconName: 'apps' },
  ];
  for (const d of destinations) {
    const item = document.createElement('md-nav-item');
    item.label = d.label;
    item.active = route.page === d.key;
    const activeIcon = document.createElement('md-icon');
    activeIcon.slot = 'active-icon';
    activeIcon.innerHTML = icon(d.iconName);
    const inactiveIcon = document.createElement('md-icon');
    inactiveIcon.slot = 'inactive-icon';
    inactiveIcon.innerHTML = icon(d.iconName);
    item.append(activeIcon, inactiveIcon);
    item.addEventListener('click', () => {
      const cur = parseHash();
      if (cur.page !== d.key || (d.key === 'apps' && cur.filter)) location.hash = d.hash;
    });
    bar.append(item);
  }
  navEl.append(bar);
}

function route() {
  const r = parseHash();
  if (current && current.unmount) current.unmount();
  current = null;
  renderHeader(r);
  renderNav(r);
  mainEl.innerHTML = '';
  fadeInPage(mainEl);
  if (!hasBridge()) {
    mainEl.innerHTML = bridgeUnavailableState();
    return;
  }
  if (r.page === 'dashboard') {
    current = dashboard;
    dashboard.mount(mainEl);
  } else if (r.page === 'apps') {
    current = apps;
    apps.mount(mainEl, { filter: r.filter });
  } else {
    current = appDetails;
    appDetails.mount(mainEl, r.packageName);
  }
}

window.addEventListener('hashchange', route);
route();
