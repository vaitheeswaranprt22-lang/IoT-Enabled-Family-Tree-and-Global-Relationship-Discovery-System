/**
 * Verification workflow -- the gate every uncertain connection passes through.
 * This is the only screen from which a family branch actually joins another.
 */
import {
  el, icon, notice, toast, avatar, lifespan, spinner, emptyState, statusPill,
  openModal, relativeTime,
} from '../ui.js';
import api from '../api.js';
import { refreshCounts } from '../store.js';

export async function list() {
  const page = el('div.view');
  const results = el('div');

  const boxTabs = el('div.tabs', {}, [
    el('button.on', { type: 'button', dataset: { box: 'incoming' } }, 'Waiting for me'),
    el('button', { type: 'button', dataset: { box: 'outgoing' } }, 'Sent by me'),
    el('button', { type: 'button', dataset: { box: 'all' } }, 'Everything'),
  ]);
  const statusSelect = el('select', { 'aria-label': 'Filter by status' }, [
    el('option', { value: 'open', text: 'Open' }),
    el('option', { value: 'approved', text: 'Approved' }),
    el('option', { value: 'rejected', text: 'Rejected' }),
    el('option', { value: 'all', text: 'All statuses' }),
  ]);

  let box = 'incoming';
  for (const tab of boxTabs.children) {
    tab.addEventListener('click', () => {
      [...boxTabs.children].forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      box = tab.dataset.box;
      load();
    });
  }
  statusSelect.addEventListener('change', load);

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get(`/api/verifications${api.qs({ box, status: statusSelect.value, pageSize: 50 })}`);

      if (!data.requests.length) {
        results.replaceChildren(emptyState(
          'shield-check',
          box === 'incoming' ? 'Nothing is waiting for you' : 'Nothing here',
          box === 'incoming'
            ? 'When someone proposes a relationship or a match involving your family tree, it will appear here for you to approve or reject.'
            : 'Requests you send will be listed here while they wait for a decision.'
        ));
        return;
      }

      results.replaceChildren(
        el('div.stack', {}, data.requests.map((request) => requestCard(request, load)))
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load verification requests', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Verification' }),
        el('p.lede', {
          text: 'Two family branches connect only after a person reviews the evidence and approves it. Every decision here is recorded in the change history.',
        }),
      ]),
      el('div.page-actions', {}, [statusSelect]),
    ]),
    boxTabs,
    results
  );

  await load();
  return page;
}

