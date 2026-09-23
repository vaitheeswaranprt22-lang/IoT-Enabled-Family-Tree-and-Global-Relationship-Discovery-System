/**
 * Application shell: hash router, navigation chrome and bootstrap.
 *
 * Views are loaded lazily so the first paint only costs what the landing page
 * actually needs.
 */
import { el, clear, icon, initials, spinner, toast, initModal, notice } from './ui.js';
import state, { loadSession, refreshCounts, signOut, subscribe, isSignedIn, loadInfo } from './store.js';

// ------------------------------------------------------------ route table ---

/**
 * `public: true`  -- reachable when signed out
 * `guestOnly`     -- redirects to the dashboard when already signed in
 */
const routes = [
  { path: '',                 load: () => import('./views/public.js'),        render: 'landing',   public: true },
  { path: 'about',            load: () => import('./views/public.js'),        render: 'about',     public: true },
  { path: 'login',            load: () => import('./views/auth.js'),          render: 'login',     public: true, guestOnly: true },
  { path: 'register',         load: () => import('./views/auth.js'),          render: 'register',  public: true, guestOnly: true },
  { path: 'forgot-password',  load: () => import('./views/auth.js'),          render: 'forgot',    public: true, guestOnly: true },
  { path: 'reset-password',   load: () => import('./views/auth.js'),          render: 'reset',     public: true, guestOnly: true },

  { path: 'dashboard',        load: () => import('./views/dashboard.js'),     render: 'dashboard' },
  { path: 'tree',             load: () => import('./views/tree-view.js'),     render: 'tree' },
  { path: 'people',           load: () => import('./views/people.js'),        render: 'list' },
  { path: 'people/new',       load: () => import('./views/people.js'),        render: 'create' },
  { path: 'person/:id',       load: () => import('./views/people.js'),        render: 'detail' },
  { path: 'person/:id/edit',  load: () => import('./views/people.js'),        render: 'edit' },
  { path: 'relationships',    load: () => import('./views/relationships.js'), render: 'list' },
  { path: 'search',           load: () => import('./views/search.js'),        render: 'search' },
  { path: 'matches',          load: () => import('./views/matches.js'),       render: 'list' },
  { path: 'matches/:id',      load: () => import('./views/matches.js'),       render: 'detail' },
  { path: 'verifications',    load: () => import('./views/verifications.js'), render: 'list' },
  { path: 'timeline',         load: () => import('./views/timeline.js'),      render: 'timeline' },
  { path: 'collaborators',    load: () => import('./views/collaborators.js'), render: 'list' },
  { path: 'notifications',    load: () => import('./views/notifications.js'), render: 'list' },
  { path: 'history',          load: () => import('./views/history.js'),       render: 'list' },
  { path: 'privacy',          load: () => import('./views/settings.js'),      render: 'privacy' },
  { path: 'export',           load: () => import('./views/settings.js'),      render: 'exportData' },
  { path: 'profile',          load: () => import('./views/settings.js'),      render: 'profile' },
  { path: 'hardware',         load: () => import('./views/hardware.js'),      render: 'hardware' },
  { path: 'scanner',          load: () => import('./views/simulator.js'),     render: 'simulator' },
];

const NAV = [
  {
    title: 'Family',
    items: [
      { path: 'dashboard',     label: 'Dashboard',       icon: 'home' },
      { path: 'tree',          label: 'Family Tree',     icon: 'tree' },
      { path: 'people',        label: 'People',          icon: 'users' },
      { path: 'relationships', label: 'Relationships',   icon: 'link' },
      { path: 'timeline',      label: 'Timeline',        icon: 'calendar' },
    ],
  },
  {
    title: 'Discover',
    items: [
      { path: 'search',        label: 'How am I related?', icon: 'search' },
      { path: 'matches',       label: 'Possible Matches',  icon: 'sparkles', count: 'matches' },
      { path: 'verifications', label: 'Verifications',     icon: 'shield-check', count: 'verifications' },
    ],
  },
  {
    title: 'Account',
    items: [
      { path: 'hardware',      label: 'Biometric & Hardware', icon: 'fingerprint' },
      { path: 'collaborators', label: 'Collaboration',        icon: 'share' },
      { path: 'notifications', label: 'Notifications',        icon: 'bell', count: 'notifications' },
      { path: 'history',       label: 'Change History',       icon: 'history' },
      { path: 'privacy',       label: 'Privacy',              icon: 'lock' },
      { path: 'export',        label: 'Export & Backup',      icon: 'download' },
    ],
  },
];

