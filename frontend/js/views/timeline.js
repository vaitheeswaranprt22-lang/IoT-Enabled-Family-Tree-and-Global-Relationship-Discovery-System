/** Chronological family timeline: births, marriages, deaths and other events. */
import {
  el, icon, notice, toast, avatar, spinner, emptyState, formatDate, openModal,
} from '../ui.js';
import api from '../api.js';

const TYPE_LABELS = {
  birth: 'Birth', death: 'Death', marriage: 'Marriage', divorce: 'Divorce',
  adoption: 'Adoption', graduation: 'Education', migration: 'Migration',
  military: 'Military service', residence: 'Residence', occupation: 'Work', other: 'Other',
};

export async function timeline({ query }) {
  const page = el('div.view');
  const results = el('div');

  const scopeSelect = el('select', { 'aria-label': 'Whose events' }, [
    el('option', { value: 'mine', text: 'My tree' }),
    el('option', { value: 'shared', text: 'My tree + shared trees' }),
  ]);
  const typeSelect = el('select', { 'aria-label': 'Event type' }, [
    el('option', { value: '', text: 'All event types' }),
    ...Object.entries(TYPE_LABELS).map(([value, label]) => el('option', { value, text: label })),
  ]);
  const fromInput = el('input', { type: 'number', placeholder: 'From year', style: { width: '110px' } });
  const toInput = el('input', { type: 'number', placeholder: 'To year', style: { width: '110px' } });

  for (const control of [scopeSelect, typeSelect]) control.addEventListener('change', load);
  let timer = null;
  for (const control of [fromInput, toInput]) {
    control.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 400); });
  }

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get(`/api/timeline${api.qs({
        scope: scopeSelect.value, type: typeSelect.value,
        from: fromInput.value, to: toInput.value,
      })}`);

      if (!data.events.length) {
        results.replaceChildren(emptyState(
          'calendar', 'No events yet',
          'Births and deaths appear automatically once you record dates on a person. Add marriages and other events for a fuller picture.',
          el('button.btn.primary', { onclick: () => addEvent(load) }, 'Add an event')
        ));
        return;
      }

      // Group by decade so the rail gives a sense of scale.
      const byDecade = new Map();
      for (const event of data.events) {
        const decade = event.year === null ? 'Undated' : `${Math.floor(event.year / 10) * 10}s`;
        if (!byDecade.has(decade)) byDecade.set(decade, []);
        byDecade.get(decade).push(event);
      }

      const blocks = [...byDecade.entries()].map(([decade, events]) =>
        el('div.card.mb', {}, [
          el('div.card-head', {}, [
            el('h3', { text: decade }),
            el('span.sub', { text: `${events.length} event${events.length === 1 ? '' : 's'}` }),
          ]),
          el('div.card-body', {}, [
            el('div.timeline', {}, events.map((event) =>
              el(`div.tl-item.${event.type}`, {}, [
                el('div.tl-year', { text: event.year ? String(event.year) : 'Undated' }),
                el('div.flex.wrap', { style: { gap: '8px', alignItems: 'flex-start' } }, [
                  el('div.grow', {}, [
                    el('div.tl-title', { text: event.title }),
                    el('div.tl-meta', {
                      text: [formatDate(event.date, event.precision), event.place].filter(Boolean).join(' · '),
                    }),
                    event.description ? el('div.small.muted', { text: event.description }) : null,
                  ]),
                  event.person
                    ? el('a.flex', { href: `#/person/${event.person.id}`, style: { gap: '7px', textDecoration: 'none' } }, [
                        avatar(event.person),
                        el('div.tiny.muted.nowrap', { text: event.person.displayName }),
                      ])
                    : null,
                ]),
                el('div.flex.wrap.mt', { style: { gap: '5px' } }, [
                  el('span.pill.weak', { text: TYPE_LABELS[event.type] ?? event.type }),
                  event.source === 'derived' ? el('span.pill.info', { text: 'From the record' }) : null,
                  event.isSynthetic ? el('span.pill.synthetic', { text: 'DEMO' }) : null,
                ]),
              ])
            )),
          ]),
        ])
      );

      results.replaceChildren(
        el('p.small.muted.mb', {
          text: data.range
            ? `${data.total} events between ${data.range.earliest} and ${data.range.latest}.`
            : `${data.total} events.`,
        }),
        ...blocks
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load the timeline', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Family timeline' }),
        el('p.lede', {
          text: 'Births and deaths are read straight from the person records, so the timeline can never drift out of step with the tree.',
        }),
      ]),
      el('div.page-actions', {}, [
        scopeSelect, typeSelect, fromInput, toInput,
        el('button.btn.primary', { onclick: () => addEvent(load) }, [icon('plus', 16), ' Add event']),
      ]),
    ]),
    results
  );

  await load();
  return page;
}

async function addEvent(reload) {
  const people = await api.get('/api/persons?scope=mine&pageSize=500').catch(() => ({ persons: [] }));
  if (!people.persons.length) {
    toast('Add a person first.', 'warn');
    return;
  }

  const personSelect = el('select', {}, people.persons.map((p) =>
    el('option', { value: p.id, text: p.displayName })));
  const typeSelect = el('select', {},
    Object.entries(TYPE_LABELS)
      .filter(([value]) => !['birth', 'death'].includes(value))   // those come from the record
      .map(([value, label]) => el('option', { value, text: label })));
  const titleInput = el('input', { type: 'text', placeholder: 'e.g. Moved to Chennai' });
  const dateInput = el('input', { type: 'date' });
  const placeInput = el('input', { type: 'text', placeholder: 'City, region' });
  const descInput = el('textarea', { placeholder: 'Anything worth remembering (optional)' });

  const ok = await openModal({
    title: 'Add a family event',
    body: el('div.stack', {}, [
      el('div.field', {}, [el('label', { text: 'Who is this about?' }), personSelect]),
      el('div.field', {}, [el('label', { text: 'Type of event' }), typeSelect]),
      el('div.field', {}, [el('label', { text: 'Title' }), titleInput]),
      el('div.form-row', {}, [
        el('div.field', {}, [el('label', { text: 'Date' }), dateInput]),
        el('div.field', {}, [el('label', { text: 'Place' }), placeInput]),
      ]),
      el('div.field', {}, [el('label', { text: 'Description' }), descInput]),
      notice('info', 'Births and deaths are automatic',
        'They are derived from the dates on the person record, so you never have to keep two copies in step.'),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Add event', variant: 'primary', value: true,
        onClick: () => {
          if (!titleInput.value.trim()) { toast('Give the event a title.', 'warn'); return false; }
          return true;
        },
      },
    ],
  });
  if (!ok) return;

  try {
    await api.post('/api/timeline/events', {
      personId: personSelect.value,
      type: typeSelect.value,
      title: titleInput.value.trim(),
      date: dateInput.value || undefined,
      place: placeInput.value.trim() || undefined,
      description: descInput.value.trim() || undefined,
    });
    toast('Event added.', 'success');
    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not add the event');
  }
}
