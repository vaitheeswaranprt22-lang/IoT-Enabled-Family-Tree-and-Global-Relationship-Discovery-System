/**
 * Biometric and hardware management: registered scanners, enrolled fingers,
 * and the authentication log.
 */
import {
  el, icon, notice, toast, spinner, field, input, statusPill, relativeTime,
  formatDateTime, openModal, confirmDialog, emptyState,
} from '../ui.js';
import api from '../api.js';

const OUTCOME_LABELS = {
  success: 'Identified', unknown_slot: 'Slot not enrolled', locked: 'Blocked',
  low_confidence: 'Match too weak', no_challenge: 'No request waiting',
  bad_signature: 'Bad signature', replay: 'Replayed request',
  device_disabled: 'Device disabled', error: 'Error',
};

export async function hardware() {
  const page = el('div.view');
  const body = el('div', {}, [spinner()]);

  async function load() {
    try {
      const data = await api.get('/api/biometric/status');

      body.replaceChildren(
        notice('info', 'What is stored, and what a fingerprint means here',
          `${data.policy.storedData} ${data.policy.meaning}`),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'Registered scanners' }),
            el('div.btn-row', {}, [
              el('a.btn.sm', { href: '#/scanner' }, [icon('cpu', 15), ' Virtual scanner']),
              el('button.btn.sm.primary', { onclick: () => registerDevice(load) }, [icon('plus', 15), ' Register a device']),
            ]),
          ]),
          el('div.card-body.tight', {}, [
            data.devices.length
              ? el('div.stack.sm', {}, data.devices.map((device) => deviceRow(device, load)))
              : el('p.muted.small', { style: { padding: '10px' } },
                  'No scanner registered. Register your ESP32, or use the virtual scanner to try the flow without hardware.'),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'My enrolled fingerprints' }),
            el('button.btn.sm.primary', {
              onclick: () => enrol(data.devices, load),
            }, [icon('fingerprint', 15), ' Enrol a finger']),
          ]),
          el('div.card-body.tight', {}, [
            data.enrollments.length
              ? el('div.stack.sm', {}, data.enrollments.map((entry) => enrollmentRow(entry, load)))
              : el('p.muted.small', { style: { padding: '10px' } },
                  'No fingerprint is linked to your account yet. Enrol one to sign in at a scanner.'),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'Authentication log' }),
            el('span.sub', { text: 'Every scan, successful or not' }),
          ]),
          el('div.card-body.tight', {}, [
            data.recentActivity.length
              ? el('div.table-wrap', {}, [
                  el('table', {}, [
                    el('thead', {}, [el('tr', {}, [
                      el('th', { text: 'When' }), el('th', { text: 'Outcome' }),
                      el('th', { text: 'Device' }), el('th', { text: 'Slot' }),
                      el('th', { text: 'Confidence' }), el('th', { text: 'Detail' }),
                    ])]),
                    el('tbody', {}, data.recentActivity.map((row) => el('tr', {}, [
                      el('td.small.muted.nowrap', { title: formatDateTime(row.at), text: relativeTime(row.at) }),
                      el('td', {}, [
                        el(`span.pill.${row.outcome === 'success' ? 'verified' : 'rejected'}`, {
                          text: OUTCOME_LABELS[row.outcome] ?? row.outcome,
                        }),
                      ]),
                      el('td.small.mono', { text: row.device ?? '—' }),
                      el('td.small.num', { text: row.slot ?? '—' }),
                      el('td.small.num', { text: row.confidence ?? '—' }),
                      el('td.small.muted', { text: row.detail ?? '—' }),
                    ]))),
                  ]),
                ])
              : el('p.muted.small', { style: { padding: '10px' } }, 'No scans recorded yet.'),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [el('h3', { text: 'Security policy in force' })]),
          el('div.card-body', {}, [
            el('dl.kv', {}, [
              el('dt', { text: 'Minimum match confidence' }),
              el('dd', { text: String(data.policy.minConfidence) }),
              el('dt', { text: 'Sign-in request lifetime' }),
              el('dd', { text: `${data.policy.challengeTtlSeconds} seconds` }),
              el('dt', { text: 'Simulated scanners' }),
              el('dd', { text: data.policy.simulatedDevicesAllowed ? 'Allowed (development)' : 'Refused' }),
            ]),
            el('p.tiny.muted.mt', {
              text: 'Every device request is signed with HMAC-SHA256 and carries a one-time nonce, so a captured request cannot be replayed.',
            }),
          ]),
        ])
      );
    } catch (err) {
      body.replaceChildren(notice('danger', 'Could not load hardware status', err.message));
    }
  }

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Biometric and hardware' }),
        el('p.lede', {
          text: 'Manage the fingerprint scanners connected to this system and the fingers linked to your account.',
        }),
      ]),
    ]),
    body
  );

  await load();
  return page;
}

