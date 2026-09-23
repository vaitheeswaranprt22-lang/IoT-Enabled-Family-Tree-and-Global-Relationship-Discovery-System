/** Privacy settings, profile and password, and export / backup. */
import {
  el, icon, notice, toast, spinner, field, input, select, openModal, confirmDialog,
  relativeTime, formatDateTime,
} from '../ui.js';
import api, { ApiError } from '../api.js';
import state, { loadSession, signOut } from '../store.js';
import { exportPng, exportPdf, downloadText } from '../export-pdf.js';

// ============================================================== privacy =====

export async function privacy() {
  const page = el('div.view');
  const body = el('div', {}, [spinner()]);

  async function load() {
    const data = await api.get('/api/privacy');
    const s = data.settings;

    const visibilitySelect = select(
      data.visibilityOptions.map((o) => ({ value: o.value, label: `${o.label} — ${o.description}` })),
      { name: 'defaultPersonVisibility', value: s.defaultPersonVisibility }
    );
    const profileSelect = select(
      data.visibilityOptions.map((o) => ({ value: o.value, label: o.label })),
      { name: 'profileVisibility', value: s.profileVisibility }
    );

    const toggles = [
      ['hideLivingDetails', 'Hide detailed information about living people', data.explanations.hideLivingDetails, s.hideLivingDetails],
      ['allowMatchDiscovery', 'Let other trees consider my people for matches', data.explanations.allowMatchDiscovery, s.allowMatchDiscovery],
      ['allowRelationshipSearch', 'Let others search for a relationship to my people', data.explanations.allowRelationshipSearch, s.allowRelationshipSearch],
      ['allowAiSuggestions', 'Allow AI-assisted suggestions on my records', data.explanations.allowAiSuggestions, s.allowAiSuggestions],
      ['showInDirectory', 'List my tree in the directory of registered families', data.explanations.showInDirectory, s.showInDirectory],
    ];

    const checkboxes = new Map();
    const toggleNodes = toggles.map(([key, label, help, checked]) => {
      const box = el('input', { type: 'checkbox', checked: checked || undefined });
      box.checked = checked;
      checkboxes.set(key, box);
      return el('label.check', {}, [box, el('span', {}, [el('strong', { text: label }), el('small', { text: help })])]);
    });

    const saveButton = el('button.btn.primary', {}, 'Save privacy settings');
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      try {
        await api.put('/api/privacy', {
          defaultPersonVisibility: visibilitySelect.value,
          profileVisibility: profileSelect.value,
          ...Object.fromEntries([...checkboxes].map(([key, box]) => [key, box.checked])),
        });
        toast('Privacy settings saved.', 'success');
        await loadSession();
      } catch (err) {
        toast(err.message, 'error', 'Could not save');
      } finally {
        saveButton.disabled = false;
      }
    });

    const impact = data.impact.personsByVisibility ?? {};

    body.replaceChildren(
      notice('info', 'These settings are enforced in the data layer',
        'Turning something off removes the data from API responses. It is not merely hidden in the interface, so it cannot be recovered by calling the API directly.'),

      el('div.card.mt', {}, [
        el('div.card-head', {}, [el('h3', { text: 'Visibility defaults' })]),
        el('div.card-body', {}, [
          field('Default visibility for new people', visibilitySelect, data.explanations.defaultPersonVisibility),
          field('My profile', profileSelect, data.explanations.profileVisibility),
        ]),
      ]),

      el('div.card.mt', {}, [
        el('div.card-head', {}, [el('h3', { text: 'Discovery and protection' })]),
        el('div.card-body', {}, toggleNodes),
      ]),

      el('div.card.mt', {}, [
        el('div.card-head', {}, [
          el('h3', { text: 'How your settings apply right now' }),
        ]),
        el('div.card-body', {}, [
          el('div.grid.cols-3', {}, [
            miniStat('Private people', impact.private ?? 0),
            miniStat('Family Only', impact.family ?? 0),
            miniStat('Public', impact.public ?? 0),
          ]),
          el('p.small.muted.mt', {
            text: data.impact.livingPeopleProtected
              ? `${data.impact.livingPeopleProtected} of your ${data.impact.totalLiving} living relatives have their detailed information hidden from anyone who cannot edit your tree.`
              : `Detailed information about your ${data.impact.totalLiving} living relatives is visible to everyone who can see them.`,
          }),
        ]),
      ]),

      el('div.card.mt', {}, [
        el('div.card-head', {}, [el('h3', { text: 'Apply a visibility to everyone at once' })]),
        el('div.card-body', {}, [
          el('p.small.muted.mb', { text: 'Useful after importing a tree, or to lock everything down quickly.' }),
          el('div.btn-row', {}, [
            bulkButton('private', 'Make everyone Private'),
            bulkButton('family', 'Make everyone Family Only'),
            bulkButton('public', 'Make everyone Public'),
            bulkButton('private', 'Make living people Private', true),
          ]),
        ]),
      ]),

      el('div.btn-row.mt-lg', {}, [saveButton]),
    );

    function bulkButton(visibility, label, onlyLiving = false) {
      return el('button.btn', {
        onclick: async (event) => {
          const ok = await confirmDialog(label,
            `This changes the visibility of ${onlyLiving ? 'every living person' : 'every person'} in your tree. You can change individuals afterwards.`,
            { confirmLabel: 'Apply to all', variant: visibility === 'public' ? 'danger' : 'primary' });
          if (!ok) return;
          event.currentTarget.disabled = true;
          try {
            const result = await api.post('/api/privacy/apply-to-all', { visibility, onlyLiving });
            toast(`${result.updated} person record(s) updated.`, 'success');
            load();
          } catch (err) {
            toast(err.message, 'error');
            event.currentTarget.disabled = false;
          }
        },
      }, label);
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Privacy' }),
        el('p.lede', { text: 'You decide who can see your family information, and whether other families may discover a connection to you.' }),
      ]),
    ]),
    body
  );

  await load();
  return page;
}

