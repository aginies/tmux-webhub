'use strict';

// ---------- state ----------
let hosts = [];        // [{name, state, error?, sessions:[{name, attached, cwd, activity}]}]
let active = null;     // {key, host, name, ws, dataSub}
let splitActive = null; // {key, host, name, ws, dataSub} — split pane session
let splitTerm = null;   // second xterm instance for split view
let splitFit = null;    // fit addon for split terminal
// host → sessions lookup, rebuilt once per renderChips so displayName is O(1)/chip instead
// of an O(#hosts) hosts.find per chip (render is O(sessions × hosts) otherwise).
let hostSessionsLookup = null;

const $ = (id) => document.getElementById(id);
const keyOf = (host, name) => host + ':' + name; // neither may contain ':' (server-enforced)
const allSessions = () => hosts.flatMap((h) => h.sessions.map((s) => ({ ...s, host: h.name })));
const findSession = (key) => allSessions().find((x) => keyOf(x.host, x.name) === key);

// fetch a JSON API endpoint → { ok, d, status }; d is {} if the body isn't JSON
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, d, status: r.status };
};

// ---------- terminal ----------
// Single source of truth for the xterm palette per UI theme. Both the main and
// split terminals read from here; the CSS custom properties above style the chrome.
const TERM_THEMES = {
  // town (default): Tokyo Night, matching the herdr-world terminal palette
  town: {
    background: '#0b0d12', foreground: '#c9cdd6', cursor: '#7aa2f7',
    selectionBackground: '#2a3a5f',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#ff9e9e', brightGreen: '#b8e991', brightYellow: '#f0c987',
    brightBlue: '#9db8ff', brightMagenta: '#d0b8ff', brightCyan: '#9fdcff', brightWhite: '#c0caf5',
  },
  // classic dark: the pre-Town palette
  classic: {
    background: '#14161a', foreground: '#d7dae0', cursor: '#d7dae0',
    selectionBackground: '#264f78',
    black: '#14161a', red: '#f85149', green: '#3fb950', yellow: '#d29922',
    blue: '#4f8cff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#d7dae0',
    brightBlack: '#565a63', brightRed: '#ff7b72', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79b8ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
  },
  light: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328',
    selectionBackground: '#0969da',
    black: '#1f2328', red: '#cf222e', green: '#1a7f37', yellow: '#9a6700',
    blue: '#0969da', magenta: '#8250df', cyan: '#0550ae', white: '#656d76',
    brightBlack: '#656d76', brightRed: '#a40e26', brightGreen: '#037303', brightYellow: '#6c3f00',
    brightBlue: '#004085', brightMagenta: '#5a32a3', brightCyan: '#015392', brightWhite: '#24292f',
  },
  contrast: {
    background: '#000000', foreground: '#ffffff', cursor: '#ffffff',
    selectionBackground: '#00ffff',
    black: '#000000', red: '#ff0000', green: '#00ff00', yellow: '#ffff00',
    blue: '#0000ff', magenta: '#ff00ff', cyan: '#00ffff', white: '#ffffff',
    brightBlack: '#808080', brightRed: '#ff8080', brightGreen: '#80ff80', brightYellow: '#ffff80',
    brightBlue: '#8080ff', brightMagenta: '#ff80ff', brightCyan: '#80ffff', brightWhite: '#ffffff',
  },
};
const getTermTheme = (name) => TERM_THEMES[name] || TERM_THEMES.town;

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  theme: getTermTheme(getTheme()),
  scrollback: 5000,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('term'));

let resizeSendTimer = null;
function fitTerm() {
  if (!active) return;
  try {
    fit.fit(); // immediate: the xterm layout must follow the container right away
    // throttle the ws.send: a resize drag fires per pixel and each send is a tmux
    // resize over ssh — a trailing send at 100 ms keeps the final size exact
    if (resizeSendTimer) return;
    resizeSendTimer = setTimeout(() => {
      resizeSendTimer = null;
      if (active) {
        try { active.ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch {}
      }
    }, 100);
  } catch {}
  // also fit split terminal if open
  if (splitTerm && splitFit) {
    try {
      splitFit.fit();
    } catch {}
  }
}
window.addEventListener('resize', () => {
  fitTerm();
  if (window.termwinClamp) {
    window.termwinClamp();
    // second pass next frame: a transient scrollbar can shrink the work
    // area on the first layout, and the final clamp must use its real size
    requestAnimationFrame(() => window.termwinClamp());
  }
});

// ---------- two-finger touch scroll (smartphone) ----------
// xterm's built-in touch handling only tracks the first finger (one-finger drag
// scrolls); a two-finger gesture would otherwise become a browser pinch-zoom.
// Intercept two-finger vertical drag and turn it into buffer scrolling, like a
// mouse wheel: fingers up → into history, fingers down → back to the bottom.
// Listeners sit on #termwrap in the CAPTURE phase: at the target element
// listeners fire in registration order (xterm's were registered first), so
// only a capture-phase ancestor can intercept the gesture before xterm sees it.
(() => {
  const el = $('termwrap');
  let ids = null;      // touch identifiers of the ongoing two-finger gesture
  let lastY = 0;       // mean clientY of those touches
  let pendingPx = 0;   // sub-line remainder, so slow drags still scroll

  const meanY = (e) => {
    let y = 0, n = 0;
    for (const t of e.touches) if (ids.has(t.identifier)) { y += t.clientY; n++; }
    return n ? y / n : null;
  };

  el.addEventListener('touchstart', (e) => {
    if (!ids && e.touches.length >= 2) {
      ids = new Set([e.touches[0].identifier, e.touches[1].identifier]);
      lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pendingPx = 0;
      e.stopPropagation(); // don't let xterm's one-finger handler latch on
    }
  }, { capture: true, passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!ids) return;
    e.preventDefault();    // no pinch-zoom / page scroll
    e.stopPropagation();   // xterm's touches[0] handler would double-scroll
    const y = meanY(e);
    if (y === null) return;
    pendingPx += lastY - y; // >0: fingers moved up
    lastY = y;
    const rowH = el.querySelector('.xterm-rows > div')?.clientHeight || 19;
    while (Math.abs(pendingPx) >= rowH) {
      term.scrollLines(pendingPx > 0 ? -1 : 1); // negative = up into history
      pendingPx -= pendingPx > 0 ? rowH : -rowH;
    }
  }, { capture: true, passive: false });

  const end = (e) => {
    if (!ids) return;
    for (const t of e.changedTouches) ids.delete(t.identifier);
    if (ids.size === 0) { ids = null; pendingPx = 0; }
    // while a tracked finger is still down, keep intercepting moves: xterm's
    // one-finger baseline is stale mid-gesture and would jump the remaining finger
  };
  el.addEventListener('touchend', end, { capture: true, passive: false });
  el.addEventListener('touchcancel', end, { capture: true, passive: false });
})();

