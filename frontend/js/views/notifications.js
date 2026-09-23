/** Notification inbox. */
import { el, icon, notice, toast, spinner, emptyState, relativeTime } from '../ui.js';
import api from '../api.js';
import { refreshCounts } from '../store.js';

const TYPE_ICONS = {
  match: 'sparkles', verification: 'shield-check', collaboration: 'share',
  security: 'lock', biometric: 'fingerprint', system: 'info', relationship: 'link',
};

export async function list() {
  const page = el('div.view');
  const results = el('div');
  let onlyUnread = false;

  const unreadToggle = el('button.btn', {}, 'Show unread only');
  unreadToggle.addEventListener('click', () => {
    onlyUnread = !onlyUnread;
    unreadToggle.textContent = onlyUnread ? 'Show all' : 'Show unread only';
    load();
  });

  const markAll = el('button.btn', {}, [icon('check', 16), ' Mark all read']);
  markAll.addEventListener('click', async () => {
    markAll.disabled = true;
    try {
      const result = await api.post('/api/notifications/read-all');
      toast(`${result.marked} notification(s) marked as read.`, 'success');
      refreshCounts();
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      markAll.disabled = false;
    }
  });

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get(`/api/notifications${api.qs({ unread: onlyUnread ? 'true' : '', pageSize: 60 })}`);

      if (!data.notifications.length) {
        results.replaceChildren(emptyState(
          'bell', onlyUnread ? 'Nothing unread' : 'No notifications yet',
          'You will be told here when someone proposes a relationship, asks for a verification, or a scan finds a possible match.'
        ));
        return;
      }

      results.replaceChildren(
        el('div.stack.sm', {}, data.notifications.map((item) => notificationRow(item, load)))
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load notifications', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Notifications' }),
        el('p.lede', { text: 'Anything that needs your attention, and a record of what has happened.' }),
      ]),
      el('div.page-actions', {}, [unreadToggle, markAll]),
    ]),
    results
  );

  await load();
  return page;
}

function notificationRow(item, reload) {
  const severityColour = {
    critical: 'var(--rose-500)', warning: 'var(--amber-500)',
    success: 'var(--green-500)', info: 'var(--accent)',
  }[item.severity] ?? 'var(--accent)';

  const row = el('div.person-row', {
    style: item.read ? { opacity: '.72' } : { borderLeft: `3px solid ${severityColour}` },
  }, [
    el('div', {
      style: {
        width: '36px', height: '36px', flex: 'none', borderRadius: 'var(--r-md)',
        display: 'grid', placeItems: 'center',
        background: 'var(--surface-2)', color: severityColour,
      },
    }, [icon(TYPE_ICONS[item.type] ?? 'info', 18)]),

    el('div.person-meta', {}, [
      el('strong', { text: item.title }),
      item.body ? el('small', { text: item.body }) : null,
      el('div.tiny.faint', { text: relativeTime(item.createdAt) }),
    ]),

    item.link ? el('a.btn.sm', { href: item.link, onclick: () => markRead(item, reload) }, 'Open') : null,
    !item.read
      ? el('button.btn.sm.ghost', { title: 'Mark as read', onclick: () => markRead(item, reload) }, [icon('check', 14)])
      : null,
    el('button.btn.sm.ghost', {
      title: 'Delete',
      onclick: async () => {
        try {
          await api.delete(`/api/notifications/${item.id}`);
          refreshCounts();
          reload();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, [icon('trash', 14)]),
  ]);

  return row;
}

async function markRead(item, reload) {
  if (item.read) return;
  try {
    await api.post(`/api/notifications/${item.id}/read`);
    refreshCounts();
    reload();
  } catch { /* the link still navigates */ }
}