function requestCard(request, reload) {
  const subject = request.subject;
  const isMatch = request.subjectType === 'match';

  const header = el('div.card-head', {}, [
    el('div.flex.grow.wrap', {}, [
      el('span.pill.info', { text: isMatch ? (subject.matchKind === 'duplicate' ? 'Duplicate merge' : 'Tree connection') : 'Relationship' }),
      statusPill(request.status),
      subject.band === 'strong' ? el('span.pill.strong', { text: 'Strong similarity' }) : null,
    ]),
    el('span.sub', { text: relativeTime(request.createdAt) }),
  ]);

  const body = el('div.card-body.stack');

  if (isMatch && subject.personA && subject.personB) {
    body.append(
      el('p', {
        text: subject.matchKind === 'duplicate'
          ? `Are "${subject.personA.displayName}" and "${subject.personB.displayName}" the same person?`
          : `Should these two records connect the family trees?`,
      }),
      el('div.grid.cols-2', {}, [
        miniPerson(subject.personA),
        miniPerson(subject.personB),
      ])
    );
    if (subject.score !== undefined) {
      body.append(el('div.flex.wrap.small.muted', {}, [
        el('span', { text: `Rule-engine similarity: ${Math.round(subject.score * 100)}%` }),
        subject.sameTree ? el('span.pill.weak', { text: 'Same tree' }) : el('span.pill.info', { text: 'Across two trees' }),
      ]));
    }
    if (subject.rationale) body.append(el('p.small.muted', { text: subject.rationale }));
    if (subject.conflicts?.length) {
      body.append(el('div', {}, [
        el('div.section-title', { text: 'Conflicting evidence' }),
        el('div.stack.sm', {}, subject.conflicts.map((c) =>
          el('div.conflict-row', {}, [icon('alert', 15), el('span', { text: c.note ?? c.factor })])
        )),
      ]));
    }
  } else if (request.subjectType === 'relationship') {
    body.append(
      el('p', {}, [
        'Please confirm: ',
        el('strong', { text: subject.label ?? 'this relationship' }),
      ]),
      subject.relationship
        ? el('div.flex.wrap', {}, [
            statusPill(subject.currentStatus),
            el('span.pill.weak', { text: subject.relationship.subtype }),
          ])
        : null
    );
  }

  if (request.message) {
    body.append(el('div', {}, [
      el('div.section-title', { text: 'Message from the requester' }),
      el('p.small', { text: request.message }),
    ]));
  }

  body.append(el('div.small.muted', {
    text: `Requested by ${request.requestedBy?.name ?? 'someone'}${request.assignedTo ? ` · assigned to ${request.assignedTo.name}` : ''}`,
  }));

  if (request.status !== 'open') {
    body.append(notice(
      request.status === 'approved' ? 'success' : 'warn',
      `This request was ${request.status}`,
      request.decisionNote ?? ''
    ));
  }

  const card = el('div.card', {}, [header, body]);

  if (request.status === 'open' && request.canDecide) {
    card.append(el('div.card-foot', {}, [
      el('button.btn.primary', {
        onclick: (event) => approve(request, event.currentTarget, reload),
      }, [icon('check', 16), ' Approve']),
      el('button.btn.danger', {
        onclick: (event) => reject(request, event.currentTarget, reload),
      }, [icon('x', 16), ' Reject']),
      isMatch && subject.personA
        ? el('a.btn.ghost', { href: `#/person/${subject.personA.id}` }, 'Inspect record A')
        : null,
      isMatch && subject.personB
        ? el('a.btn.ghost', { href: `#/person/${subject.personB.id}` }, 'Inspect record B')
        : null,
    ]));
  } else if (request.status === 'open' && request.isMine) {
    card.append(el('div.card-foot', {}, [
      el('span.small.muted.grow', { text: 'Waiting for the other person to decide.' }),
      el('button.btn.sm', {
        onclick: async (event) => {
          event.currentTarget.disabled = true;
          try {
            await api.post(`/api/verifications/${request.id}/withdraw`);
            toast('Request withdrawn.', 'info');
            reload();
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Withdraw'),
    ]));
  }

  return card;
}

function miniPerson(person) {
  return el('div', {
    style: { padding: '11px', borderRadius: 'var(--r-md)', background: 'var(--surface-2)', border: '1px solid var(--border)' },
  }, [
    el('div.flex', {}, [
      avatar(person),
      el('div.grow.truncate', {}, [
        el('strong.small.truncate', { text: person.displayName }),
        el('div.tiny.muted', { text: [lifespan(person), person.birthPlace].filter(Boolean).join(' · ') || 'No details' }),
      ]),
    ]),
  ]);
}

// ------------------------------------------------------------- decisions ---

async function approve(request, button, reload) {
  const subject = request.subject;
  const isDuplicate = request.subjectType === 'match' && subject.matchKind === 'duplicate';

  const body = el('div.stack', {}, [
    el('p', {
      text: isDuplicate
        ? 'Approving merges the two records into one. Relationships and events move across, and the merge is reversible only from the audit record.'
        : request.subjectType === 'match'
          ? 'Approving creates a verified relationship that joins the two family trees. It will immediately be used in relationship discovery.'
          : 'Approving marks this relationship as verified. It will immediately be used in relationship discovery.',
    }),
  ]);

  let survivorSelect = null;
  let typeSelect = null;

  if (isDuplicate && subject.personA && subject.personB) {
    survivorSelect = el('select', {}, [
      el('option', { value: subject.personA.id, text: `Keep "${subject.personA.displayName}"` }),
      el('option', { value: subject.personB.id, text: `Keep "${subject.personB.displayName}"` }),
    ]);
    body.append(el('div.field', {}, [
      el('label', { text: 'Which record survives?' }),
      survivorSelect,
      el('div.help', { text: 'The other record is kept as a merged-away reference, so nothing is lost.' }),
    ]));
  }

  if (request.subjectType === 'match' && subject.matchKind === 'connection') {
    typeSelect = el('select', {}, [
      el('option', { value: 'sibling', text: 'They are siblings' }),
      el('option', { value: 'spouse', text: 'They are spouses / partners' },),
      el('option', { value: 'parent', text: 'A is a parent of B' }),
      el('option', { value: 'child', text: 'A is a child of B' }),
    ]);
    body.append(el('div.field', {}, [
      el('label', { text: 'What is the relationship between them?' }),
      typeSelect,
    ]));
  }

  const noteInput = el('textarea', { placeholder: 'How did you confirm this? (optional)' });
  body.append(el('div.field', {}, [el('label', { text: 'Note for the record' }), noteInput]));

  const ok = await openModal({
    title: isDuplicate ? 'Approve and merge' : 'Approve this connection',
    body,
    actions: [
      { label: 'Cancel', value: false },
      { label: isDuplicate ? 'Approve and merge' : 'Approve', variant: 'primary', value: true },
    ],
  });
  if (!ok) return;

  button.disabled = true;
  try {
    const result = await api.post(`/api/verifications/${request.id}/approve`, {
      note: noteInput.value.trim() || undefined,
      survivingPersonId: survivorSelect?.value,
      relationshipType: typeSelect?.value,
    });
    toast(result.message, 'success', 'Approved');
    refreshCounts();
    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not approve');
    button.disabled = false;
  }
}

async function reject(request, button, reload) {
  const noteInput = el('textarea', {
    placeholder: 'e.g. "That is my grandmother’s cousin, not the same person."',
    required: true,
  });
  const ok = await openModal({
    title: 'Reject this request',
    body: el('div.stack', {}, [
      el('p', { text: 'Nothing will be merged or connected. The requester is told your reason.' }),
      el('div.field', {}, [
        el('label', { text: 'Reason (required)' }),
        noteInput,
        el('div.help', { text: 'This is stored in the audit trail.' }),
      ]),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Reject', variant: 'danger', value: true,
        onClick: () => {
          if (!noteInput.value.trim()) {
            noteInput.setAttribute('aria-invalid', 'true');
            toast('Please give a reason.', 'warn');
            return false;                       // keeps the dialog open
          }
          return true;
        },
      },
    ],
  });
  if (!ok) return;

  button.disabled = true;
  try {
    await api.post(`/api/verifications/${request.id}/reject`, { note: noteInput.value.trim() });
    toast('Rejected. Nothing was connected.', 'success');
    refreshCounts();
    reload();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}
