'use strict';
// Client-side logic test for the "Session tabs" toggle (Settings → browser-only pref).
// Loads public/app.js in a VM with a permissive DOM stub and drives the toggle's
// STATE logic (which attach path is taken, and how tabs collapse when turned off).
// It does NOT test DOM painting — the render functions are no-opped.
// Run with: node test/tabs-toggle.js   (also invoked by `npm test`)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..', 'public', 'app.js');

// --- permissive DOM element ---
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [], dataset: {}, style: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); },
    },
    textContent: '', innerHTML: '', value: '', checked: false, disabled: false, title: '',
    append(...n) { this.children.push(...n); },
    appendChild(n) { this.children.push(n); return n; },
    remove() {}, removeChild(n) { return n; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600 }; },
    focus() {}, blur() {}, click() {}, closest() { return null; }, matches() { return false; },
    cloneNode() { return makeEl(tag); }, insertBefore(n) { this.children.unshift(n); return n; },
  };
}
const elements = {};
const byId = (id) => (elements[id] || (elements[id] = makeEl('div')));

const documentStub = {
  getElementById: byId, createElement: (t) => makeEl(t),
  createTextNode: (t) => ({ textContent: t }),
  addEventListener() {}, removeEventListener() {},
  documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
  querySelector: () => makeEl('div'), querySelectorAll: () => [],
};
const storage = {};
const localStorageStub = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
  clear: () => { for (const k in storage) delete storage[k]; },
};
class WebSocketStub {
  constructor(url) { this.url = url; this.readyState = WebSocketStub.CONNECTING; this.onopen = null; this.onclose = null; this.onmessage = null; this.onerror = null; }
  send() {}
  close() { this.readyState = WebSocketStub.CLOSED; }
  addEventListener() {} removeEventListener() {}
}
WebSocketStub.CONNECTING = 0; WebSocketStub.OPEN = 1; WebSocketStub.CLOSING = 2; WebSocketStub.CLOSED = 3;
class TerminalStub {
  constructor(opts) { this.options = opts || {}; this.rows = 24; this.cols = 80; }
  loadAddon() {} open() {} write() {} reset() {} focus() {} blur() {} dispose() {}
  on() { return { dispose() {} }; }
  onData() { return { dispose() {} }; }
  get textarea() { return makeEl('textarea'); }
}
const FitAddonStub = function () {};
FitAddonStub.prototype.fit = function () {};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: documentStub, localStorage: localStorageStub,
  WebSocket: WebSocketStub, Terminal: TerminalStub, FitAddon: { FitAddon: FitAddonStub },
  fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost' },
  navigator: { onLine: true, language: 'en' },
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
  performance: { now: () => Date.now() },
  URL, URLSearchParams, JSON, Math, Date, Promise, Set, Map, Array, Object, String, Number, Boolean, RegExp, Error,
  addEventListener() {}, removeEventListener() {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(APP, 'utf8'), ctx, { filename: 'app.js' });
// No-op the pure render functions — this test targets the toggle's STATE logic, not DOM.
vm.runInContext(`
  renderChips = () => {}; renderTabs = () => {}; syncTermButtons = () => {};
  updateLocalBadge = () => {}; renderNeedsYouBadge = () => {}; populateHostSelect = () => {};
`, ctx);

const call = (expr) => vm.runInContext(expr, ctx);
let failed = 0;
function check(name, cond) { console.log((cond ? '  ok  ' : 'FAIL  ') + name); if (!cond) failed++; }
// seed the polled host list so findSession()/updateLocalBadge() resolve
const SEED = `hosts = [{ name:'h', state:'up', sessions:[
  {name:'one', attached:1, cwd:'/x', activity:false},
  {name:'two', attached:1, cwd:'/y', activity:false} ] }];`;
const fakeWs = () => `({ readyState: 1, onclose: null, send(){}, close(){ this.readyState=3; } })`;

console.log('# session tabs toggle');

// Static guard: duplicate element ids in index.html. getElementById resolves to the
// FIRST match in document order, so a second element with the same id is silently
// unreachable — this is how the "Session tabs" checkbox (cfg-tabs) was shadowed by
// the settings modal's tab strip and the toggle appeared to do nothing.
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('index.html has no duplicate element ids', dupes.length === 0);
  if (dupes.length) console.log('  duplicate ids: ' + [...new Set(dupes)].join(', '));
}

check('default tabsEnabled is OFF', call('tabsEnabled') === false);

call('setTabsEnabled(false)');
check('setTabsEnabled(false) flips the flag', call('tabsEnabled') === false);
check('setTabsEnabled(false) persists pc.tabs="0"', storage['pc.tabs'] === '0');

call('setTabsEnabled(true)');
check('setTabsEnabled(true) flips the flag back', call('tabsEnabled') === true);
check('setTabsEnabled(true) persists pc.tabs="1"', storage['pc.tabs'] === '1');

// OFF + a legacy active + click a different chip → legacy swap, no tab
call(`(function(){ ${SEED}
  active = { key:'h:one', host:'h', name:'one', ws:${fakeWs()}, dataSub:{dispose(){}} };
  tabs = []; activeTab = -1; tabsEnabled = false;
  attach('h:two', {}); })()`);
check('OFF: attach does a legacy swap (tabs empty)', call('tabs.length') === 0);
check('OFF: active is the new session', call('active && active.key') === 'h:two');

// ON + a legacy active + click a different chip → converts to two tabs
call(`(function(){ ${SEED}
  active = { key:'h:one', host:'h', name:'one', ws:${fakeWs()}, dataSub:{dispose(){}} };
  tabs = []; activeTab = -1; tabsEnabled = true;
  attach('h:two', {}); })()`);
check('ON: attach opens two tabs', call('tabs.length') === 2);
check('ON: active is null in tab mode', call('active') === null);
check('ON: the new session is the active tab', call('activeTab') === 1);

// OFF while tabs are open → collapse to the selected tab
call(`(function(){
  globalThis.__closed = [];
  const t0 = tabs[0]; const oc = t0.ws.close.bind(t0.ws);
  t0.ws.close = function(){ globalThis.__closed.push(t0.key); return oc(); };
  setTabsEnabled(false); })()`);
check('collapse: tabs cleared', call('tabs.length') === 0);
check('collapse: activeTab reset to -1', call('activeTab') === -1);
check('collapse: selected tab (h:two) becomes the plain active', call('active && active.key') === 'h:two');
check('collapse: kept tab gets the legacy onclose handler', typeof call('active.ws.onclose') === 'function');
check('collapse: non-kept tab (h:one) WS closed', JSON.stringify(call('__closed')) === JSON.stringify(['h:one']));
check('collapse: kept tab WS not closed', call('active.ws.readyState') < 2);

// OFF while the SELECTED tab's socket is dead → reconnect fresh
call(`(function(){ ${SEED}
  active = { key:'h:one', host:'h', name:'one', ws:${fakeWs()}, dataSub:{dispose(){}} };
  tabs = []; activeTab = -1; tabsEnabled = true;
  attach('h:two', {});
  tabs[1].wsDead = true; tabs[1].ws.readyState = 3;
  setTabsEnabled(false); })()`);
check('dead-socket collapse: active is h:two', call('active && active.key') === 'h:two');
check('dead-socket collapse: reconnected (not dead)', call('active.wsDead') !== true);
check('dead-socket collapse: fresh ws has legacy onclose', typeof call('active.ws.onclose') === 'function');

if (failed) { console.log(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nall checks passed');
// app.js starts a polling interval in the VM (host timers) — without an explicit
// exit the process would hang after the last check even though everything passed.
process.exit(0);
