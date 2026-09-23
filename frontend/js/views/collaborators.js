/** Family collaboration: who may read, contribute to and verify your tree. */
import {
  el, icon, notice, toast, avatar, spinner, emptyState, statusPill, relativeTime,
  openModal, confirmDialog,
} from '../ui.js';
import api from '../api.js';

const ROLE_HELP = {
  viewer: 'Can see the tree, subject to each person’s visibility setting.',
  suggester: 'Can propose new people and relationships. Everything they add starts as unverified.',
  editor: 'Can add and edit people and relationships.',
  verifier: 'Everything an editor can do, plus approving or rejecting verification requests.',
};

export async function list() {
  const page = el('div.view');
  const results = el('div');

  async function load() {
    results.replaceChildren(spinner());
    try {
      const data = await api.get('/api/collaborators');

      const pending = data.received.filter((row) => row.status === 'pending');
      const activeReceived = data.received.filter((row) => row.status !== 'pending');

      results.replaceChildren(
        pending.length
          ? el('div.card.mb', {}, [
              el('div.card-head', {}, [
                el('h3', { text: 'Invitations waiting for you' }),
                el('span.pill.possible', { text: String(pending.length) }),
              ]),
              el('div.card-body.tight', {}, [
                el('div.stack.sm', {}, pending.map((row) => invitationRow(row, load))),
              ]),
            ])
          : null,

        el('div.card.mb', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'People with access to my tree' }),
            el('button.btn.sm.primary', { onclick: () => invite(load) }, [icon('plus', 15), ' Invite']),
          ]),
          el('div.card-body.tight', {}, [
            data.granted.length
              ? el('div.stack.sm', {}, data.granted.map((row) => grantedRow(row, load)))
              : el('p.muted.small', { style: { padding: '10px' } },
                  'Nobody else can see your tree. Invite a relative so they can contribute what they know.'),
          ]),
        ]),

        el('div.card', {}, [
          el('div.card-head', {}, [el('h3', { text: 'Trees I can access' })]),
          el('div.card-body.tight', {}, [
            activeReceived.length
              ? el('div.stack.sm', {}, activeReceived.map((row) => receivedRow(row, load)))
              : el('p.muted.small', { style: { padding: '10px' } },
                  'No one has shared a tree with you yet.'),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [el('h3', { text: 'What each role can do' })]),
          el('div.card-body', {}, [
            el('div.table-wrap', {}, [
              el('table', {}, [
                el('thead', {}, [el('tr', {}, [
                  el('th', { text: 'Role' }), el('th', { text: 'View' }), el('th', { text: 'Suggest' }),
                  el('th', { text: 'Edit' }), el('th', { text: 'Verify' }),
                ])]),
                el('tbody', {}, [
                  roleRow('viewer', [true, false, false, false]),
                  roleRow('suggester', [true, true, false, false]),
                  roleRow('editor', [true, true, true, false]),
                  roleRow('verifier', [true, true, true, true]),
                ]),
              ]),
            ]),
            el('p.tiny.muted.mt', {
              text: 'Roles are checked on the server for every request, not only in the interface. A viewer cannot change anything even by calling the API directly.',
            }),
          ]),
        ])
      );
    } catch (err) {
      results.replaceChildren(notice('danger', 'Could not load collaboration settings', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Collaboration' }),
        el('p.lede', {
          text: 'Family history is easier to get right with more than one person working on it. Give relatives exactly as much access as they need.',
        }),
      ]),
    ]),
    results
  );

  await load();
  return page;
}

function roleRow(role, permissions) {
  const mark = (on) => el('td', {}, [
    el('span', { style: { color: on ? 'var(--green-500)' : 'var(--text-faint)' } }, [icon(on ? 'check' : 'x', 15)]),
  ]);
  return el('tr', {}, [
    el('td', {}, [el('strong.small', { text: role }), el('div.tiny.muted', { text: ROLE_HELP[role] })]),
    ...permissions.map(mark),
  ]);
}