function deviceRow(device, reload) {
  return el(`div.device-card${device.online ? '.online' : ''}`, {}, [
    el('div.device-icon', {}, [icon('cpu', 22)]),
    el('div.grow', {}, [
      el('div.flex.wrap', { style: { gap: '8px' } }, [
        el('strong', { text: device.name }),
        el(`span.dot.${device.online ? 'on' : 'off'}`),
        el('span.small.muted', { text: device.online ? 'online' : `last seen ${relativeTime(device.lastSeenAt)}` }),
        device.simulated ? el('span.pill.synthetic', { text: 'Simulator' }) : null,
        device.status !== 'active' ? statusPill(device.status) : null,
      ]),
      el('div.small.muted', {
        text: [
          device.id,
          device.location,
          `${device.enrolledFingerprints} enrolled`,
          device.firmwareVersion ? `firmware ${device.firmwareVersion}` : null,
          device.ipAddress,
        ].filter(Boolean).join(' · '),
      }),
      device.lastError ? el('div.tiny', { style: { color: 'var(--rose-500)' }, text: `Last error: ${device.lastError}` }) : null,
    ]),
    device.isMine
      ? el('button.btn.sm.ghost', {
          title: 'Revoke this device',
          onclick: async () => {
            const ok = await confirmDialog('Revoke this scanner?',
              `${device.name} will stop being able to authenticate anyone. Enrolled fingerprints are kept.`,
              { confirmLabel: 'Revoke', variant: 'danger' });
            if (!ok) return;
            try {
              await api.delete(`/api/biometric/devices/${device.id}`);
              toast('Device revoked.', 'success');
              reload();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, [icon('trash', 15)])
      : null,
  ]);
}

function enrollmentRow(entry, reload) {
  return el('div.person-row', {}, [
    el('div', {
      style: {
        width: '38px', height: '38px', flex: 'none', borderRadius: 'var(--r-full)',
        display: 'grid', placeItems: 'center',
        background: 'var(--violet-100)', color: 'var(--violet-700)',
      },
    }, [icon('fingerprint', 20)]),
    el('div.person-meta', {}, [
      el('strong', { text: entry.label }),
      el('small', {
        text: `${entry.deviceName} · slot #${entry.slot} · enrolled ${relativeTime(entry.enrolledAt)}`
          + (entry.lastUsedAt ? ` · last used ${relativeTime(entry.lastUsedAt)}` : ' · never used'),
      }),
    ]),
    entry.status !== 'active' ? statusPill(entry.status) : null,
    el('button.btn.sm.ghost', {
      title: 'Remove this enrolment',
      onclick: async () => {
        const ok = await confirmDialog('Remove this fingerprint link?',
          `Slot #${entry.slot} will no longer sign you in. The template itself stays on the sensor until you erase it with the enrolment sketch.`,
          { confirmLabel: 'Remove', variant: 'danger' });
        if (!ok) return;
        try {
          const result = await api.delete(`/api/biometric/enroll/${entry.id}`);
          toast(result.note, 'success', 'Removed');
          reload();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, [icon('trash', 15)]),
  ]);
}

// ------------------------------------------------------------ registration --

async function registerDevice(reload) {
  const idInput = input({ placeholder: 'ESP32-LAB-02', value: '' });
  const nameInput = input({ placeholder: 'Lab scanner 2' });
  const locationInput = input({ placeholder: 'Where it is installed' });
  const simulatedBox = el('input', { type: 'checkbox' });

  const ok = await openModal({
    title: 'Register a scanner',
    body: el('div.stack', {}, [
      field('Device ID', idInput, 'Letters, numbers, hyphens. Write it on the enclosure -- the firmware uses it.'),
      field('Friendly name', nameInput),
      field('Location', locationInput),
      el('label.check', {}, [
        simulatedBox,
        el('span', {}, [
          el('strong', { text: 'This is a software simulator' }),
          el('small', { text: 'Only for development. A simulated device has no physical possession factor.' }),
        ]),
      ]),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      {
        label: 'Register', variant: 'primary', value: true,
        onClick: () => {
          if (!idInput.value.trim() || !nameInput.value.trim()) {
            toast('A device ID and a name are required.', 'warn');
            return false;
          }
          return true;
        },
      },
    ],
  });
  if (!ok) return;

  try {
    const result = await api.post('/api/biometric/devices', {
      deviceId: idInput.value.trim(),
      name: nameInput.value.trim(),
      location: locationInput.value.trim() || undefined,
      simulated: simulatedBox.checked,
    });

    const keyField = el('pre.block', { text: result.signingKey, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } });

    await openModal({
      title: 'Device registered — copy the key now',
      body: el('div.stack', {}, [
        notice('warn', 'This key is shown only once', result.warning),
        el('div', {}, [
          el('div.section-title', { text: 'Signing key' }),
          keyField,
        ]),
        el('div.btn-row', {}, [
          el('button.btn.sm', {
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(result.signingKey);
                toast('Copied to the clipboard.', 'success');
              } catch {
                toast('Select the key and copy it manually.', 'warn');
              }
            },
          }, [icon('file', 15), ' Copy']),
        ]),
        el('div', {}, [
          el('div.section-title', { text: 'Put it in secrets.h' }),
          el('pre.block', {
            text: `#define DEVICE_ID    "${result.device.id}"\n#define DEVICE_KEY   "${result.signingKey}"`,
            style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
          }),
          el('p.tiny.muted', { text: 'esp32-firmware/global_family_tree_node/secrets.h is git-ignored, so the key never reaches the repository.' }),
        ]),
      ]),
      actions: [{ label: 'I have copied it', variant: 'primary', value: true }],
      wide: true,
    });

    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not register');
  }
}

// ---------------------------------------------------------------- enrolment --

async function enrol(devices, reload) {
  const usable = devices.filter((d) => d.status === 'active');
  if (!usable.length) {
    toast('Register a scanner first.', 'warn');
    return;
  }

  const deviceSelect = el('select', {}, usable.map((d) =>
    el('option', { value: d.id, text: `${d.name}${d.simulated ? ' (simulator)' : ''}` })));
  const slotInput = input({ type: 'number', min: '0', max: '4095', value: '1' });
  const labelInput = input({ value: 'Right index finger' });

  const ok = await openModal({
    title: 'Link a fingerprint to your account',
    body: el('div.stack', {}, [
      el('p.small.muted', {
        text: 'Run the enrolment sketch on the ESP32 first. It stores the fingerprint template on the sensor and prints the slot number it used. Enter that number here.',
      }),
      field('Scanner', deviceSelect),
      field('Template slot number', slotInput, 'The number the enrolment sketch printed on the serial monitor.'),
      field('Label', labelInput, 'So you can tell your enrolments apart later.'),
      notice('info', 'No biometric data is sent',
        'Only the slot number leaves the sensor. The fingerprint image and template never reach this application.'),
    ]),
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Link this slot', variant: 'primary', value: true },
    ],
  });
  if (!ok) return;

  try {
    const result = await api.post('/api/biometric/enroll', {
      deviceId: deviceSelect.value,
      sensorSlotId: Number(slotInput.value),
      label: labelInput.value.trim() || undefined,
    });
    toast(`Slot #${result.enrollment.slot} is now linked to your account.`, 'success', 'Enrolled');
    reload();
  } catch (err) {
    toast(err.message, 'error', 'Could not enrol');
  }
}