function miniStat(label, value) {
  return el('div.stat', {}, [el('span.label', { text: label }), el('span.value', { text: String(value) })]);
}

// ============================================================== profile =====

export async function profile() {
  const me = await api.get('/api/auth/me');
  const sessions = await api.get('/api/auth/sessions').catch(() => ({ sessions: [] }));

  const nameInput = input({ name: 'displayName', value: me.user.displayName });
  const emailInput = input({ name: 'email', type: 'email', value: me.user.email });
  const saveProfile = el('button.btn.primary', {}, 'Save profile');

  saveProfile.addEventListener('click', async () => {
    saveProfile.disabled = true;
    try {
      await api.patch('/api/auth/profile', {
        displayName: nameInput.value.trim(),
        email: emailInput.value.trim(),
      });
      toast('Profile updated.', 'success');
      await loadSession();
    } catch (err) {
      toast(err.message, 'error', 'Could not save');
    } finally {
      saveProfile.disabled = false;
    }
  });

  const currentPassword = input({ type: 'password', autocomplete: 'current-password' });
  const newPassword = input({ type: 'password', autocomplete: 'new-password' });
  const confirmPassword = input({ type: 'password', autocomplete: 'new-password' });
  const changePassword = el('button.btn.primary', {}, 'Change password');

  changePassword.addEventListener('click', async () => {
    if (newPassword.value !== confirmPassword.value) {
      toast('The two new passwords do not match.', 'warn');
      return;
    }
    changePassword.disabled = true;
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      });
      toast('Password changed. Every other device has been signed out.', 'success');
      currentPassword.value = newPassword.value = confirmPassword.value = '';
    } catch (err) {
      const fields = err instanceof ApiError ? err.fieldErrors : null;
      toast(fields ? Object.values(fields).join(' ') : err.message, 'error', 'Could not change the password');
    } finally {
      changePassword.disabled = false;
    }
  });

  return el('div.view', {}, [
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Profile and security' }),
        el('p.lede', { text: 'Your login account, separate from the person record that represents you in the family graph.' }),
      ]),
    ]),

    el('div.grid.cols-2', {}, [
      el('div', {}, [
        el('div.card', {}, [
          el('div.card-head', {}, [el('h3', { text: 'Account' })]),
          el('div.card-body', {}, [
            field('Display name', nameInput),
            field('Email address', emailInput, 'Used to sign in and to receive reset links.'),
            el('div.btn-row.mt', {}, [saveProfile]),
          ]),
        ]),

        me.person
          ? el('div.card.mt', {}, [
              el('div.card-head', {}, [el('h3', { text: 'Your person record' })]),
              el('div.card-body', {}, [
                el('p.small.muted.mb', {
                  text: 'This is the node other family trees can connect to. Editing it does not affect your login.',
                }),
                el('a.btn', { href: `#/person/${me.person.id}` }, [icon('user', 16), ` Open ${me.person.displayName}`]),
              ]),
            ])
          : null,
      ]),

      el('div', {}, [
        el('div.card', {}, [
          el('div.card-head', {}, [el('h3', { text: 'Change password' })]),
          el('div.card-body', {}, [
            field('Current password', currentPassword),
            field('New password', newPassword, 'At least 10 characters, with a number or symbol.'),
            field('Confirm new password', confirmPassword),
            notice('warn', 'Other devices will be signed out',
              'Changing your password ends every other session, including any biometric ones.'),
            el('div.btn-row.mt', {}, [changePassword]),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'Active sessions' }),
            el('span.sub', { text: `${sessions.sessions.length}` }),
          ]),
          el('div.card-body.tight', {}, [
            el('div.stack.sm', {}, sessions.sessions.map((session) =>
              el('div.flex', { style: { padding: '7px 8px' } }, [
                icon(session.authMethod === 'biometric' ? 'fingerprint' : 'lock', 17),
                el('div.grow', {}, [
                  el('div.small', {}, [
                    el('strong', { text: session.authMethod === 'biometric' ? 'Fingerprint session' : 'Password session' }),
                    session.current ? el('span.pill.verified', { text: 'this device', style: { marginLeft: '6px' } }) : null,
                  ]),
                  el('div.tiny.faint', {
                    text: `${session.ip ?? 'unknown IP'}${session.device ? ` · ${session.device}` : ''} · active ${relativeTime(session.lastSeenAt)}`,
                  }),
                ]),
                !session.current
                  ? el('button.btn.sm.ghost', {
                      onclick: async (event) => {
                        event.currentTarget.disabled = true;
                        try {
                          await api.delete(`/api/auth/sessions/${session.id}`);
                          toast('Session ended.', 'success');
                          location.reload();
                        } catch (err) { toast(err.message, 'error'); }
                      },
                    }, 'End')
                  : null,
              ])
            )),
            el('div.mt', {}, [
              el('button.btn.sm.danger', {
                onclick: async () => {
                  const ok = await confirmDialog('Sign out everywhere?',
                    'Every device, including this one, will be signed out.',
                    { confirmLabel: 'Sign out everywhere', variant: 'danger' });
                  if (!ok) return;
                  await api.post('/api/auth/logout-all').catch(() => {});
                  await signOut();
                  location.hash = '#/login';
                },
              }, 'Sign out everywhere'),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

// =============================================================== export =====

export async function exportData() {
  const page = el('div.view');
  const status = el('div');

  const focusSelect = el('select', { 'aria-label': 'Person to centre the export on' });
  const upSelect = select([2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} generations of ancestors` })), { value: '3' });
  const downSelect = select([1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} generations of descendants` })), { value: '2' });

  const people = await api.get('/api/persons?scope=mine&pageSize=500').catch(() => ({ persons: [] }));
  for (const person of people.persons) {
    focusSelect.append(el('option', { value: person.id, text: person.displayName }));
  }
  if (state.selfPerson) focusSelect.value = state.selfPerson.id;

  const svgUrl = () => `/api/export/tree.svg${api.qs({
    focus: focusSelect.value, up: upSelect.value, down: downSelect.value,
  })}`;

  async function fetchSvg() {
    const response = await fetch(svgUrl(), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('The tree image could not be generated.');
    return response.text();
  }

  const withStatus = async (label, fn) => {
    status.replaceChildren(el('div.flex', {}, [el('div.spinner'), el('span', { text: label })]));
    try {
      await fn();
      status.replaceChildren(notice('success', 'Done', 'Your download should have started.'));
    } catch (err) {
      status.replaceChildren(notice('danger', 'Export failed', err.message));
    }
  };

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Export and backup' }),
        el('p.lede', {
          text: 'Take your family data with you. Every export honours the privacy settings of whoever owns the records.',
        }),
      ]),
    ]),

    notice('info', 'What an export contains',
      'Only the records the exporting account is permitted to see. Fields hidden by an owner’s privacy settings are left out of the file, not merely hidden afterwards.'),

    el('div.card.mt', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'Visual tree' }),
        el('span.sub', { text: 'Image or printable document' }),
      ]),
      el('div.card-body', {}, [
        el('div.form-row', {}, [
          field('Centre on', focusSelect),
          field('Ancestors', upSelect),
          field('Descendants', downSelect),
        ]),
        el('div.btn-row.mt', {}, [
          el('button.btn.primary', {
            onclick: () => withStatus('Building the PDF…', async () => {
              const svg = await fetchSvg();
              const name = focusSelect.selectedOptions[0]?.textContent ?? 'Family tree';
              await exportPdf(svg, {
                filename: `family-tree-${slug(name)}.pdf`,
                title: `Family tree of ${name}`,
                subtitle: `Exported ${new Date().toLocaleDateString()} · Global Family Tree & Ancestry Mapping System`,
              });
            }),
          }, [icon('file', 16), ' Download PDF']),

          el('button.btn', {
            onclick: () => withStatus('Rendering the image…', async () => {
              const svg = await fetchSvg();
              await exportPng(svg, `family-tree-${slug(focusSelect.selectedOptions[0]?.textContent ?? 'tree')}.png`);
            }),
          }, [icon('image', 16), ' Download PNG']),

          el('button.btn', {
            onclick: () => withStatus('Fetching the vector file…', async () => {
              const svg = await fetchSvg();
              downloadText(svg, 'family-tree.svg', 'image/svg+xml;charset=utf-8');
            }),
          }, [icon('download', 16), ' Download SVG']),

          el('a.btn.ghost', { href: svgUrl(), target: '_blank', rel: 'noopener' }, 'Preview'),
        ]),
        status,
      ]),
    ]),

    el('div.card.mt', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'Data export' }),
        el('span.sub', { text: 'Machine-readable' }),
      ]),
      el('div.card-body', {}, [
        el('div.grid.cols-2', {}, [
          exportOption('JSON', 'A complete structured snapshot of the people, relationships and events you can see.',
            '/api/export/tree.json'),
          exportOption('GEDCOM 5.5.1', 'The genealogy interchange standard, readable by other family-history software.',
            '/api/export/tree.ged'),
        ]),
      ]),
    ]),

    el('div.card.mt', {}, [
      el('div.card-head', {}, [
        el('h3', { text: 'Backup and restore' }),
        el('span.sub', { text: 'Your own tree, in full' }),
      ]),
      el('div.card-body', {}, [
        el('p.small.muted.mb', {
          text: 'A backup contains your complete tree, including notes and visibility settings. Keep it somewhere safe -- it holds personal information about your family.',
        }),
        el('div.btn-row', {}, [
          el('a.btn.primary', { href: '/api/export/backup', download: '' }, [icon('download', 16), ' Download a backup']),
          el('button.btn', { onclick: () => restoreDialog() }, [icon('upload', 16), ' Restore from a backup']),
        ]),
        el('div.mt', {}, [
          notice('warn', 'Restored relationships come back unverified',
            'An import is a claim about the data, not a verification of it. You can choose to keep the original statuses, but the safe default is to re-verify.'),
        ]),
      ]),
    ])
  );

  return page;
}

