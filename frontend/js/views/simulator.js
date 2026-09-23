/**
 * Virtual ESP32 scanner.
 *
 * This is a faithful software stand-in for the hardware: it speaks the exact
 * same signed protocol as the firmware, including HMAC-SHA256 request signing,
 * nonces and clock-skew handling. If a flow works here it works on the board,
 * which makes it possible to build and demonstrate the whole system before the
 * components arrive -- and to tell a wiring fault apart from a server fault.
 *
 * The signing key is the ASCII hex string issued at registration, used as the
 * raw HMAC key (not hex-decoded). The firmware does exactly the same.
 */
import { el, icon, notice, toast, spinner, field, input, select } from '../ui.js';
import api from '../api.js';

const LCD_WIDTH = 16;

/** HMAC-SHA256 over the canonical string, hex-encoded. */
async function sign(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const randomNonce = () =>
  [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function simulator() {
  const page = el('div.view');

  // --------------------------------------------------------- persisted ---
  let saved = { deviceId: 'ESP32-SIM-01', key: '' };
  try {
    const stored = localStorage.getItem('gft:simulator');
    if (stored) saved = { ...saved, ...JSON.parse(stored) };
  } catch { /* private browsing -- the fields just start empty */ }

  const deviceInput = input({ value: saved.deviceId, placeholder: 'ESP32-SIM-01' });
  const keyInput = input({ value: saved.key, placeholder: 'Signing key from device registration', type: 'password' });
  const slotInput = input({ type: 'number', value: '1', min: '0', max: '4095' });
  const confidenceInput = input({ type: 'number', value: '140', min: '0', max: '255' });

  const persist = () => {
    try {
      localStorage.setItem('gft:simulator', JSON.stringify({
        deviceId: deviceInput.value.trim(), key: keyInput.value.trim(),
      }));
    } catch { /* nothing to do */ }
  };
  deviceInput.addEventListener('change', persist);
  keyInput.addEventListener('change', persist);

  // ------------------------------------------------------------- LCD -----
  const lcdRow1 = el('div.row', { text: 'Booting...' });
  const lcdRow2 = el('div.row', { text: '' });
  const lcd = el('div.lcd', {}, [lcdRow1, lcdRow2]);

  const pad = (text) => String(text ?? '').slice(0, LCD_WIDTH).padEnd(LCD_WIDTH, ' ');
  const setLcd = (line1, line2 = '') => {
    lcdRow1.textContent = pad(line1);
    lcdRow2.textContent = pad(line2);
  };

  const logArea = el('pre.block', { style: { maxHeight: '260px', overflowY: 'auto', margin: 0 } });
  const log = (line, kind = '') => {
    const stamp = new Date().toLocaleTimeString();
    logArea.textContent += `[${stamp}] ${kind ? `${kind} ` : ''}${line}\n`;
    logArea.scrollTop = logArea.scrollHeight;
  };

  // ---------------------------------------------------- signed requests ---

  async function signedHeaders(payload) {
    const deviceId = deviceInput.value.trim();
    const key = keyInput.value.trim();
    if (!deviceId || !key) throw new Error('Set the device ID and signing key first.');

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomNonce();
    const signature = await sign(key, `${deviceId}|${timestamp}|${nonce}|${payload}`);

    return {
      'X-Device-Id': deviceId,
      'X-Device-Timestamp': timestamp,
      'X-Device-Nonce': nonce,
      'X-Device-Signature': signature,
    };
  }

  async function deviceRequest(method, path, payload, body) {
    const headers = await signedHeaders(payload);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error?.message ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  // ---------------------------------------------------------- the loop ---

  let running = false;
  let currentChallenge = null;
  let pollTimer = null;
  let heartbeatTimer = null;

  const statusDot = el('span.dot.off');
  const statusText = el('span.small.muted', { text: 'Stopped' });
  const scanButton = el('button.btn.primary.lg', { disabled: true }, [icon('fingerprint', 18), ' Place finger on sensor']);

  async function heartbeat() {
    try {
      const result = await deviceRequest('POST', '/api/biometric/device/heartbeat', 'heartbeat', {
        firmwareVersion: 'virtual-1.0.0',
      });
      statusDot.className = 'dot on';
      statusText.textContent = `Online · ${result.enrolledSlots} enrolled slot(s)`;
      return result;
    } catch (err) {
      statusDot.className = 'dot off';
      statusText.textContent = `Offline — ${err.message}`;
      setLcd('Server Error', err.message.slice(0, LCD_WIDTH));
      log(`heartbeat failed: ${err.message}`, 'ERR');
      throw err;
    }
  }

  async function pollForChallenge() {
    if (!running) return;
    try {
      const result = await deviceRequest('GET', '/api/biometric/device/poll', 'poll');

      if (result.challenge) {
        currentChallenge = result.challenge;
        setLcd('Place Finger', `Code ${result.challenge.code}`);
        scanButton.disabled = false;
        scanButton.classList.add('primary');
        log(`challenge received: ${result.challenge.code} (${result.challenge.purpose})`, 'IN ');
        fpPanel.classList.add('active');
      } else if (!currentChallenge) {
        setLcd('Ready', 'Waiting...');
        scanButton.disabled = true;
        fpPanel.classList.remove('active');
      }
    } catch (err) {
      setLcd('Server Error', 'Retrying...');
      log(`poll failed: ${err.message}`, 'ERR');
    }
    pollTimer = setTimeout(pollForChallenge, 2000);
  }

  async function doScan() {
    if (!currentChallenge) return;
    const slot = Number(slotInput.value);
    const confidence = Number(confidenceInput.value);

    setLcd('Scanning...', '');
    scanButton.disabled = true;
    log(`finger presented: slot ${slot}, confidence ${confidence}`, 'OUT');

    await new Promise((resolve) => setTimeout(resolve, 600));
    setLcd('Verifying...', '');

    try {
      const result = await deviceRequest(
        'POST', '/api/biometric/device/scan',
        `scan|${slot}|${confidence}|${currentChallenge.code}`,
        { sensorSlotId: slot, confidence, challengeCode: currentChallenge.code }
      );

      setLcd(result.lcd ?? 'Done', (result.displayName ?? '').slice(0, LCD_WIDTH));
      log(`${result.outcome}: ${result.message}`, result.outcome === 'success' ? 'OK ' : 'ERR');

      if (result.outcome === 'success') {
        toast(`Identified ${result.displayName}. Complete the sign-in in the other tab.`, 'success', 'Match');
        fpPanel.classList.remove('active');
      } else {
        toast(result.message, 'warn', 'Not recognised');
      }
      currentChallenge = null;
      setTimeout(() => { if (running) setLcd('Ready', 'Waiting...'); }, 3500);
    } catch (err) {
      setLcd('Server Error', err.message.slice(0, LCD_WIDTH));
      log(`scan failed: ${err.message}`, 'ERR');
      toast(err.message, 'error');
      scanButton.disabled = false;
    }
  }

  scanButton.addEventListener('click', doScan);

  const fpPanel = el('div.fp-scanner', {}, [
    el('div.fp-icon', {}, [icon('fingerprint', 60)]),
    el('strong', { text: 'R307 fingerprint sensor (simulated)' }),
    el('p.small.muted', { text: 'Choose a slot number, then press the button to present that finger.' }),
    scanButton,
  ]);

  const powerButton = el('button.btn.primary', {}, [icon('cpu', 16), ' Power on']);
  powerButton.addEventListener('click', async () => {
    if (running) {
      running = false;
      clearTimeout(pollTimer);
      clearInterval(heartbeatTimer);
      currentChallenge = null;
      setLcd('Powered off', '');
      statusDot.className = 'dot off';
      statusText.textContent = 'Stopped';
      scanButton.disabled = true;
      fpPanel.classList.remove('active');
      powerButton.replaceChildren(icon('cpu', 16), document.createTextNode(' Power on'));
      log('device powered off');
      return;
    }

    setLcd('Booting...', '');
    log('boot');
    await new Promise((r) => setTimeout(r, 400));
    setLcd('WiFi Connected', 'Checking server');
    log('wifi connected (simulated)');

    try {
      await heartbeat();
    } catch {
      setLcd('Server Error', 'Check key/ID');
      return;
    }

    running = true;
    powerButton.replaceChildren(icon('x', 16), document.createTextNode(' Power off'));
    log('registered with the backend; polling for sign-in requests');
    heartbeatTimer = setInterval(() => heartbeat().catch(() => {}), 30_000);
    pollForChallenge();
  });

  // ------------------------------------------------------------- layout ---

  page.append(
    el('div.page-head', {}, [
      el('div.grow', {}, [
        el('h1', { text: 'Virtual ESP32 scanner' }),
        el('p.lede', {
          text: 'A software stand-in that speaks the identical signed protocol to the real firmware -- same HMAC signature, same nonces, same endpoints. Use it to demonstrate and test the whole biometric flow without hardware.',
        }),
      ]),
      el('div.page-actions', {}, [
        el('div.flex', {}, [statusDot, statusText]),
        powerButton,
      ]),
    ]),

    notice('warn', 'For development and demonstration only',
      'A simulated scanner has no physical possession factor. The server accepts one only while DEMO_ALLOW_SIMULATED_DEVICE is true, which must be turned off in production.'),

    el('div.grid.cols-2.mt', {}, [
      el('div', {}, [
        el('div.card', {}, [
          el('div.card-head', {}, [el('h3', { text: '16x2 LCD' })]),
          el('div.card-body', {}, [
            lcd,
            el('p.tiny.muted.mt', {
              text: 'The real firmware drives a 16x2 character display over I2C and writes exactly these strings.',
            }),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [el('h3', { text: 'Fingerprint sensor' })]),
          el('div.card-body', {}, [
            fpPanel,
            el('div.form-row.mt', {}, [
              field('Template slot', slotInput, 'The slot number the sensor would report.'),
              field('Match confidence', confidenceInput, `Rejected below the server's minimum.`),
            ]),
          ]),
        ]),
      ]),

      el('div', {}, [
        el('div.card', {}, [
          el('div.card-head', {}, [el('h3', { text: 'Device credentials' })]),
          el('div.card-body', {}, [
            field('Device ID', deviceInput, 'Must match a registered device.'),
            field('Signing key', keyInput,
              'Printed by the seed script, or shown once when you register a device.'),
            el('div.btn-row', {}, [
              el('button.btn.sm', {
                onclick: async (event) => {
                  event.currentTarget.disabled = true;
                  try { await heartbeat(); toast('The server accepted the signature.', 'success', 'Connection OK'); }
                  catch (err) { toast(err.message, 'error', 'Connection failed'); }
                  finally { event.currentTarget.disabled = false; }
                },
              }, [icon('wifi', 15), ' Test the connection']),
              el('a.btn.sm.ghost', { href: '#/hardware' }, 'Manage devices'),
            ]),
          ]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [
            el('h3', { text: 'Serial monitor' }),
            el('button.btn.sm.ghost', { onclick: () => { logArea.textContent = ''; } }, 'Clear'),
          ]),
          el('div.card-body', {}, [logArea]),
        ]),

        el('div.card.mt', {}, [
          el('div.card-head', {}, [el('h3', { text: 'How to demonstrate this' })]),
          el('div.card-body', {}, [
            el('ol.small', { style: { paddingLeft: '18px', lineHeight: '1.9' } }, [
              el('li', { text: 'Paste the signing key above and press Power on. The LCD should read "Ready".' }),
              el('li', { text: 'Open the sign-in page in another tab and choose the Fingerprint option.' }),
              el('li', { text: 'Pick this scanner and start. A six-character code appears on both screens.' }),
              el('li', { text: 'Come back here, set the slot number, and press the sensor button.' }),
              el('li', { text: 'The other tab signs in as whoever that slot is enrolled to.' }),
            ]),
            el('p.tiny.muted.mt', {
              text: 'In the seeded data slot 1 is Arjun, slot 2 is Priya and slot 3 is Maria on the simulator.',
            }),
          ]),
        ]),
      ]),
    ])
  );

  setLcd('Powered off', '');
  log('virtual device ready; press Power on');

  return page;
}
