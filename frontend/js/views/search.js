/**
 * "How am I related to this person?"
 *
 * Searches the verified relationship graph and reports the exact connection,
 * the full path, and any common ancestor. When no verified path exists it says
 * so plainly rather than guessing -- and offers to search again including
 * unverified relationships, clearly labelled as provisional.
 */
import {
  el, icon, notice, toast, avatar, lifespan, spinner, emptyState, categoryPill, statusPill,
} from '../ui.js';
import api from '../api.js';
import state from '../store.js';

export async function search({ query, navigate }) {
  const page = el('div.view');
  const resultArea = el('div');

  const searchInput = el('input', {
    type: 'search', placeholder: 'Search a person or a registered user…',
    value: query.q ?? '', 'aria-label': 'Search for a person',
  });
  const scopeSelect = el('select', { 'aria-label': 'Where to search' }, [
    el('option', { value: 'global', text: 'All registered trees' }),
    el('option', { value: 'shared', text: 'My tree and shared trees' }),
    el('option', { value: 'mine', text: 'My tree only' }),
  ]);
  const includeUnverified = el('input', { type: 'checkbox', id: 'incUnverified' });

  const searchButton = el('button.btn.primary', {}, [icon('search', 16), ' Search']);

  let timer = null;
  const runSearch = async () => {
    const term = searchInput.value.trim();
    if (term.length < 2) {
      resultArea.replaceChildren(introPanel());
      return;
    }
    resultArea.replaceChildren(spinner('Searching…'));
    try {
      const [people, users] = await Promise.all([
        api.get(`/api/search/persons${api.qs({ q: term, scope: scopeSelect.value })}`),
        api.get(`/api/search/users${api.qs({ q: term })}`).catch(() => ({ users: [] })),
      ]);
      renderCandidates(people.results, users.users, term);
    } catch (err) {
      resultArea.replaceChildren(notice('danger', 'Search failed', err.message));
    }
  };

  searchInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 300); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } });
  scopeSelect.addEventListener('change', runSearch);
  searchButton.addEventListener('click', runSearch);

  function renderCandidates(people, users, term) {
    if (!people.length && !users.length) {
      resultArea.replaceChildren(emptyState(
        'search', 'Nobody found',
        `No person or registered user matches "${term}" in the trees you can search. Trees whose owners have turned off relationship search are not included.`
      ));
      return;
    }

    const blocks = [];

    if (users.length) {
      blocks.push(el('div.card.mb', {}, [
        el('div.card-head', {}, [
          el('h3', { text: 'Registered users' }),
          el('span.sub', { text: 'Compare your tree with theirs' }),
        ]),
        el('div.card-body.tight', {}, [
          el('div.stack.sm', {}, users.map((user) =>
            el('div.person-row', {}, [
              avatar({ displayName: user.displayName }),
              el('div.person-meta', {}, [
                el('strong', { text: user.displayName }),
                el('small', { text: `${user.treeSize} people in their tree` }),
              ]),
              user.isSynthetic ? el('span.pill.synthetic', { text: 'DEMO' }) : null,
              el('button.btn.sm.primary', {
                onclick: () => compute({ toUserId: user.id }, user.displayName),
              }, 'How am I related?'),
            ])
          )),
        ]),
      ]));
    }

    if (people.length) {
      blocks.push(el('div.card', {}, [
        el('div.card-head', {}, [
          el('h3', { text: 'People' }),
          el('span.sub', { text: `${people.length} found` }),
        ]),
        el('div.card-body.tight', {}, [
          el('div.stack.sm', {}, people.map((person) =>
            el('div.person-row', {}, [
              avatar(person),
              el('div.person-meta', {}, [
                el('strong', { text: person.displayName }),
                el('small', {
                  text: [lifespan(person), person.birthPlace, person.tree.isMine ? 'your tree' : `${person.tree.ownerName}'s tree`]
                    .filter(Boolean).join(' · '),
                }),
              ]),
              person.isSynthetic ? el('span.pill.synthetic', { text: 'DEMO' }) : null,
              el('button.btn.sm.primary', {
                onclick: () => compute({ toPersonId: person.id }, person.displayName),
              }, 'How am I related?'),
            ])
          )),
        ]),
      ]));
    }

    resultArea.replaceChildren(...blocks);
  }

  async function compute(target, label) {
    resultArea.replaceChildren(spinner(`Tracing the relationship to ${label}…`));
    try {
      const result = await api.post('/api/search/relationship', {
        ...target,
        includeUnverified: includeUnverified.checked,
      });
      resultArea.replaceChildren(renderAnswer(result, target, label));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      resultArea.replaceChildren(
        notice('danger', 'Could not work out the relationship', err.message),
        el('div.mt', {}, [el('button.btn', { onclick: runSearch }, 'Back to results')])
      );
    }
  }

  function renderAnswer(result, target, label) {
    const back = el('button.btn', { onclick: runSearch }, [icon('arrow-left', 16), ' Back to results']);

    if (!result.found) {
      return el('div', {}, [
        el('div.answer-hero', {}, [
          el('div', { style: { color: 'var(--text-faint)' } }, [icon('search', 40)]),
          el('div.relation', { style: { color: 'var(--text-muted)' }, text: 'No verified path found' }),
          el('p.sub', { text: result.message }),
        ]),
        el('div.card.mt', {}, [
          el('div.card-body', {}, [
            el('p.small', { text: result.suggestion ?? '' }),
            el('div.btn-row.mt', {}, [
              !includeUnverified.checked
                ? el('button.btn', {
                    onclick: () => { includeUnverified.checked = true; compute(target, label); },
                  }, [icon('refresh', 16), ' Search again including unverified links'])
                : null,
              el('a.btn', { href: '#/matches' }, [icon('sparkles', 16), ' Look for possible matches']),
              back,
            ]),
          ]),
        ]),
        el('div.mt', {}, [
          notice('info', 'Why nothing is invented here',
            'The engine reports a connection only when the stored data supports it. It will never guess a link from similar names or dates.'),
        ]),
      ]);
    }

    if (result.samePerson) {
      return el('div', {}, [notice('info', 'Same record', result.message), el('div.mt', {}, [back])]);
    }

    const rel = result.relationship;
    const primary = result.paths[0];

    return el('div', {}, [
      el('div.answer-hero', {}, [
        el('p.sub', { text: `${result.to.displayName} is your` }),
        el('div.relation', { text: rel.label }),
        el('p.sub', { text: `You are their ${rel.reciprocal}.` }),
        el('div.flex.wrap.center.mt', { style: { justifyContent: 'center', gap: '8px' } }, [
          categoryPill(rel.category),
          el(`span.pill.${rel.verificationStatus === 'VERIFIED' ? 'verified' : 'possible'}`, {}, [
            icon(rel.verificationStatus === 'VERIFIED' ? 'check' : 'alert', 11),
            rel.verificationStatus === 'VERIFIED' ? 'Fully verified path' : 'Provisional path',
          ]),
          el('span.pill.info', { text: `${rel.degreeOfSeparation} step${rel.degreeOfSeparation === 1 ? '' : 's'} apart` }),
        ]),
      ]),

      result.note ? el('div.mt', {}, [notice('warn', 'Not yet confirmed', result.note)]) : null,

      el('div.card.mt', {}, [
        el('div.card-head', {}, [el('h3', { text: 'How the connection runs' })]),
        el('div.card-body', {}, [
          el('div.path-chain', {}, [
            el('div.path-step', {}, [
              avatar(result.from),
              el('div', {}, [el('div', { text: 'You' }), el('div.term', { text: result.from.displayName })]),
            ]),
            ...primary.chain.flatMap((link) => [
              el('span.path-arrow', {}, '→'),
              el(`div.path-step${link.direction === 'spouse' ? '.spouse' : ''}`, {}, [
                el('div', {}, [
                  el('div', { text: link.toName }),
                  el('div.term', { text: link.term }),
                ]),
                link.status !== 'verified' ? statusPill(link.status) : null,
              ]),
            ]),
          ]),
          el('p.small.muted.mt', { text: primary.narrative }),
        ]),
      ]),

      result.explanation
        ? el('div.mt', {}, [notice(rel.isBiological ? 'success' : 'info', 'What this means', result.explanation)])
        : null,

      result.commonAncestors.length
        ? el('div.card.mt', {}, [
            el('div.card-head', {}, [
              el('h3', { text: 'Common ancestor' }),
              el('span.sub', { text: 'Where the two branches meet' }),
            ]),
            el('div.card-body.tight', {}, [
              el('div.stack.sm', {}, result.commonAncestors.map((entry) =>
                el('a.person-row', { href: `#/person/${entry.person.id}` }, [
                  avatar(entry.person, 'lg'),
                  el('div.person-meta', {}, [
                    el('strong', { text: entry.person.displayName }),
                    el('small', {
                      text: `Your ${entry.relationToYou} · ${result.to.displayName}'s ${entry.relationToThem}`,
                    }),
                  ]),
                  el('span.pill.info', {
                    text: `${entry.generationsFromA} / ${entry.generationsFromB} generations`,
                  }),
                  entry.biological ? el('span.pill.biological', { text: 'Blood line' }) : null,
                ])
              )),
            ]),
          ])
        : null,

      result.multiplePathsFound
        ? el('div.card.mt', {}, [
            el('div.card-head', {}, [
              el('h3', { text: `${result.pathCount} distinct paths found` }),
              el('span.sub', { text: 'Families can be connected more than once' }),
            ]),
            el('div.card-body.tight', {}, [
              el('div.stack.sm', {}, result.paths.map((path, index) =>
                el('div', { style: { padding: '8px 4px', borderTop: index ? '1px solid var(--border)' : 'none' } }, [
                  el('div.flex.wrap', {}, [
                    el('strong.small', { text: `Path ${index + 1}: ${path.label}` }),
                    categoryPill(path.category),
                    el('span.pill.weak', { text: `${path.degreeOfSeparation} steps` }),
                  ]),
                  el('div.tiny.muted.mt', { text: path.narrative }),
                ])
              )),
            ]),
          ])
        : null,

      el('div.btn-row.mt', {}, [
        back,
        el('a.btn', { href: `#/tree?focus=${result.to.id}` }, [icon('tree', 16), ' Show them in the tree']),
        el('a.btn', { href: `#/person/${result.to.id}` }, [icon('user', 16), ' Open their profile']),
      ]),
    ]);
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'How am I related?' }),
        el('p.lede', {
          text: 'Search for anyone in your tree, a shared tree, or another registered family. The engine traverses verified relationships and names the exact connection.',
        }),
      ]),
    ]),

    el('div.card.mb', {}, [
      el('div.card-body', {}, [
        el('div.flex.wrap', {}, [
          el('div.grow', { style: { minWidth: '220px' } }, [searchInput]),
          scopeSelect,
          searchButton,
        ]),
        el('label.check.mt', { for: 'incUnverified' }, [
          includeUnverified,
          el('span', {}, [
            el('strong', { text: 'Also follow unverified relationships' }),
            el('small', { text: 'Results will be marked provisional. Off by default, so an unconfirmed link is never presented as fact.' }),
          ]),
        ]),
      ]),
    ]),

    resultArea
  );

  // Deep link: ?to=<personId> jumps straight to the answer.
  if (query.to) {
    const person = await api.get(`/api/persons/${query.to}`).catch(() => null);
    await compute({ toPersonId: query.to }, person?.person?.displayName ?? 'that person');
  } else if (query.q) {
    await runSearch();
  } else {
    resultArea.append(introPanel());
  }

  return page;
}