// Shared WebSocket attach for a terminal. Builds the ws URL, creates the state
// object, and wires the bounded input queue (keystrokes typed before the ws opens
// are queued and flushed on open — the server queues its side until the pty exists,
// so the client must too; bounded so a stalled WS can't accumulate forever), the
// open-flush, and the output handler. The caller assigns the returned state to
// active/splitActive and adds its own onclose + focus/fit behavior via onOpen.
function connectTerminal(key, host, name, term, onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?host=${encodeURIComponent(host)}&session=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`);
  const st = { key, host, name, ws, term };
  // input coalescing: buffer keystrokes and flush ONE frame per ~INPUT_FLUSH_MS
  // window instead of one frame per keystroke. Fast typing then sends fewer, larger
  // frames (less per-frame JSON + WS overhead); normal typing feels unchanged (the
  // window is a few ms). Paste already arrives as a single chunk from xterm. The
  // buffer is bounded (drop oldest) so a stuck CONNECTING socket can't grow it.
  const INPUT_FLUSH_MS = 8;
  const INPUT_MAX = 1000;
  let buf = [];
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!buf.length || ws.readyState !== WebSocket.OPEN) return; // keep buf until open
    const chunks = buf; buf = [];
    ws.send(JSON.stringify({ type: 'input', chunks }));
  };
  st.dataSub = term.onData((d) => {
    buf.push(d);
    if (buf.length >= INPUT_MAX) buf.shift(); // drop oldest
    if (flushTimer == null) flushTimer = setTimeout(flush, INPUT_FLUSH_MS);
  });
  ws.onopen = () => {
    flush(); // send anything buffered while CONNECTING
    if (onOpen) onOpen();
  };
  ws.onmessage = (ev) => {
    // server→client text frames ARE the terminal output (no control messages from server)
    if (typeof ev.data === 'string') term.write(ev.data);
  };
  return st;
}

function attach(key) {
  detach();
  const s = findSession(key);
  try { fit.fit(); } catch {} // sync xterm to the container so we can pass the real size
  // If the session is not found in the list (stale list), extract the session name
  // from the key (format: host:session_name) instead of using the full key.
  const sessionName = s ? s.name : key.split(':').pop();
  const host = s ? s.host : 'localhost';
  const st = connectTerminal(key, host, sessionName, term, () => { fitTerm(); term.focus(); });
  active = st;
  if (view === 'town' && townView) { $('termwin').classList.add('attached'); townView.activeKey = key; townView.needsRedraw = true; }
  $('placeholder').style.display = 'none';
  $('t-detach').style.display = '';
  syncTermButtons();
  // no term.reset() here: detach() above already cleared the screen when a session
  // was active, and a fresh tmux attach full-redraws it when we come from a
  // closed/detached state — a second reset was redundant
  $('t-name').textContent = s ? `${displayName(s)}  [${s.host}:${s.name}]` : key;
  $('t-cwd').textContent = s ? s.cwd : '';
  updateLocalBadge(s);
  renderChips();

  st.ws.onclose = (ev) => {
    if (active !== st) return;
    const why = ev.reason ? ev.reason : 'detached — session still runs in tmux';
    detach(); // resets the terminal — the reason is written over the CLEAN screen
    term.write('\x1b[90m[' + why + ' — ' + key + ']\x1b[0m\r\n');
  };
}

function detach() {
  if (!active) return;
  try { active.dataSub.dispose(); } catch {}
  try { active.ws.close(); } catch {}
  active = null;
  term.reset(); // clean screen: stale content must not linger behind the placeholder
  if (view === 'town' && townView) { $('termwin').classList.remove('attached'); townView.activeKey = null; townView.needsRedraw = true; }
  $('placeholder').style.display = 'flex';
  $('t-detach').style.display = 'none';
  syncTermButtons();
  $('keys-bg').classList.remove('open');
  $('rn-bg').classList.remove('open');
  $('t-name').textContent = 'no session selected';
  $('t-cwd').textContent = '';
  $('t-local').style.display = 'none';
  renderChips();
}

// Termbar buttons that only make sense per view: split view is a List-view
// feature (the Town floating window is too small for two panes — the ⤢ icon
// is hidden there), fullscreen only makes sense in Town (List is already
// full-area). Called from attach/detach/setView so the buttons track the view.
function syncTermButtons() {
  const inTown = view === 'town' && !!townView;
  $('t-split').style.display = inTown ? 'none' : (active ? '' : 'none');
  $('t-full').style.display = inTown && active ? '' : 'none';
}

// tmux counts our own web client once its ws is open; subtract it to get the number of
// OTHER clients attached (shared by the chip tooltip and the "also attached" badge)
function otherAttached(s) {
  const selfAttached = active && active.key === keyOf(s.host, s.name) && active.ws.readyState === WebSocket.OPEN;
  return s.attached - (selfAttached ? 1 : 0);
}

function updateLocalBadge(s) {
  const others = otherAttached(s);
  const el = $('t-local');
  if (others > 0) { el.textContent = `● ${others} other client${others > 1 ? 's' : ''} attached`; el.style.display = 'inline'; }
  else el.style.display = 'none';
}

// ---------- split view ----------
function openSplit() {
  if (splitActive || splitTerm) return; // already split
  const wrap = $('termwrap');
  wrap.classList.add('split');

  // move existing terminal into a pane
  const pane1 = document.createElement('div');
  pane1.className = 'split-pane';
  pane1.dataset.pane = '1';
  const h1 = document.createElement('div');
  h1.className = 'split-header';
  // build via DOM (textContent), NOT innerHTML: the title can be a cwd basename
  // (displayName for a bare-numeric tmux name) that may contain HTML — innerHTML
  // would run it (CSP allows inline scripts), and an in-origin XSS can read the
  // one-use CSRF token from GET /api/config and rewrite config / disable 2FA.
  const h1span = document.createElement('span');
  h1span.textContent = $('t-name').textContent;
  const h1btn = document.createElement('button');
  h1btn.title = 'Close pane';
  h1btn.textContent = '✕';
  h1btn.onclick = () => closeSplitView();
  h1.append(h1span, h1btn);
  pane1.appendChild(h1);
  wrap.insertBefore(pane1, $('term'));
  pane1.appendChild($('term'));

  // create second terminal
  const pane2 = document.createElement('div');
  pane2.className = 'split-pane';
  pane2.dataset.pane = '2';
  const h2 = document.createElement('div');
  h2.className = 'split-header';
  h2.innerHTML = '<span>select session</span><button title="Close pane">✕</button>';
  h2.querySelector('button').onclick = () => closeSplitView();
  pane2.appendChild(h2);
  const div2 = document.createElement('div');
  div2.className = 'fit';
  pane2.appendChild(div2);
  wrap.appendChild(pane2);

  // theme-aware split terminal colors (single source of truth: TERM_THEMES)
  splitTerm = new Terminal({
    fontFamily: 'Cascadia Code, Fira Code, Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    theme: getTermTheme(getTheme()),
  });
  splitFit = new FitAddon.FitAddon();
  splitTerm.loadAddon(splitFit);
  splitTerm.open(div2);
  // resize split terminal to fill pane
  try {
    splitFit.fit();
  } catch {}
  splitTerm.write('\x1b[90mselect a session to attach to this pane\x1b[0m\r\n');

  // highlight chips to indicate split mode (exclude currently active session)
  const activeKey = active ? active.key : null;
  document.querySelectorAll('.chip').forEach(c => {
    if (c.dataset.key !== activeKey) c.classList.add('split-select');
  });
}

// Single teardown for split view, shared by the two pane close buttons and the
// split toggle. Moves the main terminal back out of its pane, closes the split
// websocket, disposes the split terminal, and restores the original layout.
function closeSplitView() {
  if (!splitActive && !splitTerm) return;
  const wrap = $('termwrap');
  wrap.classList.remove('split');
  wrap.style.gridTemplateColumns = '';

  // move the main terminal back out of its pane
  const pane1 = wrap.querySelector('.split-pane[data-pane="1"]');
  if (pane1) {
    wrap.insertBefore($('term'), pane1);
    pane1.remove();
  }

  // close the split websocket + dispose the split terminal
  if (splitActive) {
    try { splitActive.dataSub.dispose(); } catch {}
    try { splitActive.ws.close(); } catch {}
    splitActive = null;
  }
  if (splitTerm) {
    splitTerm.dispose();
    splitTerm = null;
  }
  splitFit = null;

  // remove any remaining panes, clear chip highlighting, re-fit
  wrap.querySelectorAll('.split-pane').forEach(p => p.remove());
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('split-select'));
  fitTerm();
}

function attachSplit(key) {
  if (!splitTerm) return;
  const s = findSession(key);
  if (!s) return;

  const st = connectTerminal(key, s.host, s.name, splitTerm, () => {
    splitTerm.focus();
    // resize split terminal to fill pane
    try { splitFit.fit(); } catch {}
  });
  splitActive = st;

  splitTerm.reset();
  splitTerm.write(`\x1b[90m[attaching to ${s.host}:${s.name}]\x1b[0m\r\n`);

  st.ws.onclose = (ev) => {
    if (splitActive !== st) return;
    splitTerm.write(`\x1b[90m[${ev.reason || 'detached'}]\x1b[0m\r\n`);
  };

  // update split pane header
  const panes = document.querySelectorAll('.split-pane');
  for (const p of panes) {
    if (p.dataset.pane === '2') {
      p.querySelector('.split-header span').textContent = `${s.host}:${s.name}`;
      break;
    }
  }

  // clear split-select highlighting
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('split-select'));
}

$('t-split').onclick = () => {
  if (splitTerm) {
    closeSplitView();
  } else {
    openSplit();
  }
};

// Fullscreen toggle (Town view): the floating terminal window fills the area
// under the header, xterm re-fits to the new size
$('t-full').onclick = () => {
  const win = $('termwin');
  const fs = win.classList.toggle('fs');
  $('t-full').title = fs ? 'Exit fullscreen' : 'Fullscreen (the terminal window fills the screen)';
  setTimeout(fitTerm, 50);
};

// ---------- Town view: move & resize the floating terminal window ----------
// The CSS parks the window with right/bottom; the first move or resize
// converts it to explicit left/top (relative to #main, its offset parent).
// Moving: drag the termbar (buttons excluded). Resizing: drag the corner
// grip. Both are clamped so the window can't be lost off-screen, and both
// are inactive on phones (the window is a fullscreen sheet there).
// setView() clears the inline styles while the List view is showing (and
// restores them on the way back) — see townWinGeo there.
let townWinGeo = null;
(function () {
  const win = $('termwin'), bar = $('termbar'), grip = $('term-resize');
  const phone = () => matchMedia('(max-width: 640px)').matches;
  const usable = () => view === 'town' && !!townView && win.classList.contains('attached') && !phone();
  const area = () => $('main').getBoundingClientRect(); // work area under the header
  // keep the window inside the work area; if it is bigger than the area,
  // pin it to the bottom-right corner so the resize grip stays reachable
  const clampLT = (x, y) => {
    const a = area(), w = win.offsetWidth, h = win.offsetHeight;
    const cx = w > a.width ? a.width - w : Math.min(Math.max(x, 0), a.width - w);
    const cy = h > a.height ? a.height - h : Math.min(Math.max(y, 0), a.height - h);
    return [cx, cy];
  };
  const toLT = () => {
    if (win.style.left) return;
    const r = win.getBoundingClientRect(), a = area();
    win.style.left = (r.left - a.left) + 'px';
    win.style.top = (r.top - a.top) + 'px';
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  };
  window.termwinClamp = () => { // also called on viewport resize
    if (!usable() || !win.style.left || win.classList.contains('fs')) return;
    const [x, y] = clampLT(parseFloat(win.style.left) || 0, parseFloat(win.style.top) || 0);
    win.style.left = x + 'px';
    win.style.top = y + 'px';
  };

  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !usable() || e.target.closest('button')) return;
    if (win.classList.contains('fs')) { // dragging out of fullscreen: float from the grab
      win.classList.remove('fs');
      $('t-full').title = 'Fullscreen (the terminal window fills the screen)';
    }
    toLT();
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { bar.setPointerCapture(e.pointerId); } catch {}
    bar.classList.add('dragging');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = clampLT(e.clientX - area().left - drag.dx, e.clientY - area().top - drag.dy);
    win.style.left = x + 'px';
    win.style.top = y + 'px';
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    bar.classList.remove('dragging');
    try { bar.releasePointerCapture(e.pointerId); } catch {}
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  let rs = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !usable() || win.classList.contains('fs')) return;
    toLT();
    const r = win.getBoundingClientRect();
    rs = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    try { grip.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!rs) return;
    const a = area();
    // grow/shrink within the space left of the window's current position,
    // so the window never grows past the work area (the grip follows the
    // cursor until it hits the area edge)
    const posL = parseFloat(win.style.left) || 0, posT = parseFloat(win.style.top) || 0;
    win.style.width = Math.min(Math.max(rs.w + (e.clientX - rs.x), 320), Math.max(320, a.width - posL)) + 'px';
    win.style.height = Math.min(Math.max(rs.h + (e.clientY - rs.y), 200), Math.max(200, a.height - posT)) + 'px';
    fitTerm(); // immediate xterm reflow; the tmux resize send is throttled inside
  });
  const endResize = (e) => {
    if (!rs) return;
    rs = null;
    try { grip.releasePointerCapture(e.pointerId); } catch {}
    fitTerm();
  };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);
})();

// ---------- display names: explicit tmux name, else cwd basename (disambiguated per host) ----------
// A bare-numeric name is tmux's default ("0", "1", …) — anonymous, so the cwd
// basename stands in. Any other name was chosen (✎ rename, +New) → shown as-is,
// so a rename is visible on the chip.
function cwdParts(s) { return s.cwd.split('/').filter(Boolean); }
const labelOf = (s) => (/^[0-9]+$/.test(s.name) ? (cwdParts(s).pop() || s.name) : s.name);
function displayName(s) {
  const selfKey = keyOf(s.host, s.name);
  const siblings = (hostSessionsLookup && hostSessionsLookup.get(s.host)) || (hosts.find((h) => h.name === s.host) || { sessions: [] }).sessions;
  // compare by key, not object identity (chipEl receives copies of the session objects)
  const collides = (pred) => siblings.some((x) => keyOf(s.host, x.name) !== selfKey && pred(x));
  const base = labelOf(s);
  if (!collides((x) => labelOf(x) === base)) return base;
  // label collision: add the parent dir
  let label = cwdParts(s).slice(-2).join('/') || s.name;
  if (collides((x) => (cwdParts(x).slice(-2).join('/') || x.name) === label)) {
    label += ` (#${s.name})`; // still colliding: show the tmux session name
  }
  return label;
}

// host connection state → short label for the chip tooltip
const stateLabel = (hs) => hs === 'slow' ? 'connected (slow)' : hs === 'offline' ? 'host offline' : 'connected';
// chip tooltip: host · state · tmux name · cwd (+ other clients, + active)
const chipTitle = (s, hostState, others) =>
  `${s.host}: ${stateLabel(hostState)} · tmux: ${s.name} · ${s.cwd}` +
  (others > 0 ? ` · ${others} other client(s) attached` : '') + (s.activity ? ' · active' : '');

// rename a session (tmux rename-session). If it's the one we're attached to, the WS
// keeps working (tmux clients follow the session, not its name) — just re-point the
// client's identity so the chip highlight + termbar track the new name.
// In-page modal, not prompt(): native dialogs are unreliable on phones (iOS/PWA
// quirks, blocked popups) and inconsistent with the rest of the UI.
let rnKey = null;
function openRename(key) {
  const s = findSession(key);
  if (!s) return;
  rnKey = key;
  $('rn-err').textContent = '';
  // pre-fill with the chip's label — the name the user sees and edits
  $('rn-name').value = displayName(s);
  $('rn-bg').classList.add('open');
  $('rn-name').focus();
  $('rn-name').select();
}
async function doRename() {
  const s = findSession(rnKey);
  if (!s) return;
  const name = $('rn-name').value.trim();
  if (!name || name === s.name) return;
  // mirrors NAME_RE in server.js — keep in sync
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { $('rn-err').textContent = 'name: start with letter/digit, then letters, digits, . _ -'; return; }
  $('rn-err').textContent = 'renaming…';
  const wasActive = !!(active && active.key === rnKey);
  const { ok, d } = await api('/api/sessions/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: s.host, from: s.name, to: name }) });
  if (!ok) { $('rn-err').textContent = d.error || 'failed'; return; }
  $('rn-bg').classList.remove('open');
  if (wasActive) {
    active.key = keyOf(s.host, name);
    active.name = name;
    $('t-name').textContent = `${name}  [${s.host}:${name}]`;
  }
  renderChips();
  refresh(); // reconciles the chip list (old name gone, new name present)
}
const rnBg = $('rn-bg');
$('rn-cancel').onclick = () => rnBg.classList.remove('open');
$('rn-ok').onclick = doRename;
rnBg.addEventListener('click', (e) => { if (e.target === rnBg) rnBg.classList.remove('open'); });
$('rn-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRename(); });

// ---------- rendering: one section per host (automatic, no manual grouping) ----------
// Reconcile in place: a full rebuild every 5 s poll (any field change, e.g. one
// session's activity flag, would trigger it) resets hover/scroll and can eat a click
// mid-rebuild. Existing chips are updated by key (host+name); only added/removed
// sessions and hosts create or remove DOM nodes.
const FLASH_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M11 21h-1l1-7H7.5c-.86 0-.91-.28-.71-.61l.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z" fill="var(--amber)"/></svg>';
function renderChips() {
  const box = $('hosts');
  hostSessionsLookup = new Map(hosts.map((h) => [h.name, h.sessions]));
  const groups = new Map();
  for (const g of box.children) groups.set(g.dataset.host, g);
  const seen = new Set();
  hosts.forEach((h, i) => {
    seen.add(h.name);
    const g = groups.get(h.name);
    if (!g) { box.appendChild(hostEl(h, i)); return; }
    syncGroupHead(g, h, i);
    syncChips(g.querySelector('.chips'), h);
  });
  for (const [name, g] of groups) if (!seen.has(name)) g.remove();
}

function syncGroupHead(g, h, idx) {
  const off = h.enabled === false;
  g.className = 'group tint-' + (idx % 5) + (off ? ' disabled' : h.error ? ' offline' : '');
  const [hst, nm, cnt] = g.querySelector('.group-head').children;
  hst.className = 'hst' + (off ? '' : h.state === 'slow' ? ' slow' : h.state === 'offline' ? ' offline' : '');
  hst.title = off ? 'disabled — click to enable' : h.state === 'offline' ? `unreachable: ${h.error}` : h.state === 'slow' ? 'connected, but slow' : 'connected';
  nm.title = off ? 'disabled — click to enable' : h.error ? `unreachable: ${h.error}` : `${h.sessions.length} session(s) — click to hide this host`;
  // the count is only useful when there is nothing to count (or the host is down) —
  // the chips already show the sessions; the total stays in the host-name tooltip
  const cntText = off ? 'off' : h.error ? 'offline' : h.sessions.length ? '' : '(0)';
  cnt.style.display = cntText ? '' : 'none';
  if (cnt.textContent !== cntText) cnt.textContent = cntText;
}

// click the host badge → flip "enabled" in config.json (optimistic, rolled back on error)
async function toggleHost(name) {
  const h = hosts.find((x) => x.name === name);
  if (!h) return;
  const wasEnabled = h.enabled !== false;
  h.enabled = !wasEnabled;
  renderChips();
  populateHostSelect();
  try {
    const { ok, d, status } = await api('/api/hosts/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: name }) });
    if (!ok) throw new Error(d.error || 'HTTP ' + status);
    h.enabled = d.enabled !== false;
  } catch (e) {
    h.enabled = wasEnabled;
    setConnBanner(`⚠ could not ${wasEnabled ? 'hide' : 'show'} host “${name}”: ${e.message}`);
  }
  renderChips();
  populateHostSelect();
}

function syncChips(box, h) {
  const byKey = new Map();
  for (const c of box.children) byKey.set(c.dataset.key, c);
  const present = new Set();
  for (const s of h.sessions) {
    const key = keyOf(h.name, s.name);
    present.add(key); // O(1) removal check below (was h.sessions.some() per chip)
    const c = byKey.get(key);
    if (c) syncChip(c, { ...s, host: h.name }, h.state);
    else box.appendChild(chipEl({ ...s, host: h.name }, h.state));
  }
  for (const [key, c] of byKey) if (!present.has(key)) c.remove();
}

function syncChip(c, s, hostState) {
  c.classList.toggle('active', !!(active && active.key === keyOf(s.host, s.name)));
  const ind = c.children[0];
  if (s.activity && ind.className !== 'flash') { ind.className = 'flash'; ind.innerHTML = FLASH_SVG; }
  else if (!s.activity && ind.className !== 'ind-empty') { ind.className = 'ind-empty'; ind.innerHTML = ''; }
  const nm = c.children[1];
  const nmText = displayName(s);
  if (nm.textContent !== nmText) nm.textContent = nmText; // skip the DOM write when unchanged
  const others = otherAttached(s);
  nm.title = chipTitle(s, hostState, others);
}

function hostEl(h, idx) {
  const g = document.createElement('div');
  g.dataset.host = h.name;
  g.className = 'group tint-' + (idx % 5);

  const head = document.createElement('div');
  head.className = 'group-head';
  const hst = document.createElement('span');
  hst.className = 'hst';
  const nm = document.createElement('span');
  nm.className = 'gname'; nm.textContent = h.name;
  const cnt = document.createElement('span');
  cnt.className = 'gcount';
  head.append(hst, nm, cnt);
  head.onclick = () => toggleHost(h.name);
  g.appendChild(head);
  syncGroupHead(g, h, idx); // titles/count/disabled state (single source: syncGroupHead)

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const s of h.sessions) chips.appendChild(chipEl({ ...s, host: h.name }, h.state));
  g.appendChild(chips);
  return g;
}

function chipEl(s, hostState) {
  const key = keyOf(s.host, s.name);
  const c = document.createElement('div');
  c.dataset.key = key;
  c.className = 'chip' + (active && active.key === key ? ' active' : '');
  const others = otherAttached(s);
  // indicator: ⚡ only while the session is active; idle sessions show nothing
  // (host connection state is still visible on the host label)
  const ind = document.createElement('span');
  if (s.activity) {
    ind.className = 'flash';
    ind.innerHTML = FLASH_SVG;
  } else {
    ind.className = 'ind-empty';
  }
  const nm = document.createElement('span');
  nm.className = 'cname'; nm.textContent = displayName(s);
  nm.title = chipTitle(s, hostState, others);
  // action: ✎ rename (tmux rename-session)
  const rn = document.createElement('button');
  rn.className = 'crename';
  rn.textContent = '✎';
  rn.title = 'rename session';
  rn.onclick = (e) => { e.stopPropagation(); openRename(key); };
  c.append(ind, nm, rn);
  c.onclick = () => {
    if (splitTerm && !splitActive) {
      attachSplit(key);
    } else {
      attach(key);
    }
  };
  return c;
}

// ---------- api polling ----------
let netFails = 0;
// poll cadence comes from the server (single source of truth); DEFAULT_POLL_MS is
// only the fallback for the first poll, before a response has supplied the real value
const DEFAULT_POLL_MS = 5000;
let pollMs = DEFAULT_POLL_MS;
let defaultCmd = 'pi'; // server's PI_CMD — placeholder for the +New command field
let refreshTimer = null;
let refreshing = false;
function setConnBanner(msg) {
  const el = $('conn');
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = msg;
  el.style.display = 'block';
}
function fmtBytes(b) {
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return Math.round(b) + ' B';
}
function setNetReadout(n) {
  const el = $('net');
  el.textContent = `↓ ${fmtBytes(n.inBps)}/s · ↑ ${fmtBytes(n.outBps)}/s`;
  el.title = `server bandwidth (5 s average) — since start: ↓ ${fmtBytes(n.inTotal)} · ↑ ${fmtBytes(n.outTotal)}`;
}
async function refresh() {
  refreshTimer = null;
  if (refreshing) return; // one already in flight; it reschedules on completion
  refreshing = true;
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    netFails = 0;
    if (Number.isFinite(d.pollMs) && d.pollMs > 0) pollMs = d.pollMs;
    if (typeof d.pi === 'string' && d.pi) defaultCmd = d.pi;
    if (d.net) setNetReadout(d.net); else $('net').textContent = ''; // netDisplay: false
    hosts = d.hosts || [];
    if (townView && view === 'town') townView.update(hosts, active && active.key);
    renderChips();
    populateHostSelect();
    setConnBanner(d.configError ? `⚠ config.json unreadable (${d.configError}) — showing last good host list` : null);
    if (active) {
      const s = findSession(active.key);
      if (s) updateLocalBadge(s);
      // if !s: session died, ws close handles the UI
    }
  } catch {
    netFails++;
    setConnBanner(netFails >= 2
      ? `⚠ server unreachable (${netFails} failed polls) — showing stale data`
      : '⚠ reconnecting…');
  } finally {
    refreshing = false;
  }
  // the chips/badges are the only consumers of this poll in list view; in town
  // view the scene needs it too, so a hidden panel (Ctrl+B) doesn't stop it there
  if (!document.hidden && !(document.body.classList.contains('panel-hidden') && view !== 'town')) refreshTimer = setTimeout(refresh, pollMs);
}
// hidden tabs stop polling entirely (the browser only throttles them to ~1/s);
// one immediate refresh when the tab comes back. A hidden tab must also not hold a
// terminal WS open: the server polls all hosts while any WS is alive and would
// stream the terminal to a tab nobody sees — detach on hide, reattach on show.
let hiddenAttachKey = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (active) { hiddenAttachKey = active.key; detach(); }
  } else {
    if (!refreshTimer && !refreshing && (view === 'town' || !document.body.classList.contains('panel-hidden'))) {
      refreshTimer = setTimeout(refresh, 0);
    }
    if (hiddenAttachKey) {
      const key = hiddenAttachKey; hiddenAttachKey = null;
      // stale data is safe to attach from: the host/name in the key are stable, and a
      // session killed while hidden just gets a clean "no such tmux session" close
      setTimeout(() => { if (!document.hidden && findSession(key)) attach(key); }, 0);
    }
  }
});

// ---------- panel toggle ----------
const header = $('header');
const unhideBtn = $('unhide');
function setPanelHidden(hidden) {
  header.classList.toggle('hidden', hidden);
  unhideBtn.classList.toggle('hidden', !hidden);
  document.body.classList.toggle('panel-hidden', hidden);
  localStorage.setItem('pc.panel', hidden ? 'hidden' : 'shown');
  // pause/resume the 5 s GET poll: with the panel hidden nothing on screen uses it
  // (the terminal keeps working via its own WS; server-side polling follows that WS).
  // Exception: town view — the scene is fed by the poll, so Ctrl+B only hides the
  // header there and the poll keeps running.
  const pause = hidden && view !== 'town';
  if (pause) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  } else if (!refreshTimer && !refreshing && !document.hidden) {
    refreshTimer = setTimeout(refresh, 0);
  }
  setTimeout(fitTerm, 50);
}
if (localStorage.getItem('pc.panel') === 'hidden') setPanelHidden(true);
$('toggle-panel').onclick = () => setPanelHidden(true);
unhideBtn.onclick = () => setPanelHidden(false);

// ---------- theme ----------
// town (default, no class) | classic (theme-classic) | light | contrast.
// Saved values from the old UI: '' (dark) and 'dark' both map to town.
function setTheme(name) {
  if (!name || name === 'dark') name = 'town';
  document.documentElement.classList.remove('theme-classic', 'theme-light', 'theme-contrast');
  if (name === 'classic' || name === 'light' || name === 'contrast')
    document.documentElement.classList.add('theme-' + name);
  localStorage.setItem('pc.theme', name);
  // keep the main terminal's palette in sync (xterm re-renders on a live theme
  // change); in the Town view the terminal window is always dark-scoped
  try {
    const inTown = document.body.classList.contains('view-town');
    term.options.theme = getTermTheme(inTown ? 'town' : name);
  } catch {}
}
function getTheme() {
  if (document.documentElement.classList.contains('theme-classic')) return 'classic';
  if (document.documentElement.classList.contains('theme-light')) return 'light';
  if (document.documentElement.classList.contains('theme-contrast')) return 'contrast';
  return 'town';
}
setTheme(localStorage.getItem('pc.theme') || 'town');

// ---------- view: Town (default) or List ----------
// Town renders herdr-world's town as the main page (public/town.js +
// /vendor/town-art.js): building per host, desk per session. List is the old
// chip list — the power-user view and the phone default.
let townView = null;
let view = 'list';
if (window.TownView) {
  townView = new TownView($('town'), { attach: (k) => attach(k) });
  window.__townview = townView; // debug handle
  view = localStorage.getItem('pc.view') || (innerWidth < 640 ? 'list' : 'town');
}
function setView(v) {
  if (v === 'town' && !townView) v = 'list'; // no art bundle → list only
  // The town floating window carries inline left/top/width/height from
  // move/resize — those are only valid in Town view. The List view's flex
  // layout must own the geometry (the terminal fills the space), so clear
  // them on the way out and remember them to restore on the way back.
  const tw = $('termwin');
  if (view === 'town' && v !== 'town') {
    townWinGeo = { left: tw.style.left, top: tw.style.top, width: tw.style.width, height: tw.style.height };
    tw.style.left = tw.style.top = tw.style.width = tw.style.height = '';
  } else if (view !== 'town' && v === 'town' && townWinGeo) {
    tw.style.left = townWinGeo.left; tw.style.top = townWinGeo.top;
    tw.style.width = townWinGeo.width; tw.style.height = townWinGeo.height;
  }
  view = v;
  localStorage.setItem('pc.view', v);
  document.body.classList.toggle('view-town', v === 'town');
  $('view-toggle').textContent = v === 'town' ? 'List' : 'Town';
  if (townView) {
    if (v === 'town') { townView.update(hosts, active && active.key); townView.start(); }
    else townView.stop();
  }
  // surfaces over Town wear the Town skin: the terminal is always dark-scoped there
  try { term.options.theme = getTermTheme(v === 'town' ? 'town' : getTheme()); } catch {}
  syncTermButtons();
  setTimeout(fitTerm, 50);
}
$('view-toggle').onclick = () => setView(view === 'town' ? 'list' : 'town');
setView(view);

// ---------- cwd completion: subdirectories on the chosen host (local or ssh) ----------
let dirsTimer = null;
let dirsReq = 0; // stale-response guard: only the latest fetch may render
const dirsBox = $('ns-dirs');
function hideDirs() { dirsBox.classList.remove('open'); dirsBox.innerHTML = ''; }
async function fetchDirs() {
  const host = $('ns-host').value;
  const p = $('ns-cwd').value.trim();
  if (!host) return hideDirs();
  const id = ++dirsReq;
  const dot = p.endsWith('.') ? '1' : '';
  const { ok, d } = await api('/api/dirs?host=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p) + '&dot=' + dot);
  if (id !== dirsReq) return; // a newer request superseded this one
  if (!ok || !Array.isArray(d.dirs)) { hideDirs(); return; }
  if (!d.dirs.length) { hideDirs(); return; }
  dirsBox.innerHTML = '';
  if (d.path) {
    const hint = document.createElement('div');
    hint.className = 'dim';
    hint.textContent = d.path;
    dirsBox.appendChild(hint);
  }
  for (const name of d.dirs) {
    const el = document.createElement('div');
    el.textContent = name + '/';
    el.title = (d.path ? d.path.replace(/\/$/, '') + '/' : '') + name;
    el.onclick = () => {
      let cur = $('ns-cwd').value.trim();
      // empty field means the host's home: build ~/name, not a bare relative name
      // (tmux would resolve that against the tmux server's own cwd)
      $('ns-cwd').value = cur ? (cur.endsWith('/') ? cur + name : cur + '/' + name) : '~/' + name;
      hideDirs();
      $('ns-cwd').focus();
      scheduleDirs(); // complete one level deeper
    };
    dirsBox.appendChild(el);
  }
  dirsBox.classList.add('open');
}
function scheduleDirs() {
  clearTimeout(dirsTimer);
  dirsTimer = setTimeout(fetchDirs, 250);
}
$('ns-cwd').addEventListener('input', scheduleDirs);
$('ns-cwd').addEventListener('focus', fetchDirs);
$('ns-cwd').addEventListener('blur', () => setTimeout(hideDirs, 150)); // let the suggestion click land first
$('ns-host').addEventListener('change', scheduleDirs);

// ---------- new session modal ----------
const modal = $('modal-bg');
let lastHostsSnap = '';
function populateHostSelect() {
  // skip the DOM rebuild when the host list (names + reachability + enabled) is unchanged
  const snap = hosts.map((h) => h.name + (h.error ? '!' : '') + (h.enabled === false ? 'x' : '')).join(',');
  if (snap === lastHostsSnap) return;
  lastHostsSnap = snap;
  const sel = $('ns-host');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const h of hosts) {
    if (h.enabled === false) continue; // hidden hosts can't receive new sessions
    const o = document.createElement('option');
    o.value = h.name;
    o.textContent = h.name + (h.error ? ' (offline)' : '');
    o.disabled = !!h.error;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
function hostDefaultCmd(name) {
  // placeholder for the +New command field: the selected host's per-host cmd
  // (config "cmd"), falling back to the server's global PI_CMD
  const h = hosts.find((x) => x.name === name);
  const c = h && typeof h.cmd === 'string' && h.cmd.trim() ? h.cmd.trim() : defaultCmd;
  return c;
}
$('new-session').onclick = () => { $('ns-err').textContent = ''; $('ns-name').value = ''; $('ns-cwd').value = ''; $('ns-cmd').value = ''; $('ns-cmd').placeholder = hostDefaultCmd($('ns-host').value); hideDirs(); modal.classList.add('open'); $('ns-name').focus(); };
$('ns-host').addEventListener('change', () => { $('ns-cmd').placeholder = hostDefaultCmd($('ns-host').value); });
$('ns-cancel').onclick = () => modal.classList.remove('open');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
$('ns-ok').onclick = async () => {
  const host = $('ns-host').value;
  const name = $('ns-name').value.trim();
  const cwd = $('ns-cwd').value.trim() || undefined;
  const cmd = $('ns-cmd').value.trim() || undefined;
  if (!host) { $('ns-err').textContent = 'no reachable host'; return; }
  // mirrors NAME_RE in server.js (and valid_name in pitux) — keep in sync
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { $('ns-err').textContent = 'name: start with letter/digit, then letters, digits, . _ -'; return; }
  $('ns-err').textContent = 'creating…';
  const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host, name, cwd, cmd }) });
  const d = await r.json();
  if (!r.ok) { $('ns-err').textContent = d.error || 'failed'; return; }
  modal.classList.remove('open');
  await refresh();
  setTimeout(() => attach(keyOf(host, name)), 400); // let tmux + pi boot a moment
};