// ---------------------------------------------------------------- routing ---

/** Splits `#/person/abc?x=1` into its path, params and query. */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart ?? ''));

  for (const route of routes) {
    const routeSegments = route.path.split('/').filter(Boolean);
    if (routeSegments.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < routeSegments.length; i += 1) {
      const segment = routeSegments[i];
      if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(segments[i]);
      else if (segment !== segments[i]) { matched = false; break; }
    }
    if (matched) return { route, params, query, path: pathPart };
  }
  return { route: null, params: {}, query, path: pathPart };
}

export function navigate(path, replace = false) {
  const target = `#/${String(path).replace(/^#?\/?/, '')}`;
  if (replace) location.replace(target);
  else location.hash = target;
}

let currentToken = 0;

async function renderRoute() {
  const token = ++currentToken;
  const { route, params, query, path } = parseHash();
  const view = document.getElementById('view');

  // Unknown route.
  if (!route) {
    clear(view);
    view.append(el('div.view', {}, [
      notice('warn', 'Page not found', `There is no page at "#/${path}".`),
      el('div.mt', {}, [el('a.btn.primary', { href: isSignedIn() ? '#/dashboard' : '#/' }, 'Go back')]),
    ]));
    return;
  }

  if (!route.public && !isSignedIn()) {
    sessionStorage.setItem('gft:redirect', location.hash);
    return navigate('login', true);
  }
  if (route.guestOnly && isSignedIn()) return navigate('dashboard', true);

  clear(view);
  view.append(spinner());

  try {
    const module = await route.load();
    if (token !== currentToken) return;          // a newer navigation won
    const renderer = module[route.render];
    if (typeof renderer !== 'function') {
      throw new Error(`View "${route.render}" is missing from its module.`);
    }
    const content = await renderer({ params, query, navigate });
    if (token !== currentToken) return;
    clear(view);
    view.append(content);
    document.getElementById('main').scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (err) {
    if (token !== currentToken) return;
    console.error('[router]', err);
    clear(view);
    view.append(el('div', {}, [
      notice('danger', 'This page could not be loaded', err.message),
      el('div.mt', {}, [
        el('button.btn', { onclick: () => renderRoute() }, 'Try again'),
      ]),
    ]));
  }

  renderNav();
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarScrim')?.setAttribute('hidden', '');
}

// ------------------------------------------------------------- navigation ---

function renderNav() {
  const sidebar = document.getElementById('sidebar');
  const topbar = document.getElementById('topbar');
  if (!sidebar || !topbar) return;

  const signedIn = isSignedIn();
  topbar.hidden = false;
  sidebar.hidden = !signedIn;
  document.getElementById('layout').classList.toggle('no-sidebar', !signedIn);

  // Auth chip + notification badge.
  const chip = document.getElementById('authChip');
  clear(chip);
  if (signedIn && state.session) {
    const biometric = state.session.authMethod === 'biometric';
    chip.className = `auth-chip${biometric ? ' biometric' : ''}`;
    chip.append(icon(biometric ? 'fingerprint' : 'lock', 13));
    chip.append(document.createTextNode(biometric ? 'Fingerprint verified' : 'Password sign-in'));
    chip.title = 'Authentication confirms who you are. It says nothing about family relationships.';
  }

  const badge = document.getElementById('notifBadge');
  if (badge) {
    const n = state.counts.notifications;
    badge.hidden = !signedIn || n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
  document.querySelector('.notif-btn').hidden = !signedIn;

  renderUserMenu();

  if (!signedIn) { clear(sidebar); return; }

  const current = parseHash();
  clear(sidebar);
  for (const group of NAV) {
    const groupNode = el('div.nav-group', {}, [el('h4', { text: group.title })]);
    for (const item of group.items) {
      const active = current.route?.path === item.path
        || (item.path === 'people' && current.path.startsWith('person'))
        || (item.path !== '' && current.path.startsWith(`${item.path}/`));
      const count = item.count ? state.counts[item.count] : 0;
      groupNode.append(el(`a.nav-link${active ? '.active' : ''}`, { href: `#/${item.path}` }, [
        icon(item.icon, 17),
        el('span', { text: item.label }),
        count > 0 ? el('span.count', { text: count > 99 ? '99+' : String(count) }) : null,
      ]));
    }
    sidebar.append(groupNode);
  }

  sidebar.append(el('div.nav-group', {}, [
    el('h4', { text: 'Hardware demo' }),
    el('a.nav-link', { href: '#/scanner' }, [icon('cpu', 17), el('span', { text: 'Virtual ESP32 Scanner' })]),
  ]));
}

function renderUserMenu() {
  const host = document.getElementById('userMenu');
  clear(host);

  if (!isSignedIn()) {
    host.append(el('div.btn-row', {}, [
      el('a.btn.sm', { href: '#/login' }, 'Sign in'),
      el('a.btn.sm.primary', { href: '#/register' }, 'Create account'),
    ]));
    return;
  }

  const button = el('button.user-avatar', {
    text: initials(state.user.displayName),
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    title: state.user.displayName,
  });
  host.append(button);

  let dropdown = null;
  const close = () => {
    dropdown?.remove();
    dropdown = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
  };
  const onDocClick = (event) => { if (!host.contains(event.target)) close(); };

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (dropdown) return close();
    dropdown = el('div.dropdown', {}, [
      el('div.dropdown-head', {}, [
        el('strong', { text: state.user.displayName }),
        el('span', { text: state.user.email }),
      ]),
      el('hr'),
      el('a', { href: '#/profile', onclick: close }, [icon('user', 16), 'Profile & password']),
      el('a', { href: '#/privacy', onclick: close }, [icon('lock', 16), 'Privacy settings']),
      el('a', { href: '#/hardware', onclick: close }, [icon('fingerprint', 16), 'Biometric & hardware']),
      el('hr'),
      el('button', {
        onclick: () => {
          const html = document.documentElement;
          const next = html.dataset.theme === 'dark' ? 'light'
            : html.dataset.theme === 'light' ? '' : 'dark';
          if (next) html.dataset.theme = next; else delete html.dataset.theme;
          try { localStorage.setItem('gft:theme', next); } catch { /* private mode */ }
          close();
        },
      }, [icon('eye', 16), 'Switch light / dark']),
      el('hr'),
      el('button', {
        onclick: async () => { close(); await signOut(); navigate('', true); toast('You have been signed out.', 'info'); },
      }, [icon('logout', 16), 'Sign out']),
    ]);
    host.append(dropdown);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick, true);
  });
}

// -------------------------------------------------------------- bootstrap ---

function initChrome() {
  initModal();

  try {
    const theme = localStorage.getItem('gft:theme');
    if (theme) document.documentElement.dataset.theme = theme;
  } catch { /* storage unavailable -- fall back to the OS preference */ }

  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('sidebarScrim');
  const toggle = document.getElementById('menuToggle');

  toggle?.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
  });
  scrim?.addEventListener('click', () => {
    sidebar.classList.remove('open');
    scrim.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  });

  subscribe(renderNav);
  window.addEventListener('hashchange', renderRoute);
}

async function boot() {
  initChrome();
  await loadSession();
  loadInfo();

  if (isSignedIn()) {
    refreshCounts();
    // Keep the badges fresh while the tab is open, but only when visible.
    setInterval(() => { if (!document.hidden && isSignedIn()) refreshCounts(); }, 60_000);
  }

  // Land somewhere sensible on first load.
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    if (isSignedIn()) navigate('dashboard', true);
  }

  await renderRoute();
  renderNav();
  state.booted = true;
}

boot().catch((err) => {
  console.error('[boot]', err);
  const view = document.getElementById('view');
  clear(view);
  view.append(notice('danger', 'The application failed to start', err.message));
});

export { renderNav, refreshCounts };
