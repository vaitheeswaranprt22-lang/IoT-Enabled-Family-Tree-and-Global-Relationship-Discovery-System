/** Relationship management: the stored edges of the family graph. */
import {
  el, icon, notice, toast, spinner, emptyState, statusPill, relativeTime,
  confirmDialog, openModal, formatDate,
} from '../ui.js';
import api from '../api.js';
import { refreshCounts } from '../store.js';

export async function list({ query }) {
  const page = el('div.view');
  const results = el('div');

  const statusSelect = el('select', { 'aria-label': 'Filter by status' }, [
    el('option', { value: '', text: 'All statuses' }),
    el('option', { value: 'verified', text: 'Verified' }),
    el('option', { value: 'unverified', text: 'Unverified' }),
    el('option', { value: 'verification_requested', text: 'Awaiting verification' }),
    el('option', { value: 'rejected', text: 'Rejected' }),
  ]);
  const typeSelect = el('select', { 'aria-label': 'Filter by type' }, [
    el('option', { value: '', text: 'All types' }),
    el('option', { value: 'parent', text: 'Parent → child' }),
    el('option', { value: 'spouse', text: 'Marriage / partnership' }),
    el('option', { value: 'sibling', text: 'Sibling (explicit)' }),
  ]);
  statusSelect.addEventListener('change', load);
  typeSelect.addEventListener('change', load);

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get(`/api/relationships${api.qs({
        status: statusSelect.value, type: typeSelect.value,
        person: query.person, pageSize: 200,
      })}`);

      if (!data.relationships.length) {
        results.replaceChildren(emptyState(
          'link', 'No relationships recorded',
          'Add a person and link them to someone, or open a profile and use the "Add parent" and "Add child" buttons.',
          el('a.btn.primary', { href: '#/people/new' }, 'Add a person')
        ));
        return;
      }

      const rows = data.relationships.map((rel) => el('tr', {}, [
        el('td', {}, [
          el('a', { href: `#/person/${rel.from?.id}`, text: rel.from?.name ?? 'Unknown' }),
        ]),
        el('td.small.muted.nowrap', { text: relationWording(rel.type) }),
        el('td', {}, [
          el('a', { href: `#/person/${rel.to?.id}`, text: rel.to?.name ?? 'Unknown' }),
        ]),
        el('td', {}, [el('span.pill.weak', { text: rel.subtype })]),
        el('td', {}, [statusPill(rel.status)]),
        el('td.small.muted.nowrap', { text: rel.startDate ? formatDate(rel.startDate) : '—' }),
        el('td.actions', {}, [
          rel.status !== 'verified'
            ? el('button.btn.sm', {
                onclick: (e) => requestVerification(rel, e.currentTarget, load),
              }, 'Verify')
            : null,
          el('button.btn.sm.ghost', {
            title: 'Remove this relationship',
            onclick: (e) => removeRelationship(rel, e.currentTarget, load),
          }, [icon('trash', 14)]),
        ]),
      ]));

      results.replaceChildren(
        el('div.card', {}, [
          el('div.table-wrap', {}, [
            el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'Person' }), el('th', { text: '' }), el('th', { text: 'Person' }),
                el('th', { text: 'Nature' }), el('th', { text: 'Status' }),
                el('th', { text: 'Since' }), el('th', { text: '' }),
              ])]),
              el('tbody', {}, rows),
            ]),
          ]),
        ])
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load relationships', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Relationships' }),
        el('p.lede', {
          text: 'The stored edges of your family graph. Only three kinds are stored -- parent, marriage and explicit sibling. Everything else, from cousin to great-aunt, is computed from these.',
        }),
      ]),
      el('div.page-actions', {}, [
        statusSelect, typeSelect,
        el('button.btn.primary', { onclick: () => addRelationship(load) }, [icon('plus', 16), ' Add a link']),
      ]),
    ]),
    notice('info', 'Only verified edges are traversed',
      'A relationship is recorded as soon as you add it, but relationship discovery uses it only once it has been verified.'),
    el('div.mt'),
    results
  );

  await load();
  return page;
}

const relationWording = (type) =>
  ({ parent: 'is a parent of', spouse: 'is married to', sibling: 'is a sibling of' }[type] ?? type);