function grantedRow(row, reload) {
  const roleSelect = el('select', { style: { width: 'auto' } },
    Object.keys(ROLE_HELP).map((role) =>
      el('option', { value: role, text: role, selected: row.role === role || undefined })));
  roleSelect.value = row.role;

  roleSelect.addEventListener('change', async () => {
    try {
      await api.patch(`/api/collaborators/${row.id}`, { role: roleSelect.value });
      toast(`${row.user.name} is now a ${roleSelect.value}.`, 'success');
      reload();
    } catch (err) {
      toast(err.message, 'error');
      roleSelect.value = row.role;
    }
  });

  return el('div.person-row', {}, [
    avatar({ displayName: row.user?.name }),
    el('div.person-meta', {}, [
      el('strong', { text: row.user?.name ?? 'Unknown' }),
      el('small', { text: `${ROLE_HELP[row.role]} · invited ${relativeTime(row.createdAt)}` }),
    ]),
    statusPill(row.status),
    row.status === 'active' ? roleSelect : null,
    el('button.btn.sm.ghost', {
      title: 'Remove access',
      onclick: async () => {
        const ok = await confirmDialog('Remove access?',
          `${row.user?.name} will no longer be able to see your family tree.`,
          { confirmLabel: 'Remove access', variant: 'danger' });
        if (!ok) return;
        try {
          await api.delete(`/api/collaborators/${row.id}`);
          toast('Access removed.', 'success');
          reload();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, [icon('trash', 14)]),
  ]);
}

function receivedRow(row, reload) {
  return el('div.person-row', {}, [
    avatar({ displayName: row.user?.name }),
    el('div.person-meta', {}, [
      el('strong', { text: `${row.user?.name}'s family tree` }),
      el('small', { text: `Your role: ${row.role} · ${ROLE_HELP[row.role]}` }),
    ]),
    statusPill(row.status),
    row.status === 'active'
      ? el('button.btn.sm.ghost', {
          onclick: async () => {
            const ok = await confirmDialog('Leave this family tree?',
              `You will lose access to ${row.user?.name}'s tree.`, { confirmLabel: 'Leave', variant: 'danger' });
            if (!ok) return;
            try {
              await api.delete(`/api/collaborators/${row.id}`);
              toast('You have left that tree.', 'info');
              reload();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Leave')
      : null,
  ]);
}

function invitationRow(row, reload) {
  return el('div.person-row', {}, [
    avatar({ displayName: row.user?.name }),
    el('div.person-meta', {}, [
      el('strong', { text: `${row.user?.name} invited you` }),
      el('small', { text: row.message || ROLE_HELP[row.role] }),
    ]),
    el('span.pill.info', { text: `as ${row.role}` }),
    el('button.btn.sm.primary', {
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api.post(`/api/collaborators/${row.id}/accept`);
          toast(`You now have ${row.role} access to ${row.user?.name}'s tree.`, 'success');
          reload();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Accept'),
    el('button.btn.sm', {
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api.post(`/api/collaborators/${row.id}/decline`);
          toast('Invitation declined.', 'info');
          reload();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, 'Decline'),
  ]);
}

async function invite(reload) {
  const emailInput = el('input', { type: 'email', placeholder: 'their@email.address' });
  const roleSelect = el('div.radio-cards', {}, Object.entries(ROLE_HELP).map(([role, help], index) =>
    el('label.radio-card', {}, [
      el('input', { type: 'radio', name: 'role', value: role, checked: index === 0 || undefined }),
      el('div', {}, [el('strong', { text: role }), el('small', { text: help })]),
    ])
  ));
  const messageInput = el('textarea', { placeholder: 'e.g. "I think our families connect through the Raghavan side."' });

  const ok = await openModal({
    title: 'Invite someone to your family tree',
    body: el('div.stack', {}, [
      el('div.field', {}, [
        el('label', { text: 'Their email address' }), emailInput,
        el('div.help', { text: 'They need an account on this platform already.' }),
      ]),
      el('div.field', {}, [el('label', { text: 'What should they be able to do?' }), roleSelect]),
      el('div.field', {}, [el('label', { text: 'Message' }), messageInput]),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Send invitation', variant: 'primary', value: true,
        onClick: () => {
          if (!emailInput.value.trim()) { toast('Enter an email address.', 'warn'); return false; }
          return true;
        },
      },
    ],
  });
  if (!ok) return;

  try {
    const role = roleSelect.querySelector('input:checked').value;
    const result = await api.post('/api/collaborators', {
      email: emailInput.value.trim(),
      role,
      message: messageInput.value.trim() || undefined,
    });
    toast(`Invitation sent to ${result.invitation.user}.`, 'success');
    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not send the invitation');
  }
}
