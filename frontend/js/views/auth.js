/**
 * Sign in, register, password reset -- and the browser half of the biometric
 * handshake.
 *
 * The biometric flow is started here, by the browser, on purpose: the session
 * is handed to the page that asked for it, so a scanner on its own can never
 * mint a session for somebody else's browser.
 */
import { el, icon, notice, toast, field, input, spinner } from '../ui.js';
import api, { setToken, ApiError } from '../api.js';
import { loadSession, refreshCounts } from '../store.js';
import { navigate } from '../app.js';

const DEMO_ACCOUNTS = [
  ['arjun@demo.familytree.local', 'Arjun Raghavan', 'Chennai · shares an ancestor with Priya'],
  ['priya@demo.familytree.local', 'Priya Iyer', 'Madurai · the other half of that pair'],
  ['rohit@demo.familytree.local', 'Rohit Sharma', 'Delhi · adoption and a name collision'],
  ['maria@demo.familytree.local', "Maria D'Souza", 'Goa · step-family, married into the Sharmas'],
  ['chidi@demo.familytree.local', 'Chidi Okafor', 'Lagos · deliberately unconnected'],
];
const DEMO_PASSWORD = 'DemoPassword#2026';

/** Shows server-side field errors next to the right inputs. */
function applyFieldErrors(form, error) {
  form.querySelectorAll('.field .error').forEach((node) => node.remove());
  form.querySelectorAll('[aria-invalid]').forEach((node) => node.removeAttribute('aria-invalid'));

  const fields = error instanceof ApiError ? error.fieldErrors : null;
  if (!fields) return false;

  for (const [name, message] of Object.entries(fields)) {
    const control = form.querySelector(`[name="${name}"]`);
    if (!control) continue;
    control.setAttribute('aria-invalid', 'true');
    control.closest('.field')?.append(el('div.error', { text: message }));
  }
  const first = form.querySelector('[aria-invalid]');
  first?.focus();
  return true;
}

function authShell(title, subtitle, body, footer) {
  return el('div.auth-page', {}, [
    el('div.auth-card', {}, [
      el('div.card', {}, [
        el('div.card-body', {}, [
          el('div.auth-head', {}, [
            el('h1', { text: title }),
            subtitle ? el('p', { text: subtitle }) : null,
          ]),
          body,
        ]),
        footer ? el('div.card-foot', {}, [footer]) : null,
      ]),
      el('p.center.mt.small', {}, [el('a', { href: '#/' }, 'Back to the home page')]),
    ]),
  ]);
}

// =============================================================== sign in ====

