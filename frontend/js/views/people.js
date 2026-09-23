/** People: list, detail, create and edit. */
import {
  el, icon, notice, toast, avatar, lifespan, statusPill, field, input, select,
  emptyState, confirmDialog, formatDate, relativeTime, spinner, clear,
} from '../ui.js';
import api, { ApiError } from '../api.js';
import state from '../store.js';

const GENDERS = [
  { value: 'unknown', label: 'Not recorded' },
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
];

const VISIBILITY = [
  { value: 'private', label: 'Private — only me' },
  { value: 'family', label: 'Family Only — my approved collaborators' },
  { value: 'public', label: 'Public — any signed-in user' },
];

const PRECISION = [
  { value: 'exact', label: 'Exact date' },
  { value: 'month', label: 'Month and year' },
  { value: 'year', label: 'Year only' },
  { value: 'about', label: 'Approximate' },
  { value: 'unknown', label: 'Unknown' },
];

// ================================================================== list ====

export async function list({ query }) {
  const page = el('div.view');
  const results = el('div');

  const searchBox = el('input', {
    type: 'search', placeholder: 'Search by name…', value: query.q ?? '',
    'aria-label': 'Search people',
  });
  const scopeSelect = select([
    { value: 'mine', label: 'My tree' },
    { value: 'shared', label: 'My tree + shared with me' },
  ], { value: query.scope ?? 'mine' });
  const sortSelect = select([
    { value: 'name', label: 'Sort by name' },
    { value: 'birth', label: 'Sort by birth year' },
    { value: 'created', label: 'Sort by date added' },
  ], { value: 'name' });
  const livingSelect = select([
    { value: '', label: 'Everyone' },
    { value: 'true', label: 'Living only' },
    { value: 'false', label: 'Deceased only' },
  ], { value: '' });

  let timer = null;
  const reload = () => { clearTimeout(timer); timer = setTimeout(load, 220); };
  for (const control of [searchBox, scopeSelect, sortSelect, livingSelect]) {
    control.addEventListener(control === searchBox ? 'input' : 'change', reload);
  }

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get(`/api/persons${api.qs({
        q: searchBox.value.trim(), scope: scopeSelect.value,
        sort: sortSelect.value, living: livingSelect.value, pageSize: 200,
      })}`);

      if (!data.persons.length) {
        results.replaceChildren(emptyState(
          'users',
          searchBox.value ? 'No one matches that search' : 'No people yet',
          searchBox.value
            ? 'Try a shorter search, or check the scope selector above.'
            : 'Start with yourself, your parents and your siblings. The tree grows from there.',
          el('a.btn.primary', { href: '#/people/new' }, 'Add a person')
        ));
        return;
      }

      results.replaceChildren(
        el('p.small.muted.mb', { text: `${data.total} person${data.total === 1 ? '' : 's'}` }),
        el('div.grid.cols-3', {}, data.persons.map(personCard))
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load people', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'People' }),
        el('p.lede', { text: 'Everyone recorded in your family graph. Each person is a node the relationship engine can traverse.' }),
      ]),
      el('div.page-actions', {}, [
        el('a.btn.primary', { href: '#/people/new' }, [icon('plus', 16), ' Add a person']),
      ]),
    ]),
    el('div.card.mb', {}, [
      el('div.card-body', {}, [
        el('div.form-row', {}, [
          el('div.field', { style: { margin: 0 } }, [searchBox]),
          el('div.field', { style: { margin: 0 } }, [scopeSelect]),
          el('div.field', { style: { margin: 0 } }, [livingSelect]),
          el('div.field', { style: { margin: 0 } }, [sortSelect]),
        ]),
      ]),
    ]),
    results
  );

  await load();
  return page;
}

function personCard(person) {
  return el('a.person-row', { href: `#/person/${person.id}` }, [
    avatar(person),
    el('div.person-meta', {}, [
      el('strong.truncate', { text: person.displayName }),
      el('small.truncate', {
        text: [lifespan(person), person.birthPlace].filter(Boolean).join(' · ') || 'No details recorded',
      }),
    ]),
    person.visibility === 'private' ? el('span.pill.weak', {}, [icon('lock', 11), 'Private']) : null,
    person.isSynthetic ? el('span.pill.synthetic', { text: 'DEMO' }) : null,
  ]);
}

