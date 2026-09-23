/**
 * Possible matches.
 *
 * The interface is built around one rule: a match is a question, not a
 * decision. Accepting one opens a verification request; it never merges or
 * connects anything by itself.
 */
import {
  el, icon, notice, toast, avatar, lifespan, spinner, emptyState, statusPill,
  openModal, relativeTime, titleCase,
} from '../ui.js';
import api from '../api.js';
import { refreshCounts } from '../store.js';

const FACTOR_LABELS = {
  fullName: 'Full name', givenName: 'First name', familyName: 'Family name',
  birthDate: 'Date of birth', deathDate: 'Date of death', birthPlace: 'Birthplace',
  gender: 'Gender', parents: 'Parent names', spouses: 'Spouse names',
  children: 'Children names', evidenceMass: 'Comparable information', living: 'Living status',
};

// ================================================================== list ====

export async function list({ navigate }) {
  const page = el('div.view');
  const results = el('div');

  const statusSelect = el('select', { 'aria-label': 'Filter by status' }, [
    el('option', { value: 'possible', text: 'Waiting for review' }),
    el('option', { value: 'verification_requested', text: 'Sent for verification' }),
    el('option', { value: 'accepted', text: 'Accepted' }),
    el('option', { value: 'rejected', text: 'Rejected' }),
    el('option', { value: 'all', text: 'All' }),
  ]);
  const kindSelect = el('select', { 'aria-label': 'Filter by kind' }, [
    el('option', { value: '', text: 'Duplicates and connections' }),
    el('option', { value: 'duplicate', text: 'Possible duplicates only' }),
    el('option', { value: 'connection', text: 'Cross-tree connections only' }),
  ]);
  statusSelect.addEventListener('change', load);
  kindSelect.addEventListener('change', load);

  const scanButton = el('button.btn.primary', {}, [icon('sparkles', 16), ' Run a scan']);
  scanButton.addEventListener('click', async () => {
    scanButton.disabled = true;
    scanButton.textContent = 'Scanning…';
    try {
      const result = await api.post('/api/matches/scan', { crossTree: true });
      toast(result.message, result.suggestions.length ? 'success' : 'info', 'Scan complete');
      statusSelect.value = 'possible';
      await load();
      refreshCounts();
    } catch (err) {
      toast(err.message, 'error', 'Scan failed');
    } finally {
      scanButton.disabled = false;
      scanButton.replaceChildren(icon('sparkles', 16), document.createTextNode(' Run a scan'));
    }
  });

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get(`/api/matches${api.qs({
        status: statusSelect.value, kind: kindSelect.value, pageSize: 50,
      })}`);

      if (!data.matches.length) {
        results.replaceChildren(emptyState(
          'sparkles',
          statusSelect.value === 'possible' ? 'No possible matches waiting' : 'Nothing here',
          statusSelect.value === 'possible'
            ? 'Run a scan to compare your people against other registered family trees. Nothing is connected automatically.'
            : 'Try a different filter.',
          statusSelect.value === 'possible' ? el('button.btn.primary', { onclick: () => scanButton.click() }, 'Run a scan now') : null
        ));
        return;
      }

      results.replaceChildren(
        el('p.small.muted.mb', { text: `${data.total} match${data.total === 1 ? '' : 'es'}` }),
        el('div.stack', {}, data.matches.map((match) => matchCard(match, load)))
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load matches', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Possible matches' }),
        el('p.lede', {
          text: 'Records that may describe the same person, or that could join two family trees. Every one of them is a question for you to answer.',
        }),
      ]),
      el('div.page-actions', {}, [statusSelect, kindSelect, scanButton]),
    ]),

    notice('warn', 'Nothing here has been connected',
      'A high score means the records look alike. It never means they are the same person. Accepting a match opens a verification request; only an approval merges or connects anything.'),

    el('div.mt'),
    results
  );

  await load();
  return page;
}