function exportOption(title, description, href) {
  return el('div', {
    style: { padding: '14px', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' },
  }, [
    el('strong', { text: title }),
    el('p.small.muted', { text: description, style: { margin: '5px 0 11px' } }),
    el('a.btn.sm', { href, download: '' }, [icon('download', 15), ' Download']),
  ]);
}

const slug = (value) => String(value).toLowerCase().replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'tree';

async function restoreDialog() {
  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
  const modeSelect = select([
    { value: 'merge', label: 'Merge — add the backup alongside what is already there' },
    { value: 'replace', label: 'Replace — delete my current tree first' },
  ], { value: 'merge' });
  const keepStatus = el('input', { type: 'checkbox' });

  const ok = await openModal({
    title: 'Restore from a backup',
    body: el('div.stack', {}, [
      field('Backup file', fileInput, 'A .json file downloaded from this application.'),
      field('How should it be applied?', modeSelect),
      el('label.check', {}, [
        keepStatus,
        el('span', {}, [
          el('strong', { text: 'Keep the original verification statuses' }),
          el('small', { text: 'Leave this off unless you are restoring your own data after a mishap. Otherwise everything comes back unverified so it can be checked again.' }),
        ]),
      ]),
      notice('warn', 'Replace mode deletes data',
        'Choosing Replace removes every person in your tree except your own record before importing.'),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Restore', variant: 'primary', value: true,
        onClick: () => {
          if (!fileInput.files?.length) { toast('Choose a backup file first.', 'warn'); return false; }
          return true;
        },
      },
    ],
  });
  if (!ok) return;

  try {
    const text = await fileInput.files[0].text();
    const backup = JSON.parse(text);
    const result = await api.post('/api/export/restore', {
      backup,
      mode: modeSelect.value,
      keepStatus: keepStatus.checked,
      confirm: true,
    });
    toast(
      `Restored ${result.created} person(s) and ${result.links} relationship(s).${result.skipped ? ` ${result.skipped} skipped.` : ''}`,
      'success', 'Restore complete'
    );
    setTimeout(() => { location.hash = '#/people'; }, 900);
  } catch (err) {
    toast(err.message, 'error', 'Restore failed');
  }
}
