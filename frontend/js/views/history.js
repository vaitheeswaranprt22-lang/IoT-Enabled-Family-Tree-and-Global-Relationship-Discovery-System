/** Change history: who changed what, when, and what the value was before. */
import { el, icon, notice, spinner, emptyState, relativeTime, formatDateTime } from '../ui.js';
import api from '../api.js';

export async function list() {
  const page = el('div.view');
  const results = el('div');

  const groupSelect = el('select', { 'aria-label': 'Filter by kind of change' }, [
    el('option', { value: '', text: 'Everything' }),
    el('option', { value: 'person', text: 'People' }),
    el('option', { value: 'relationship', text: 'Relationships' }),
    el('option', { value: 'verification', text: 'Verifications' }),
    el('option', { value: 'match', text: 'Matches' }),
    el('option', { value: 'collaboration', text: 'Collaboration' }),
    el('option', { value: 'security', text: 'Security and hardware' }),
  ]);
  const actorSelect = el('select', { 'aria-label': 'Filter by who made the change' }, [
    el('option', { value: '', text: 'Anyone' }),
    el('option', { value: 'me', text: 'Only me' }),
  ]);
  groupSelect.addEventListener('change', load);
  actorSelect.addEventListener('change', load);

  const tabs = el('div.tabs', {}, [
    el('button.on', { type: 'button', dataset: { view: 'changes' } }, 'Family data changes'),
    el('button', { type: 'button', dataset: { view: 'security' } }, 'Security events'),
  ]);
  let view = 'changes';
  for (const tab of tabs.children) {
    tab.addEventListener('click', () => {
      [...tabs.children].forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      view = tab.dataset.view;
      groupSelect.parentElement.hidden = view !== 'changes';
      load();
    });
  }

  async function load() {
    results.replaceChildren(spinner());
    try {
      if (view === 'security') return renderSecurity();

      const data = await api.get(`/api/history${api.qs({
        group: groupSelect.value, actor: actorSelect.value, pageSize: 150,
      })}`);

      if (!data.history.length) {
        results.replaceChildren(emptyState('history', 'Nothing recorded yet',
          'Every change to a person, relationship or verification is logged here automatically.'));
        return;
      }

      results.replaceChildren(
        el('p.small.muted.mb', { text: `${data.total} recorded change${data.total === 1 ? '' : 's'}` }),
        el('div.card', {}, [
          el('div.table-wrap', {}, [
            el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'When' }), el('th', { text: 'Action' }),
                el('th', { text: 'What' }), el('th', { text: 'Field' }),
                el('th', { text: 'Before' }), el('th', { text: 'After' }),
                el('th', { text: 'By' }),
              ])]),
              el('tbody', {}, data.history.map((row) => el('tr', {}, [
                el('td.small.muted.nowrap', { title: formatDateTime(row.at), text: relativeTime(row.at) }),
                el('td', {}, [
                  el('div.flex', { style: { gap: '7px' } }, [
                    el('span', { style: { color: 'var(--text-faint)', flex: 'none' } }, [icon(iconFor(row.action), 15)]),
                    el('strong.small', { text: row.action }),
                  ]),
                ]),
                el('td.small', { text: row.entityLabel ?? '—' }),
                el('td.small.muted', { text: row.field ?? '—' }),
                el('td.small', {}, [valueCell(row.oldValue)]),
                el('td.small', {}, [valueCell(row.newValue)]),
                el('td.small', {}, [
                  el('span', { text: row.actor.name }),
                  row.actor.isMe ? el('span.pill.info', { text: 'you', style: { marginLeft: '5px' } }) : null,
                ]),
              ]))),
            ]),
          ]),
        ])
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load the history', err.message));
    }
  }

  async function renderSecurity() {
    try {
      const data = await api.get('/api/history/security');
      if (!data.events.length) {
        results.replaceChildren(emptyState('shield', 'No security events', 'Sign-ins, password changes and device activity appear here.'));
        return;
      }
      results.replaceChildren(el('div.card', {}, [
        el('div.table-wrap', {}, [
          el('table', {}, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'When' }), el('th', { text: 'Event' }),
              el('th', { text: 'Severity' }), el('th', { text: 'IP address' }), el('th', { text: 'Detail' }),
            ])]),
            el('tbody', {}, data.events.map((row) => el('tr', {}, [
              el('td.small.muted.nowrap', { title: formatDateTime(row.at), text: relativeTime(row.at) }),
              el('td.small', {}, [el('code.inline', { text: row.event })]),
              el('td', {}, [el(`span.pill.${row.severity === 'critical' ? 'rejected' : row.severity === 'warning' ? 'possible' : 'weak'}`, { text: row.severity })]),
              el('td.small.mono', { text: row.ip ?? '—' }),
              el('td.small.muted', { text: row.detail ?? '—' }),
            ]))),
          ]),
        ]),
      ]));
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load security events', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Change history' }),
        el('p.lede', {
          text: 'A complete audit trail. Every change to a person, relationship, match or verification is recorded with who did it and what the value was before.',
        }),
      ]),
      el('div.page-actions', {}, [
        el('div', {}, [groupSelect]),
        actorSelect,
      ]),
    ]),
    tabs,
    results
  );

  await load();
  return page;
}

function valueCell(value) {
  if (value === null || value === undefined || value === '') return el('span.faint', { text: '—' });
  const text = String(value);
  return el('span', { title: text, text: text.length > 40 ? `${text.slice(0, 39)}…` : text });
}

function iconFor(action) {
  if (/verif/i.test(action)) return 'shield-check';
  if (/merge/i.test(action)) return 'merge';
  if (/reject/i.test(action)) return 'x';
  if (/relationship/i.test(action)) return 'link';
  if (/person|photo/i.test(action)) return 'user';
  if (/device|fingerprint|biometric/i.test(action)) return 'fingerprint';
  if (/export|backup/i.test(action)) return 'download';
  if (/password|account/i.test(action)) return 'lock';
  if (/collaborat/i.test(action)) return 'share';
  if (/privacy/i.test(action)) return 'eye';
  return 'edit';
}