// ---------- config editor (friendly form) ----------
const cfgBg = $('cfg-bg');
const REDACTED = '__REDACTED__'; // mirrors server: token/totp are never returned in the clear
let cfgBase = null;      // full config snapshot from GET — the save base, so no field is ever dropped
let cfgCsrf = null;      // one-use CSRF token from GET /api/config — required to save (PUT)
let cfgHostDraft = [];   // working copy of the host list for this modal open
let cfgTokenUnchanged = true;

const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- hosts ---
function renderHostRow(host, idx) {
  const row = document.createElement('div');
  row.className = 'cfg-host';
  row.innerHTML =
    '<div class="cfg-host-top"><span class="cfg-host-name"></span>' +
    '<div class="cfg-host-actions">' +
    '<button type="button" class="cfg-up" data-act="up" title="Move up">↑</button>' +
    '<button type="button" class="cfg-down" data-act="down" title="Move down">↓</button>' +
    '<button type="button" class="cfg-host-remove" data-act="remove" title="Remove">✕</button>' +
    '</div></div>' +
    '<div class="cfg-host-row">' +
    '<input class="cfg-h-name" type="text" placeholder="name">' +
    '<input class="cfg-h-ssh" type="text" placeholder="ssh (user@host)">' +
    '<input class="cfg-h-cmd" type="text" placeholder="cmd (default: pi)">' +
    '<label class="cfg-h-enchk"><span>on</span><input class="cfg-h-enabled" type="checkbox"></label>' +
    '</div>';
  const name = row.querySelector('.cfg-h-name');
  const ssh = row.querySelector('.cfg-h-ssh');
  const cmd = row.querySelector('.cfg-h-cmd');
  const en = row.querySelector('.cfg-h-enabled');
  const label = row.querySelector('.cfg-host-name');
  const sync = () => { cfgHostDraft[idx].name = name.value; label.textContent = name.value || 'unnamed'; };
  name.addEventListener('input', sync);
  ssh.addEventListener('input', () => { cfgHostDraft[idx].ssh = ssh.value; });
  cmd.addEventListener('input', () => { cfgHostDraft[idx].cmd = cmd.value; });
  en.addEventListener('change', () => { cfgHostDraft[idx].enabled = en.checked ? undefined : false; });
  label.textContent = host.name || 'unnamed';
  name.value = host.name || '';
  ssh.value = host.ssh || '';
  cmd.value = host.cmd || '';
  en.checked = host.enabled !== false;
  row.querySelector('[data-act=up]').onclick = () => moveHost(idx, idx - 1);
  row.querySelector('[data-act=down]').onclick = () => moveHost(idx, idx + 1);
  row.querySelector('[data-act=remove]').onclick = () => removeHost(idx);
  return row;
}
function renderHosts() {
  const wrap = $('cfg-hosts');
  wrap.innerHTML = '';
  cfgHostDraft.forEach((h, i) => wrap.appendChild(renderHostRow(h, i)));
}
function moveHost(from, to) {
  if (to < 0 || to >= cfgHostDraft.length) return;
  const m = cfgHostDraft.splice(from, 1)[0];
  cfgHostDraft.splice(to, 0, m);
  renderHosts();
}
function removeHost(idx) { cfgHostDraft.splice(idx, 1); renderHosts(); }
function normalizeHost(h) {
  const name = (h.name || '').trim();
  const out = { name };
  const ssh = (h.ssh || '').trim();
  const cmd = (h.cmd || '').trim();
  if (ssh) out.ssh = ssh;
  if (cmd) out.cmd = cmd;
  if (h.enabled === false) out.enabled = false;
  return out;
}

