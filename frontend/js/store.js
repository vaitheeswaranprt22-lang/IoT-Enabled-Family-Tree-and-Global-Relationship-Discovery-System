/**
 * Application state.
 *
 * A very small observable store -- enough to keep the navigation badges and
 * the header in step with whatever the current view is doing, without pulling
 * in a framework.
 */
import api, { setToken } from './api.js';

const listeners = new Set();

export const state = {
  user: null,
  privacy: null,
  session: null,
  selfPerson: null,
  counts: { notifications: 0, matches: 0, verifications: 0 },
  info: null,
  booted: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('[store] listener failed', err); }
  }
}

export function patch(changes) {
  Object.assign(state, changes);
  emit();
}

export const isSignedIn = () => Boolean(state.user);

/** Loads the current session, if any. Safe to call when signed out. */
export async function loadSession() {
  try {
    const data = await api.get('/api/auth/me');
    patch({
      user: data.user,
      privacy: data.privacy,
      session: data.session,
      selfPerson: data.person,
    });
    return data.user;
  } catch {
    patch({ user: null, privacy: null, session: null, selfPerson: null });
    return null;
  }
}

export async function signOut() {
  try { await api.post('/api/auth/logout'); } catch { /* sign out locally regardless */ }
  setToken(null);
  patch({ user: null, privacy: null, session: null, selfPerson: null, counts: { notifications: 0, matches: 0, verifications: 0 } });
}

/** Refreshes the badge counts shown in the sidebar. */
export async function refreshCounts() {
  if (!state.user) return;
  try {
    const [notifications, matches, verifications] = await Promise.all([
      api.get('/api/notifications/count').catch(() => ({ unread: 0 })),
      api.get('/api/matches?status=possible&pageSize=1').catch(() => ({ total: 0 })),
      api.get('/api/verifications?box=incoming&status=open&pageSize=1').catch(() => ({ counts: { incomingOpen: 0 } })),
    ]);
    patch({
      counts: {
        notifications: notifications.unread ?? 0,
        matches: matches.total ?? 0,
        verifications: verifications.counts?.incomingOpen ?? 0,
      },
    });
  } catch (err) {
    console.warn('[store] could not refresh counts', err.message);
  }
}

export async function loadInfo() {
  try {
    const info = await api.get('/api/info');
    patch({ info });
    return info;
  } catch {
    return null;
  }
}

export default state;