function introPanel() {
  return el('div.card', {}, [
    el('div.card-body', {}, [
      el('div.grid.cols-2', {}, [
        el('div', {}, [
          el('h3.mb', { text: 'What you will get back' }),
          el('div.stack.sm', {}, [
            bullet('check', 'The precise relationship term', 'Second cousin once removed, great-aunt, brother-in-law, step-father -- not just "related".'),
            bullet('share', 'The full path', 'Every person and every step between you, so you can check the reasoning yourself.'),
            bullet('users', 'The common ancestor', 'Where the two branches meet, and how many generations back it is.'),
            bullet('shield-check', 'Verification status', 'Whether every step on the path has been confirmed by a person.'),
          ]),
        ]),
        el('div', {}, [
          el('h3.mb', { text: 'What it will not do' }),
          el('div.stack.sm', {}, [
            bullet('x', 'Guess from similar names', 'Two people who share a name are not connected. They become a Possible Match for someone to judge.'),
            bullet('x', 'Treat marriage as blood', 'A path through a marriage is reported as a relationship by marriage, never as descent.'),
            bullet('x', 'Use a fingerprint as evidence', 'Biometrics identify an account. They say nothing about ancestry.'),
          ]),
        ]),
      ]),
    ]),
  ]);
}

function bullet(iconName, title, body) {
  return el('div.flex', {}, [
    el('span', { style: { color: iconName === 'x' ? 'var(--rose-500)' : 'var(--accent)', flex: 'none', marginTop: '2px' } }, [icon(iconName, 17)]),
    el('div', {}, [
      el('strong.small', { text: title }),
      el('div.tiny.muted', { text: body }),
    ]),
  ]);
}