// --- tls paths reveal ---
function toggleTlsPaths() { $('cfg-tls-paths').style.display = $('cfg-tls').checked ? '' : 'none'; }

// --- fill the form from a config object (GET shape) ---
function fillForm(cfg) {
  cfgBase = JSON.parse(JSON.stringify(cfg));
  $('cfg-port').value = cfg.port != null ? cfg.port : '';
  $('cfg-host').value = cfg.host || '';
  $('cfg-pollMs').value = cfg.pollMs != null ? cfg.pollMs : '';
  $('cfg-netDisplay').checked = !!cfg.netDisplay;
  $('cfg-theme').value = getTheme();
  $('cfg-tls').checked = !!cfg.tls;
  toggleTlsPaths();
  $('cfg-cert').value = cfg.cert || '';
  $('cfg-key').value = cfg.key || '';
  $('cfg-twoFA').value = cfg.twoFA || '';
  // the server always redacts the token → keep it masked; reveal only works after typing a new value
  cfgTokenUnchanged = (cfg.token === REDACTED);
  $('cfg-token').value = '';
  cfgHostDraft = (Array.isArray(cfg.hosts) ? cfg.hosts : []).map((h) => ({ ...h }));
  renderHosts();
  populateBindSuggestions();
}

// offer 0.0.0.0 + the server's real addresses as bind-address suggestions (datalist).
// fetched from the server because the browser can't read its network interfaces.
async function populateBindSuggestions() {
  const dl = $('cfg-host-list');
  if (!dl) return;
  dl.innerHTML = '';
  let addresses = [];
  try {
    const r = await api('/api/net-interfaces');
    if (r.ok && Array.isArray(r.d.addresses)) addresses = r.d.addresses;
  } catch {}
  const current = $('cfg-host').value.trim();
  const seen = new Set();
  const add = (v) => {
    if (v && !seen.has(v)) {
      seen.add(v);
      const o = document.createElement('option');
      o.value = v;
      dl.appendChild(o);
    }
  };
  add('0.0.0.0');       // propose "bind to all" first
  addresses.forEach(add);
  add(current);        // keep a custom value that isn't in the list selectable
}