function matchCard(match, reload) {
  const scoreColour = match.band === 'strong' ? 'var(--rose-500)'
    : match.band === 'possible' ? 'var(--amber-500)' : 'var(--text-faint)';

  const agreeing = (match.evidence ?? []).filter((e) => e.value >= 0.7 && e.factor !== 'evidenceMass');

  return el('div.card', {}, [
    el('div.card-head', {}, [
      el('div.flex.grow.wrap', {}, [
        el('span.pill.possible', {
          text: match.kind !== 'duplicate' ? 'Possible connection'
            : match.trees.sameTree ? 'Possible duplicate'
              : 'Possible duplicate — would join two trees',
        }),
        statusPill(match.status),
        match.band === 'strong' ? el('span.pill.strong', { text: 'Strong similarity' }) : null,
        match.source === 'ai' ? el('span.pill.info', {}, [icon('sparkles', 11), 'AI reviewed']) : null,
      ]),
      el('span.sub', { text: relativeTime(match.createdAt) }),
    ]),

    el('div.card-body', {}, [
      el('div.flex.wrap', { style: { alignItems: 'stretch', gap: '14px' } }, [
        scoreRing(match.score, scoreColour),
        el('div.grow', { style: { minWidth: '240px' } }, [
          el('div.grid.cols-2', {}, [
            personPanel(match.personA, match.trees.a),
            personPanel(match.personB, match.trees.b),
          ]),
        ]),
      ]),

      match.rationale ? el('p.small.mt', { text: match.rationale }) : null,

      agreeing.length
        ? el('div.mt', {}, [
            el('div.section-title', { text: 'What agrees' }),
            el('div.flex.wrap', { style: { gap: '6px' } }, agreeing.map((e) =>
              el('span.pill.verified', { text: FACTOR_LABELS[e.factor] ?? e.factor })
            )),
          ])
        : null,

      match.conflicts?.length
        ? el('div.mt', {}, [
            el('div.section-title', { text: 'What conflicts' }),
            el('div.stack.sm', {}, match.conflicts.map((c) =>
              el('div.conflict-row', {}, [icon('alert', 15), el('span', { text: c.note ?? `${FACTOR_LABELS[c.factor] ?? c.factor} differs` })])
            )),
          ])
        : null,
    ]),

    match.canDecide && ['possible'].includes(match.status)
      ? el('div.card-foot', {}, [
          el('button.btn.primary', {
            onclick: (event) => acceptMatch(match, event.currentTarget, reload),
          }, [icon('check', 16), ' These are the same — request verification']),
          el('button.btn', {
            onclick: (event) => rejectMatch(match, event.currentTarget, reload),
          }, [icon('x', 16), ' Different people']),
          el('a.btn.ghost', { href: `#/matches/${match.id}` }, 'See all the evidence'),
          el('button.btn.ghost', {
            onclick: async () => {
              await api.post(`/api/matches/${match.id}/dismiss`);
              toast('Dismissed. It will not come back in future scans.', 'info');
              reload();
            },
          }, 'Dismiss'),
        ])
      : el('div.card-foot', {}, [
          el('a.btn.sm.ghost', { href: `#/matches/${match.id}` }, 'View details'),
          match.reviewedBy ? el('span.small.muted', { text: `Reviewed by ${match.reviewedBy} ${relativeTime(match.reviewedAt)}` }) : null,
        ]),
  ]);
}

function personPanel(person, tree) {
  return el('div', {
    style: {
      padding: '11px', borderRadius: 'var(--r-md)',
      background: 'var(--surface-2)', border: '1px solid var(--border)',
    },
  }, [
    el('div.flex', {}, [
      avatar(person),
      el('div.grow.truncate', {}, [
        el('strong.small.truncate', { text: person.displayName }),
        el('div.tiny.muted', { text: lifespan(person) ?? 'No dates' }),
      ]),
    ]),
    el('div.tiny.muted.mt', {
      text: [person.birthPlace, tree.isMine ? 'your tree' : `${tree.ownerName}'s tree`].filter(Boolean).join(' · '),
    }),
  ]);
}

