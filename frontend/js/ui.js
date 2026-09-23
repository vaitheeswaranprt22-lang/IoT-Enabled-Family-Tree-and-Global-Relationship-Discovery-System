/**
 * DOM helpers, icons, formatting and the shared toast/modal chrome.
 *
 * Everything that inserts user-supplied text uses `textContent` or the
 * `escapeHtml` helper. Nothing built from server data reaches innerHTML
 * unescaped.
 */

// ------------------------------------------------------------------ DOM ----

/**
 * Creates an element.
 *   el('div.card', { onclick }, [child, 'text'])
 * The tag string accepts `tag.class1.class2#id`.
 */
export function el(spec, props = {}, children = []) {
  const [tagAndClasses, id] = String(spec).split('#');
  const [tag, ...classes] = tagAndClasses.split('.');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = `${node.className} ${value}`.trim();
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.firstChild.remove(); return node; }

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Inline SVG icon. Paths are a fixed, internal set -- never user data. */
export function icon(name, size = 18) {
  const paths = {
    tree: '<circle cx="12" cy="5" r="2.6"/><circle cx="5" cy="18" r="2.6"/><circle cx="19" cy="18" r="2.6"/><path d="M12 7.6v3.9M12 11.5H5.6v3.9M12 11.5h6.4v3.9"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'shield-check': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    fingerprint: '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
    alert: '<path d="M12 9v4"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    merge: '<path d="M8 3v6a6 6 0 0 0 6 6h6"/><path d="m16 11 4 4-4 4"/><path d="M4 21 20 15"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M10.7 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.4 3.4M6.6 6.6A18 18 0 0 0 2 12s3.6 7 10 7a10.7 10.7 0 0 0 5.4-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M2 9a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-left': '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
    'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3"/>',
    heart: '<path d="M19 14c1.5-1.5 3-3.3 3-5.5A5.5 5.5 0 0 0 12 5a5.5 5.5 0 0 0-10 3.5C2 10.7 3.5 12.5 5 14l7 7z"/>',
    'book-open': '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
  };
  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrapper.setAttribute('viewBox', '0 0 24 24');
  wrapper.setAttribute('width', size);
  wrapper.setAttribute('height', size);
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.innerHTML = paths[name] ?? paths.info;
  return wrapper;
}

// ------------------------------------------------------------ formatting ---