// ================================================================ detail ====

export async function detail({ params, navigate }) {
  const data = await api.get(`/api/persons/${params.id}`);
  const person = data.person;

  const page = el('div.view');

  page.append(
    el('div.page-head', {}, [
      avatar(person, 'lg'),
      el('div.grow', {}, [
        el('h1', { text: person.displayName }),
        el('p.lede', {
          text: [lifespan(person), person.birthPlace, person.occupation].filter(Boolean).join(' · ')
            || 'No details recorded yet',
        }),
        el('div.flex.wrap.mt', { style: { gap: '6px' } }, [
          person.isSynthetic ? el('span.pill.synthetic', { text: person.dataLabel ?? 'SYNTHETIC DATA' }) : null,
          el('span.pill.info', { text: visibilityLabel(person.visibility) }),
          person.isLiving === false ? el('span.pill.weak', { text: 'Deceased' }) : null,
        ]),
      ]),
      el('div.page-actions', {}, [
        el('a.btn', { href: `#/tree?focus=${person.id}` }, [icon('tree', 16), ' Show in tree']),
        el('a.btn', { href: `#/search?to=${person.id}` }, [icon('search', 16), ' How am I related?']),
        person.canEdit ? el('a.btn.primary', { href: `#/person/${person.id}/edit` }, [icon('edit', 16), ' Edit']) : null,
      ]),
    ])
  );

  if (person.detailsHidden) {
    page.append(notice('info', 'Some details are hidden', person.detailsHiddenReason));
  }

  const facts = el('dl.kv');
  const addFact = (label, value) => {
    if (!value) return;
    facts.append(el('dt', { text: label }), el('dd', { text: value }));
  };
  addFact('Born', formatDate(person.birthDate, person.birthPrecision) ?? (person.birthYear ? String(person.birthYear) : null));
  addFact('Birthplace', person.birthPlace);
  addFact('Died', formatDate(person.deathDate, person.deathPrecision));
  addFact('Place of death', person.deathPlace);
  addFact('Gender', person.gender === 'unknown' ? null : person.gender);
  addFact('Maiden name', person.maidenName);
  addFact('Occupation', person.occupation);
  addFact('Lives in', person.currentPlace);

  page.append(el('div.grid.cols-2.mt', {}, [
    el('div', {}, [
      el('div.card', {}, [
        el('div.card-head', {}, [el('h3', { text: 'Details' })]),
        el('div.card-body', {}, [
          facts.children.length ? facts : el('p.muted.small', { text: 'No further details recorded.' }),
          person.notes ? el('div.mt', {}, [
            el('div.section-title', { text: 'Notes' }),
            el('p.small', { text: person.notes }),
          ]) : null,
        ]),
      ]),

      data.events.length
        ? el('div.card.mt', {}, [
            el('div.card-head', {}, [el('h3', { text: 'Life events' })]),
            el('div.card-body', {}, [
              el('div.timeline', {}, data.events.map((event) =>
                el(`div.tl-item.${event.type}`, {}, [
                  el('div.tl-year', { text: event.year ? String(event.year) : 'Undated' }),
                  el('div.tl-title', { text: event.title }),
                  el('div.tl-meta', { text: [formatDate(event.date, event.precision), event.place].filter(Boolean).join(' · ') }),
                ])
              )),
            ]),
          ])
        : null,
    ]),

    el('div', {}, [
      familyCard('Parents', data.family.parents, person, 'parent'),
      familyCard('Spouses / partners', data.family.spouses, person, 'spouse'),
      familyCard('Siblings', data.family.siblings, person, 'sibling'),
      familyCard('Children', data.family.children, person, 'child'),
    ]),
  ]));

  if (person.canEdit) {
    page.append(el('div.card.mt', {}, [
      el('div.card-head', {}, [el('h3', { text: 'Manage' })]),
      el('div.card-body', {}, [
        el('div.btn-row', {}, [
          el('a.btn', { href: `#/person/${person.id}/edit` }, [icon('edit', 16), ' Edit details']),
          el('a.btn', { href: `#/relationships?person=${person.id}` }, [icon('link', 16), ' Manage relationships']),
          el('button.btn.danger', {
            onclick: async () => {
              const ok = await confirmDialog(
                `Delete ${person.displayName}?`,
                'This removes the person and every relationship that involves them. It cannot be undone.',
                { confirmLabel: 'Delete permanently', variant: 'danger' }
              );
              if (!ok) return;
              try {
                await api.delete(`/api/persons/${person.id}?force=true`);
                toast(`${person.displayName} was deleted.`, 'success');
                navigate('people');
              } catch (err) {
                toast(err.message, 'error', 'Could not delete');
              }
            },
          }, [icon('trash', 16), ' Delete person']),
        ]),
      ]),
    ]));
  }

  page.append(await historyCard(person.id));
  return page;
}