// --- build the FULL config payload: start from the snapshot, override only edited fields ---
function buildPayload() {
  const p = JSON.parse(JSON.stringify(cfgBase));
  const pv = $('cfg-port').value.trim();
  p.port = pv === '' ? cfgBase.port : Number(pv);
  p.host = $('cfg-host').value.trim();
  const pmv = $('cfg-pollMs').value.trim();
  p.pollMs = pmv === '' ? cfgBase.pollMs : Number(pmv);
  p.netDisplay = $('cfg-netDisplay').checked;
  p.tls = $('cfg-tls').checked;
  p.cert = $('cfg-cert').value.trim();
  p.key = $('cfg-key').value.trim();
  p.twoFA = $('cfg-twoFA').value || undefined;
  p.hosts = cfgHostDraft.map(normalizeHost);
  // CSRF: the one-use synchronizer token from GET /api/config — required for the
  // server to accept the write (protects token/2FA/totp/tls/hosts against CSRF).
  p.csrf = cfgCsrf;
  // 2FA off → drop any enrolled secret so login stops asking for a code and the
  // settings panel later shows "not enrolled"; otherwise never touch the secret.
  if ($('cfg-twoFA').value === '') {
    delete p.totp;
  } else {
    // the form never edits the TOTP secret value → preserve whatever is in config.json
    p.totp = REDACTED;
  }
  // token: preserve unless the user typed a new value
  p.token = cfgTokenUnchanged ? REDACTED : $('cfg-token').value;
  // drop empty path fields the server would not want
  if (p.cert === '') delete p.cert;
  if (p.key === '') delete p.key;
  if (p.host === '') delete p.host;
  return p;
}