export async function login() {
  const container = el('div');
  const passwordPane = el('div');
  const biometricPane = el('div.hidden');

  const tabs = el('div.tabs', { role: 'tablist' }, [
    el('button.on', { type: 'button', role: 'tab' }, [icon('lock', 15), ' Password']),
    el('button', { type: 'button', role: 'tab' }, [icon('fingerprint', 15), ' Fingerprint']),
  ]);
  const [passwordTab, biometricTab] = tabs.children;

  passwordTab.addEventListener('click', () => {
    passwordTab.classList.add('on'); biometricTab.classList.remove('on');
    passwordPane.classList.remove('hidden'); biometricPane.classList.add('hidden');
  });
  biometricTab.addEventListener('click', () => {
    biometricTab.classList.add('on'); passwordTab.classList.remove('on');
    biometricPane.classList.remove('hidden'); passwordPane.classList.add('hidden');
    startBiometricPane(biometricPane);
  });

  // ---- password form ----
  const emailInput = input({ name: 'email', type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
  const passwordInput = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Your password' });
  const submit = el('button.btn.primary.block.lg', { type: 'submit' }, 'Sign in');

  const form = el('form', { novalidate: true }, [
    field('Email address', emailInput),
    field('Password', passwordInput),
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const result = await api.post('/api/auth/login', {
        email: emailInput.value.trim(),
        password: passwordInput.value,
      });
      setToken(result.session.token);
      await loadSession();
      refreshCounts();
      toast(`Welcome back, ${result.user.displayName}.`, 'success');
      const redirect = sessionStorage.getItem('gft:redirect');
      sessionStorage.removeItem('gft:redirect');
      navigate(redirect ? redirect.replace(/^#\/?/, '') : 'dashboard', true);
    } catch (err) {
      if (!applyFieldErrors(form, err)) toast(err.message, 'error', 'Could not sign in');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  passwordPane.append(
    form,
    el('p.center.mt.small', {}, [el('a', { href: '#/forgot-password' }, 'Forgot your password?')]),
    el('div.divider', {}, 'Demonstration accounts'),
    demoAccountList(emailInput, passwordInput, form)
  );

  container.append(tabs, passwordPane, biometricPane);

  return authShell(
    'Sign in',
    'Use your password, or place an enrolled finger on a registered scanner.',
    container,
    el('div.center.small.grow', {}, ['New here? ', el('a', { href: '#/register' }, 'Create an account')])
  );
}

function demoAccountList(emailInput, passwordInput, form) {
  const list = el('div.demo-accounts', {}, DEMO_ACCOUNTS.map(([email, name, hint]) =>
    el('button', { type: 'button', onclick: () => {
      emailInput.value = email;
      passwordInput.value = DEMO_PASSWORD;
      form.requestSubmit();
    } }, [
      icon('user', 15),
      el('div.grow', {}, [
        el('strong', { text: name }),
        el('div.tiny.muted', { text: hint }),
      ]),
      el('span.pill.synthetic', { text: 'DEMO' }),
    ])
  ));
  list.append(el('p.tiny.muted.mt', {
    text: `All demonstration accounts use the password ${DEMO_PASSWORD}. Every record they contain is synthetic.`,
  }));
  return list;
}

// ==================================================== biometric sign-in ====

/**
 * Browser side of the handshake:
 *   1. ask for a challenge bound to a chosen scanner
 *   2. show the code so the user can check it against the LCD
 *   3. poll until the scanner reports who it recognised
 */
async function startBiometricPane(pane) {
  pane.replaceChildren(spinner('Looking for scanners…'));

  let devices;
  try {
    const result = await api.get('/api/biometric/devices/available');
    devices = result.devices ?? [];
  } catch (err) {
    pane.replaceChildren(notice('danger', 'Could not reach the server', err.message));
    return;
  }

  if (!devices.length) {
    pane.replaceChildren(
      notice('warn', 'No scanner is registered yet',
        'Register an ESP32 device from the Biometric & Hardware page after signing in with a password, or start the built-in Virtual Scanner.'),
      el('div.mt', {}, [el('a.btn', { href: '#/scanner' }, 'Open the Virtual ESP32 Scanner')])
    );
    return;
  }

  const deviceSelect = el('select', { name: 'device' },
    devices.map((device) => el('option', {
      value: device.id,
      text: `${device.name}${device.simulated ? ' (simulator)' : ''}${device.online ? ' — online' : ' — offline'}`,
    }))
  );

  const startButton = el('button.btn.primary.block.lg', {}, [icon('fingerprint', 17), ' Start fingerprint sign-in']);
  const area = el('div');

  pane.replaceChildren(
    field('Scanner', deviceSelect, 'Pick the device you are standing at.'),
    startButton,
    area,
    el('p.tiny.muted.mt', {
      text: 'The fingerprint identifies which registered account is present. It is not evidence of any family relationship.',
    })
  );

  startButton.addEventListener('click', async () => {
    startButton.disabled = true;
    try {
      const challenge = await api.post('/api/biometric/challenge', { deviceId: deviceSelect.value });
      await runChallenge(area, challenge, () => { startButton.disabled = false; });
    } catch (err) {
      toast(err.message, 'error', 'Could not start');
      startButton.disabled = false;
    }
  });
}

async function runChallenge(area, challenge, onDone) {
  const statusLine = el('p.muted.small.center', { text: 'Waiting for the scanner to pick up this request…' });
  const scanner = el('div.fp-scanner.active', {}, [
    el('div.fp-icon', {}, [icon('fingerprint', 60)]),
    el('strong', { text: 'Place your finger on the sensor' }),
    statusLine,
  ]);

  area.replaceChildren(
    el('div.mt', {}, [
      el('p.small.muted.center.mb', { text: 'Check that this code matches the one on the scanner’s LCD:' }),
      el('div.code-display', { text: challenge.code }),
      scanner,
    ])
  );

  const deadline = Date.now() + (challenge.expiresInSeconds ?? 90) * 1000;

  const poll = async () => {
    if (Date.now() > deadline) {
      scanner.classList.remove('active');
      statusLine.textContent = 'This request timed out. Start again.';
      onDone?.();
      return;
    }
    try {
      const result = await api.get(`/api/biometric/challenge/${challenge.challengeId}`);

      if (result.status === 'fulfilled') {
        setToken(result.session.token);
        await loadSession();
        refreshCounts();
        scanner.replaceChildren(
          el('div.fp-icon', { style: { color: 'var(--green-500)' } }, [icon('shield-check', 60)]),
          el('strong', { text: `Identified as ${result.user.displayName}` }),
          el('p.small.muted', { text: 'Opening your dashboard…' })
        );
        toast(`Signed in by fingerprint as ${result.user.displayName}.`, 'success');
        setTimeout(() => navigate('dashboard', true), 700);
        return;
      }
      if (result.status === 'failed') {
        scanner.classList.remove('active');
        statusLine.textContent = result.message;
        toast(result.message, 'error', 'Not recognised');
        onDone?.();
        return;
      }
      if (['expired', 'consumed'].includes(result.status)) {
        scanner.classList.remove('active');
        statusLine.textContent = result.message ?? 'This request is no longer valid.';
        onDone?.();
        return;
      }
      statusLine.textContent = result.message ?? 'Waiting…';
    } catch (err) {
      statusLine.textContent = `Connection problem: ${err.message}`;
    }
    setTimeout(poll, 1200);
  };

  setTimeout(poll, 700);
}

// ============================================================== register ====

export async function register() {
  const fields = {
    displayName: input({ name: 'displayName', required: true, autocomplete: 'name', placeholder: 'e.g. Arjun Raghavan' }),
    email: input({ name: 'email', type: 'email', required: true, autocomplete: 'username', placeholder: 'you@example.com' }),
    password: input({ name: 'password', type: 'password', required: true, autocomplete: 'new-password', placeholder: 'At least 10 characters' }),
    birthDate: input({ name: 'birthDate', type: 'date' }),
    birthPlace: input({ name: 'birthPlace', placeholder: 'City, region' }),
  };
  const genderSelect = el('select', { name: 'gender' }, [
    el('option', { value: 'unknown', text: 'Prefer not to say' }),
    el('option', { value: 'female', text: 'Female' }),
    el('option', { value: 'male', text: 'Male' }),
    el('option', { value: 'other', text: 'Other' }),
  ]);

  const strengthBar = el('i');
  const strengthText = el('div.help', { text: 'Length matters more than symbols. Aim for a memorable phrase.' });
  let strengthTimer = null;

  fields.password.addEventListener('input', () => {
    clearTimeout(strengthTimer);
    strengthTimer = setTimeout(async () => {
      const value = fields.password.value;
      if (!value) { strengthBar.style.width = '0%'; return; }
      try {
        const result = await api.post('/api/auth/check-password', { password: value });
        const score = result.ok ? 1 : Math.max(0.15, 1 - result.problems.length * 0.3);
        strengthBar.style.width = `${score * 100}%`;
        strengthBar.style.background = result.ok ? 'var(--green-500)' : score > 0.5 ? 'var(--amber-500)' : 'var(--rose-500)';
        strengthText.textContent = result.ok ? 'Strong enough.' : result.problems.join(' ');
      } catch { /* the form still validates on submit */ }
    }, 260);
  });

  const submit = el('button.btn.primary.block.lg', { type: 'submit' }, 'Create my account');

  const form = el('form', { novalidate: true }, [
    field('Your name', fields.displayName, 'This also creates your own person record in the family graph.'),
    field('Email address', fields.email),
    el('div.field', {}, [
      el('label', { text: 'Password' }),
      fields.password,
      el('div.strength', {}, [strengthBar]),
      strengthText,
    ]),
    el('div.divider', {}, 'Optional — helps relationship discovery'),
    el('div.form-row', {}, [
      field('Date of birth', fields.birthDate),
      field('Gender', genderSelect),
    ]),
    field('Place of birth', fields.birthPlace),
    submit,
    el('p.tiny.muted.mt', {
      text: 'Everything you add starts as Family Only. You can change visibility per person at any time.',
    }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Creating your account…';
    try {
      const result = await api.post('/api/auth/register', {
        displayName: fields.displayName.value.trim(),
        email: fields.email.value.trim(),
        password: fields.password.value,
        gender: genderSelect.value,
        birthDate: fields.birthDate.value || undefined,
        birthPlace: fields.birthPlace.value.trim() || undefined,
      });
      setToken(result.session.token);
      await loadSession();
      refreshCounts();
      toast('Your family tree is ready. Start by adding your parents.', 'success', 'Account created');
      navigate('people/new', true);
    } catch (err) {
      if (!applyFieldErrors(form, err)) toast(err.message, 'error', 'Could not create the account');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Create my account';
    }
  });

  return authShell(
    'Create your account',
    'Your account and your person record in the tree are kept separate, so other families can link to you without gaining access to your login.',
    form,
    el('div.center.small.grow', {}, ['Already registered? ', el('a', { href: '#/login' }, 'Sign in')])
  );
}

// ======================================================== password reset ====

export async function forgot() {
  const emailInput = input({ name: 'email', type: 'email', required: true, autocomplete: 'username' });
  const submit = el('button.btn.primary.block', { type: 'submit' }, 'Send a reset link');
  const result = el('div');

  const form = el('form', { novalidate: true }, [
    field('Email address', emailInput, 'We will send a link if that address is registered.'),
    submit,
    result,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const response = await api.post('/api/auth/forgot-password', { email: emailInput.value.trim() });
      result.replaceChildren(
        el('div.mt', {}, [notice('success', 'Check your email', response.message)]),
        // Local demos have no mail server; the server returns the link directly
        // so the flow can be completed. It never does this in production.
        response.devResetLink
          ? el('div.mt', {}, [
              notice('info', 'Development mode',
                'No mail server is configured, so the reset link is shown here and also printed in the server log.'),
              el('p.mt', {}, [el('a.btn.block', { href: response.devResetLink }, 'Open the reset link')]),
            ])
          : null
      );
    } catch (err) {
      if (!applyFieldErrors(form, err)) toast(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  return authShell('Reset your password', 'Enter the address you registered with.', form,
    el('div.center.small.grow', {}, [el('a', { href: '#/login' }, 'Back to sign in')]));
}

export async function reset({ query }) {
  const token = query.token ?? '';
  if (!token) {
    return authShell('Reset your password', null,
      notice('warn', 'This link is incomplete', 'Open the reset link from your email, or request a new one.'),
      el('div.center.small.grow', {}, [el('a', { href: '#/forgot-password' }, 'Request a new link')]));
  }

  const passwordInput = input({ name: 'newPassword', type: 'password', required: true, autocomplete: 'new-password' });
  const confirmInput = input({ name: 'confirm', type: 'password', required: true, autocomplete: 'new-password' });
  const submit = el('button.btn.primary.block', { type: 'submit' }, 'Set my new password');

  const form = el('form', { novalidate: true }, [
    field('New password', passwordInput, 'At least 10 characters, with a number or symbol.'),
    field('Confirm new password', confirmInput),
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    form.querySelectorAll('.field .error').forEach((node) => node.remove());

    if (passwordInput.value !== confirmInput.value) {
      confirmInput.setAttribute('aria-invalid', 'true');
      confirmInput.closest('.field').append(el('div.error', { text: 'The two passwords do not match.' }));
      return;
    }
    submit.disabled = true;
    try {
      await api.post('/api/auth/reset-password', { token, newPassword: passwordInput.value });
      toast('Your password has been reset. Please sign in.', 'success');
      navigate('login', true);
    } catch (err) {
      if (!applyFieldErrors(form, err)) toast(err.message, 'error', 'Could not reset the password');
    } finally {
      submit.disabled = false;
    }
  });

  return authShell('Choose a new password',
    'All other signed-in devices will be signed out once you do.', form);
}
