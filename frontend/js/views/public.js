/** Landing page and About page -- the only views reachable while signed out. */
import { el, icon, notice } from '../ui.js';
import state from '../store.js';
import api from '../api.js';

const FEATURES = [
  ['tree', 'An interactive family tree',
    'Every person is a node, every relationship an edge. Zoom, pan, search, and expand a branch at a time so a tree with thousands of people stays responsive.'],
  ['search', '"How am I related to this person?"',
    'The engine walks the verified relationship graph and names the connection precisely -- second cousin once removed, aunt by marriage, step-father -- and shows the whole path.'],
  ['fingerprint', 'Fingerprint sign-in over ESP32',
    'A fingerprint sensor wired to an ESP32 identifies your account and opens your dashboard. It authenticates you; it never claims anything about your ancestry.'],
  ['sparkles', 'Possible matches, never silent merges',
    'When two records look like the same person you get a Possible Match with the evidence laid out. Similar names alone never connect two families.'],
  ['shield-check', 'Human verification at every join',
    'Two family branches connect only after an authorised person reviews and approves it. Every decision is recorded in the change history.'],
  ['lock', 'Privacy enforced in the data layer',
    'Private, Family Only and Public visibility are applied when data is read from the database, not hidden in the interface afterwards.'],
];

const FLOW = [
  ['Fingerprint', 'Sensor reads an enrolled finger'],
  ['ESP32', 'Reads the slot ID, shows status on the LCD'],
  ['Wi-Fi', 'Signed request over the network'],
  ['Backend API', 'Maps the slot to a registered account'],
  ['Session', 'Browser collects the session it started'],
  ['Dashboard', 'That account’s family tree loads'],
];

export async function landing() {
  const info = state.info ?? (await api.get('/api/info').catch(() => null));

  const stats = info?.stats
    ? el('div.grid.cols-4.mt-lg', {}, [
        tile('People recorded', info.stats.people),
        tile('Verified relationships', info.stats.verifiedRelationships),
        tile('Registered trees', info.stats.registeredUsers),
        tile('Scanners online', info.stats.registeredScanners),
      ])
    : null;

  return el('div', {}, [
    el('section.hero', {}, [
      el('span.eyebrow', {}, [icon('sparkles', 14), 'Secure · Verified · Biometric']),
      el('h1', { text: 'Find out how your family connects to everyone else’s' }),
      el('p.lede', {
        text: 'Build your family tree, then discover verified relationship paths to other registered families through common ancestors. Sign in with a fingerprint over ESP32 hardware, and let people -- not guesswork -- confirm every connection.',
      }),
      el('div.btn-row', {}, [
        el('a.btn.primary.lg', { href: '#/register' }, ['Create your family tree', icon('arrow-right', 17)]),
        el('a.btn.lg', { href: '#/login' }, 'Sign in'),
      ]),
      stats,
    ]),

    el('section.view', {}, [
      el('div.grid.cols-3', {}, FEATURES.map(([ico, title, body]) =>
        el('div.feature', {}, [
          el('div.ico', {}, [icon(ico, 20)]),
          el('h3', { text: title }),
          el('p', { text: body }),
        ])
      )),

      el('div.card.mt-lg', {}, [
        el('div.card-head', {}, [
          el('h3', { text: 'How a fingerprint sign-in works' }),
          el('span.sub', { text: 'Hardware to dashboard, end to end' }),
        ]),
        el('div.card-body', {}, [
          el('div.flow', {}, FLOW.map(([title, body], i) =>
            el('div.flow-step', {}, [
              el('div.n', { text: String(i + 1) }),
              el('strong', { text: title }),
              el('small', { text: body }),
            ])
          )),
          el('div.mt', {}, [
            notice('info', 'What a fingerprint does and does not mean',
              'The sensor identifies which registered account is present. It is never treated as evidence of a biological relationship. Family relationships come only from recorded tree data that a person has verified.'),
          ]),
        ]),
      ]),

      el('div.card.mt', {}, [
        el('div.card-head', {}, [el('h3', { text: 'The rules this system will not break' })]),
        el('div.card-body.stack', {},
          (info?.principles ?? [
            'A fingerprint identifies a registered account. It is never treated as evidence of a biological relationship.',
            'Similar names and dates produce a Possible Match, never an automatic connection.',
            'Only human-verified relationships are used as confirmed graph edges.',
            'AI suggests. People decide.',
          ]).map((line) => el('div.flex', {}, [
            el('span', { style: { color: 'var(--accent)', flex: 'none' } }, [icon('check', 17)]),
            el('span', { text: line }),
          ]))
        ),
      ]),

      el('div.center.mt-lg', {}, [
        el('a.btn.primary.lg', { href: '#/register' }, 'Start building your tree'),
        el('p.muted.small.mt', { text: 'Or explore the demonstration accounts from the sign-in page.' }),
      ]),
    ]),
  ]);
}