$('edit-config').onclick = async () => {
  $('cfg-err').textContent = '';
  cfgBg.classList.add('open');
  tfRefresh();
  // fetch version for display
  try {
    const vr = await api('/api/version');
    if (vr.ok) {
      $('cfg-title').textContent = 'config.json — tmux-webhub v' + vr.d.version;
    }
  } catch {}
  const { ok, d } = await api('/api/config');
  if (!ok) { $('cfg-err').textContent = d.error || 'failed to load config'; return; }
  cfgCsrf = d.csrf || null; // required by the PUT — a fresh one per modal open
  fillForm(JSON.parse(d.raw));
};
$('cfg-cancel').onclick = () => cfgBg.classList.remove('open');
$('cfg-logout').onclick = async () => {
  await fetch('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  location.replace('/');
};
cfgBg.addEventListener('click', (e) => { if (e.target === cfgBg) cfgBg.classList.remove('open'); });
$('cfg-save').onclick = async () => {
  const p = buildPayload();
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) { $('cfg-err').textContent = 'enter a valid port (1–65535)'; return; }
  if (!Number.isInteger(p.pollMs) || p.pollMs < 250) { $('cfg-err').textContent = 'poll interval must be ≥250 ms'; return; }
  if (!p.host) { $('cfg-err').textContent = 'enter a bind address'; return; }
  if (p.hosts.some((h) => !h.name)) { $('cfg-err').textContent = 'every host needs a name'; return; }
  if (!cfgTokenUnchanged && !$('cfg-token').value.trim()) {
    if (!confirm('Clear the access token? This puts the server in open (no-token) mode.')) return;
  }
  $('cfg-save').disabled = true;
  const { ok, d } = await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  $('cfg-save').disabled = false;
  if (!ok) { $('cfg-err').textContent = d.error || 'failed to save'; return; }
  cfgBg.classList.remove('open');
  await refresh(); // mtime changed → server reloads hosts, cache invalidated
};
// one-time form bindings
$('cfg-tls').addEventListener('change', toggleTlsPaths);
$('cfg-theme').addEventListener('change', () => setTheme($('cfg-theme').value));
$('cfg-token-toggle').onclick = () => {
  const inp = $('cfg-token');
  const showing = inp.type === 'text';
  inp.type = showing ? 'password' : 'text';
  $('cfg-token-toggle').textContent = showing ? 'show' : 'hide';
};
$('cfg-token').addEventListener('input', () => { cfgTokenUnchanged = false; });
$('cfg-host-add').onclick = () => { cfgHostDraft.push({ name: '' }); renderHosts(); };
// tab navigation between Server / Authentication / Hosts
function switchCfgTab(name) {
  document.querySelectorAll('.cfg-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.cfg-sec[data-section]').forEach((s) => { s.style.display = s.dataset.section === name ? '' : 'none'; });
}
document.querySelectorAll('.cfg-tab').forEach((b) => { b.onclick = () => switchCfgTab(b.dataset.tab); });

