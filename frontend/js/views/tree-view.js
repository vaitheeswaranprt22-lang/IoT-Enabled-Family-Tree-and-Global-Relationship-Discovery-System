/**
 * Family tree page: the interactive graph plus its detail panel.
 *
 * The client never loads the whole graph. It requests a window of generations
 * around a focus person and pulls in further branches when the user expands a
 * node, so the page stays responsive however large the tree grows.
 */
import {
  el, icon, notice, toast, avatar, lifespan, statusPill, spinner, emptyState, clear,
} from '../ui.js';
import api from '../api.js';
import { createTreeRenderer } from '../tree-render.js';

export async function tree({ query, navigate }) {
  const page = el('div.view.wide');
  const stage = el('div.tree-stage');
  const status = el('span.small.muted');

  let renderer = null;
  let current = {
    focus: query.focus ?? null,
    up: Number(query.up ?? 3),
    down: Number(query.down ?? 3),
    include: query.include ?? 'verified',
  };
  let data = null;
  /** Extra nodes pulled in by expanding a branch, merged with the window. */
  const extraNodes = new Map();
  const extraEdges = new Map();

  // -------------------------------------------------------------- toolbar --

  const genSelect = el('select', { 'aria-label': 'Generations shown' },
    [2, 3, 4, 5, 6, 8].map((n) => el('option', { value: String(n), text: `${n} generations`, selected: n === current.up || undefined }))
  );
  genSelect.value = String(current.up);
  genSelect.addEventListener('change', () => {
    current.up = Number(genSelect.value);
    current.down = Number(genSelect.value);
    load();
  });

  const includeSelect = el('select', { 'aria-label': 'Which relationships to show' }, [
    el('option', { value: 'verified', text: 'Verified only' }),
    el('option', { value: 'unverified', text: 'Include unverified' }),
    el('option', { value: 'all', text: 'Everything, including possible' }),
  ]);
  includeSelect.value = current.include;
  includeSelect.addEventListener('change', () => { current.include = includeSelect.value; load(); });

  const searchInput = el('input', {
    type: 'search', placeholder: 'Find in tree…', 'aria-label': 'Find a person in the tree',
    style: { width: '170px' },
  });
  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim().toLowerCase();
    if (!renderer) return;
    if (!term) return renderer.clearHighlight();
    const matches = allNodes().filter((n) => n.displayName.toLowerCase().includes(term));
    renderer.highlight(matches.map((n) => n.id));
    if (matches.length === 1) renderer.centreOn(matches[0].id);
    status.textContent = `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
  });

  const toolbar = el('div.tree-toolbar', {}, [
    el('div.group', {}, [
      el('button.btn', { title: 'Zoom in', onclick: () => renderer?.zoomIn() }, [icon('zoom-in', 16)]),
      el('button.btn', { title: 'Zoom out', onclick: () => renderer?.zoomOut() }, [icon('zoom-out', 16)]),
      el('button.btn', { title: 'Fit to screen', onclick: () => renderer?.fit() }, [icon('target', 16)]),
    ]),
    el('div.group', {}, [genSelect]),
    el('div.group', {}, [includeSelect]),
    el('div.group', {}, [searchInput]),
    el('div.group', {}, [
      el('button.btn', { title: 'Reload', onclick: () => load() }, [icon('refresh', 16)]),
    ]),
  ]);

  const legend = el('div.tree-legend', {}, [
    el('span', {}, [el('i', { style: { background: 'var(--teal-500)' } }), 'Verified parent link']),
    el('span', {}, [el('i', { style: { background: 'var(--text-faint)', height: '0', borderTop: '2px dashed var(--text-faint)' } }), 'Unverified']),
    el('span', {}, [el('i', { style: { background: 'var(--violet-500)' } }), 'Marriage']),
    el('span', {}, ['Click a card for details · drag to pan · scroll to zoom']),
  ]);

  stage.append(toolbar, legend);

  // ------------------------------------------------------------- helpers --

  const allNodes = () => [...(data?.nodes ?? []), ...extraNodes.values()];
  const allEdges = () => [...(data?.edges ?? []), ...extraEdges.values()];

  function paint() {
    const nodes = [];
    const seen = new Set();
    for (const node of allNodes()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
    renderer.setData({ nodes, edges: allEdges(), focusId: data?.focus?.id });
  }

  async function load() {
    status.textContent = 'Loading…';
    extraNodes.clear();
    extraEdges.clear();
    try {
      data = await api.get(`/api/tree${api.qs({
        focus: current.focus, up: current.up, down: current.down, include: current.include,
      })}`);
      current.focus = data.focus.id;

      if (!data.nodes.length) {
        clear(stage);
        stage.append(emptyState('tree', 'Your tree is empty',
          'Add your parents or a sibling and the tree will start to take shape.',
          el('a.btn.primary', { href: '#/people/new' }, 'Add the first person')));
        return;
      }

      if (!renderer) {
        renderer = createTreeRenderer(stage, {
          onSelect: openDetail,
          onExpand: expandBranch,
          onBackgroundClick: closeDetail,
        });
      }
      paint();
      renderer.fit();
      status.textContent = `${data.counts.nodes} people · ${data.counts.edges} links${data.truncated ? ' · view truncated' : ''}`;
      headline.textContent = data.focus.displayName;
    } catch (err) {
      clear(stage);
      stage.append(el('div.view', {}, [notice('danger', 'Could not load the tree', err.message)]));
    }
  }

  async function expandBranch(personId, direction) {
    try {
      const result = await api.get(`/api/tree/neighbors/${personId}${api.qs({ include: current.include })}`);
      const group = direction === 'up' ? result.parents : result.children;
      let added = 0;
      for (const person of [...group, ...result.spouses]) {
        if (allNodes().some((n) => n.id === person.id)) continue;
        const base = allNodes().find((n) => n.id === personId);
        const generation = (base?.generation ?? 0) + (direction === 'up' ? 1 : -1);
        extraNodes.set(person.id, { ...person, generation: person.role === 'spouse' ? (base?.generation ?? 0) : generation });
        const key = direction === 'up' ? `${person.id}|${personId}` : `${personId}|${person.id}`;
        extraEdges.set(key, {
          from: direction === 'up' ? person.id : personId,
          to: direction === 'up' ? personId : person.id,
          type: person.edge.type,
          subtype: person.edge.subtype,
          status: person.edge.status,
        });
        added += 1;
      }
      if (!added) {
        toast('Nothing further to load on that branch.', 'info');
        return;
      }
      paint();
      toast(`Loaded ${added} more ${direction === 'up' ? 'ancestor' : 'descendant'}(s).`, 'success');
      status.textContent = `${allNodes().length} people loaded`;
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // -------------------------------------------------------- detail panel --

  let panel = null;
  function closeDetail() { panel?.remove(); panel = null; }

  async function openDetail(personId) {
    closeDetail();
    panel = el('div.detail-panel');
    panel.append(el('div.panel-body', {}, [spinner('Loading…')]));
    stage.append(panel);

    try {
      const result = await api.get(`/api/persons/${personId}`);
      const person = result.person;
      clear(panel);

      panel.append(
        el('div.panel-head', {}, [
          avatar(person, 'lg'),
          el('div.grow', {}, [
            el('h3', { text: person.displayName }),
            el('div.small.muted', { text: lifespan(person) ?? 'No dates recorded' }),
          ]),
          el('button.icon-btn', { 'aria-label': 'Close', onclick: closeDetail }, [icon('x', 17)]),
        ])
      );

      const body = el('div.panel-body.stack');

      if (person.restricted) {
        body.append(notice('warn', 'Private record',
          'This person belongs to another family tree and is not shared with you.'));
      } else {
        const facts = el('dl.kv');
        const add = (label, value) => {
          if (!value) return;
          facts.append(el('dt', { text: label }), el('dd', { text: value }));
        };
        add('Born', person.birthDate ? new Date(`${person.birthDate}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : person.birthYear ? String(person.birthYear) : null);
        add('Birthplace', person.birthPlace);
        add('Died', person.deathDate);
        add('Gender', person.gender === 'unknown' ? null : person.gender);
        add('Occupation', person.occupation);
        add('Lives in', person.currentPlace);
        if (facts.children.length) body.append(facts);

        if (person.detailsHidden) {
          body.append(notice('info', 'Some details are hidden', person.detailsHiddenReason));
        }
        if (person.notes) {
          body.append(el('div', {}, [el('div.section-title', { text: 'Notes' }), el('p.small', { text: person.notes })]));
        }

        const groups = [
          ['Parents', result.family.parents], ['Spouses', result.family.spouses],
          ['Siblings', result.family.siblings], ['Children', result.family.children],
        ].filter(([, list]) => list.length);

        for (const [title, list] of groups) {
          body.append(el('div', {}, [
            el('div.section-title', { text: title }),
            el('div.rel-list', {}, list.map((entry) =>
              el('div.rel-item', { onclick: () => openDetail(entry.person.id) }, [
                avatar(entry.person),
                el('div.grow.truncate', {}, [
                  el('div.truncate', { text: entry.person.displayName }),
                  el('div.tiny.faint', { text: lifespan(entry.person) ?? '' }),
                ]),
                el('span.term', { text: entry.term }),
                entry.status !== 'verified' ? statusPill(entry.status) : null,
              ])
            )),
          ]));
        }

        if (result.events?.length) {
          body.append(el('div', {}, [
            el('div.section-title', { text: 'Events' }),
            el('div.stack.sm', {}, result.events.slice(0, 6).map((event) =>
              el('div.small', {}, [
                el('strong', { text: event.title }),
                el('div.tiny.faint', { text: [event.date, event.place].filter(Boolean).join(' · ') }),
              ])
            )),
          ]));
        }
      }

      body.append(el('div.btn-row.mt', {}, [
        el('button.btn.sm', {
          onclick: () => { current.focus = person.id; extraNodes.clear(); extraEdges.clear(); load(); closeDetail(); },
        }, [icon('target', 15), ' Centre here']),
        el('a.btn.sm', { href: `#/person/${person.id}` }, [icon('user', 15), ' Full profile']),
        el('a.btn.sm', { href: `#/search?to=${person.id}` }, [icon('search', 15), ' How am I related?']),
      ]));

      panel.append(body);
    } catch (err) {
      clear(panel);
      panel.append(el('div.panel-body', {}, [
        notice('danger', 'Could not load this person', err.message),
        el('button.btn.mt', { onclick: closeDetail }, 'Close'),
      ]));
    }
  }

  // ----------------------------------------------------------------- page --

  const headline = el('h1', { text: 'Family tree' });

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        headline,
        el('div.flex.wrap.small.muted', { style: { marginTop: '4px' } }, [
          status,
          el('span', {}, '·'),
          el('span', { text: 'Solid lines are verified; dashed lines are not yet confirmed.' }),
        ]),
      ]),
      el('div.page-actions', {}, [
        el('a.btn', { href: '#/people/new' }, [icon('plus', 16), ' Add person']),
        el('a.btn', { href: '#/export' }, [icon('download', 16), ' Export']),
      ]),
    ]),
    stage
  );

  await load();
  return page;
}