function scoreRing(score, colour) {
  const circumference = 2 * Math.PI * 26;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 62 62');
  svg.innerHTML = `
    <circle cx="31" cy="31" r="26" style="fill:none;stroke:var(--surface-3);stroke-width:6"/>
    <circle cx="31" cy="31" r="26" style="fill:none;stroke:${colour};stroke-width:6;stroke-linecap:round;
      stroke-dasharray:${circumference};stroke-dashoffset:${circumference * (1 - score)}"/>`;
  return el('div', { style: { textAlign: 'center', flex: 'none' } }, [
    el('div.score-ring', {}, [svg, el('span.num', { text: `${Math.round(score * 100)}%` })]),
    el('div.tiny.faint', { text: 'similarity' }),
  ]);
}

// ---------------------------------------------------------- the decisions ---

async function acceptMatch(match, button, reload) {
  const sameTree = match.trees.sameTree;

  const body = el('div.stack', {}, [
    el('p', {
      text: match.kind === 'duplicate'
        ? `You are saying that "${match.personA.displayName}" and "${match.personB.displayName}" are the same person.`
        : `You are proposing that these records connect the two family trees.`,
    }),
    notice('warn', 'This does not merge anything yet',
      sameTree
        ? 'A verification request will be created. Approving it is what performs the merge.'
        : `The other tree's owner will be asked to confirm. Nothing changes until they approve.`),
  ]);

  let survivorSelect = null;
  if (match.kind === 'duplicate' && sameTree) {
    survivorSelect = el('select', {}, [
      el('option', { value: match.personA.id, text: `Keep "${match.personA.displayName}"` }),
      el('option', { value: match.personB.id, text: `Keep "${match.personB.displayName}"` }),
    ]);
    body.append(el('div.field', {}, [
      el('label', { text: 'Which record should survive the merge?' }),
      survivorSelect,
      el('div.help', { text: 'The other record’s relationships, events and any details the survivor is missing are moved across.' }),
    ]));
  }

  const noteInput = el('textarea', { placeholder: 'Why do you think these are the same? (optional but helpful)' });
  body.append(el('div.field', {}, [el('label', { text: 'Note for the reviewer' }), noteInput]));

  const confirmed = await openModal({
    title: match.kind === 'duplicate' ? 'Request a duplicate merge' : 'Propose a connection',
    body,
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Send for verification', variant: 'primary', value: true },
    ],
  });
  if (!confirmed) return;

  button.disabled = true;
  try {
    const result = await api.post(`/api/matches/${match.id}/accept`, {
      note: noteInput.value.trim() || undefined,
      survivingPersonId: survivorSelect?.value,
    });
    toast(result.message, 'success', 'Verification requested');
    refreshCounts();
    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not send');
    button.disabled = false;
  }
}

