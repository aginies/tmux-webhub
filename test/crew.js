'use strict';
// Crew style test (Settings → Crew: astronauts / minions / evil minions).
// Loads the real vendor art bundle + space-art override in a VM with a
// recording canvas stub, and checks the townCharacter override:
//   - astronauts stay the default; minions/evil swap the sprite
//   - the four minion types (kevin/stuart/bob/otto) differ in geometry
//   - evil minions are purple, closed eyes hide the eyeball
//   - the imperial guard is untouched by the crew mode
//   - the sprite cache separates modes and stays stable across switches
// Plus a wiring sanity check on index.html / app.js (cfg-crew select + pref).
// Run with: node test/crew.js   (also invoked by `npm test`)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// --- recording canvas: every 2D op is logged with the current fillStyle ---
function makeCanvas() {
  const ops = [];
  const canvas = { width: 0, height: 0, ops, toDataURL: () => 'data:,' };
  const state = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return canvas;
      return (...a) => { ops.push([k, t.fillStyle, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  canvas.getContext = () => ctx;
  return canvas;
}

const storage = {};
const sandbox = {
  console,
  document: { createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {} }) },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  },
  performance: { now: () => 0 },
  Math, JSON, Object, Array, Map, Set, String, Number, Boolean, Promise,
  Uint8Array, Float32Array, Int32Array, WeakMap, Infinity, NaN,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/town-art.js'), 'utf8'), ctx, { filename: 'town-art.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/vendor/space-art.js'), 'utf8'), ctx, { filename: 'space-art.js' });

const call = (expr) => vm.runInContext(expr, ctx);
let failed = 0;
function check(name, cond) { console.log((cond ? '  ok  ' : 'FAIL  ') + name); if (!cond) failed++; }

const TA = call('window.HerdrTownArt');
const look = (style) => ({ skin: '#f2c9a0', hair: '#2b2026', shirt: '#4f7cc9', pants: '#2e3447', style });
const render = (lk, dir = 'down', frame = 0, pose = 'stand', eyes = false) => TA.townCharacter(lk, dir, frame, pose, eyes);
const fills = (c) => c.ops.filter((o) => o[0] === 'fillRect').map((o) => o[1]);
const sig = (c) => JSON.stringify(c.ops);

// default mode is minions
check('default crew mode is minions', call('window.WhCrew.mode') === 'minions');
call("window.WhCrew.mode = 'astronauts'");
const astro = render(look(3));
check('astronaut renders the white EVA suit', fills(astro).includes('#f8fafc'));

// minions mode
call("window.WhCrew.mode = 'minions'");
const min = render(look(3));
check('minions mode returns a fresh sprite (cache keyed by mode)', min !== astro);
check('minion has a yellow body', fills(min).includes('#fdd835'));
check('minion wears denim overalls', fills(min).includes('#3b5ba5'));
check('minion is not an astronaut', !fills(min).includes('#f8fafc'));
check('repeat call hits the cache', render(look(3)) === min);

// four distinct types from the deterministic look hash (styles 0..3 cover all four)
const typeSigs = new Set([0, 1, 2, 3].map((s) => sig(render(look(s)))));
check('kevin/stuart/bob/otto are four distinct sprites', typeSigs.size === 4);
// stuart (style 0) is the one-eyed type: a single big goggle → more white than kevin's two
const whiteCount = (c) => c.ops.filter((o) => o[0] === 'fillRect' && o[1] === '#f9fafb').reduce((n, o) => n + o[4] * o[5], 0);
check('stuart single eye vs kevin two eyes (white area differs)', whiteCount(render(look(0))) !== whiteCount(render(look(3))));

// evil mode
call("window.WhCrew.mode = 'evil'");
const evil = render(look(3));
check('evil minion is purple', fills(evil).includes('#a855f7'));
check('evil minion has no yellow skin', !fills(evil).includes('#fdd835'));
check('evil mode returns a fresh sprite', evil !== min && evil !== astro);

// closed eyes hide the eyeball white (checked in minions mode: evil buck
// teeth are white too, so they would false-positive here)
call("window.WhCrew.mode = 'minions'");
const zzz = render(look(3), 'down', 0, 'stand', true);
check('closed eyes: no white eyeball', !fills(zzz).includes('#f9fafb'));
call("window.WhCrew.mode = 'evil'");
// back view has no face
const up = render(look(3), 'up', 0, 'stand', false);
check('back view: no white eyeball', !fills(up).includes('#f9fafb'));
// sit pose differs from stand (typing posture; same mode for a fair compare)
check('sit pose renders differently from stand', sig(render(look(3), 'down', 0, 'sit', false)) !== sig(evil));
// repair crew minion keeps cyan overalls
const rep = render({ tone: 0, hair: 0, isRepair: true });
check('repair minion wears cyan EVA overalls', fills(rep).includes('#0284c7'));

// guard is identical in every mode
const guard = { isGuard: true, isImperial: true, visor: '#ffd700' };
const gEvil = sig(render(guard));
call("window.WhCrew.mode = 'minions'");
const gMin = sig(render(guard));
call("window.WhCrew.mode = 'astronauts'");
const gAst = sig(render(guard));
check('imperial guard untouched by crew mode', gEvil === gMin && gMin === gAst);

// cache stability across mode switches
call("window.WhCrew.mode = 'minions'");
check('switching back to minions reuses the cached sprite', render(look(3)) === min);
// definition upgrade: minions rasterise at 2× resolution with a bold outline
check('minion rendered at 32× resolution (1280×1536)', min.width === 1280 && min.height === 1536);
check('minion has a bold cartoon outline', fills(min).includes('#1f2430'));
call("window.WhCrew.mode = 'astronauts'");
check('switching back to astronauts reuses the cached sprite', render(look(3)) === astro);
check('astronaut rendered at 8× resolution (160×192)', astro.width === 160 && astro.height === 192);

// eye count is a property of the minion TYPE, never of the pose: a one-eyed
// minion (Stuart) keeps exactly one eye seated at the desk, typing, standing,
// and in profile. Pupils are drawn as '#1f2937' fillRects (one per open eye).
call("window.WhCrew.mode = 'minions'");
const pupils = (c) => c.ops.filter((o) => o[0] === 'fillRect' && o[1] === '#1f2937').length;
const stuart = look(0), kevin = look(3);
check('Stuart keeps ONE eye seated at the desk', pupils(render(stuart, 'down', 0, 'sit', false)) === 1);
check('Stuart keeps ONE eye while typing', pupils(render(stuart, 'down', 1, 'sit', false)) === 1);
check('Stuart keeps ONE eye standing', pupils(render(stuart, 'down', 0, 'stand', false)) === 1);
check('Stuart keeps ONE eye in profile', pupils(render(stuart, 'left', 0, 'stand', false)) === 1);
check('Kevin has TWO eyes seated at the desk', pupils(render(kevin, 'down', 0, 'sit', false)) === 2);
check('Kevin has TWO eyes standing', pupils(render(kevin, 'down', 0, 'stand', false)) === 2);
check('profile shows a single eye (Kevin)', pupils(render(kevin, 'right', 0, 'stand', false)) === 1);

// determinism per session name
const n1 = render(TA.townLookFor('alice'));
const n2 = render(TA.townLookFor('alice'));
check('same session name → same sprite', n1 === n2);

// wiring sanity: settings select + browser-only pref
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const town = fs.readFileSync(path.join(ROOT, 'public/town.js'), 'utf8');
check('space theme enlarges the crew (TOWN_AGENT_SCALE > vendor 1.4)', TA.TOWN_AGENT_SCALE > 1.4);
check('rename hit box matches the 20×24 sprite', town.includes('const aw = 20 * AS, ah = 24 * AS;'));
check('session tabs default OFF', app.includes("localStorage.getItem('pc.tabs') === '1'"));

// minion mischief bubble art exists (fart / burp / giggle / banana / pow / dizzy)
const space = fs.readFileSync(path.join(ROOT, 'public/vendor/space-art.js'), 'utf8');
check('mischief bubbles defined', ['fart', 'burp', 'giggle', 'banana', 'pow', 'dizzy'].every((k) => space.includes('sp.bubble.' + k + ' =')));
check('town.js wires the idle mischief (antics + brawl)',
  town.includes('mischiefAt') && town.includes('drawFighter') && town.includes('drawBrawlCloud') && town.includes("activity === 'fight'"));
check('town.js scales high-res minions back to the crew footprint', town.includes('const charScale ='));
check('lounge spots spread on a roomy row + occupancy capped',
  town.includes('(L.y + 4) * TT + 6') && town.includes('if (!spot) continue;'));
check('default crew is minions', app.includes("localStorage.getItem('pc.crew') || 'minions'"));
check('index.html has the cfg-crew select with 3 options',
  /id="cfg-crew"/.test(html) && ['astronauts', 'minions', 'evil'].every((v) => html.includes(`value="${v}"`)));
check('app.js persists the pref (pc.crew) and applies it live',
  app.includes('pc.crew') && app.includes('function setCrew') && app.includes("$('cfg-crew').addEventListener('change'"));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);