export function formatDate(iso, precision = 'exact') {
  if (!iso) return null;
  if (precision === 'year') return String(iso).slice(0, 4);
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(iso);
  const formatted = date.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return precision === 'about' ? `about ${formatted}` : formatted;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(String(value).includes('T') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function relativeTime(value) {
  if (!value) return 'never';
  const date = new Date(String(value).includes('T') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const units = [
    [60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600],
    [604800, 'day', 86400], [2629800, 'week', 604800],
    [31557600, 'month', 2629800], [Infinity, 'year', 31557600],
  ];
  for (const [limit, unit, divisor] of units) {
    if (seconds < limit) {
      const n = Math.round(seconds / divisor);
      return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    }
  }
  return date.toLocaleDateString();
}

/** "1948 – 2011", "b. 1992", or null. */
export function lifespan(person) {
  const birth = person.birthYear ?? (person.birthDate ? String(person.birthDate).slice(0, 4) : null);
  const death = person.deathDate ? String(person.deathDate).slice(0, 4) : null;
  if (birth && death) return `${birth} – ${death}`;
  if (birth) return person.isLiving === false ? `${birth} – ?` : `b. ${birth}`;
  if (death) return `d. ${death}`;
  return null;
}

export function initials(name) {
  return String(name ?? '?')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0].toUpperCase()).join('') || '?';
}

export const titleCase = (value) =>
  String(value ?? '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ----------------------------------------------------------- components ----

export function avatar(person, size = '') {
  const node = el(`div.avatar${size ? `.${size}` : ''}`, {
    class: person?.gender === 'male' ? 'male' : person?.gender === 'female' ? 'female' : '',
    title: person?.displayName ?? '',
  });
  if (person?.photoUrl) {
    node.append(el('img', { src: person.photoUrl, alt: '', loading: 'lazy',
      onerror: (e) => { e.target.remove(); node.textContent = initials(person.displayName); } }));
  } else {
    node.textContent = initials(person?.displayName);
  }
  return node;
}

/** Status pill for a relationship or match. */
export function statusPill(status) {
  const map = {
    verified: ['verified', 'Verified', 'check'],
    unverified: ['unverified', 'Unverified', 'info'],
    possible: ['possible', 'Possible Match', 'alert'],
    verification_requested: ['requested', 'Verification Requested', 'clock'],
    rejected: ['rejected', 'Rejected', 'x'],
    accepted: ['verified', 'Accepted', 'check'],
    dismissed: ['weak', 'Dismissed', 'x'],
    open: ['requested', 'Open', 'clock'],
    approved: ['verified', 'Approved', 'check'],
    withdrawn: ['weak', 'Withdrawn', 'x'],
    pending: ['possible', 'Pending', 'clock'],
    active: ['verified', 'Active', 'check'],
    revoked: ['rejected', 'Revoked', 'x'],
    declined: ['rejected', 'Declined', 'x'],
    expired: ['weak', 'Expired', 'clock'],
    strong: ['strong', 'Strong', 'alert'],
    weak: ['weak', 'Weak', 'info'],
  };
  const [cls, label, ico] = map[status] ?? ['weak', titleCase(status), 'info'];
  return el(`span.pill.${cls}`, {}, [icon(ico, 11), label]);
}

export function categoryPill(category) {
  const labels = {
    biological: 'Blood relative', marital: 'By marriage',
    adoptive: 'Adoptive', step: 'Step-relationship', mixed: 'Mixed', self: 'Same person',
  };
  return el(`span.pill.${category}`, {}, labels[category] ?? titleCase(category));
}

export function emptyState(iconName, title, message, action) {
  return el('div.empty', {}, [
    icon(iconName, 42),
    el('h3', { text: title }),
    message ? el('p', { text: message }) : null,
    action ?? null,
  ]);
}

export function notice(kind, title, message) {
  const icons = { info: 'info', warn: 'alert', danger: 'alert', success: 'check' };
  return el(`div.notice.${kind}`, {}, [
    icon(icons[kind] ?? 'info', 18),
    el('div', {}, [
      title ? el('strong', { text: title }) : null,
      message ? el('span', { text: message }) : null,
    ]),
  ]);
}

export function spinner(label = 'Loading…') {
  return el('div.boot', {}, [el('div.spinner.lg'), el('p', { text: label })]);
}

export function field(label, control, help, errorText) {
  return el('div.field', {}, [
    label ? el('label', { text: label, for: control.id || undefined }) : null,
    control,
    help ? el('div.help', { text: help }) : null,
    errorText ? el('div.error', { text: errorText }) : null,
  ]);
}

export function input(props = {}) {
  return el('input', { type: 'text', ...props });
}

export function select(options, props = {}) {
  const node = el('select', props);
  for (const option of options) {
    const value = typeof option === 'string' ? option : option.value;
    const label = typeof option === 'string' ? titleCase(option) : option.label;
    node.append(el('option', { value, text: label, selected: props.value === value || undefined }));
  }
  if (props.value !== undefined) node.value = props.value;
  return node;
}

// --------------------------------------------------------------- toasts ----

export function toast(message, kind = 'info', title = null, timeout = 5200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el(`div.toast.${kind}`, {}, [
    icon({ success: 'check', error: 'alert', warn: 'alert', info: 'info' }[kind] ?? 'info', 18),
    el('div.grow', {}, [
      title ? el('strong', { text: title }) : null,
      el('span', { text: message }),
    ]),
    el('button.close', { 'aria-label': 'Dismiss', onclick: () => node.remove() }, [icon('x', 15)]),
  ]);
  host.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

// ---------------------------------------------------------------- modal ----

let modalResolve = null;

export function openModal({ title, body, actions = [], wide = false }) {
  const backdrop = document.getElementById('modalBackdrop');
  const modal = document.getElementById('modal');
  const titleNode = document.getElementById('modalTitle');
  const bodyNode = document.getElementById('modalBody');
  const footNode = document.getElementById('modalFoot');

  titleNode.textContent = title ?? '';
  clear(bodyNode);
  bodyNode.append(body instanceof Node ? body : el('p', { text: String(body ?? '') }));
  clear(footNode);

  modal.classList.toggle('wide', Boolean(wide));

  for (const action of actions) {
    footNode.append(el(`button.btn${action.variant ? `.${action.variant}` : ''}`, {
      text: action.label,
      onclick: async () => {
        if (action.onClick) {
          const result = await action.onClick(bodyNode);
          if (result === false) return;      // handler asked to keep it open
        }
        closeModal(action.value ?? true);
      },
    }));
  }

  backdrop.hidden = false;
  setTimeout(() => bodyNode.querySelector('input, select, textarea, button')?.focus(), 60);

  return new Promise((resolve) => { modalResolve = resolve; });
}

export function closeModal(value = null) {
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.hidden = true;
  if (modalResolve) { modalResolve(value); modalResolve = null; }
}

export function confirmDialog(title, message, { confirmLabel = 'Confirm', variant = 'primary' } = {}) {
  return openModal({
    title,
    body: el('p', { text: message }),
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, variant, value: true },
    ],
  });
}

/** Wires the modal's close affordances once, at boot. */
export function initModal() {
  document.getElementById('modalClose')?.addEventListener('click', () => closeModal(null));
  document.getElementById('modalBackdrop')?.addEventListener('click', (event) => {
    if (event.target.id === 'modalBackdrop') closeModal(null);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('modalBackdrop').hidden) closeModal(null);
  });
}

/** Runs an async action with a button in its loading state. */
export async function withBusy(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