function visibilityLabel(visibility) {
  return { private: 'Private', family: 'Family Only', public: 'Public' }[visibility] ?? visibility;
}

function familyCard(title, entries, person, addType) {
  return el('div.card.mb', {}, [
    el('div.card-head', {}, [
      el('h3', { text: title }),
      el('span.sub', { text: `${entries.length}` }),
    ]),
    el('div.card-body.tight', {}, [
      entries.length
        ? el('div.rel-list', {}, entries.map((entry) =>
            el('a.rel-item', { href: `#/person/${entry.person.id}` }, [
              avatar(entry.person),
              el('div.grow.truncate', {}, [
                el('div.truncate', { text: entry.person.displayName }),
                el('div.tiny.faint', { text: lifespan(entry.person) ?? '' }),
              ]),
              el('span.term', { text: entry.term }),
              entry.status !== 'verified' ? statusPill(entry.status) : null,
            ])
          ))
        : el('p.muted.small', { style: { padding: '8px 4px' } },
            `No ${title.toLowerCase()} recorded.`),
      person.canEdit
        ? el('div.mt', {}, [
            el('a.btn.sm.ghost', { href: `#/people/new?relateTo=${person.id}&relation=${addType}` }, [
              icon('plus', 15), ` Add ${addType}`,
            ]),
          ])
        : null,
    ]),
  ]);
}

async function historyCard(personId) {
  const card = el('div.card.mt', {}, [
    el('div.card-head', {}, [
      el('h3', { text: 'Change history' }),
      el('span.sub', { text: 'Who changed what, and when' }),
    ]),
  ]);
  const body = el('div.card-body.tight', {}, [spinner()]);
  card.append(body);

  try {
    const data = await api.get(`/api/persons/${personId}/history`);
    body.replaceChildren(
      data.history.length
        ? el('div.table-wrap', {}, [
            el('table', {}, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'Action' }), el('th', { text: 'Field' }),
                el('th', { text: 'From' }), el('th', { text: 'To' }),
                el('th', { text: 'By' }), el('th', { text: 'When' }),
              ])]),
              el('tbody', {}, data.history.map((row) =>
                el('tr', {}, [
                  el('td', {}, [el('strong.small', { text: row.action })]),
                  el('td.small.muted', { text: row.field ?? '—' }),
                  el('td.small', { text: row.oldValue ?? '—' }),
                  el('td.small', { text: row.newValue ?? '—' }),
                  el('td.small', { text: row.actor }),
                  el('td.small.muted.nowrap', { text: relativeTime(row.at) }),
                ])
              )),
            ]),
          ])
        : el('p.muted.small', { style: { padding: '10px' } }, 'No changes recorded yet.')
    );
  } catch (err) {
    body.replaceChildren(notice('warn', 'Could not load the history', err.message));
  }
  return card;
}

// ======================================================= create and edit ====

export async function create({ query, navigate }) {
  let relative = null;
  if (query.relateTo) {
    try {
      const result = await api.get(`/api/persons/${query.relateTo}`);
      relative = result.person;
    } catch { /* fall back to an unlinked person */ }
  }
  return personForm({ mode: 'create', relative, relation: query.relation, navigate });
}