// ---------- 2FA panel ----------
async function tfRefresh() {
  let s;
  try { s = await (await fetch('/api/totp/status')).json(); } catch { s = { mode: null, enrolled: false }; }
  $('tf-state').textContent = s.mode
    ? (s.mode + (s.enrolled ? ' — enrolled' : ' — not enrolled'))
    : 'off (set "twoFA" in config.json, restart)';
  $('tf-enrolled').style.display = s.enrolled ? 'flex' : 'none';
  $('tf-not-enrolled').style.display = s.enrolled ? 'none' : '';
}
$('tf-disable').onclick = async () => {
  $('tf-err').textContent = '';
  const code = $('tf-code').value.trim();
  if (!/^\d{6}$/.test(code)) { $('tf-err').textContent = 'enter the 6-digit code'; return; }
  const r = await fetch('/api/totp/disable', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const j = await r.json();
  if (!r.ok) { $('tf-err').textContent = j.error || 'failed'; return; }
  $('tf-code').value = '';
  await tfRefresh();
};

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setPanelHidden(!header.classList.contains('hidden')); }
  // Esc detaches only when the terminal is NOT focused (Esc is a normal key inside TUIs)
  if (e.key === 'Escape' && active && !term.isActive) detach();
});

// ---------- keyboard focus in Town view ----------
// The map, the map buttons and the window chrome are not focusable — clicking
// them sends keyboard focus to <body>, and physical typing then silently stops
// working (the ⌨ virtual keyboard still works: it goes server-side). In Town
// view the terminal is the star: any click that is not aimed at an open dialog
// returns keyboard focus to the terminal, so typing always works.
document.addEventListener('click', (e) => {
  if (view !== 'town' || !active) return;
  if (e.target.closest('input, textarea, select')) return; // a real input keeps the keyboard
  // a dialog is open — or was just opened by this very click (the button that
  // opens it sits OUTSIDE the backdrop, so test the backdrop, not the target)
  if (document.querySelector('#modal-bg.open, #cfg-bg.open, #rn-bg.open')) return;
  term.focus();
});