async function addRelationship(reload) {
  const people = await api.get('/api/persons?scope=mine&pageSize=500').catch(() => ({ persons: [] }));
  if (people.persons.length < 2) {
    toast('Add at least two people first.', 'warn');
    return;
  }

  const options = people.persons.map((p) =>
    el('option', { value: p.id, text: `${p.displayName}${p.birthYear ? ` (b. ${p.birthYear})` : ''}` }));

  const fromSelect = el('select', {}, options.map((o) => o.cloneNode(true)));
  const toSelect = el('select', {}, options.map((o) => o.cloneNode(true)));
  if (toSelect.options.length > 1) toSelect.selectedIndex = 1;

  const typeSelect = el('select', {}, [
    el('option', { value: 'parent', text: 'is a parent of' }),
    el('option', { value: 'child', text: 'is a child of' }),
    el('option', { value: 'spouse', text: 'is married to / partner of' }),
    el('option', { value: 'sibling', text: 'is a sibling of' }),
  ]);

  const SUBTYPES = {
    parent: ['biological', 'adoptive', 'step', 'foster', 'guardian'],
    child: ['biological', 'adoptive', 'step', 'foster', 'guardian'],
    spouse: ['married', 'partner', 'divorced', 'widowed'],
    sibling: ['full', 'half', 'step', 'adoptive'],
  };
  const subtypeSelect = el('select', {}, SUBTYPES.parent.map((s) => el('option', { value: s, text: s })));
  typeSelect.addEventListener('change', () => {
    subtypeSelect.replaceChildren(
      ...SUBTYPES[typeSelect.value].map((s) => el('option', { value: s, text: s }))
    );
  });

  const startInput = el('input', { type: 'date' });
  const notesInput = el('textarea', { placeholder: 'Anything worth recording about this link (optional)' });

  const ok = await openModal({
    title: 'Add a relationship',
    body: el('div.stack', {}, [
      el('div.field', {}, [el('label', { text: 'This person' }), fromSelect]),
      el('div.field', {}, [el('label', { text: 'Relationship' }), typeSelect]),
      el('div.field', {}, [el('label', { text: 'That person' }), toSelect]),
      el('div.field', {}, [el('label', { text: 'Nature of the link' }), subtypeSelect]),
      el('div.field', {}, [
        el('label', { text: 'Start date (e.g. marriage date)' }), startInput,
      ]),
      el('div.field', {}, [el('label', { text: 'Notes' }), notesInput]),
      notice('info', 'It starts unverified',
        'The link is stored straight away but is not used in relationship discovery until it has been verified.'),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Add relationship', variant: 'primary', value: true },
    ],
  });
  if (!ok) return;

  try {
    await api.post('/api/relationships', {
      fromPersonId: fromSelect.value,
      toPersonId: toSelect.value,
      type: typeSelect.value,
      subtype: subtypeSelect.value,
      startDate: startInput.value || undefined,
      notes: notesInput.value.trim() || undefined,
    });
    toast('Relationship added. Verify it to use it in relationship discovery.', 'success');
    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not add the relationship');
  }
}

async function requestVerification(rel, button, reload) {
  // The tree owner can verify their own records directly; anything crossing
  // into another tree has to be asked for.
  const messageInput = el('textarea', { placeholder: 'Anything the reviewer should know (optional)' });

  const choice = await openModal({
    title: 'Verify this relationship',
    body: el('div.stack', {}, [
      el('p', {}, [el('strong', { text: rel.label ?? '' })]),
      el('p.small.muted', {
        text: 'If both people are in trees you can verify on, this marks the relationship verified immediately. Otherwise a request is sent to the other tree’s owner.',
      }),
      el('div.field', {}, [el('label', { text: 'Message' }), messageInput]),
    ]),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Verify now', value: 'direct', variant: 'primary' },
      { label: 'Send a request', value: 'request' },
    ],
  });
  if (!choice) return;

  button.disabled = true;
  try {
    if (choice === 'direct') {
      await api.patch(`/api/relationships/${rel.id}`, { status: 'verified' });
      toast('Verified. It is now used in relationship discovery.', 'success');
    } else {
      await api.post(`/api/relationships/${rel.id}/request-verification`, {
        message: messageInput.value.trim() || undefined,
      });
      toast('Request sent. Nothing changes until it is approved.', 'success');
    }
    refreshCounts();
    reload();
  } catch (err) {
    // A direct verify is refused when the caller lacks verifier standing on
    // both trees; fall back to the request path rather than dead-ending.
    if (choice === 'direct' && err.status === 403) {
      try {
        await api.post(`/api/relationships/${rel.id}/request-verification`, {
          message: messageInput.value.trim() || undefined,
        });
        toast('You cannot verify this one directly, so a request was sent instead.', 'info');
        refreshCounts();
        reload();
        return;
      } catch (innerErr) {
        toast(innerErr.message, 'error');
      }
    } else {
      toast(err.message, 'error');
    }
    button.disabled = false;
  }
}

async function removeRelationship(rel, button, reload) {
  const ok = await confirmDialog(
    'Remove this relationship?',
    `"${rel.label}" will be deleted. The people themselves are not affected.`,
    { confirmLabel: 'Remove', variant: 'danger' }
  );
  if (!ok) return;
  button.disabled = true;
  try {
    await api.delete(`/api/relationships/${rel.id}`);
    toast('Relationship removed.', 'success');
    reload();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}
