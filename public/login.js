  const $ = (id) => document.getElementById(id);
  const show = (id) => {
    document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  };

  // show/hide the token so you can verify exactly what you typed
  $('toggle-token').addEventListener('click', () => {
    const inp = $('token');
    const on = inp.type === 'text';
    inp.type = on ? 'password' : 'text';
    $('toggle-token').textContent = on ? 'show' : 'hide';
  });

  // what does the server expect? (public endpoint, safe before auth)
  fetch('/api/totp/status').then((r) => r.json()).then((s) => {
    $('hint-2fa').textContent = s.enrolled
      ? 'Two-factor is enabled. The Token field is your access token (config.json → token), NOT the 2FA secret. Enter it, then the 6-digit code from your authenticator app.'
      : (s.mode === 'required' ? 'Two-factor is required — you will set it up now.' : '');
    if (s.mode === 'optional' && !s.enrolled) $('enroll-opt').style.display = '';
  }).catch(() => {});

  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let j = {};
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, j };
  }

  function showEnroll(j) {
    $('enroll-ui').style.display = '';
    $('enroll-sub').textContent = 'Set up two-factor: scan with your authenticator app, then enter the 6-digit code.';
    $('code-label').textContent = '6-digit code (from your app)';
    $('code-btn').textContent = 'Confirm & sign in';
    $('secret').textContent = j.secret;
    const qr = qrcode(0, 'M');
    qr.addData(j.otpauthUrl);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ scalable: true, margin: 0 });
    $('code').value = '';
    show('step-code');
    $('code').focus();
  }

  // token (+ optional enroll flag) → enroll step, or straight in
  async function doLogin(extra) {
    const { ok, status, j } = await post('/login', { token: $('token').value.trim(), ...extra });
    if (ok && j.next === 'enroll') { showEnroll(j); return null; }
    if (ok && j.next === 'verify') { showVerify(); return null; }
    if (ok && j.ok) { location.replace('/'); return null; }
    return { ok, status, j };
  }

  // step 2 in verify mode (already enrolled): hide the QR/secret, just ask for the code
  function showVerify() {
    $('enroll-ui').style.display = 'none';
    $('code').value = '';
    show('step-code');
    $('code').focus();
  }

  $('f-token').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err-token').textContent = '';
    const r = await doLogin({});
    if (r) $('err-token').textContent = r.status === 429 ? r.j.error : 'wrong token';
  });

  $('enroll-opt').addEventListener('click', async () => {
    $('err-token').textContent = '';
    const r = await doLogin({ enroll: true });
    if (r) $('err-token').textContent = r.status === 429 ? r.j.error : 'wrong token';
  });

  // step 2 → in
  $('f-code').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err-code').textContent = '';
    const code = $('code').value.trim();
    if (!/^\d{6}$/.test(code)) { $('err-code').textContent = 'enter the 6-digit code'; return; }
    const { ok, status, j } = await post('/login', { token: $('token').value.trim(), code });
    if (ok) { location.replace('/'); return; }
    $('err-code').textContent = status === 429 ? j.error : (j.error || 'wrong code');
  });

  // back to step 1 (keeps the token, drops any in-flight enrollment)
  $('back').addEventListener('click', () => {
    $('err-code').textContent = '';
    $('code').value = '';
    show('step-token');
    $('token').focus();
  });