// ---------- phone shortcuts (⎋ / Pg↑ / Pg↓, right of +New) ----------
// phones have no Esc / PageUp / PageDown keys. ⎋ is injected server-side with
// `tmux send-keys` (over ssh for remote hosts): tapping the button blurs the
// terminal, so xterm's own input path can't be used — and its paste() would wrap
// the byte in bracketed-paste markers, which vim & co. treat as a literal paste,
// not an Esc key.
function sendKeys(keys) {
  if (active && active.ws.readyState === WebSocket.OPEN)
    active.ws.send(JSON.stringify({ type: 'send-keys', keys }));
}
$('btn-esc').onclick = () => sendKeys(['Escape']);

// Pg↑/Pg↓: normal screen → page the xterm scrollback (like the PageUp/PageDown
// keys — same call the two-finger touch handler uses). Alternate screen (vim,
// less, TUIs) has NO xterm scrollback — send the real PageUp/PageDown key to
// the app via tmux send-keys, like a real terminal would.
function pageScroll(dir) { // dir: -1 = up, +1 = down
  if (!active) return;
  if (term.buffer.active === term.buffer.alternate) sendKeys(dir < 0 ? ['Pageup'] : ['Pagedown']);
  else term.scrollLines(dir, term.rows);
}
$('btn-pgup').onclick = () => pageScroll(-1);
$('btn-pgdn').onclick = () => pageScroll(1);
$('t-detach').onclick = detach; // ✕ in the termbar — the only detach on phones (⎋ now sends Esc)

// ---------- key palette (⌨) ----------
// floating panel of keys sent via tmux send-keys (server-side) — for keys the
// on-screen keyboard can't produce. Stays open for repeat sends (the backdrop is
// click-through, so the terminal stays usable); closes on ✕ or ⌨ again.
// Drag the header to move, the corner handle to resize (width and height).
// Geometry is remembered in localStorage.
// Two pages: “special” (F1–F4, Tab/Shift+Tab, Alt+m, Enter, Ctrl+C, PgUp/PgDn,
// arrows) and “abc” (classical keyboard: F1–F10, Esc+numbers+Backspace, QWERTY,
// and a bottom row of Shift/Ctrl/Alt + a wide Space, with Enter/Del below (Ins was removed).
// Page 2 combos: hold a modifier 2 s to lock it (it stays lit, haptic tick);
// tap a key to send the combo (C-c, M-x, S-a); tap the locked modifier again to
// unlock. Shift alone → literal uppercase (S-a → 'A'); with Ctrl/Alt locked,
// shift is dropped (C-S-x is meaningless in a terminal).
const keysBg = $('keys-bg');
const keysPanel = $('keys-panel');
const KEYS_MIN_W = 250, KEYS_MIN_H = 124; // min height: header + tabs + one row of keys (body scrolls below that)
const keysMaxW = () => Math.min(560, innerWidth * 0.92);
const keysMaxH = () => innerHeight - 8;
let keysGeom = null;
try { keysGeom = JSON.parse(localStorage.getItem('wh-keys-geom') || 'null'); } catch {}
function clampKeys() {
  const vw = innerWidth, vh = innerHeight;
  keysGeom.w = Math.min(Math.max(keysGeom.w, KEYS_MIN_W), keysMaxW());
  keysGeom.h = Math.min(Math.max(keysGeom.h, KEYS_MIN_H), keysMaxH());
  keysPanel.style.width = keysGeom.w + 'px';
  keysPanel.style.height = keysGeom.h + 'px';
  keysGeom.x = Math.min(Math.max(4, keysGeom.x), vw - keysGeom.w - 4);
  keysGeom.y = Math.min(Math.max(4, keysGeom.y), vh - keysGeom.h - 4);
  keysPanel.style.left = keysGeom.x + 'px';
  keysPanel.style.top = keysGeom.y + 'px';
}
$('btn-keys').onclick = () => {
  if (keysBg.classList.contains('open')) { keysBg.classList.remove('open'); return; }
  keysBg.classList.add('open');
  if (!keysGeom || typeof keysGeom.x !== 'number') {
    // first open: adopt the CSS default (top center, below the notch)
    const r = keysPanel.getBoundingClientRect();
    keysGeom = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  } else if (typeof keysGeom.h !== 'number') {
    // geometry saved before height-resize existed: adopt the natural height
    keysPanel.style.height = 'auto';
    keysGeom.h = keysPanel.offsetHeight;
  }
  keysPanel.style.transform = 'none'; // geometry is now absolute px
  clampKeys();
};
$('keys-close').onclick = () => keysBg.classList.remove('open');
function keysDrag(handle, apply) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // ✕ sits inside the drag header
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const g0 = { ...keysGeom };
    const move = (ev) => { apply(g0, ev.clientX - sx, ev.clientY - sy); clampKeys(); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      saveKeysGeom();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
keysDrag($('keys-head'), (g0, dx, dy) => { keysGeom.x = g0.x + dx; keysGeom.y = g0.y + dy; });
keysDrag($('keys-resize'), (g0, dx, dy) => { keysGeom.w = g0.w + dx; keysGeom.h = g0.h + dy; });
window.addEventListener('resize', () => { if (keysBg.classList.contains('open')) clampKeys(); });
function saveKeysGeom() { try { localStorage.setItem('wh-keys-geom', JSON.stringify(keysGeom)); } catch {} }

// ---------- page 2: classical keyboard ----------
// letters/digits/F/specials send as-is (lowercase; a locked Shift uppercases).
// Shift/Alt/Ctrl are LOCKABLE: hold 2 s to lock (it stays lit), tap a key to
// send the combo, tap the locked modifier again to unlock.
const LOCK_MS = 2000;
const keysLocked = { C: false, M: false, S: false };
function comboName(base) {
  let mods = '';
  if (keysLocked.C) mods += 'C-';
  if (keysLocked.M) mods += 'M-';
  if (keysLocked.S && !mods) mods = 'S-'; // shift alone; dropped under C/M
  return mods + base;
}
function setLock(mod, on) {
  keysLocked[mod] = on;
  document.querySelector(`#keys-mods2 button[data-mod="${mod}"]`).classList.toggle('locked', on);
  try { navigator.vibrate && navigator.vibrate(30); } catch {}
}
function keysPage(n) {
  for (const p of document.querySelectorAll('.keys-page')) p.classList.toggle('on', p.id === 'keys-page' + n);
  for (const b of $('keys-tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.page === n);
  if (n === '2' && keysGeom && keysGeom.w < 300) { keysGeom.w = 300; clampKeys(); saveKeysGeom(); } // 10 columns need room
}
$('keys-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-page]');
  if (b) keysPage(b.dataset.page);
});
for (const b of $('keys-page2').querySelectorAll('button[data-key], button[data-mod]')) {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // no selection / context menu / click synthesis — we handle it all
    const isMod = !!b.dataset.mod;
    let longPressed = false;
    const timer = isMod ? setTimeout(() => {
      longPressed = true;
      setLock(b.dataset.mod, !keysLocked[b.dataset.mod]);
    }, LOCK_MS) : null;
    const up = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (longPressed) return; // the hold already toggled the lock; the release is not a tap
      if (isMod) {
        if (keysLocked[b.dataset.mod]) setLock(b.dataset.mod, false); // tap on a locked modifier: unlock
        else { b.classList.add('sent'); setTimeout(() => b.classList.remove('sent'), 150); } // hint: hold to lock
        return;
      }
      const name = comboName(b.dataset.key);
      sendKeys([name]);
      b.classList.add('sent');
      setTimeout(() => b.classList.remove('sent'), 150);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
// the 2 s hold must not bring up the browser's context menu
keysPanel.addEventListener('contextmenu', (e) => e.preventDefault());
for (const b of $('keys-grid').querySelectorAll('button'))
  b.onclick = () => {
    sendKeys([b.dataset.key]);
    b.classList.add('sent'); // brief flash: the key was sent (the app may still not react)
    setTimeout(() => b.classList.remove('sent'), 150);
  };

refresh();