function tile(label, value) {
  return el('div.stat', {}, [
    el('span.label', { text: label }),
    el('span.value', { text: value === undefined || value === null ? '—' : String(value) }),
  ]);
}

export async function about() {
  return el('div.view', {}, [
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'About this project' }),
        el('p.lede', {
          text: 'A secure, biometric-enabled platform where individual family trees gradually connect through verified common ancestors.',
        }),
      ]),
      el('a.btn', { href: '#/' }, 'Back to home'),
    ]),

    section('The problem it addresses', [
      'Family history is usually recorded in isolation. Two people can independently record the same great-grandparent and never discover that they are related.',
      'Matching people automatically on names and dates is unsafe: names repeat across families and generations, transcriptions vary, and dates are often approximate. A system that merges on similarity produces confident, wrong family trees.',
      'This project takes the opposite position. It surfaces candidates with their evidence and requires a person to approve every connection before two branches are joined.',
    ]),

    section('How relationships are stored', [
      'Relationships are stored as graph edges, not as text labels. Only three edge types are persisted: parent, spouse, and sibling (the last only when the shared parents are unknown).',
      'Everything else -- grandparent, uncle, cousin, in-law -- is computed on demand by traversing those edges. A derived label can therefore never contradict the stored data, and cousin degrees follow the standard genealogical formula rather than a lookup table someone has to maintain.',
      'A path that crosses a marriage is labelled as a relationship by marriage and is never reported as a blood relationship. Adoptive and step links keep their own labels too.',
    ]),

    section('What is stored about a fingerprint', [
      'Nothing biometric. The fingerprint template stays inside the sensor module, which performs the comparison itself and returns only the numeric slot it matched.',
      'The application stores that slot number together with a keyed hash binding it to an account. There is no fingerprint image or template in the database, and none is ever sent over the network.',
    ]),

    section('Demonstration data', [
      'The bundled dataset is entirely invented and every record is flagged as synthetic. It includes two families that share an ancestor recorded twice, a pair of unrelated people who happen to share a name, an adoption, a step-parent, a cross-family marriage, and a tree that connects to nothing.',
      'Those cases exist so the difficult behaviour -- and not just the happy path -- can be demonstrated.',
    ]),

    el('div.card', {}, [
      el('div.card-head', {}, [el('h3', { text: 'Documentation' })]),
      el('div.card-body.stack.sm', {}, [
        docLink('README.md', 'Setup, demo script and troubleshooting'),
        docLink('docs/architecture.md', 'System design and data flow'),
        docLink('docs/api.md', 'Full REST API reference'),
        docLink('docs/hardware-wiring.md', 'Components, pin mapping and firmware'),
        docLink('docs/database.md', 'Schema, constraints and indexes'),
        docLink('docs/setup.md', 'Installation, configuration and deployment'),
      ]),
    ]),
  ]);
}

function section(title, paragraphs) {
  return el('div.card.mb', {}, [
    el('div.card-head', {}, [el('h3', { text: title })]),
    el('div.card-body.stack', {}, paragraphs.map((text) => el('p', { text }))),
  ]);
}

function docLink(path, description) {
  return el('div.flex', {}, [
    icon('book-open', 17),
    el('div', {}, [
      el('strong.small', { text: path }),
      el('div.tiny.muted', { text: description }),
    ]),
  ]);
}
