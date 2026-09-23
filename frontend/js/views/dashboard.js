/** Dashboard: authentication status, tree statistics and what needs attention. */
import {
  el, icon, notice, avatar, lifespan, relativeTime, statusPill, emptyState, toast,
} from '../ui.js';
import api from '../api.js';
import state from '../store.js';

export async function dashboard() {
  const data = await api.get('/api/dashboard');
  const counts = data.counts;

  const needsAttention = counts.possibleMatches + counts.verificationRequests;

  return el('div', {}, [
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: `Welcome back, ${data.user.displayName.split(' ')[0]}` }),
        el('p.lede', {
          text: needsAttention
            ? `${needsAttention} item${needsAttention === 1 ? '' : 's'} need your review before anything connects.`
            : 'Your family tree is up to date. Nothing is waiting for a decision.',
        }),
      ]),
      el('div.page-actions', {}, [
        el('a.btn', { href: '#/people/new' }, [icon('plus', 16), ' Add a person']),
        el('a.btn.primary', { href: '#/tree' }, [icon('tree', 16), ' Open family tree']),
      ]),
    ]),

    authenticationCard(data.authentication),

    el('div.grid.cols-4.mt', {}, [
      statTile('People in your tree', counts.people, '#/people', 'users'),
      statTile('Verified relationships', counts.relationships.verified, '#/relationships', 'link', 'accent'),
      statTile('Generations spanned', counts.generations.total,
        '#/tree', 'tree', '',
        `${counts.generations.ancestors} up · ${counts.generations.descendants} down`),
      statTile('Possible matches', counts.possibleMatches, '#/matches', 'sparkles',
        counts.possibleMatches ? 'warn' : ''),
    ]),

    counts.verificationRequests > 0
      ? el('div.mt', {}, [
          notice('warn', `${counts.verificationRequests} verification request${counts.verificationRequests === 1 ? '' : 's'} waiting for you`,
            'Someone has asked you to confirm a relationship or a possible match. Nothing connects until you decide.'),
          el('div.mt', {}, [el('a.btn.primary', { href: '#/verifications' }, 'Review them now')]),
        ])
      : null,

    el('div.grid.cols-2.mt', {}, [
      relationshipBreakdown(counts.relationships),
      hardwareCard(data.hardware, data.authentication),
    ]),

    el('div.grid.cols-2.mt', {}, [
      recentChangesCard(data.recentChanges),
      el('div', {}, [
        quickSearchCard(),
        aiCard(data.ai),
      ]),
    ]),

    data.self
      ? el('div.card.mt', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'Your person record' }),
            el('span.sub', { text: 'Separate from your login account' }),
          ]),
          el('div.card-body', {}, [
            el('a.person-row', { href: `#/person/${data.self.id}` }, [
              avatar(data.self, 'lg'),
              el('div.person-meta', {}, [
                el('strong', { text: data.self.displayName }),
                el('small', { text: [lifespan(data.self), data.self.birthPlace].filter(Boolean).join(' · ') || 'No details recorded yet' }),
              ]),
              el('span.pill.info', { text: 'This is you in the graph' }),
            ]),
            el('p.tiny.muted.mt', {
              text: 'Your account signs you in; this record is what other family trees can connect to. Keeping them separate means a relative can link to you without any access to your login.',
            }),
          ]),
        ])
      : null,
  ]);
}

function authenticationCard(auth) {
  const biometric = auth.method === 'biometric';
  return el('div.card', {}, [
    el('div.card-body', {}, [
      el('div.flex.wrap', {}, [
        el('div', {
          style: {
            width: '46px', height: '46px', borderRadius: '12px', flex: 'none',
            display: 'grid', placeItems: 'center',
            background: biometric ? 'var(--violet-100)' : 'var(--green-100)',
            color: biometric ? 'var(--violet-700)' : 'var(--green-700)',
          },
        }, [icon(biometric ? 'fingerprint' : 'lock', 24)]),
        el('div.grow', {}, [
          el('div.flex.wrap', { style: { gap: '8px' } }, [
            el('strong', { text: 'Authenticated' }),
            el('span.pill.verified', { text: auth.label }),
          ]),
          el('div.small.muted', { text: auth.note }),
        ]),
        el('div.right.small', {}, [
          el('div.muted', { text: `${auth.enrolledFingerprints} fingerprint${auth.enrolledFingerprints === 1 ? '' : 's'} enrolled` }),
          auth.lastBiometricAttempt
            ? el('div.tiny.faint', {
                text: `Last scan: ${auth.lastBiometricAttempt.outcome} · ${relativeTime(auth.lastBiometricAttempt.at)}`,
              })
            : el('div.tiny.faint', { text: 'No fingerprint scans recorded yet' }),
        ]),
        el('a.btn.sm', { href: '#/hardware' }, 'Manage'),
      ]),
    ]),
  ]);
}

function statTile(label, value, href, iconName, tone = '', hint = null) {
  return el(`a.stat${tone ? `.${tone}` : ''}`, { href }, [
    el('span.label', {}, [label]),
    el('span.value', { text: String(value ?? 0) }),
    hint ? el('span.hint', { text: hint }) : null,
  ]);
}