export async function edit({ params, navigate }) {
  const data = await api.get(`/api/persons/${params.id}`);
  if (!data.person.canEdit) {
    return el('div.view', {}, [
      notice('warn', 'You cannot edit this person', 'They belong to a family tree you only have read access to.'),
      el('div.mt', {}, [el('a.btn', { href: `#/person/${params.id}` }, 'Back to the profile')]),
    ]);
  }
  return personForm({ mode: 'edit', person: data.person, navigate });
}

function personForm({ mode, person = null, relative = null, relation = null, navigate }) {
  const isEdit = mode === 'edit';

  const controls = {
    givenName: input({ name: 'givenName', required: true, value: person?.givenName ?? '' }),
    middleName: input({ name: 'middleName', value: person?.middleName ?? '' }),
    familyName: input({ name: 'familyName', value: person?.familyName ?? '' }),
    maidenName: input({ name: 'maidenName', value: person?.maidenName ?? '' }),
    gender: select(GENDERS, { name: 'gender', value: person?.gender ?? 'unknown' }),
    birthDate: input({ name: 'birthDate', type: 'date', value: person?.birthDate ?? '' }),
    birthPrecision: select(PRECISION, { name: 'birthPrecision', value: person?.birthPrecision ?? 'exact' }),
    birthPlace: input({ name: 'birthPlace', value: person?.birthPlace ?? '' }),
    deathDate: input({ name: 'deathDate', type: 'date', value: person?.deathDate ?? '' }),
    deathPlace: input({ name: 'deathPlace', value: person?.deathPlace ?? '' }),
    occupation: input({ name: 'occupation', value: person?.occupation ?? '' }),
    currentPlace: input({ name: 'currentPlace', value: person?.currentPlace ?? '' }),
    notes: el('textarea', { name: 'notes', maxlength: '4000' }, person?.notes ?? ''),
    visibility: select(VISIBILITY, {
      name: 'visibility',
      value: person?.visibility ?? state.privacy?.defaultPersonVisibility ?? 'family',
    }),
  };

  const relationSelect = select([
    { value: 'parent', label: 'is a parent of' },
    { value: 'child', label: 'is a child of' },
    { value: 'spouse', label: 'is the spouse/partner of' },
    { value: 'sibling', label: 'is a sibling of' },
  ], { name: 'relationType', value: relation ?? 'parent' });

  const subtypeSelect = select([
    { value: 'biological', label: 'Biological' },
    { value: 'adoptive', label: 'Adoptive' },
    { value: 'step', label: 'Step' },
    { value: 'foster', label: 'Foster' },
    { value: 'guardian', label: 'Legal guardian' },
  ], { name: 'relationSubtype', value: 'biological' });

  const subtypeField = el('div.field', {}, [
    el('label', { text: 'Nature of the relationship' }),
    subtypeSelect,
    el('div.help', { text: 'Adoptive and step links are labelled as such wherever they appear in a relationship path.' }),
  ]);

  /** The valid subtypes depend on the edge type, so the options are swapped. */
  const SUBTYPES = {
    spouse: [{ value: 'married', label: 'Married' }, { value: 'partner', label: 'Partner' },
             { value: 'divorced', label: 'Divorced' }, { value: 'widowed', label: 'Widowed' }],
    sibling: [{ value: 'full', label: 'Full sibling' }, { value: 'half', label: 'Half sibling' },
              { value: 'step', label: 'Step sibling' }, { value: 'adoptive', label: 'Adoptive sibling' }],
    parent: [{ value: 'biological', label: 'Biological' }, { value: 'adoptive', label: 'Adoptive' },
             { value: 'step', label: 'Step' }, { value: 'foster', label: 'Foster' },
             { value: 'guardian', label: 'Legal guardian' }],
  };

  relationSelect.addEventListener('change', () => {
    const options = SUBTYPES[relationSelect.value] ?? SUBTYPES.parent;
    const replacement = select(options, { name: 'relationSubtype', value: options[0].value });
    subtypeField.querySelector('select').replaceWith(replacement);
  });

  const submit = el('button.btn.primary.lg', { type: 'submit' },
    isEdit ? 'Save changes' : 'Add this person');

  const form = el('form', { novalidate: true }, [
    el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'Who is this person?' })]),
      el('div.card-body', {}, [
        el('div.form-row', {}, [
          field('First name *', controls.givenName),
          field('Middle name', controls.middleName),
          field('Family name', controls.familyName),
        ]),
        el('div.form-row', {}, [
          field('Maiden name', controls.maidenName, 'Helps match records across families.'),
          field('Gender', controls.gender),
        ]),
      ]),
    ]),

    el('div.card.mt', {}, [
      el('div.card-head', {}, [el('h3', { text: 'Dates and places' })]),
      el('div.card-body', {}, [
        el('div.form-row', {}, [
          field('Date of birth', controls.birthDate),
          field('How precise is that?', controls.birthPrecision),
        ]),
        field('Place of birth', controls.birthPlace),
        el('div.form-row', {}, [
          field('Date of death', controls.deathDate, 'Leave blank if they are living.'),
          field('Place of death', controls.deathPlace),
        ]),
        el('div.form-row', {}, [
          field('Occupation', controls.occupation),
          field('Currently lives in', controls.currentPlace),
        ]),
        field('Notes', controls.notes),
      ]),
    ]),

    relative
      ? el('div.card.mt', {}, [
          el('div.card-head', {}, [el('h3', { text: 'How do they connect?' })]),
          el('div.card-body', {}, [
            el('div.flex.wrap.mb', {}, [
              el('strong', { text: 'This new person' }),
              relationSelect,
              el('strong', { text: relative.displayName }),
            ]),
            subtypeField,
            notice('info', 'New relationships start unverified',
              'The link is recorded immediately but is not used in relationship discovery until it has been verified.'),
          ]),
        ])
      : null,

    el('div.card.mt', {}, [
      el('div.card-head', {}, [el('h3', { text: 'Who can see this person?' })]),
      el('div.card-body', {}, [
        field('Visibility', controls.visibility,
          'Enforced when data is read from the database, not just hidden in the interface.'),
      ]),
    ]),

    el('div.btn-row.mt-lg', {}, [
      submit,
      el('a.btn', { href: isEdit ? `#/person/${person.id}` : '#/people' }, 'Cancel'),
    ]),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    form.querySelectorAll('.field .error').forEach((node) => node.remove());
    form.querySelectorAll('[aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));

    const payload = {};
    for (const [key, control] of Object.entries(controls)) {
      const value = control.value?.trim?.() ?? control.value;
      if (value !== '' && value !== undefined) payload[key] = value;
      else if (isEdit) payload[key] = null;
    }
    // Only send a null the server will accept as "clear this field".
    if (!isEdit) for (const key of Object.keys(payload)) if (payload[key] === null) delete payload[key];

    if (relative && !isEdit) {
      payload.relateTo = relative.id;
      payload.relationType = relationSelect.value;
      payload.relationSubtype = form.querySelector('[name="relationSubtype"]').value;
    }

    submit.disabled = true;
    submit.textContent = 'Saving…';
    try {
      if (isEdit) {
        await api.patch(`/api/persons/${person.id}`, payload);
        toast('Saved.', 'success');
        navigate(`person/${person.id}`);
      } else {
        const result = await api.post('/api/persons', payload);
        toast(`${result.person.displayName} was added.`, 'success');
        navigate(`person/${result.person.id}`);
      }
    } catch (err) {
      const fields = err instanceof ApiError ? err.fieldErrors : null;
      if (fields) {
        for (const [name, message] of Object.entries(fields)) {
          const control = form.querySelector(`[name="${name}"]`);
          control?.setAttribute('aria-invalid', 'true');
          control?.closest('.field')?.append(el('div.error', { text: message }));
        }
        form.querySelector('[aria-invalid]')?.focus();
        toast('Some fields need attention.', 'warn');
      } else {
        toast(err.message, 'error', 'Could not save');
      }
    } finally {
      submit.disabled = false;
      submit.textContent = isEdit ? 'Save changes' : 'Add this person';
    }
  });

  return el('div.view', {}, [
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: isEdit ? `Edit ${person.displayName}` : 'Add a person' }),
        el('p.lede', {
          text: relative
            ? `They will be linked to ${relative.displayName} as you save.`
            : 'Only a first name is required. Everything else can be filled in later.',
        }),
      ]),
    ]),
    form,
  ]);
}