async function rejectMatch(match, button, reload) {
  const noteInput = el('textarea', {
    placeholder: 'e.g. "Different birth years, and their parents do not match."',
  });
  const confirmed = await openModal({
    title: 'These are different people',
    body: el('div.stack', {}, [
      el('p', { text: 'The two records will stay separate and this pair will not be suggested again.' }),
      el('div.field', {}, [el('label', { text: 'Reason (recorded in the audit trail)' }), noteInput]),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Record as different', variant: 'danger', value: true },
    ],
  });
  if (!confirmed) return;

  button.disabled = true;
  try {
    await api.post(`/api/matches/${match.id}/reject`, { note: noteInput.value.trim() || undefined });
    toast('Recorded. These records will stay separate.', 'success');
    refreshCounts();
    reload();
  } catch (err) {
    toast(err.message, 'error');
    button.disabled = false;
  }
}

// ================================================================ detail ====

export async function detail({ params, navigate }) {
  const data = await api.get(`/api/matches/${params.id}`);
  const match = data.match;

  const evidenceRows = (match.evidence ?? [])
    .filter((e) => e.factor !== 'evidenceMass')
    .sort((a, b) => b.weight - a.weight);

  return el('div.view', {}, [
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: match.kind !== 'duplicate' ? 'Possible connection' : match.trees.sameTree ? 'Possible duplicate' : 'Possible duplicate across two trees' }),
        el('p.lede', { text: match.rationale ?? '' }),
      ]),
      el('a.btn', { href: '#/matches' }, [icon('arrow-left', 16), ' All matches']),
    ]),

    el('div.grid.cols-2', {}, [
      detailPanel(match.personA, data.context.a, match.trees.a),
      detailPanel(match.personB, data.context.b, match.trees.b),
    ]),

    el('div.card.mt', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'Evidence' }),
        el('span.sub', { text: `Overall similarity ${Math.round(match.score * 100)}% · band "${match.band}"` }),
      ]),
      el('div.card-body', {}, [
        evidenceRows.length
          ? el('div', {}, evidenceRows.map((e) =>
              el('div.evidence-row', {}, [
                el('span.name', { text: FACTOR_LABELS[e.factor] ?? titleCase(e.factor) }),
                el('div.evidence-bar', {}, [el('i', { style: { width: `${e.value * 100}%` } })]),
                el('span.val', { text: `${Math.round(e.value * 100)}%` }),
              ])
            ))
          : el('p.muted.small', { text: 'No detailed evidence was recorded for this match.' }),

        match.conflicts?.length
          ? el('div.mt', {}, [
              el('div.section-title', { text: 'Conflicting evidence' }),
              el('div.stack.sm', {}, match.conflicts.map((c) =>
                el('div.conflict-row', {}, [
                  icon('alert', 15),
                  el('div', {}, [
                    el('strong', { text: `${FACTOR_LABELS[c.factor] ?? c.factor} (${c.severity})` }),
                    el('div', { text: c.note ?? '' }),
                  ]),
                ])
              )),
              el('p.tiny.muted.mt', {
                text: 'Decisive conflicts -- different exact dates of birth, or different recorded genders -- suppress a match no matter how well the names agree.',
              }),
            ])
          : null,
      ]),
    ]),

    data.openVerification
      ? el('div.mt', {}, [
          notice('info', 'A verification request is already open for this match',
            `Opened ${relativeTime(data.openVerification.created_at)}. It is waiting for a decision.`),
          el('div.mt', {}, [el('a.btn', { href: '#/verifications' }, 'Go to verifications')]),
        ])
      : match.canDecide && match.status === 'possible'
        ? el('div.card.mt', {}, [
            el('div.card-head', {}, [el('h3', { text: 'Your decision' })]),
            el('div.card-body', {}, [
              el('p.small.muted.mb', {
                text: 'Neither option changes the family graph on its own. Accepting opens a verification request; rejecting records that these are different people.',
              }),
              el('div.btn-row', {}, [
                el('button.btn.primary', {
                  onclick: (e) => acceptMatch(match, e.currentTarget, () => navigate('matches')),
                }, [icon('check', 16), ' Same person — request verification']),
                el('button.btn', {
                  onclick: (e) => rejectMatch(match, e.currentTarget, () => navigate('matches')),
                }, [icon('x', 16), ' Different people']),
              ]),
            ]),
          ])
        : null,
  ]);
}

function detailPanel(person, context, tree) {
  const facts = el('dl.kv');
  const add = (label, value) => {
    if (!value || (Array.isArray(value) && !value.length)) return;
    facts.append(el('dt', { text: label }), el('dd', { text: Array.isArray(value) ? value.join(', ') : value }));
  };
  add('Born', person.birthDate ?? (person.birthYear ? String(person.birthYear) : null));
  add('Birthplace', person.birthPlace);
  add('Died', person.deathDate);
  add('Gender', person.gender === 'unknown' ? null : person.gender);
  add('Parents', context?.parents);
  add('Spouses', context?.spouses);
  add('Children', context?.children);

  return el('div.card', {}, [
    el('div.card-head', {}, [
      avatar(person),
      el('div.grow', {}, [
        el('h3', { text: person.displayName }),
        el('span.sub', { text: tree.isMine ? 'In your tree' : `In ${tree.ownerName}'s tree` }),
      ]),
    ]),
    el('div.card-body', {}, [
      facts.children.length ? facts : el('p.muted.small', { text: 'Very little information recorded.' }),
      el('div.mt', {}, [
        el('a.btn.sm', { href: `#/person/${person.id}` }, 'Open profile'),
      ]),
    ]),
  ]);
}