function relationshipBreakdown(rel) {
  const rows = [
    ['verified', 'Verified', rel.verified, 'Used in relationship discovery'],
    ['unverified', 'Unverified', rel.unverified, 'Recorded but not yet confirmed'],
    ['verification_requested', 'Awaiting verification', rel.verificationRequested, 'A decision is pending'],
    ['possible', 'Possible', rel.possible, 'Suggested, not confirmed'],
    ['rejected', 'Rejected', rel.rejected, 'Reviewed and declined'],
  ].filter(([, , count]) => count > 0);

  return el('div.card', {}, [
    el('div.card-head', {}, [
      el('h3', { text: 'Relationship status' }),
      el('a.btn.sm.ghost', { href: '#/relationships' }, 'View all'),
    ]),
    el('div.card-body', {}, [
      rows.length
        ? el('div.stack.sm', {}, rows.map(([status, label, count, hint]) =>
            el('div.flex', {}, [
              statusPill(status),
              el('div.grow', {}, [el('div.tiny.muted', { text: hint })]),
              el('strong', { text: String(count) }),
            ])
          ))
        : el('p.muted.small', { text: 'No relationships recorded yet. Add a parent or a sibling to begin.' }),
      el('p.tiny.muted.mt', {
        text: 'Only verified relationships are traversed when working out how two people are related.',
      }),
    ]),
  ]);
}

function hardwareCard(hardware, auth) {
  const devices = hardware.devices ?? [];
  return el('div.card', {}, [
    el('div.card-head', {}, [
      el('h3', { text: 'Biometric hardware' }),
      el('a.btn.sm.ghost', { href: '#/hardware' }, 'Manage'),
    ]),
    el('div.card-body', {}, [
      devices.length
        ? el('div.stack.sm', {}, devices.map((device) =>
            el('div.flex', {}, [
              el(`span.dot.${device.online ? 'on' : 'off'}`),
              el('div.grow', {}, [
                el('strong.small', { text: device.name }),
                el('div.tiny.muted', {
                  text: `${device.id}${device.simulated ? ' · simulator' : ''} · ${device.online ? 'online' : `last seen ${relativeTime(device.lastSeenAt)}`}`,
                }),
              ]),
              device.status !== 'active' ? statusPill(device.status) : null,
            ])
          ))
        : el('p.muted.small', { text: 'No scanner registered yet.' }),
      el('div.btn-row.mt', {}, [
        el('a.btn.sm', { href: '#/scanner' }, [icon('cpu', 15), ' Virtual scanner']),
        el('a.btn.sm', { href: '#/hardware' }, [icon('fingerprint', 15), ' Enrol a finger']),
      ]),
    ]),
  ]);
}

function recentChangesCard(changes) {
  return el('div.card', {}, [
    el('div.card-head', {}, [
      el('h3', { text: 'Recent changes' }),
      el('a.btn.sm.ghost', { href: '#/history' }, 'Full history'),
    ]),
    el('div.card-body.tight', {}, [
      changes.length
        ? el('div.stack.sm', {}, changes.map((change) =>
            el('div.flex', { style: { padding: '6px 8px' } }, [
              el('span', { style: { color: 'var(--text-faint)', flex: 'none' } }, [icon(iconForAction(change.action), 16)]),
              el('div.grow', {}, [
                el('div.small', {}, [
                  el('strong', { text: change.action }),
                  change.entityLabel ? el('span.muted', { text: ` · ${change.entityLabel}` }) : null,
                ]),
                el('div.tiny.faint', { text: `${change.actor} · ${relativeTime(change.at)}` }),
              ]),
            ])
          ))
        : el('p.muted.small', { style: { padding: '10px' } }, 'Nothing has changed yet.'),
    ]),
  ]);
}

function iconForAction(action) {
  if (/verif/i.test(action)) return 'shield-check';
  if (/merge/i.test(action)) return 'merge';
  if (/reject/i.test(action)) return 'x';
  if (/relationship/i.test(action)) return 'link';
  if (/person|photo/i.test(action)) return 'user';
  if (/device|fingerprint|biometric/i.test(action)) return 'fingerprint';
  if (/export|backup/i.test(action)) return 'download';
  return 'edit';
}

function quickSearchCard() {
  const input = el('input', { type: 'search', placeholder: 'Search a registered person…', 'aria-label': 'Search a person' });
  const go = el('button.btn.primary', {}, [icon('search', 16)]);

  const submit = () => {
    const term = input.value.trim();
    location.hash = term ? `#/search?q=${encodeURIComponent(term)}` : '#/search';
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });

  return el('div.card', {}, [
    el('div.card-head', {}, [el('h3', { text: 'How am I related to…?' })]),
    el('div.card-body', {}, [
      el('div.flex', {}, [el('div.grow', {}, [input]), go]),
      el('p.tiny.muted.mt', {
        text: 'Searches the verified relationship graph and names the exact connection, including the path and any common ancestor.',
      }),
    ]),
  ]);
}

function aiCard(ai) {
  return el('div.card.mt', {}, [
    el('div.card-head', {}, [
      el('h3', { text: 'AI assistance' }),
      el('span.pill.info', { text: ai.mode === 'model-assisted' ? 'Model-assisted' : 'Local heuristics' }),
    ]),
    el('div.card-body', {}, [
      el('p.small.muted', { text: ai.note }),
      el('div.mt', {}, [
        notice('info', 'Suggestions only',
          'The assistant can propose duplicates, missing links and candidate connections. It cannot create or verify a relationship -- every suggestion needs a person to approve it.'),
      ]),
      el('div.btn-row.mt', {}, [
        el('a.btn.sm', { href: '#/matches' }, [icon('sparkles', 15), ' See suggestions']),
      ]),
    ]),
  ]);
}
