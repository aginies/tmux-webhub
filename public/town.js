/* Town view — herdr-world's town as the main page (Phase 2).
 *
 * One building per host, one room per host, one desk per session. Click a desk
 * to attach, click a building to zoom in, wheel/pinch to zoom, drag to pan.
 * The art is the real thing: /vendor/town-art.js (HerdrTownArt, MIT — see
 * LICENSES/herdr-world-MIT.txt). The render pipeline mirrors herdr-world's
 * film (makeTown/drawPod): a static base canvas (ground, landscape, town
 * center, building interiors + facades) plus a per-frame dynamic layer
 * (seated agents, desks, monitors, glows) under a light glass roof, so the
 * people working at the desks stay visible at every zoom (the film's
 * default shots run roofless for exactly this reason).
 *
 * The scene is a night town: always the dark void, whatever the selected skin.
 *
 * API (used by app.js):
 *   const tv = new TownView(canvas, { attach(key) });
 *   tv.update(hosts, activeKey)   // hosts as polled; rebuilds when the spec changes
 *   tv.start() / tv.stop()        // town view on/off
 */
(function () {
  'use strict';
  const TA = window.HerdrTownArt;
  if (!TA) return; // no art bundle → list view only
  const TT = TA.TOWN_TILE;
  const AS = TA.TOWN_AGENT_SCALE;
  const DESK_COLORS = Object.keys(TA.TOWN_DESK_COLORS);
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const Z_MIN = 0.35, Z_MAX = 4;
  // Memory budget per baked static layer, in source pixels. On HiDPI screens the
  // ground/base layers bake at 2x; past this budget they fall back to 1x
  // (16 Mpx ≈ 64 MB per layer at 4 bytes/px; a 4-host town at 2x is ~13 Mpx).
  const MAX_BAKE_PX = 16e6;
  const GUARD_VISOR_GOLD = '#f59e0b'; // resting visor colour
  const GUARD_VISOR_BLINK = '#00e5ff'; // flash colour while acknowledging a poll
  const GUARD_BLINK_STEP = 0.18; // s per half-blink → 3 blinks over ~1.08 s

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

  // buildTownSprites() is pure and layout-independent (a fixed set of pixel art), so
  // bake it once instead of re-rasterizing every sprite on each town rebuild — a
  // session create/kill or host up/down used to regenerate the whole set for no reason.
  let _townSprites = null;
  function townSprites() {
    if (!_townSprites) _townSprites = TA.buildTownSprites();
    return _townSprites;
  }

  class TownView {
    constructor(canvas, api) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.api = api; // { attach(key) }
      this.tip = document.getElementById('town-tip');
      this.on = false;
      this.dpr = 1;
      this.town = null;
      this.specSig = null;
      this.sessions = new Map(); // 'host:name' -> { host, name, activity, cwd }
      this.activeKey = null;
      this.cam = { x: 0, y: 0, z: 1 };
      this.target = null;
      this.hover = null;
      this.naps = new Map(); // 'host:name' -> nap state (idle agents take the sofa)
      this.lastSessions = new Map(); // 'host:name' -> { name, b, entry, feet } (last desk state, for departures)
      this.bus = null; // { route, stop, roadY, cycleMs, haltMs, speed, riders }
      this.busRode = new Set(); // agent keys riding the current bus (hidden while aboard)
      this.repairCrew = {
        state: 'waiting-arrival',
        shipIndex: 0,
        shipStartTime: 0,
        shipDuration: 4.2, // seconds spent welding each ship hull
        lastCycleTime: 0,
        lastT: 0,
        weldingStart: 0,
        a1: { x: 0, y: 0, dir: 'right', look: { tone: 0, hair: 0, isRepair: true } },
        a2: { x: 0, y: 0, dir: 'left', look: { tone: 1, hair: 1, isRepair: true } },
      };
      // Imperial Station Security Guard: the obsidian (black) stormtrooper look
      // is drawn by the space-art.js `townCharacter` override when isGuard/isImperial is set.
      this.guardLook = { isGuard: true, isImperial: true, visor: GUARD_VISOR_GOLD };
      this.guardBlinkUntil = 0; // timestamp (s) up to which the visors blink after a poll
      this.guards = []; // { x, y, hostKey } — one guard per office entrance
      // Hosts hidden from the map by the ORBITAL SESSIONS eye toggle (visual
      // only — polling, sessions and the manifest are untouched). Persisted.
      this.hiddenHosts = new Set();
      try {
        const saved = JSON.parse(localStorage.getItem('pc.hiddenHosts') || '[]');
        if (Array.isArray(saved)) for (const n of saved) if (typeof n === 'string') this.hiddenHosts.add(n);
      } catch {}
      this.nav = new Map();  // hostKey -> TA.TownNavigation (A* through the building)
      this.previewCache = new Map(); // name -> { raw, canvas } offscreen cached tactical cards
      this.layoutCols = 0; // host buildings per row (0 = vendor auto; 2 in portrait)
      this.lift = new Map(); // hostKey -> 0..1 office deploy state (1 online, 0 offline)
      this.needsRedraw = true;
      this.raf = null;
      this.pointers = new Map();
      this.drag = null;

      // iconic sci-fi space traffic (Millennium Falcon, X-Wing, Star Trek Enterprise: max 1-2 active at a time)
      this.spaceTraffic = [
        {
          id: 'falcon',
          active: true,
          passTimer: 0,
          cooldown: 0,
          x: 520, y: 640,
          vx: 130, vy: -15,
          speed: 135,
          targetAngle: -0.12,
          angle: -0.12,
          timer: 0,
          interval: 4,
          trailColor: 'rgba(0, 229, 255, 0.75)',
        },
        {
          id: 'xwing',
          active: false,
          passTimer: 0,
          cooldown: 5.0, // launches after Falcon's pass
          x: 820, y: 700,
          vx: -160, vy: 25,
          speed: 165,
          targetAngle: Math.PI + 0.15,
          angle: Math.PI + 0.15,
          timer: 0,
          interval: 3.2,
          trailColor: 'rgba(244, 63, 94, 0.8)',
        },
        {
          id: 'enterprise',
          active: false,
          passTimer: 0,
          cooldown: 13.0, // enters later
          x: 620, y: 520,
          vx: 85, vy: 20,
          speed: 95,
          targetAngle: 0.25,
          angle: 0.25,
          timer: 0,
          interval: 6,
          trailColor: 'rgba(56, 189, 248, 0.75)',
        },
      ];

      // starfield for the deep-space sky
      this.skyStars = [];
      let seed = 777;
      const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let i = 0; i < 80; i++) {
        this.skyStars.push({
          x: rand(), y: rand(),
          size: rand() < 0.65 ? 1 : rand() < 0.88 ? 2 : 3,
          color: rand() < 0.22 ? '#00e5ff' : rand() < 0.38 ? '#bd93f9' : rand() < 0.52 ? '#f1fa8c' : rand() < 0.68 ? '#8be9fd' : '#ffffff',
          freq: 0.35 + rand() * 0.85, // gentle, slow cosmic twinkle
          phase: rand() * Math.PI * 2,
          spike: rand() > 0.85,
        });
      }

      // slowly rotating spiral galaxies in the sky
      const makeGalaxy = (seedVal, count) => {
        const pts = [];
        let s = seedVal;
        const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
        for (let i = 0; i < count; i++) {
          const arm = i % 2;
          const baseTheta = arm * Math.PI;
          const dist = Math.pow(r(), 1.4);
          const theta = baseTheta + dist * 3.8 + (r() - 0.5) * 0.3;
          pts.push({
            dist: dist + (r() - 0.5) * 0.12,
            theta,
            size: r() < 0.75 ? 1 : 1.5,
            alpha: 0.35 + r() * 0.65,
            isCore: dist < 0.22,
          });
        }
        return pts;
      };

      this.galaxies = [
        {
          nx: 0.88, ny: 0.11, // High open sky on the right
          radius: 46,
          tilt: 0.58,
          angle: 0.45,
          speed: -0.05, // counter-clockwise slow rotation
          coreColor: '#e0faff',
          haloColor: 'rgba(0, 229, 255, 0.38)',
          armColor1: 'rgba(0, 229, 255, 0.85)',
          armColor2: 'rgba(241, 250, 140, 0.8)',
          stars: makeGalaxy(8765, 120),
        },
      ];

      // precompute the dimmed outer-halo stop and bake spiral galaxy to offscreen canvas
      for (const g of this.galaxies) {
        g.haloColor2 = g.haloColor.replace(/[\d.]+\)$/, '0.1)');
        const rad = g.radius;
        const size = Math.ceil(rad * 2 + 16);
        const c = document.createElement('canvas');
        c.width = size * 2; c.height = size * 2; // 2x bake for HiDPI crispness
        const ctx = c.getContext('2d');
        const cx = size / 2, cy = size / 2;

        ctx.scale(2, 2);
        ctx.translate(cx, cy);

        // Outer diffuse galactic haze
        const outerHalo = ctx.createRadialGradient(0, 0, rad * 0.2, 0, 0, rad);
        outerHalo.addColorStop(0, g.haloColor);
        outerHalo.addColorStop(0.65, g.haloColor2);
        outerHalo.addColorStop(1, 'transparent');
        ctx.fillStyle = outerHalo;
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fill();

        // Continuous glowing spiral gas arms
        for (let arm = 0; arm < 2; arm++) {
          const armBase = arm * Math.PI;
          ctx.beginPath();
          for (let step = 0; step <= 36; step++) {
            const frac = step / 36;
            const r = Math.pow(frac, 1.25) * rad;
            const theta = armBase + frac * 4.2;
            const px = Math.cos(theta) * r;
            const py = Math.sin(theta) * r;
            if (step === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.strokeStyle = arm === 0 ? g.armColor1 : g.armColor2;
          ctx.lineWidth = 3.5;
          ctx.stroke();

          // Inner brighter arm filament
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
          ctx.stroke();
        }

        // Spiral arm stardust clusters
        for (const st of g.stars) {
          const r = st.dist * rad;
          const px = Math.cos(st.theta) * r;
          const py = Math.sin(st.theta) * r;
          ctx.fillStyle = st.isCore ? '#ffffff' : (st.dist < 0.5 ? g.armColor1 : g.armColor2);
          ctx.globalAlpha = st.alpha;
          ctx.fillRect(px - st.size / 2, py - st.size / 2, st.size, st.size);
        }

        // Brilliant central core
        ctx.globalAlpha = 1;
        const coreHalo = ctx.createRadialGradient(0, 0, 1, 0, 0, rad * 0.35);
        coreHalo.addColorStop(0, '#ffffff');
        coreHalo.addColorStop(0.35, g.coreColor);
        coreHalo.addColorStop(1, 'transparent');
        ctx.fillStyle = coreHalo;
        ctx.beginPath();
        ctx.arc(0, 0, rad * 0.35, 0, Math.PI * 2);
        ctx.fill();

        // Central supermassive nucleus point
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
        ctx.fill();

        g.canvas = c;
        g.offset = size / 2;
        g.size = size;
      }

      // Pre-baked pod glow sprites (drawPod): a createRadialGradient + 'lighter' fill per
      // working/active pod per frame was the priciest fill in the pod loop. The two
      // variants are static — bake each once at 2x (80x80 → 40x40 world units) and draw
      // with globalAlpha = pulse*0.55; the compositing result is identical.
      const bakeGlow = (rgb) => {
        const c = document.createElement('canvas');
        c.width = 80; c.height = 80;
        const gc = c.getContext('2d');
        const gg = gc.createRadialGradient(40, 40, 0, 40, 40, 40);
        gg.addColorStop(0, 'rgba(' + rgb + ',1)');
        gg.addColorStop(1, 'rgba(' + rgb + ',0)');
        gc.fillStyle = gg;
        gc.fillRect(0, 0, 80, 80);
        return c;
      };
      this.glowWorking = bakeGlow('0,180,255');
      this.glowActive = bakeGlow('0,229,255');

      // Pre-baked holographic projection light beam (drawPreview)
      const bakeBeam = (active) => {
        const c = document.createElement('canvas');
        c.width = 208; c.height = 12; // 2x bake (drawn at 104×6)
        const bc = c.getContext('2d');
        bc.scale(2, 2);
        const cx = 52;
        const beam = bc.createLinearGradient(cx, 0, cx, 6);
        beam.addColorStop(0, active ? 'rgba(0, 229, 255, 0.55)' : 'rgba(0, 180, 255, 0.35)');
        beam.addColorStop(0.4, active ? 'rgba(0, 200, 255, 0.25)' : 'rgba(0, 150, 255, 0.15)');
        beam.addColorStop(1, 'rgba(0, 229, 255, 0.04)');
        bc.fillStyle = beam;
        bc.beginPath();
        bc.moveTo(cx - 3, 0);
        bc.lineTo(cx + 3, 0);
        bc.lineTo(104, 6);
        bc.lineTo(0, 6);
        bc.closePath();
        bc.fill();
        return c;
      };
      this.holoBeamActive = bakeBeam(true);
      this.holoBeamWorking = bakeBeam(false);

      // Pre-baked settings gear badges (drawCenterBadge)
      const bakeCenterBadge = (hover) => {
        const c = document.createElement('canvas');
        c.width = 52; c.height = 52; // 2x bake (drawn at 26×26)
        const bc = c.getContext('2d');
        bc.scale(2, 2);
        const cx = 13, cy = 13, R = 8;
        bc.beginPath();
        bc.arc(cx, cy, R + 3, 0, Math.PI * 2);
        bc.fillStyle = hover ? 'rgba(122,162,247,.95)' : 'rgba(20,26,40,.88)';
        bc.fill();
        bc.strokeStyle = hover ? '#cdd9ff' : 'rgba(167,181,218,.6)';
        bc.lineWidth = 1.5;
        bc.stroke();
        const gc = hover ? '#0a0e18' : '#c9d4f0';
        bc.strokeStyle = gc;
        bc.fillStyle = gc;
        bc.lineWidth = 1.5;
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          bc.beginPath();
          bc.moveTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2));
          bc.lineTo(cx + Math.cos(a) * (R + 1), cy + Math.sin(a) * (R + 1));
          bc.stroke();
        }
        bc.beginPath();
        bc.arc(cx, cy, R - 2, 0, Math.PI * 2);
        bc.stroke();
        bc.beginPath();
        bc.arc(cx, cy, 2, 0, Math.PI * 2);
        bc.fill();
        return c;
      };
      this.centerBadgeNormal = bakeCenterBadge(false);
      this.centerBadgeHover = bakeCenterBadge(true);

      // Pre-baked space traffic engine plume trails (drawSpaceTraffic)
      for (const ship of this.spaceTraffic) {
        const tc = document.createElement('canvas');
        tc.width = 48; tc.height = 8;
        const tctx = tc.getContext('2d');
        const tg = tctx.createLinearGradient(0, 0, 48, 0);
        tg.addColorStop(0, 'transparent');
        tg.addColorStop(0.4, ship.trailColor);
        tg.addColorStop(1, '#ffffff');
        tctx.fillStyle = tg;
        tctx.fillRect(0, 0, 48, 8);
        ship.trailCanvas = tc;
      }

      // Smart Eco activity tracking
      this.lastActivityTime = performance.now();
      const onUserActive = () => {
        this.lastActivityTime = performance.now();
        this.needsRedraw = true;
      };
      window.addEventListener('pointerdown', onUserActive, { passive: true });
      window.addEventListener('pointermove', onUserActive, { passive: true });
      window.addEventListener('keydown', onUserActive, { passive: true });
      window.addEventListener('focus', onUserActive);
      window.addEventListener('blur', () => { this.needsRedraw = true; });

      canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      window.addEventListener('pointermove', (e) => this.onPointerMove(e));
      window.addEventListener('pointerup', (e) => this.onPointerUp(e));
      canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
      canvas.addEventListener('pointerleave', () => this.setHover(null, null));
      window.addEventListener('resize', () => this.resize());
      // map controls (+ / − / All): zoom about the view center, fit the whole town
      const ctl = document.getElementById('town-ctl');
      if (ctl) {
        const tvt = ctl.querySelector('#town-view-toggle');
        if (tvt) tvt.addEventListener('click', () => { const vt = document.getElementById('view-toggle'); if (vt) vt.click(); });
        const tKeys = ctl.querySelector('#town-keys');
        if (tKeys) tKeys.addEventListener('click', () => { const bk = document.getElementById('btn-keys'); if (bk) bk.click(); });
        ctl.querySelector('#town-zin').addEventListener('click', () => this.zoomBy(1.5));
        ctl.querySelector('#town-zout').addEventListener('click', () => this.zoomBy(1 / 1.5));
        ctl.querySelector('#town-zall').addEventListener('click', () => this.fitCamera(false));
      }
    }

    /* ---------- lifecycle ---------- */

    start() {
      if (this.on) return;
      this.on = true;
      this.resize();
      // the host signs are canvas text: make sure the pixel font is loaded, then repaint
      if (document.fonts && document.fonts.load) {
        document.fonts.load('700 10px Silkscreen').then(() => { this.needsRedraw = true; }).catch(() => {});
      }
      this.raf = requestAnimationFrame(this.frame);
    }

    stop() {
      this.on = false;
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
      this.setHover(null, null);
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (!w || !h) return;
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
      this.dpr = dpr;

      // Pre-bake cosmic nebulae gradients once on resize (zero per-frame gradient allocations)
      const nc = document.createElement('canvas');
      nc.width = Math.round(w); nc.height = Math.round(h);
      const nctx = nc.getContext('2d');
      const n1 = nctx.createRadialGradient(w * 0.22, h * 0.35, 10, w * 0.22, h * 0.35, Math.max(w, h) * 0.4);
      n1.addColorStop(0, 'rgba(110, 40, 180, 0.12)');
      n1.addColorStop(1, 'transparent');
      nctx.fillStyle = n1;
      nctx.fillRect(0, 0, w, h);
      const n2 = nctx.createRadialGradient(w * 0.78, h * 0.55, 10, w * 0.78, h * 0.55, Math.max(w, h) * 0.45);
      n2.addColorStop(0, 'rgba(0, 150, 255, 0.10)');
      n2.addColorStop(1, 'transparent');
      nctx.fillStyle = n2;
      nctx.fillRect(0, 0, w, h);
      this.nebulaCanvas = nc;

      // A portrait↔landscape flip changes how many offices fit per row; re-lay
      // the town out so every host keeps showing on screen. Moving to a monitor
      // with a different devicePixelRatio changes the HiDPI bake scale — re-bake
      // the static layers too, but leave the camera alone.
      const cols = this.layoutColumns();
      if (this.town && this.hosts && this.hosts.length) {
        const relayout = cols !== this.layoutCols;
        const rebake = this.bakeSFor(this.town.Wp, this.town.Hp) !== this.town.S;
        if (relayout || rebake) {
          this.buildTown(this.hosts);
          if (relayout) this.initialCamera();
        }
      }

      this.needsRedraw = true;
    }

    /* ---------- data ---------- */

    update(hosts, activeKey) {
      this.activeKey = activeKey;
      // A poll (SSH sync of each host's tmux sessions) just happened → the
      // guards acknowledge it: visor blinks 3 times, then settles back to gold.
      this.guardBlinkUntil = performance.now() / 1000 + GUARD_BLINK_STEP * 6;
      const sessions = new Map();
      const sigHosts = [], sigRooms = [];
      for (const h of hosts) {
        sigHosts.push(h.name + (this.hostOff(h.name) ? ':off' : ''));
        const names = (h.sessions || []).map((s) => s.name);
        sigRooms.push(h.name + ':' + names.join(','));
        for (const s of h.sessions || []) {
          sessions.set(h.name + ':' + s.name, { host: h, name: s.name, activity: !!s.activity, cwd: s.cwd || '', preview: s.preview || '' });
        }
      }
      this.sessions = sessions;
      // Prune the offscreen preview cards of sessions that no longer exist — each
      // entry is a supersampled canvas (up to ~1.5 MB at high zoom/HiDPI) keyed by
      // host:name, and nothing else ever removes it, so the cache would grow without
      // bound as sessions come and go over the page's lifetime.
      for (const k of [...this.previewCache.keys()]) if (!sessions.has(k)) this.previewCache.delete(k);
      this.hosts = hosts;
      const hostSig = JSON.stringify(sigHosts);
      const sig = JSON.stringify([sigHosts, sigRooms]);
      if (sig !== this.specSig) {
        const first = !this.town;
        const hostsChanged = this.hostSig !== hostSig;
        this.specSig = sig;
        this.hostSig = hostSig;
        this.buildTown(hosts);
        // sessions coming and going must not yank the camera; a new/lost
        // host (or the very first build) re-centres on the street
        if (this.town && (first || hostsChanged)) this.initialCamera();
      }
      this.syncNaps();
      this.updateStorageShipLayout();
      this.needsRedraw = true;
    }

    deskColor(name) {
      return DESK_COLORS[hash(name) % DESK_COLORS.length];
    }

    hostOff(name) {
      const h = (this.hosts || []).find((x) => x.name === name);
      return !h || h.enabled === false || h.state === 'offline' || !!h.error;
    }

    isHostHidden(name) {
      return this.hiddenHosts.has(name);
    }

    // The eye + slide switch of an ORBITAL SESSIONS row: show/hide that host's
    // office on the map. Visual only — polling and sessions keep running, the
    // row stays in the manifest (dimmed) so it can be brought back.
    toggleHostVisible(name) {
      if (this.hiddenHosts.has(name)) this.hiddenHosts.delete(name);
      else this.hiddenHosts.add(name);
      try { localStorage.setItem('pc.hiddenHosts', JSON.stringify([...this.hiddenHosts])); } catch {}
      if (this.hosts && this.hosts.length) {
        this.buildTown(this.hosts);
        this.updateStorageShipLayout();
        this.initialCamera();
      }
      this.needsRedraw = true;
    }

    // How many host offices per row. One office per ~280px of viewport width,
    // clamped to 1..5 (and by the number of hosts), so wide windows fit more
    // per row instead of being capped at 2.
    layoutColumns() {
      const n = (this.hosts || []).length;
      const w = this.cv.clientWidth || 0;
      if (!w || !n) return 0;
      return Math.max(1, Math.min(5, n, Math.floor(w / 280)));
    }

    // Per-host deploy value (0 = retracted/offline → 1 = deployed/online),
    // eased each frame so a host going down collapses its office canopy and
    // coming back up redeploys it.
    hostLift(hostKey) {
      const v = this.lift.get(hostKey);
      if (v != null) return v;
      return this.hostOff(hostKey) ? 0 : 1;
    }

    updateHostLift() {
      if (!this.town || !this.town.roofs) return;
      const k = REDUCED ? 1 : 0.1;
      for (const r of this.town.roofs) {
        const key = r.host;
        const target = this.hostOff(key) ? 0 : 1;
        const cur = this.lift.has(key) ? this.lift.get(key) : target;
        const next = cur + (target - cur) * k;
        this.lift.set(key, Math.abs(target - next) < 0.004 ? target : next);
      }
    }

    // A stationary station-security guard. It stands at attention; on each
    // poll its visor blinks 3 times (gold ↔ cyan), then returns to gold.
    drawGuard(g, t) {
      const { ctx } = this;
      const off = this.hostOff(g.hostKey);
      const blinking = !off && t < this.guardBlinkUntil;
      const phase = blinking ? Math.floor((this.guardBlinkUntil - t) / GUARD_BLINK_STEP) % 2 : 0;
      this.guardLook.visor = phase ? GUARD_VISOR_BLINK : GUARD_VISOR_GOLD;
      const c = TA.townCharacter(this.guardLook, 'down', 0, 'stand', false);
      const gs = 1.6; // taller guard (matches the previous seated scale)
      const w = c.width * gs, h = c.height * gs;
      ctx.fillStyle = 'rgba(0,0,0,.22)';
      ctx.fillRect(Math.round(g.x) - 5, Math.round(g.y) - 1, 10, 3);
      ctx.drawImage(this.sprite2x(c), Math.round(g.x) - w / 2, Math.round(g.y) - h + 1, w, h);
    }

    /* ---------- building the static scene ---------- */

    buildTown(hosts) {
      if (!hosts.length) { this.town = null; return; }
      // Hosts hidden by the ORBITAL SESSIONS eye toggle stay out of the map
      // layout; the others reflow (an all-hidden town is just the citadel +
      // the storage ship, and the manifest remains the way back).
      const visible = this.hiddenHosts.size ? hosts.filter((h) => !this.hiddenHosts.has(h.name)) : hosts;
      const input = {
        hosts: visible.map((h, i) => ({ key: h.name, displayOrder: i })),
        rooms: visible.map((h, i) => ({
          key: 'main', hostKey: h.name, order: i,
          deskKeys: (h.sessions || []).map((s) => s.name),
          deskSeats: (h.sessions || []).map(() => 1),
        })),
      };
      const cols = this.layoutColumns();
      const formFactor = cols
        ? { formFactor: 'wide', roomColumns: 3, deskColumns: 8, buildingColumns: cols }
        : 'wide';
      this.layoutCols = cols;
      const { layout } = TA.layoutTown(input, formFactor);
      const sp = townSprites();
      const M = 32; // margin around the layout (the film uses spec.margin * TT)
      const Wp = layout.width * TT + 2 * M, Hp = layout.height * TT + 2 * M;
      // HiDPI: bake the static layers at 2x so the per-frame blit maps ~1:1 onto
      // device pixels instead of bilinear-upscaling a 1x bake. 1x displays (and
      // towns past the memory budget) keep the old 1x bakes — zero extra cost.
      const S = this.bakeSFor(Wp, Hp);
      this.bakeS = S;

      // Two baked layers so the EVA repair astronauts pass *behind* the offices
      // (occluded by the modules) while staying visible over the street:
      //   ground — grass/roads + town center + transit guideline
      //   base   — office interiors, furniture, guard and facades
      const ground = document.createElement('canvas');
      ground.width = Wp * S; ground.height = Hp * S;
      const gg = ground.getContext('2d');
      gg.imageSmoothingEnabled = false;
      gg.scale(S, S);
      gg.drawImage(TA.paintTownGround(layout, { x: -M, y: -M, w: Wp, h: Hp }), 0, 0);
      gg.translate(M, M);

      // landscape + town center, depth-sorted by feet y
      const items = [];
      const center = layout.center;
      items.push([(center.y + center.h) * TT, () => this.bakeCitadel(gg, center)]);
      items.sort((a, b) => a[0] - b[0]).forEach((i) => i[1]());

      // Segmented glowing cyan transit guideline on the shuttle's road (at the
      // shuttle centerline): soft glow underlay + dashed neon core. Everything
      // is baked into the ground layer, so the richer look is free per frame.
      const busRoute = TA.townBusRoute(layout);
      const busStop = busRoute && busRoute.stops[0];
      const roadY = busStop ? (busStop.wait.y - 27) : ((layout.roads[0] + 1) * TT + 29);
      gg.lineCap = 'round';
      for (const [gw, ga] of [[9, 'rgba(0, 229, 255, 0.05)'], [5, 'rgba(0, 229, 255, 0.10)']]) {
        gg.strokeStyle = ga;
        gg.lineWidth = gw;
        gg.beginPath();
        gg.moveTo(-M, roadY);
        gg.lineTo(Wp, roadY);
        gg.stroke();
      }
      gg.strokeStyle = 'rgba(0, 229, 255, 0.45)';
      gg.lineWidth = 1.5;
      gg.setLineDash([16, 12]);
      gg.beginPath();
      gg.moveTo(-M, roadY);
      gg.lineTo(Wp, roadY);
      gg.stroke();
      gg.setLineDash([]);
      gg.lineCap = 'butt';

      // The offices layer is transparent elsewhere: the EVA repair crew is
      // drawn between it and the ground so buildings occlude the astronauts.
      const base = document.createElement('canvas');
      base.width = Wp * S; base.height = Hp * S;
      const g = base.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.scale(S, S);
      g.translate(M, M);

      // buildings: interior (floors, walls, desks' furniture), lounge, facade;
      // roofs are kept for the per-frame layer (they fade when you look inside)
      const cells = new Map(), roofs = [];
      this.guards = [];
      layout.buildings.forEach((b, i) => {
        const theme = TA.TOWN_HOST_THEMES[i % TA.TOWN_HOST_THEMES.length];
        g.drawImage(TA.paintTownInterior(b, theme, {
          table: sp.table, tableSmall: sp.tableSmall, chair: sp.chair, chairBack: sp.chairBack,
          colorFor: (k) => this.deskColor(k),
        }), b.x * TT, b.y * TT);
        b.plants.forEach((p) => g.drawImage(sp.plant, p.x * TT, (p.y + 1) * TT - 24));
        const L = b.lounge;
        g.drawImage(sp.sofa, (L.x + 1) * TT - 1, (L.y + 1) * TT - 8);
        g.drawImage(sp.sofa, (L.x + 1) * TT - 1, (L.y + 3) * TT - 8); // second sofa, one below the other
        g.drawImage(sp.coffee, (L.x + 4) * TT + 1, (L.y + 1) * TT - 10);
        g.drawImage(sp.cooler, (L.x + 5) * TT + 2, (L.y + 1) * TT - 12);
        if (sp.pingpong) g.drawImage(sp.pingpong, (L.x + 7) * TT, (L.y + 1) * TT - 8);
        const cx = b.doorX * TT, cy = (b.counter.y + 1) * TT - 8;
        // The imperial guard patrols the office entrance, left ↔ right.
        this.guards.push({ x: cx, y: cy + 9, hostKey: b.hostKey });
        // "+" new-session button right of the reception counter ("à l'accueil")
        b.plus = { x: cx + 44, y: cy - 3, s: 18 };
        g.drawImage(TA.paintTownFacade(b, theme), b.x * TT, (b.y + b.h) * TT);
        this.bakeHostSigns(b);
        const rc = TA.paintTownRoof(b, theme, this.hostOff(b.hostKey));
        roofs.push({ host: b.hostKey, c: this.pixelScale(rc, S), lw: rc.width, lh: rc.height, x: b.x * TT - 4, y: b.y * TT - 12, b });
        b.rooms.forEach((r) => r.cells.forEach((cell) => {
          if (cell.deskKey) cells.set(b.hostKey + ':' + cell.deskKey, { cell, b, name: cell.deskKey });
        }));
      });

      // Orbital Storage Starship / Data Vault to the left of the Town Hall
      const shipW = 560, shipH = 215;
      const shipX = center.x * TT - shipW - 40;
      const shipY = center.y * TT + 10;
      const storageShip = { x: shipX, y: shipY, w: shipW, h: shipH, items: [], hostItems: [] };
      this.bakeStorageShipHull(storageShip);

      this.town = { layout, ground, base, M, S, sp, cells, roofs, Wp, Hp, storageShip };
      this.nav.clear(); // navigation grids are bound to the building objects
      this.reanchorNaps();
      this.setupBus();
    }

    // the town's bus: it loops along the road by the town center, halting at
    // the main stop where idle agents can wait and board (the film's bus).
    setupBus() {
      if (!this.town) { this.bus = null; return; }
      const layout = this.town.layout;
      const route = TA.townBusRoute(layout);
      if (!route || !route.stops.length) { this.bus = null; return; }
      // the stop nearest the town center is the main stop
      const c = layout.center;
      const cx = (c.x + c.w / 2) * TT, cy = (c.y + c.h) * TT;
      let stop = route.stops[0], best = Infinity;
      for (const s of route.stops) {
        const d = Math.abs(s.wait.x - cx) + Math.abs(s.wait.y - cy);
        if (d < best) { best = d; stop = s; }
      }
      this.bus = {
        route, stop,
        roadY: stop.wait.y - 18, // on the street (above the sidewalk stop)
        cycleMs: 22000, // between arrivals
        haltMs: 3500,   // how long it halts at the stop
        speed: 300,     // px / s
        riders: [],     // worker names aboard (shown in the passenger window)
        crew: this.repairCrew.state === 'waiting-arrival'
          ? [this.repairCrew.a1.look, this.repairCrew.a2.look] // repair crew rides aboard
          : [],
      };
      this.busRode.clear();
    }

    // the bus position at time t: { x, y, hazard, riders } or null (between runs)
    busAt(t) {
      if (!this.bus) return null;
      const b = this.bus;
      const W = this.town.layout.width * TT;
      const roadLeft = -40, roadRight = W + 40;
      const stopX = b.stop.wait.x - 46; // the bus halts just short of the stop
      const driveIn = (stopX - roadLeft) / b.speed * 1000;
      const driveOut = (roadRight - stopX) / b.speed * 1000;
      const enterMs = 0, arriveMs = driveIn, departMs = arriveMs + b.haltMs, exitMs = departMs + driveOut;
      const cycleMs = exitMs + 4000; // a gap between runs
      const phase = (t * 1000) % cycleMs;
      if (phase < enterMs || phase >= exitMs) return null;
      const eo = (u) => u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      let x, hazard = false;
      if (phase < arriveMs) x = roadLeft + (stopX - roadLeft) * eo((phase - enterMs) / driveIn);
      else if (phase < departMs) { x = stopX; hazard = true; }
      else x = stopX + (roadRight - stopX) * Math.pow((phase - departMs) / driveOut, 2);
      return { x, y: b.roadY, hazard, riders: b.riders, crew: b.crew };
    }

    // waypoints from a point inside the building out to the main bus stop's
    // queue (out the door, up to the road, along the road to the stop)
    busWaypoints(b, from, spot) {
      const stop = this.bus.stop;
      const ex = b.entryX * TT + 8;
      const fromPt = Array.isArray(from) ? from : [from.x, from.y];
      const destPt = spot ? (Array.isArray(spot) ? spot : [spot.x, spot.y]) : [stop.wait.x, stop.wait.y];
      return [
        fromPt,
        [ex, (b.y + 1) * TT + 13],
        [ex, b.y * TT + 2],
        [ex, stop.wait.y],
        destPt,
      ];
    }

    // board the bus: every agent waiting at the main stop gets on (shown in
    // the windows) and is hidden while aboard
    boardBus() {
      const board = (map) => {
        for (const [key, nap] of [...map]) {
          if (nap.phase !== 'waiting-bus') continue;
          const name = this.agentName(key);
          if (name) this.bus.riders.push(name);
          this.busRode.add(key);
          map.delete(key);
        }
      };
      board(this.naps);
    }

    // advance the bus: board riders when it halts, release them when it leaves
    updateBus(t) {
      if (!this.bus) { this._busHalt = false; this._busVisible = false; return; }
      const bus = this.busAt(t);
      const isHalt = !!(bus && bus.hazard);
      const isVisible = !!bus;
      if (isHalt) this.boardBus();
      if (this._busVisible && !isVisible) { this.bus.riders = []; this.busRode.clear(); }
      this._busHalt = isHalt;
      this._busVisible = isVisible;
    }

    // A random exterior repair spot on an office hull, plus its weld point on
    // the hull surface (so the laser flare lands on the ship, not in space).
    repairSpot(b) {
      const px = b.x * TT, py = b.y * TT;
      const w = b.w * TT, h = b.h * TT;
      const off = 14;                        // stand-off distance from the hull
      const f = 0.25 + Math.random() * 0.5;  // 0.25..0.75 along an edge
      const side = Math.floor(Math.random() * 4);
      if (side === 0) return { x: px + f * w, y: py - off, wx: px + f * w, wy: py - 2 };          // top
      if (side === 1) return { x: px + w + off, y: py + f * h, wx: px + w + 2, wy: py + f * h };  // right
      if (side === 2) return { x: px + f * w, y: py + h + off, wx: px + f * w, wy: py + h + 2 };  // bottom
      return { x: px - off, y: py + f * h, wx: px - 2, wy: py + f * h };                         // left
    }

    // EVA Astronaut Repair Crew: arrive in the shuttle, repair all starship offices on the outside, and depart in the shuttle
    updateRepairCrew(t) {
      if (!this.bus || !this.town) return;
      const crew = this.repairCrew;
      const bus = this.busAt(t);
      const isHalt = !!(bus && bus.hazard);
      const stop = this.bus.stop;
      const stopX = stop.wait.x, stopY = stop.wait.y;
      const buildings = this.town.layout.buildings;

      // 1. Arrival: shuttle halts at docking beacon
      if (crew.state === 'waiting-arrival') {
        if (isHalt && (t - crew.lastCycleTime > 10)) {
          crew.state = 'repairing';
          crew.shipIndex = 0;
          crew.targetShip = -1;   // force fresh random repair spots
          crew.t1 = null; crew.t2 = null;
          crew.shipStartTime = t;
          crew.weldingStart = 0;
          crew.a1.x = stopX - 14; crew.a1.y = stopY;
          crew.a2.x = stopX + 14; crew.a2.y = stopY;
          this.bus.crew = []; // the crew has gotten off the shuttle
        }
        return;
      }

      // Delta time & zero-g exterior flight speed
      const dt = crew.lastT ? Math.min(0.1, t - crew.lastT) : 0.016;
      crew.lastT = t;
      const speed = 140; // px / s

      const moveAstronaut = (a, tx, ty) => {
        const dx = tx - a.x, dy = ty - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 3) {
          const step = Math.min(dist, speed * dt);
          a.x += (dx / dist) * step;
          a.y += (dy / dist) * step;
          a.dir = dx >= 0 ? 'right' : 'left';
          return false;
        }
        a.x = tx; a.y = ty;
        return true;
      };

      // 2. Repairing office starships outside
      if (crew.state === 'repairing') {
        if (!buildings.length || crew.shipIndex >= buildings.length) {
          crew.state = 'returning';
          return;
        }
        const b = buildings[crew.shipIndex];
        // pick fresh random repair spots once per office
        if (!crew.t1 || crew.targetShip !== crew.shipIndex) {
          crew.targetShip = crew.shipIndex;
          crew.t1 = this.repairSpot(b);
          crew.t2 = this.repairSpot(b);
        }

        const arr1 = moveAstronaut(crew.a1, crew.t1.x, crew.t1.y);
        const arr2 = moveAstronaut(crew.a2, crew.t2.x, crew.t2.y);

        if (arr1 && arr2) {
          if (!crew.weldingStart) crew.weldingStart = t;
          if (t - crew.weldingStart >= crew.shipDuration) {
            crew.shipIndex++;
            crew.weldingStart = 0;
          }
        }
        return;
      }

      // 3. Returning to docking beacon
      if (crew.state === 'returning') {
        const arr1 = moveAstronaut(crew.a1, stopX - 14, stopY);
        const arr2 = moveAstronaut(crew.a2, stopX + 14, stopY);
        if (arr1 && arr2) {
          crew.state = 'waiting-departure';
        }
        return;
      }

      // 4. Waiting for shuttle departure
      if (crew.state === 'waiting-departure') {
        if (isHalt) {
          crew.state = 'waiting-arrival';
          crew.lastCycleTime = t;
          this.bus.crew = [crew.a1.look, crew.a2.look]; // board the shuttle
        }
      }
    }

    drawRepairCrew(ctx, t) {
      const crew = this.repairCrew;
      if (!crew || crew.state === 'waiting-arrival') return;

      const isRepairing = (crew.state === 'repairing' && this.town.layout.buildings[crew.shipIndex]);
      const currentShip = isRepairing ? this.town.layout.buildings[crew.shipIndex] : null;

      const drawWorker = (a, weldPoint) => {
        const wf = Math.floor(t * 8) % 4;
        const c = TA.townCharacter(a.look, a.dir, wf, 'stand', false);
        const w = c.width * AS, h = c.height * AS;
        const ax = Math.round(a.x), ay = Math.round(a.y);

        // Zero-g thruster puffs when floating
        if (!weldPoint) {
          ctx.fillStyle = 'rgba(0, 229, 255, 0.75)';
          const puffOff = a.dir === 'right' ? -w / 2 - 3 : w / 2 + 1;
          ctx.fillRect(ax + puffOff, ay - h / 2, 3, 3);
        }

        ctx.drawImage(this.sprite2x(c), ax - w / 2, ay - h + 1, w, h);

        // Exterior laser welding & spark effects on hull
        if (weldPoint) {
          const wx = weldPoint.x, wy = weldPoint.y;
          const flicker = Math.sin(t * 45) > 0;

          // Laser welding beam from hands to hull seam
          ctx.strokeStyle = flicker ? '#00e5ff' : '#fef08a';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(ax + (a.dir === 'left' ? -6 : 6), ay - h / 2);
          ctx.lineTo(wx, wy);
          ctx.stroke();

          // Pulsing plasma weld flare on the hull
          const flare = ctx.createRadialGradient(wx, wy, 0, wx, wy, 12);
          flare.addColorStop(0, '#ffffff');
          flare.addColorStop(0.35, '#38bdf8');
          flare.addColorStop(0.7, 'rgba(0, 229, 255, 0.4)');
          flare.addColorStop(1, 'transparent');
          ctx.fillStyle = flare;
          ctx.beginPath();
          ctx.arc(wx, wy, 12, 0, Math.PI * 2);
          ctx.fill();

          // Flying golden spark particles
          ctx.fillStyle = '#fef08a';
          for (let s = 0; s < 6; s++) {
            const spT = ((t * 9 + s * 1.618) % 1);
            const ang = (s * Math.PI * 2) / 6 + Math.sin(t * 18 + s);
            const dist = spT * 14;
            const sx = wx + Math.cos(ang) * dist;
            const sy = wy + Math.sin(ang) * dist - spT * 3;
            ctx.fillRect(sx, sy, 1.5, 1.5);
          }
        }
      };

      let w1 = null, w2 = null;
      if (currentShip && crew.weldingStart && crew.t1 && crew.t2) {
        if (Math.hypot(crew.a1.x - crew.t1.x, crew.a1.y - crew.t1.y) < 5) w1 = { x: crew.t1.wx, y: crew.t1.wy };
        if (Math.hypot(crew.a2.x - crew.t2.x, crew.a2.y - crew.t2.y) < 5) w2 = { x: crew.t2.wx, y: crew.t2.wy };
      }

      drawWorker(crew.a1, w1);
      drawWorker(crew.a2, w2);

      // Status indicator tag over the ship being repaired
      if (currentShip && (w1 || w2)) {
        const topX = (currentShip.x + currentShip.w / 2) * TT;
        const topY = currentShip.y * TT - 40;
        ctx.fillStyle = 'rgba(10, 15, 25, 0.9)';
        ctx.fillRect(topX - 44, topY, 88, 16);
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(topX - 44, topY, 88, 16);

        ctx.font = '700 8px "JetBrains Mono", monospace';
        ctx.fillStyle = '#00e5ff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚙ HULL REPAIR', topX, topY + 8);
        ctx.textAlign = 'left';
      }
    }

    /* ---------- idle agents: front-desk check-in (✓), then nap / water / bus ---------- */

    // how long the ✓ ("report done") shows at the front desk
    checkMs() { return 1800; }

    // stand to the left of the reception counter, facing it — the report spot
    frontPos(b) {
      const cx = b.doorX * TT, cy = (b.counter.y + 1) * TT - 8;
      return { x: cx - 26, y: cy + 4 };
    }

    // Waypoints straight to an idle agent's rest spot (sofa / water / food /
    // bus queue), skipping the reception check-in. `from` is an optional
    // mid-walk [x, y]; otherwise the desk is the start.
    restWaypoints(at, p, from) {
      const spot = [p.spot.x, p.spot.y];
      if (p.activity === 'bus' && this.bus) {
        return from
          ? this.busWaypoints(at.b, from, p.spot)
          : [at.feet, at.entry, ...this.busWaypoints(at.b, at.entry, p.spot).slice(1)];
      }
      return from ? [from, spot] : [at.feet, at.entry, spot];
    }

    // the water / nutrient synthesizer spots in the lounge
    coolerSpots(b) {
      const L = b.lounge;
      return [
        { x: (L.x + 5) * TT + 2, y: (L.y + 1) * TT + 4, dir: 'up' },
        { x: (L.x + 5) * TT + 18, y: (L.y + 1) * TT + 4, dir: 'left' },
        { x: (L.x + 5) * TT - 14, y: (L.y + 1) * TT + 4, dir: 'right' },
      ];
    }

    // eating spots around the existing lounge table (fits inside lounge without extra width)
    foodSpots(b) {
      const L = b.lounge;
      return [
        { x: (L.x + 4) * TT - 6, y: (L.y + 1) * TT + 4, dir: 'right' },
        { x: (L.x + 4) * TT + 18, y: (L.y + 1) * TT + 4, dir: 'left' },
      ];
    }

    sofaSpots(b) {
      // two nappers per sofa — one sofa above, the second below
      const L = b.lounge;
      const sx = (L.x + 1) * TT - 1;
      const sy1 = (L.y + 1) * TT - 8;
      const sy2 = (L.y + 3) * TT - 8;
      return [
        { x: sx + 14, y: sy1 + 9, side: -1 },
        { x: sx + 34, y: sy1 + 9, side: 1 },
        { x: sx + 14, y: sy2 + 9, side: -1 },
        { x: sx + 34, y: sy2 + 9, side: 1 },
      ];
    }

    // two idle workers square off at a ping-pong table in the lounge
    pingpongSpots(b) {
      const L = b.lounge;
      const px = (L.x + 7) * TT, py = (L.y + 1) * TT + 4;
      return [
        { x: px - 8, y: py, dir: 'right' },
        { x: px + 8, y: py, dir: 'left' },
      ];
    }

    // deterministic idle activity for an agent (by name): sleep on sofa, drink water, or eat food
    activityFor(name) {
      // idle workers only rest — they never take the shuttle; only killed
      // sessions depart by bus (see the departure block in syncNaps).
      const m = hash(name) % 3;
      if (m === 0) return 'nap';
      if (m === 1) return 'drink';
      return 'eat';
    }

    // the idle plan: idle agents leave the desk to sleep, drink, eat, or play
    // ping-pong. Eating/drinking stay capped at their spots; overflow goes to
    // the sofa first, then a ping-pong match, so no spot gets crowded.
    idlePlan() {
      const plan = new Map(); // key -> { activity, spot, b }
      if (!this.town) return plan;
      for (const b of this.town.layout.buildings) {
        if (this.hostOff(b.hostKey)) continue;
        const sofa = this.sofaSpots(b);
        const ping = this.pingpongSpots(b);
        const drinks = this.coolerSpots(b);
        const foods = this.foodSpots(b);
        const idle = [];
        for (const [key, info] of this.town.cells) {
          if (info.b.hostKey !== b.hostKey) continue;
          const s = this.sessions.get(key);
          if (s && !s.activity) idle.push(key);
        }
        idle.sort();
        let sofaI = 0, pingI = 0, drinkI = 0, eatI = 0;
        for (const key of idle) {
          const name = key.slice(b.hostKey.length + 1);
          const want = this.activityFor(name); // 'nap' | 'drink' | 'eat'
          let activity, spot;
          if (want === 'nap' && sofaI < sofa.length) { activity = 'nap'; spot = { ...sofa[sofaI++] }; }
          else if (want === 'drink' && drinkI < drinks.length) { activity = 'drink'; spot = { ...drinks[drinkI++] }; }
          else if (want === 'eat' && eatI < foods.length) { activity = 'eat'; spot = { ...foods[eatI++] }; }
          else if (sofaI < sofa.length) { activity = 'nap'; spot = { ...sofa[sofaI++] }; }
          else if (pingI < ping.length) { activity = 'pingpong'; spot = { ...ping[pingI++] }; }
          else if (drinkI < drinks.length) { activity = 'drink'; spot = { ...drinks[drinkI++] }; }
          else { activity = 'eat'; spot = { ...foods[eatI++ % foods.length] }; }
          plan.set(key, { activity, spot, b });
        }
      }
      return plan;
    }

    deskFeet(key) {
      const info = this.town && this.town.cells.get(key);
      if (!info) return null;
      const Y = info.cell.y * TT;
      const seat = TA.townSeat(info.cell, 0);
      return {
        b: info.b,
        feet: [seat.cx, Y + 25],
        entry: [(seat.entry.x + 0.5) * TT, (seat.entry.y + 0.5) * TT],
      };
    }

    // the display name for an agent key (a session name, or a stored name for
    // a departure agent whose session was killed)
    agentName(key) {
      const s = this.sessions.get(key);
      if (s) return s.name;
      const nap = this.naps.get(key);
      return nap && nap.name ? nap.name : null;
    }

    agentLook(key) {
      const name = this.agentName(key);
      return TA.townLookFor(name || 'you');
    }

    // HiDPI bake scale for the static layers: 2 on dpr>1 screens while the bake
    // stays inside the per-layer memory budget, else 1 (identical to before).
    bakeSFor(Wp, Hp) {
      return (window.devicePixelRatio || 1) > 1 && Wp * Hp * 4 <= MAX_BAKE_PX ? 2 : 1;
    }

    // Nearest-neighbour pixel-duplicate a baked 1x canvas to S (S=1 → as-is), so
    // vendor pixel art maps 1:1 onto HiDPI device pixels instead of blurring.
    pixelScale(c, S) {
      if (S <= 1) return c;
      const big = document.createElement('canvas');
      big.width = c.width * S;
      big.height = c.height * S;
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(c, 0, 0, big.width, big.height);
      return big;
    }

    // The vendor pixel art (astronauts 12×18, desks, monitors, bubbles, ships)
    // is baked at 1x. Render each unique sprite once at 2x (crisp nearest
    // upscale, cached by canvas identity — townCharacter/townScreen/the sprite
    // set are memoized, so the cache is bounded) so every per-frame bilinear
    // draw under a HiDPI transform has real source pixels — sharper, not blurry.
    sprite2x(c) {
      if (!this._sprite2x) this._sprite2x = new Map();
      let big = this._sprite2x.get(c);
      if (big) return big;
      big = document.createElement('canvas');
      big.width = c.width * 2;
      big.height = c.height * 2;
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(c, 0, 0, big.width, big.height);
      this._sprite2x.set(c, big);
      return big;
    }

    // The command citadel (town center): the vendor pixel-art body plus a
    // night-time treatment, all baked into the ground layer (free per frame):
    //   1. a warm shape-following glow behind the building
    //   2. a lit forecourt light pool on the plaza in front
    //   3. the body itself
    //   4. a subtle vertical depth gradient (masked to the silhouette)
    //   5. a faint mirrored reflection on the plaza below the base
    //   6. a warm bloom over the lit entrance + main windows
    // The clock hands move, so they're drawn live (drawCitadelClock).
    bakeCitadel(gg, center) {
      const body = TA.paintTownCenter(center.w); // memoized by the vendor
      const bw = body.width, bh = body.height;   // center.w*16 x 240
      const x = center.x * TT, y = center.y * TT; // body top-left (tile units)
      const cx = x + bw / 2;
      const baseY = y + 228; // bottom of the forecourt steps (the ground line)

      // 1) Warm shape-following glow behind the building (blurred + brightened).
      const glow = document.createElement('canvas');
      glow.width = bw + 28; glow.height = bh + 28;
      const gc = glow.getContext('2d');
      const canFilter = typeof gc.filter === 'string';
      if (canFilter) gc.filter = 'blur(7px) brightness(1.5) saturate(1.15)';
      gc.drawImage(body, 14, 14);
      gg.save();
      gg.globalCompositeOperation = 'lighter';
      gg.globalAlpha = canFilter ? 0.5 : 0.22;
      gg.drawImage(glow, x - 14, y - 14);
      gg.restore();

      // 2) Lit forecourt light pool on the plaza in front of the base.
      gg.save();
      gg.globalCompositeOperation = 'lighter';
      const pool = gg.createRadialGradient(cx, baseY, 4, cx, baseY, bw * 0.6);
      pool.addColorStop(0, 'rgba(255, 214, 130, 0.30)');
      pool.addColorStop(0.5, 'rgba(255, 190, 100, 0.12)');
      pool.addColorStop(1, 'rgba(255, 170, 80, 0)');
      gg.fillStyle = pool;
      gg.beginPath();
      gg.ellipse(cx, baseY, bw * 0.6, 24, 0, 0, Math.PI * 2);
      gg.fill();
      gg.restore();

      // 3) The body.
      gg.drawImage(body, x, y);

      // 4) Subtle vertical depth, masked to the silhouette (darker toward the base).
      const dc = document.createElement('canvas');
      dc.width = bw; dc.height = bh;
      const dctx = dc.getContext('2d');
      dctx.drawImage(body, 0, 0);
      dctx.globalCompositeOperation = 'source-in';
      const depth = dctx.createLinearGradient(0, 60, 0, 228);
      depth.addColorStop(0, 'rgba(0,0,0,0)');
      depth.addColorStop(1, 'rgba(12, 10, 24, 0.30)');
      dctx.fillStyle = depth;
      dctx.fillRect(0, 0, bw, bh);
      gg.drawImage(dc, x, y);

      // 5) Faint mirrored reflection on the plaza below the base (temp-canvas fade).
      const reflH = 72;
      const refl = document.createElement('canvas');
      refl.width = bw; refl.height = reflH;
      const rc = refl.getContext('2d');
      rc.imageSmoothingEnabled = false;
      rc.save(); rc.translate(0, 228); rc.scale(1, -1);
      rc.drawImage(body, 0, 0, bw, 228, 0, 0, bw, 228);
      rc.restore();
      rc.globalCompositeOperation = 'destination-in';
      const fg = rc.createLinearGradient(0, 0, 0, reflH);
      fg.addColorStop(0, 'rgba(255,255,255,0.5)');
      fg.addColorStop(1, 'rgba(255,255,255,0)');
      rc.fillStyle = fg; rc.fillRect(0, 0, bw, reflH);
      gg.save();
      gg.globalCompositeOperation = 'lighter';
      gg.globalAlpha = 0.5;
      gg.drawImage(refl, x, baseY);
      gg.restore();

      // 6) Warm bloom over the lit entrance + main windows (lower centre).
      gg.save();
      gg.globalCompositeOperation = 'lighter';
      const bloom = gg.createRadialGradient(cx, y + 175, 4, cx, y + 175, 62);
      bloom.addColorStop(0, 'rgba(255, 200, 110, 0.20)');
      bloom.addColorStop(1, 'rgba(255, 180, 90, 0)');
      gg.fillStyle = bloom;
      gg.fillRect(cx - 62, y + 113, 124, 124);
      gg.restore();
    }

    // The citadel's clock tower runs on live time: a fresh face + hands drawn
    // over the vendor's static clock each frame (the body is baked, but the
    // hands move). Hour + minute only — calm, and fine under reduced motion.
    drawCitadelClock(ctx) {
      const c = this.town.layout.center;
      const cx = (c.x + c.w / 2) * TT; // clock centre x (world)
      const cy = c.y * TT + 82;        // clock centre y (world) — vendor bakes it at body-y 82
      const R = 18;                    // rim radius — a bigger face, still clear of the tower's cornice (y 58–62) and inside the 56px tower
      const now = new Date();
      const min = now.getMinutes() + now.getSeconds() / 60;
      const hr = (now.getHours() % 12) + min / 60;

      // Face + rim (opaque, covers the vendor's static clock and a bit of the tower).
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = '#a8862e'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, R - 3.5, 0, Math.PI * 2); ctx.fillStyle = '#fbf6e8'; ctx.fill();
      // Ticks (12, the quarters longer).
      ctx.strokeStyle = '#1c1722'; ctx.lineCap = 'round';
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2, r1 = R - 3.5, r2 = i % 3 === 0 ? R - 7.5 : R - 5.5;
        ctx.lineWidth = i % 3 === 0 ? 2 : 1.2;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.stroke();
      }
      // Hands: 12 o'clock at the top (angle -PI/2).
      const hand = (ang, len, w) => {
        ctx.strokeStyle = '#1c1722'; ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
        ctx.stroke();
      };
      hand(hr / 12 * Math.PI * 2 - Math.PI / 2, R - 9, 2.8); // hour
      hand(min / 60 * Math.PI * 2 - Math.PI / 2, R - 5, 2);   // minute
      // Center pin.
      ctx.beginPath(); ctx.arc(cx, cy, 2.4, 0, Math.PI * 2); ctx.fillStyle = '#a8862e'; ctx.fill();
    }

    buildWalk(b, waypoints) {
      // A* between consecutive waypoints where the grid allows it (the film's
      // TownNavigation); a straight segment where it doesn't (inside a cell)
      let nav = this.nav.get(b.hostKey);
      if (!nav) this.nav.set(b.hostKey, nav = new TA.TownNavigation(b));
      const pt = (p) => (Array.isArray(p) ? p : [p.x, p.y]);
      const pts0 = waypoints.map(pt);
      const raw = [pts0[0]];
      for (let i = 1; i < pts0.length; i++) {
        const a = pts0[i - 1], c = pts0[i];
        const tiles = nav.path(Math.floor(a[0] / TT), Math.floor(a[1] / TT), Math.floor(c[0] / TT), Math.floor(c[1] / TT));
        if (tiles && tiles.length) for (const [tx, ty] of tiles) raw.push([(tx + 0.5) * TT, (ty + 0.5) * TT]);
        raw.push(c);
      }
      const pts = [raw[0]];
      for (let i = 1; i < raw.length; i++) {
        const q = pts[pts.length - 1];
        if (Math.hypot(raw[i][0] - q[0], raw[i][1] - q[1]) >= 1) pts.push(raw[i]);
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { pts, cum, total: cum[cum.length - 1] };
    }

    walkPoint(walk, d) {
      const { pts, cum } = walk;
      if (walk.total <= 0) { const q = pts[pts.length - 1]; return [q[0], q[1], 'down']; }
      d = clamp(d, 0, walk.total);
      for (let i = 1; i < cum.length; i++) {
        if (d <= cum[i]) {
          const seg = cum[i] - cum[i - 1];
          const f = seg > 0 ? (d - cum[i - 1]) / seg : 1;
          const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
          const dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'down' : 'up');
          return [pts[i - 1][0] + dx * f, pts[i - 1][1] + dy * f, dir];
        }
      }
      const q = pts[pts.length - 1];
      return [q[0], q[1], 'down'];
    }

    napPos(nap, t) {
      const total = nap.walk.total;
      const p = clamp((t - nap.start) / this.walkDur(nap), 0, 1);
      const e = p * p * (3 - 2 * p); // ease in-out over the whole route
      return this.walkPoint(nap.walk, total * e).concat(p);
    }

    walkDur(nap) {
      return Math.max(0.4, nap.walk.total / 90); // ~90 px/s stroll, like the film's moves
    }

    // build a nap-state object for a walk (session agents)
    makeWalk(key, phase, waypoints, p, b) {
      return {
        phase, // 'to-front' | 'checking' | 'to-activity' | 'activity' | 'to-desk'
        start: performance.now() / 1000,
        from: waypoints[0],
        to: waypoints[waypoints.length - 1],
        p: p || null, // { activity, spot, b } — the idle plan entry
        b,
        walk: this.buildWalk(b, waypoints),
      };
    }

    startWalk(key, phase, waypoints, p, b) {
      const at = this.deskFeet(key);
      this.naps.set(key, this.makeWalk(key, phase, waypoints, p, b || (at && at.b)));
    }

    syncNaps() {
      if (!this.town) { this.naps.clear(); return; }
      const t = performance.now() / 1000;
      const plan = this.idlePlan();
      // killed sessions: their agent walks straight out and takes the shuttle
      // bus (the one the repair crew arrives on) — no front-desk stop.
      const current = new Set(this.sessions.keys());
      for (const [key, info] of [...this.lastSessions]) {
        if (current.has(key)) continue; // still alive
        this.lastSessions.delete(key);
        if (!this.bus) { this.naps.delete(key); continue; } // no bus: agent leaves
        const b = this.town.layout.buildings.find((x) => x.hostKey === info.b.hostKey) || this.town.layout.buildings[0];
        if (!b) continue;
        const p = { activity: 'bus', spot: this.bus.stop.wait, b };
        const existing = this.naps.get(key);
        if (existing) {
          // already idle: route from the current position out to the stop
          const r = this.napPos(existing, t);
          this.naps.set(key, { ...this.makeWalk(key, 'to-activity', this.busWaypoints(b, [r[0], r[1]], p.spot), p, b), name: info.name, leaving: true });
        } else {
          // at the desk: out through the entry, up to the road, along to the stop
          this.naps.set(key, { ...this.makeWalk(key, 'to-activity', [info.feet, info.entry, ...this.busWaypoints(b, info.entry, p.spot).slice(1)], p, b), name: info.name, leaving: true });
        }
      }
      const posOf = (key) => {
        const nap = this.naps.get(key);
        if (!nap) return null;
        if (nap.phase === 'checking') { const fp = this.frontPos(nap.b); return [fp.x, fp.y]; }
        if ((nap.phase === 'activity' || nap.phase === 'waiting-bus') && nap.p) return [nap.p.spot.x, nap.p.spot.y];
        const r = this.napPos(nap, t);
        return [r[0], r[1]];
      };
      for (const key of [...this.naps.keys()]) {
        const s = this.sessions.get(key);
        if (!s) {
          if (this.naps.get(key).leaving) continue; // departure: session gone, keep the walk
          this.naps.delete(key); continue;
        }
        const nap = this.naps.get(key);
        const p = plan.get(key);
        const at = this.deskFeet(key);
        if (!at) { this.naps.delete(key); continue; }
        if (s.activity || !p) {
          // belongs at the desk: get up and walk back
          if (nap.phase !== 'to-desk') {
            const from = posOf(key);
            if (from) this.startWalk(key, 'to-desk', [from, at.entry, at.feet], null, at.b);
          }
        } else if (nap.phase === 'to-desk') {
          // went idle again mid-return: head straight to the rest spot
          const from = posOf(key);
          this.startWalk(key, 'to-activity', this.restWaypoints(at, p, from), p, at.b);
        } else if (nap.phase === 'to-activity') {
          // reassigned to a different spot mid-walk
          if (nap.p && (nap.p.spot.x !== p.spot.x || nap.p.spot.y !== p.spot.y)) {
            const from = posOf(key);
            this.startWalk(key, 'to-activity', this.restWaypoints(at, p, from), p, at.b);
          }
        } else if (nap.phase === 'activity') {
          if (nap.p && (nap.p.spot.x !== p.spot.x || nap.p.spot.y !== p.spot.y)) {
            this.startWalk(key, 'to-activity', [[nap.p.spot.x, nap.p.spot.y], [p.spot.x, p.spot.y]], p, at.b);
          }
        }
        // 'to-front' and 'checking' advance in frame()
      }
      // fresh idle sessions: leave the desk straight to the rest spot
      for (const [key, p] of plan) {
        if (this.naps.has(key)) continue;
        const at = this.deskFeet(key);
        if (!at) continue;
        this.startWalk(key, 'to-activity', this.restWaypoints(at, p), p, at.b);
      }
      // remember each live session's desk state (for departure detection)
      for (const key of current) {
        const at = this.deskFeet(key);
        if (at) this.lastSessions.set(key, { name: key.split(':').pop(), b: at.b, entry: at.entry, feet: at.feet });
      }
      if (REDUCED) for (const [key, nap] of [...this.naps]) {
        if (nap.leaving) { this.naps.delete(key); continue; } // no animating bus to board
        const toBus = nap.p && nap.p.activity === 'bus';
        if (nap.phase === 'to-front' || nap.phase === 'checking' || nap.phase === 'to-activity')
          this.naps.set(key, { phase: toBus ? 'waiting-bus' : 'activity', start: t, p: nap.p, b: nap.b });
        else if (nap.phase === 'to-desk') this.naps.delete(key);
      }
    }

    reanchorNaps() {
      // the layout was rebuilt (a session was added/killed): re-attach the agent
      // state to the new geometry instead of dropping it
      if (!this.town || !this.naps.size) return;
      const t = performance.now() / 1000;
      const plan = this.idlePlan();
      for (const [key, nap] of [...this.naps]) {
        if (nap.leaving) continue; // departure agents keep their own walk
        const s = this.sessions.get(key);
        const at = s && this.deskFeet(key);
        if (!s || !at) { this.naps.delete(key); continue; }
        const p = plan.get(key);
        const r = this.napPos(nap, t);
        const from = [r[0], r[1]];
        if (!p) this.startWalk(key, 'to-desk', [from, at.entry, at.feet], null, at.b);
        else this.startWalk(key, 'to-activity', this.restWaypoints(at, p, from), p, at.b);
      }
    }

    /* ---------- camera ---------- */

    initialCamera(instant = true) {
      if (!this.town) return;
      const L = this.town.layout;
      const c = L.center;
      if (c) {
        // Frame the host buildings (the sessions) + the town center + the bus
        // stop, so the workers and their previews are visible by default. Shows
        // a part of the town — the central area — not all of it. Wheel/pinch to
        // zoom, click empty ground to fit-all.
        const bxs = L.buildings.map((b) => b.x * TT);
        const bx2 = L.buildings.map((b) => (b.x + b.w) * TT);
        const shp = this.town.storageShip;
        const minX = Math.min(...bxs, c.x * TT, shp ? shp.x : Infinity);
        const maxX = Math.max(...bx2, (c.x + c.w) * TT, shp ? shp.x + shp.w : -Infinity);
        const cx = (minX + maxX) / 2;
        const top = Math.min(c.y * TT, ...L.buildings.map((b) => b.y * TT));
        const bottom = Math.max(...L.buildings.map((b) => (b.y + b.h) * TT), c.y * TT + 500);
        const cy = (top + bottom) / 2;
        const w = this.cv.clientWidth, h = this.cv.clientHeight;
        const z = clamp(Math.min(w / (maxX - minX + 180), (h - 60) / (bottom - top + 120)), 0.5, 1.0);
        const t = { x: cx, y: cy, z };
        if (instant) { this.cam = { ...t }; this.target = null; }
        else this.target = t;
        this.needsRedraw = true;
        return;
      }
      const b = L.buildings[0];
      if (!b) return;
      const t = { x: b.x * TT + (b.w * TT) / 2, y: b.y * TT + (b.h * TT) / 2 + 6, z: 1 };
      if (instant) { this.cam = { ...t }; this.target = null; }
      else this.target = t;
      this.needsRedraw = true;
    }

    fitCamera(instant = false) {
      this.initialCamera(instant);
    }

    zoomToBuilding(b) {
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      // desk-level view: at z >= 1.6 the pods are big enough to read
      const z = clamp(Math.min(w * 0.9 / (b.w * TT), (h - 60) * 0.9 / ((b.h + 2) * TT)), 1.6, 2.6);
      this.target = { x: b.x * TT + (b.w * TT) / 2, y: b.y * TT + (b.h * TT) / 2, z };
      this.needsRedraw = true;
    }

    zoomToStorageShip() {
      if (!this.town || !this.town.storageShip) return;
      const s = this.town.storageShip;
      this.target = {
        x: Math.round(s.x + s.w / 2),
        y: Math.round(s.y + s.h / 2),
        z: 1.35,
      };
      this.needsRedraw = true;
    }

    // zoom about the current view center (cam.x, cam.y is the world point at
    // screen center) — used by the + / − map buttons; eases like every other
    // camera move (instant under prefers-reduced-motion)
    zoomBy(f) {
      if (!this.town) return;
      const nz = clamp(this.cam.z * f, Z_MIN, Z_MAX);
      this.target = { x: this.cam.x, y: this.cam.y, z: nz };
      this.needsRedraw = true;
    }

    /* ---------- input ---------- */

    screenToWorld(sx, sy) {
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      return [this.cam.x + (sx - w / 2) / this.cam.z, this.cam.y + (sy - h / 2) / this.cam.z];
    }

    podAt(wx, wy) {
      if (!this.town) return null;
      // moving agents: a napper on the sofa or a walker in between is the
      // same session as its desk (click attach directly)
      for (const [key, nap] of this.naps) {
        let px, py;
        if (nap.phase === 'checking') { const fp = this.frontPos(nap.b); px = fp.x; py = fp.y; }
        else if ((nap.phase === 'activity' || nap.phase === 'waiting-bus') && nap.p) { px = nap.p.spot.x; py = nap.p.spot.y; }
        else { const r = this.napPos(nap, performance.now() / 1000); px = r[0]; py = r[1]; }
        if (wx >= px - 15 && wx <= px + 15 && wy >= py - 16 && wy <= py + 10) {
          const info = this.town.cells.get(key);
          if (info) return { name: info.name, info, key };
        }
      }
      return null;
    }

    // Geometry of a desk's two click targets (world coordinates): the seated
    // astronaut (rename) and the holographic screen projection (attach). Both
    // match how drawPod / drawPreview place them, so hit boxes line up with
    // the art at every zoom.
    podGeom(info) {
      const { cell } = info;
      const X = (cell.x + 1) * TT, Y = cell.y * TT;
      const cx = X + TA.townDeskSlots(cell.seats)[0].chairX + 7;
      const aw = 12 * AS, ah = 18 * AS; // character sprite is 12×18, scaled by AS
      return {
        agent: { x: cx - aw / 2, y: Y + 25 - ah, w: aw, h: ah },
        screen: { x: cx - 54, y: Y + 40, w: 108, h: 54 }, // drawPreview's projX/projY
      };
    }

    // A desk's holographic screen projection → click attaches (pops up) the session.
    // The projection stays drawn while a session is idle (its agent naps away),
    // so it remains the attach target alongside the worker.
    previewAt(wx, wy) {
      if (!this.town) return null;
      for (const [key, info] of this.town.cells) {
        const r = this.podGeom(info).screen;
        if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
          return { name: info.name, info, key };
        }
      }
      return null;
    }

    // A desk's seated astronaut → click renames the session.
    agentAt(wx, wy) {
      if (!this.town) return null;
      for (const [key, info] of this.town.cells) {
        if (this.naps.has(key)) continue; // the astronaut has left the desk
        const r = this.podGeom(info).agent;
        if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
          return { name: info.name, info, key };
        }
      }
      return null;
    }

    // The Host badge sign above each starship: clicking toggles polling on/off
    signAt(wx, wy) {
      if (!this.town) return null;
      for (const r of this.town.roofs) {
        const b = r.b;
        const x = Math.round(b.x * TT + (b.w * TT) / 2), y = Math.round(b.y * TT - 34);
        if (wx >= x - 130 && wx <= x + 130 && wy >= y - 32 && wy <= y + 24) {
          return b.hostKey;
        }
      }
      return null;
    }

    buildingAt(wx, wy) {
      if (!this.town) return null;
      for (const r of this.town.roofs) {
        const b = r.b;
        if (wx >= b.x * TT - 4 && wx <= (b.x + b.w) * TT + 4 && wy >= b.y * TT - 14 && wy <= (b.y + b.h + 2) * TT) return b;
      }
      return null;
    }

    // The "+" new-session button at each reception counter ("à l'accueil")
    plusAt(wx, wy) {
      if (!this.town) return null;
      for (const b of this.town.layout.buildings) {
        const p = b.plus;
        if (!p) continue;
        if (wx >= p.x - 4 && wx <= p.x + p.s + 4 && wy >= p.y - 4 && wy <= p.y + p.s + 4) return b.hostKey;
      }
      return null;
    }

    // The town center (the top building, with the clock tower): opens settings.
    centerAt(wx, wy) {
      if (!this.town) return null;
      const c = this.town.layout.center;
      if (!c) return null;
      if (wx >= c.x * TT && wx <= (c.x + c.w) * TT && wy >= c.y * TT && wy <= (c.y + c.h) * TT) return c;
      return null;
    }

    onWheel(e) {
      if (!this.on) return;
      e.preventDefault();
      const rect = this.cv.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const { x, y, z } = this.cam;
      const nz = clamp(z * Math.exp(-e.deltaY * 0.0016), Z_MIN, Z_MAX);
      // keep the world point under the cursor fixed
      const wx = x + (sx - this.cv.clientWidth / 2) / z;
      const wy = y + (sy - this.cv.clientHeight / 2) / z;
      this.cam = { z: nz, x: wx - (sx - this.cv.clientWidth / 2) / nz, y: wy - (sy - this.cv.clientHeight / 2) / nz };
      this.target = null;
      this.needsRedraw = true;
    }

    onPointerDown(e) {
      if (!this.on || e.button !== 0) return;
      try { this.cv.setPointerCapture(e.pointerId); } catch {} // synthetic pointers (tests) have no capture
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.drag = { sx: e.clientX, sy: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      } else if (this.pointers.size === 2) {
        this.drag = null; // switch to pinch
        const [p1, p2] = [...this.pointers.values()];
        this.pinch = { d0: Math.hypot(p2.x - p1.x, p2.y - p1.y), z0: this.cam.z };
      }
      this.cv.classList.add('dragging');
      this.setHover(null, null);
    }

    onPointerMove(e) {
      if (!this.on) return;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [p1, p2] = [...this.pointers.values()];
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (this.pinch.d0 > 0) {
          const nz = clamp(this.pinch.z0 * (d / this.pinch.d0), Z_MIN, Z_MAX);
          this.cam.z = nz;
          this.target = null;
          this.needsRedraw = true;
        }
        return;
      }
      if (this.drag) {
        const dx = e.clientX - this.drag.sx, dy = e.clientY - this.drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
        if (this.drag.moved) {
          this.cam.x = this.drag.cx - dx / this.cam.z;
          this.cam.y = this.drag.cy - dy / this.cam.z;
          this.target = null;
          this.needsRedraw = true;
        }
        return;
      }
      // Hover only over the map canvas itself. The floating terminal window
      // (and other overlays) sits on top of the map in town view; hovering the
      // console must not leak map tooltips through from underneath.
      if (e.target !== this.cv) {
        this.setHover(null, null);
        return;
      }
      this.updateHover(e);
    }

    onPointerUp(e) {
      if (!this.on) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.drag && !this.drag.moved && this.pointers.size === 0) this.onClick(e);
      if (this.pointers.size === 0) { this.drag = null; this.cv.classList.remove('dragging'); }
    }

    onDblClick(e) {
      if (!this.on) return;
      const rect = this.cv.getBoundingClientRect();
      const [wx, wy] = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const b = this.buildingAt(wx, wy);
      if (b) this.zoomToBuilding(b);
      else this.fitCamera(false);
    }

    onClick(e) {
      const rect = this.cv.getBoundingClientRect();
      const [wx, wy] = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      // Check storage ship manifest session pills or host items or starship hull
      if (this.town && this.town.storageShip) {
        const s = this.town.storageShip;
        if (s.visItems) {
          for (const item of s.visItems) {
            if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
              this.toggleHostVisible(item.host);
              return;
            }
          }
        }
        if (s.items) {
          for (const item of s.items) {
            if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
              this.api.attach(item.key);
              return;
            }
          }
        }
        if (s.hostItems) {
          for (const item of s.hostItems) {
            if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
              if (this.api.toggleHost) this.api.toggleHost(item.host);
              return;
            }
          }
        }
        if (wx >= s.x - 14 && wx <= s.x + s.w + 14 && wy >= s.y - 4 && wy <= s.y + s.h + 8) {
          this.zoomToStorageShip();
          return;
        }
      }
      // Check starship host callsign sign badge to toggle polling
      const signHost = this.signAt(wx, wy);
      if (signHost) {
        if (this.api.toggleHost) this.api.toggleHost(signHost);
        return;
      }
      const screen = this.previewAt(wx, wy);
      if (screen) { this.api.attach(screen.key); return; }
      const agent = this.agentAt(wx, wy);
      if (agent) { if (this.api.rename) this.api.rename(agent.key); return; }
      const pod = this.podAt(wx, wy);
      if (pod) { this.api.attach(pod.key); return; }
      const plus = this.plusAt(wx, wy);
      if (plus) { if (this.api.newSession) this.api.newSession(plus); return; }
      const b = this.buildingAt(wx, wy);
      if (b) { this.zoomToBuilding(b); return; }
      if (this.centerAt(wx, wy)) { if (this.api.openSettings) this.api.openSettings(); return; }
      this.fitCamera(false);
    }

    updateHover(e) {
      const rect = this.cv.getBoundingClientRect();
      const [wx, wy] = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      // Check storage ship manifest session pills or starship hull
      if (this.town && this.town.storageShip) {
        const s = this.town.storageShip;
        if (s.visItems) {
          for (const item of s.visItems) {
            if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
              this.setHover({ type: 'host-vis', host: item.host }, e);
              return;
            }
          }
        }
        if (s.items) {
          for (const item of s.items) {
            if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
              this.setHover({ type: 'manifest-session', key: item.key, host: item.host }, e);
              return;
            }
          }
        }
        if (s.hostItems) {
          for (const item of s.hostItems) {
            if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
              this.setHover({ type: 'host-sign', host: item.host }, e);
              return;
            }
          }
        }
        if (wx >= s.x - 14 && wx <= s.x + s.w + 14 && wy >= s.y - 4 && wy <= s.y + s.h + 8) {
          this.setHover({ type: 'storage-ship' }, e);
          return;
        }
      }
      const signHost = this.signAt(wx, wy);
      if (signHost) {
        this.setHover({ type: 'host-sign', host: signHost }, e);
        return;
      }
      const screen = this.previewAt(wx, wy);
      const agent = screen ? null : this.agentAt(wx, wy);
      const pod = screen || agent ? null : this.podAt(wx, wy);
      const plus = screen || agent || pod ? null : this.plusAt(wx, wy);
      const b = screen || agent || pod || plus ? null : this.buildingAt(wx, wy);
      const c = screen || agent || pod || plus || b ? null : this.centerAt(wx, wy);
      this.setHover(screen ? { type: 'pod', ...screen } : agent ? { type: 'agent', ...agent } : pod ? { type: 'pod', ...pod } : plus ? { type: 'plus', host: plus } : b ? { type: 'building', b } : c ? { type: 'center' } : null, e);
    }

    setHover(hover, e) {
      const changed = JSON.stringify(this.hoverKey()) !== JSON.stringify(hover ? this.hoverId(hover) : null);
      this.hover = hover;
      this.cv.style.cursor = hover ? 'pointer' : 'grab';
      const tip = this.tip;
      if (!hover || !e || !this.on) { if (tip) tip.hidden = true; if (changed) this.needsRedraw = true; return; }
      if (tip) {
        if (hover.type === 'pod') {
          const s = this.sessions.get(hover.key);
          const st = s ? (s.activity ? 'active' : 'idle') : '—';
          tip.innerHTML = '<b></b><span class="dim"> · ' + hover.info.b.hostKey + ' · ' + st + (s && s.cwd ? ' · ' + s.cwd : '') + ' · click to attach</span>';
          tip.firstChild.textContent = hover.name;
        } else if (hover.type === 'agent') {
          tip.innerHTML = '<b></b><span class="dim"> · ' + hover.info.b.hostKey + ' · click to rename</span>';
          tip.firstChild.textContent = hover.name;
        } else if (hover.type === 'manifest-session') {
          const s = this.sessions.get(hover.key);
          const st = s ? (s.activity ? 'active' : 'idle') : '—';
          tip.innerHTML = '<b></b><span class="dim"> · ' + hover.host + ' · ' + st + ' · click to attach</span>';
          tip.firstChild.textContent = hover.key.split(':').pop();
        } else if (hover.type === 'host-vis') {
          const hid = this.isHostHidden(hover.host);
          tip.innerHTML = '<b></b><span class="dim"> · ' + (hid ? 'hidden — click to show it on the map' : 'shown on the map — click to hide it') + '</span>';
          tip.firstChild.textContent = hover.host;
        } else if (hover.type === 'host-sign') {
          // (also fixes a stale fall-through: host-sign hovers have no .b)
          tip.innerHTML = '<b></b><span class="dim"> · click to toggle polling</span>';
          tip.firstChild.textContent = hover.host;
        } else if (hover.type === 'storage-ship') {
          tip.innerHTML = '<b>📦 Orbital Sessions</b><span class="dim"> · click to zoom & focus</span>';
        } else if (hover.type === 'plus') {
          tip.innerHTML = '<b>+ new session</b><span class="dim"> on ' + hover.host + '</span>';
        } else if (hover.type === 'center') {
          tip.innerHTML = '<b>⚙ settings</b><span class="dim"> · click to open config</span>';
        } else {
          const h = (this.hosts || []).find((x) => x.name === hover.b.hostKey);
          const n = h && h.sessions ? h.sessions.length : 0;
          const st = this.hostOff(hover.b.hostKey) ? 'offline' : 'online';
          tip.innerHTML = '<b></b><span class="dim"> · ' + st + ' · ' + n + ' session' + (n === 1 ? '' : 's') + ' · click to zoom</span>';
          tip.firstChild.textContent = hover.b.hostKey;
        }
        tip.hidden = false;
        const x = clamp(e.clientX + 14, 4, innerWidth - tip.offsetWidth - 4);
        const y = clamp(e.clientY + 12, 4, innerHeight - tip.offsetHeight - 4);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
      }
      if (changed) this.needsRedraw = true;
    }

    hoverId(hover) {
      if (hover.type === 'pod') return 'pod:' + hover.key;
      if (hover.type === 'agent') return 'agent:' + hover.key;
      if (hover.type === 'manifest-session') return 'ms:' + hover.key;
      if (hover.type === 'host-vis') return 'vis:' + hover.host;
      if (hover.type === 'host-sign') return 'hs:' + hover.host;
      if (hover.type === 'storage-ship') return 'storage-ship';
      if (hover.type === 'plus') return 'plus:' + hover.host;
      if (hover.type === 'center') return 'center';
      return 'b:' + hover.b.hostKey;
    }

    hoverKey() {
      return this.hover ? this.hoverId(this.hover) : null;
    }

    /* ---------- render ---------- */

    frame = (now) => {
      if (!this.on) return;
      this.raf = requestAnimationFrame(this.frame);
      if (document.hidden) return;

      // Smart Eco Frame Throttle:
      // 1. Camera moving / dragging / easing: full display refresh rate (60Hz-120Hz)
      // 2. Unfocused window (user in another app/terminal): 1 FPS (~1000ms)
      // 3. Inactive for >15s (no mouse/keyboard): 2 FPS (~500ms)
      // 4. Normal active static viewing: 15 FPS (~66ms)
      const isMoving = !!this.target || !!this.drag || !!this.pinch;
      const isUnfocused = typeof document.hasFocus === 'function' && !document.hasFocus();
      const isInactive = (now - this.lastActivityTime) > 15000;
      const minInterval = isMoving ? 0 : isUnfocused ? 1000 : isInactive ? 500 : 66;

      if (!isMoving && this._lastFrameTime && (now - this._lastFrameTime < minInterval)) {
        return;
      }
      this._lastFrameTime = now;
      const t = now / 1000;

      // camera easing
      if (this.target) {
        const k = REDUCED ? 1 : 0.16;
        this.cam.x += (this.target.x - this.cam.x) * k;
        this.cam.y += (this.target.y - this.cam.y) * k;
        this.cam.z += (this.target.z - this.cam.z) * k;
        if (Math.abs(this.target.x - this.cam.x) < 0.5 && Math.abs(this.target.y - this.cam.y) < 0.5 && Math.abs(this.target.z - this.cam.z) < 0.002) {
          this.cam = { ...this.target };
          this.target = null;
        }
        this.needsRedraw = true;
      }

      // walks / timers that finished: advance the idle lifecycle
      // (to-front -> checking -> to-activity -> activity; to-desk -> seated).
      // Session agents stay at 'activity' until active again.
      const advance = (map) => {
        for (const [key, nap] of [...map]) {
          const dur = this.walkDur(nap);
          if (nap.phase === 'to-front' && t - nap.start >= dur) {
            map.set(key, { ...nap, phase: 'checking', start: t });
          } else if (nap.phase === 'checking' && t - nap.start >= this.checkMs() / 1000) {
            const fp = this.frontPos(nap.b);
            const p = nap.p;
            if (p && p.spot) {
              const wps = (p.activity === 'bus' && this.bus)
                ? this.busWaypoints(nap.b, [fp.x, fp.y], p.spot)
                : [[fp.x, fp.y], [p.spot.x, p.spot.y]];
              map.set(key, { ...this.makeWalk(key, 'to-activity', wps, p, nap.b), leaving: nap.leaving, name: nap.name });
            } else {
              const at = this.deskFeet(key);
              if (at) map.set(key, this.makeWalk(key, 'to-desk', [[fp.x, fp.y], at.entry, at.feet], null, nap.b));
            }
          } else if (nap.phase === 'to-activity' && t - nap.start >= dur) {
            const phase = (nap.p && nap.p.activity === 'bus') ? 'waiting-bus' : 'activity';
            map.set(key, { ...nap, phase, start: t });
          } else if (nap.phase === 'to-desk' && t - nap.start >= dur) {
            map.delete(key);
          }
        }
      };
      if (this.naps.size) advance(this.naps);
      this.updateBus(t);
      this.updateRepairCrew(t);
      this.updateHostLift();
      this.updateSpaceTraffic(t);

      const animate = !REDUCED && !!this.town;
      if (REDUCED && !this.needsRedraw) return;
      if (!animate && !this.needsRedraw && !this.target) return;
      this.needsRedraw = false;
      this.draw(t);
    };

    roofAlpha() {
      // Glass roof: the building keeps its silhouette, but the desks and the
      // agents working at them stay visible at every zoom (the film's default
      // shots run roofless for exactly this reason).
      return 0.16;
    }

    draw(t) {
      const { ctx, cv } = this;
      const w = cv.clientWidth, h = cv.clientHeight;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#030509';
      ctx.fillRect(0, 0, w, h);
      this.drawSkyStars(ctx, w, h, t);
      this.drawGalaxies(ctx, w, h, t);
      if (!this.town) {
        ctx.fillStyle = '#858faa';
        ctx.font = '12px ' + 'Silkscreen, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('no hosts — add one in ⚙ config', w / 2, h / 2);
        ctx.textAlign = 'left';
        return;
      }
      // Distant space traffic flies behind the offices (screen space), not over them
      this.drawSpaceTraffic(ctx, t);
      const T = this.town;
      const { x: camx, y: camy, z } = this.cam;
      const ox = w / 2, oy = h / 2;

      // Direct camera affine transform matrix (zero save/restore matrix stack overhead)
      const a = this.dpr * z, d = this.dpr * z;
      const e = this.dpr * (ox - camx * z), f = this.dpr * (oy - camy * z);
      this.worldA = a; this.worldD = d; this.worldE = e; this.worldF = f;
      ctx.setTransform(a, 0, 0, d, e, f);
      // Smooth upscaling for the pixel sprites (astronauts, desks, screens,
      // guard, furniture) and the baked art. Nearest-neighbour made every zoom
      // step and HiDPI factor look chunky; bilinear minification/magnification
      // gives a finer, less blocky view at negligible GPU cost.
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

      // Clip T.base to only the visible viewport rect (avoids copying ~4.5 million offscreen pixels)
      const halfW = (w / 2) / z + 20;
      const halfH = (h / 2) / z + 20;
      const S = T.S || 1; // HiDPI bake factor: source rects are in bake pixels
      const worldLeft = Math.max(0, Math.floor(camx - halfW + T.M));
      const worldTop = Math.max(0, Math.floor(camy - halfH + T.M));
      const worldRight = Math.min(T.Wp, Math.ceil(camx + halfW + T.M));
      const worldBottom = Math.min(T.Hp, Math.ceil(camy + halfH + T.M));
      const sw = Math.max(0, worldRight - worldLeft);
      const sh = Math.max(0, worldBottom - worldTop);
      if (sw > 0 && sh > 0) {
        ctx.drawImage(T.ground, worldLeft * S, worldTop * S, sw * S, sh * S, worldLeft - T.M, worldTop - T.M, sw, sh);
        // EVA repair astronauts fly *behind* the offices (over the street,
        // occluded by the modules) — like the starships, not over them.
        if (this.repairCrew && this.repairCrew.state !== 'waiting-arrival') {
          this.drawRepairCrew(ctx, t);
        }
        ctx.drawImage(T.base, worldLeft * S, worldTop * S, sw * S, sh * S, worldLeft - T.M, worldTop - T.M, sw, sh);
        // The citadel's clock tower runs on live time — its hands are drawn over
        // the baked static clock each frame (the body itself is baked).
        this.drawCitadelClock(ctx);
      }

      // dynamic desk layer, depth-sorted (pods and the moving agents together)
      const list = [];
      const bubbles = [];
      const frame = REDUCED ? 0 : Math.floor(t * 6);

      // Viewport bounds in world space for culling offscreen elements when zoomed in
      const padW = (w / 2) / z + 120;
      const padH = (h / 2) / z + 120;
      const viewMinX = camx - padW, viewMaxX = camx + padW;
      const viewMinY = camy - padH, viewMaxY = camy + padH;

      for (const [key, info] of T.cells) {
        const deskX = (info.cell.x + 1) * TT, deskY = info.cell.y * TT;
        const nap = this.naps.get(key);
        // Cull workstations outside the visible viewport
        if (!nap && (deskX < viewMinX || deskX > viewMaxX || deskY < viewMinY || deskY > viewMaxY)) {
          continue;
        }
        const name = info.name;
        const s = this.sessions.get(key);
        const state = s ? (s.activity ? 'working' : 'idle') : 'off';
        // seated only when the agent is actually at the desk — any nap state
        // (walking, checking, at an activity) means the chair is empty
        list.push([info.cell.y * TT + 52, () => this.drawPod(info, name, state, t, key, frame, !nap, bubbles)]);
        if (nap) {
          if (nap.phase === 'checking' || nap.phase === 'activity' || nap.phase === 'waiting-bus') {
            const pos = nap.phase === 'checking' ? this.frontPos(nap.b) : (nap.p && nap.p.spot);
            if (pos) {
              // naps lie down on the sofa; everything else stands
              if (nap.phase === 'activity' && nap.p && nap.p.activity === 'nap')
                list.push([pos.y + 8, () => this.drawNapper(key, nap, bubbles)]);
              else
                list.push([pos.y + 8, () => this.drawAgentAt(key, nap, pos, bubbles)]);
            }
          } else {
            const r = this.napPos(nap, t);
            if (r[3] < 1) list.push([r[1] + 2, () => this.drawWalker(key, nap, r, t)]);
          }
        }
      }
      // the bus stop and the bus (on the street, depth-sorted by feet y)
      if (this.bus) {
        const s = this.bus.stop;
        list.push([s.wait.y + 1, () => this.drawBusStop(s)]);
        const bus = this.busAt(t);
        if (bus) list.push([bus.y + 8, () => this.drawBus(bus, t)]);
      }
      // the imperial guards patrol each office entrance (in front of the facade)
      for (const g of this.guards) {
        list.push([g.y + 2, () => this.drawGuard(g, t)]);
      }
      list.sort((a, b) => a[0] - b[0]).forEach((e) => e[1]());

      // roofs (light glass — the desks stay visible underneath, batched without save/restore).
      // A host's canopy retracts when it goes offline and redeploys on reconnect,
      // so a down office visibly "shrinks".
      const ra = this.roofAlpha();
      for (const r of T.roofs) {
        const lift = this.hostLift(r.host);
        if (lift <= 0.01) continue;
        const w = r.lw * (0.25 + 0.75 * lift);
        const h = r.lh * lift;
        ctx.globalAlpha = ra * (0.3 + 0.7 * lift);
        ctx.drawImage(r.c, r.x + (r.lw - w) / 2, r.y + (r.lh - h), w, h);
      }
      ctx.globalAlpha = 1;
      for (const r of T.roofs) {
        this.drawStationEffects(r.b, t);
      }

      // host signs above the buildings
      for (const r of T.roofs) this.drawSign(r.b);

      // "+" new-session button at each reception counter ("à l'accueil")
      for (const b of T.layout.buildings) this.drawPlus(b);

      // ⚙ badge on the command citadel center (settings)
      this.drawCenterBadge();

      // Orbital Storage Starship with live host/session manifest
      this.drawStorageShip(ctx, t);

      // hover / active highlights — the clickable "square" follows the target:
      // the projected screen for attach, the seated astronaut for rename.
      if (this.hover && (this.hover.type === 'pod' || this.hover.type === 'agent')) {
        const g = this.podGeom(this.hover.info);
        ctx.strokeStyle = this.hover.type === 'agent' ? 'rgba(255, 209, 102, 0.9)' : 'rgba(0, 229, 255, 0.85)';
        ctx.lineWidth = 2 / z;
        const r = this.hover.type === 'agent' ? g.agent : g.screen;
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }

      // Reset to screen coordinates for thought bubbles (direct identity matrix)
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // thought bubbles in screen space: constant size at every zoom, like the film
      for (const [x, y, kind] of bubbles) {
        const img = T.sp.bubble[kind];
        if (!img) continue;
        const img2 = this.sprite2x(img);
        const sx = ox + (x - camx) * z, sy = oy + (y - camy) * z;
        const near = z >= 1.4;
        const bs = near ? clamp(Math.round(z * 1.5), 2, 4) : z < 0.7 ? 1 : 2;
        ctx.drawImage(img2, Math.round(sx - img.width * bs / 2), Math.round(sy - 2 - img.height * bs), img.width * bs, img.height * bs);
      }
    }

    drawNapper(key, nap, bubbles) {
      const look = this.agentLook(key);
      const spot = (nap.p && nap.p.spot) || nap.spot;
      if (!spot) return;
      const { ctx } = this;
      const c = TA.townCharacter(look, 'down', 0, 'stand', true); // eyes closed
      const sprite = this.sprite2x(c);
      const w = c.width * AS, h = c.height * AS;
      const x = spot.x, y = spot.y;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(x - 14, y + 8, 28, 3);
      // lying along the sofa, head to one side (the film's floor-nap, on the couch)
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      ctx.rotate((spot.side || 0) * Math.PI / 2);
      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
      ctx.restore();
      bubbles.push([x + (spot.side || 0) * 16, y - 12, 'sleep']);
    }

    // an agent standing still at a spot: checking in at the front desk (✓),
    // playing ping pong, eating, drinking, playing holochess, or at the bus stop.
    drawAgentAt(key, nap, pos, bubbles) {
      const look = this.agentLook(key);
      const { ctx } = this;
      const x = pos.x, y = pos.y;
      const dir = (pos && pos.dir) ? pos.dir : 'down';
      const c = TA.townCharacter(look, dir, 0, 'stand', false);
      const w = c.width * AS, h = c.height * AS;
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.fillRect(Math.round(x) - 5, Math.round(y) - 1, 10, 3);
      ctx.drawImage(this.sprite2x(c), Math.round(x) - w / 2, Math.round(y) - h + 1, w, h);
      if (nap.phase === 'checking') bubbles.push([x, y - h - 4, 'done']);
      else if (nap.p) {
        const act = nap.p.activity;
        if (act === 'water' || act === 'drink') bubbles.push([x, y - h - 4, 'drink']);
        else if (act === 'pingpong') bubbles.push([x, y - h - 4, 'pingpong']);
        else if (act === 'eat') bubbles.push([x, y - h - 4, 'eat']);
        else if (act === 'holochess') bubbles.push([x, y - h - 4, 'chess']);
        else bubbles.push([x, y - h - 4, 'idle']);
      }
    }

    drawWalker(key, nap, r, t) {
      const look = this.agentLook(key);
      const { ctx } = this;
      const [x, y, dir] = r;
      const wf = Math.floor(t * 9) % 4; // the film's 4-frame walk cycle at 9 fps
      const c = TA.townCharacter(look, dir, wf, 'stand', false);
      const w = c.width * AS, h = c.height * AS;
      const bob = wf % 2 ? -1 : 0;
      ctx.fillStyle = 'rgba(0,0,0,.22)';
      ctx.fillRect(Math.round(x) - 5, Math.round(y) - 1, 10, 3);
      ctx.drawImage(this.sprite2x(c), Math.round(x) - w / 2, Math.round(y) - h + 1 + bob, w, h);
    }

    drawPod(info, name, state, t, key, frame, seated, bubbles) {
      const { ctx } = this;
      const { cell } = info;
      const X = (cell.x + 1) * TT, Y = cell.y * TT;
      const slot = TA.townDeskSlots(cell.seats)[0]; // solo seat, top (faces the viewer)
      const cx = X + slot.chairX + 7;
      const sp = this.town.sp;
      const s = this.sessions.get(key);

      // seated agent — a pure function of the session name (film's drawPod:
      // person first, then the table over the lower body, then the device).
      // Absent (seated=false) while the agent is walking or napping on the sofa.
      if (seated && state !== 'off') {
        const typing = state === 'working' && !REDUCED ? Math.floor(t * 7 + hash(name)) % 2 : 0;
        const c = TA.townCharacter(TA.townLookFor(name), 'down', typing, 'sit', state === 'idle');
        const cw = c.width * AS, ch = c.height * AS;
        ctx.drawImage(this.sprite2x(c), cx - cw / 2, Y + 25 - ch, cw, ch);
        if (state === 'idle' && bubbles) bubbles.push([cx, Y - 12, 'sleep']); // Zzz above chair
      }

      // table over the agent's lower body (also baked in the base canvas)
      const table = sp.tableSmall[this.deskColor(name)];
      if (table) ctx.drawImage(this.sprite2x(table), X + 14, Y + 17, table.width, table.height);

      // monitor on the desk — the session state is readable on it
      const screenFrame = state === 'working' ? frame % 7 : state === 'idle' ? frame % 2 : 0;
      const scr = TA.townScreen(state, screenFrame);
      ctx.drawImage(this.sprite2x(scr), X + slot.chairX, Y + 13, scr.width, scr.height);

      // holographic live preview: floating tactical projection after the desktop (lower) with radiant light beam
      const isActive = key === this.activeKey;
      if (s && s.preview) this.drawPreview(X + slot.chairX, Y, s.preview, key, name, state === 'working' || isActive, t);

      // glow: working (blue), active session (accent, steady) — pre-baked sprites,
      // the pulse modulates globalAlpha directly without save/restore or pipeline flushes
      if (state === 'working' || isActive) {
        const pulse = REDUCED ? 0.5 : state === 'working' ? 0.5 + 0.08 * Math.sin(t * 23 + hash(name) % 7) : 0.55;
        ctx.globalAlpha = pulse * 0.55;
        ctx.drawImage(isActive ? this.glowActive : this.glowWorking, cx - 20, Y - 8, 40, 40);
        ctx.globalAlpha = 1;
      }
      if (isActive) {
        // Frame the holographic projection of the session currently displayed
        // in the terminal, so it's obvious which office preview is live. Line
        // width is held constant in screen space (/z) — a fixed 1.5px world
        // line all but disappears when the whole town is zoomed out.
        const bx = cx - 54, by = Y + 40, bw = 108, bh = 54;
        const lw = 2 / this.cam.z;
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.30)';
        ctx.lineWidth = lw * 2.5;
        ctx.strokeRect(bx - lw, by - lw, bw + lw * 2, bh + lw * 2);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.95)';
        ctx.lineWidth = lw;
        ctx.strokeRect(bx, by, bw, bh);
      }
    }

    // holographic screen projection: live session lines projected after the desktop (lower)
    // with a glowing radiant light cone shooting down from the console table.
    drawPreview(mx, Y, preview, cacheKey, sessionName, active = false, t = performance.now() / 1000) {
      const { ctx } = this;
      const W = 108, H = 54, pad = 3.0, fs = 5.2, lh = 5.8;
      // Supersample the cached card so the terminal text stays crisp once the
      // town zoom and HiDPI factor (devicePixelRatio × zoom) scale it up. The
      // factor is quantized to ½-steps so smooth zooming re-rasterizes rarely.
      const s = Math.min(8, Math.max(1, Math.round((this.dpr * this.cam.z) * 2) / 2));

      // position: centered in front of the desk, below the desktop
      const cx = mx + 7;
      const projX = Math.round(cx - W / 2), projY = Math.round(Y + 40);
      const emitY = Y + 34;

      // Relaxed refresh rate for projection effects (stepped at 10 FPS to minimize CPU cycles)
      const nameHash = hash(cacheKey);
      const animStep = Math.floor(t * 10);
      const waveShimmer = 0.88 + 0.12 * Math.sin(animStep * 0.35 + nameHash);
      const microFlicker = ((animStep + nameHash) % 23 === 0) ? 0.75 : 1.0;
      const holoAlpha = waveShimmer * microFlicker;

      // Blit pre-baked holographic projection light beam
      ctx.globalAlpha = holoAlpha;
      ctx.drawImage(active ? this.holoBeamActive : this.holoBeamWorking, projX, emitY, 104, 6);
      ctx.globalAlpha = 1;

      // Console emitter lens / projector head with pulsing flare
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 2, emitY - 1, 4, 2);
      ctx.fillStyle = `rgba(0, 229, 255, ${0.85 * holoAlpha})`;
      ctx.fillRect(cx - 5, emitY, 10, 1.5);

      // Cache the text and HUD panel on an offscreen canvas; only redraw when preview text changes!
      let cached = this.previewCache.get(cacheKey);
      if (!cached || cached.raw !== preview || cached.s !== s) {
        const lines = preview.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0);
        const maxChars = Math.floor((W - pad * 2) / (fs * 0.6));

        const off = document.createElement('canvas');
        off.width = Math.round(W * s); off.height = Math.round(H * s);
        const octx = off.getContext('2d');
        octx.scale(s, s);

        // Dark translucent panel
        octx.fillStyle = 'rgba(8, 16, 28, 0.94)';
        octx.fillRect(0, 0, W, H);

        // Glowing cyan border
        octx.strokeStyle = 'rgba(0, 229, 255, 0.85)';
        octx.lineWidth = 1;
        octx.strokeRect(0.5, 0.5, W - 1, H - 1);

        // Corner HUD brackets
        octx.fillStyle = '#00e5ff';
        octx.fillRect(0, 0, 5, 1.5); octx.fillRect(0, 0, 1.5, 5);
        octx.fillRect(W - 5, 0, 5, 1.5); octx.fillRect(W - 1.5, 0, 1.5, 5);
        octx.fillRect(0, H - 1.5, 5, 1.5); octx.fillRect(0, H - 5, 1.5, 5);
        octx.fillRect(W - 5, H - 1.5, 5, 1.5); octx.fillRect(W - 1.5, H - 5, 1.5, 5);

        // Subtle scanlines
        octx.fillStyle = 'rgba(0, 229, 255, 0.05)';
        for (let sl = 2; sl < H; sl += 4) {
          octx.fillRect(1, sl, W - 2, 1);
        }

        // Header bar with session name: ensures every preview card clearly shows its identity
        octx.font = '700 6px "JetBrains Mono", ui-monospace, Menlo, monospace';
        octx.textBaseline = 'top';
        octx.fillStyle = active ? '#00e5ff' : '#38bdf8';
        octx.fillText('▶ ' + (sessionName || cacheKey.split(':').pop()), pad, pad);

        octx.strokeStyle = 'rgba(0, 229, 255, 0.25)';
        octx.beginPath();
        octx.moveTo(pad, pad + 7.5);
        octx.lineTo(W - pad, pad + 7.5);
        octx.stroke();

        // Terminal text lines (the last 7 lines below the header — a denser
        // 5.2px face fits ~80% more console context in the same card size)
        octx.font = '600 ' + fs + 'px "JetBrains Mono", ui-monospace, Menlo, monospace';
        const shown = lines.slice(-7);
        shown.forEach((l, i) => {
          let txt = l.length > maxChars ? '…' + l.slice(-(maxChars - 1)) : l;
          const isPrompt = /^[$>\u276f#%]/.test(l.trim()) || /\$\s/.test(l);
          octx.fillStyle = isPrompt ? '#4ade80' : '#e0f2fe';
          octx.fillText(txt, pad, pad + 9 + i * lh);
        });

        cached = { raw: preview, s, canvas: off };
        this.previewCache.set(cacheKey, cached);
      }

      // Blit cached holographic tactical display screen (downsample the
      // supersampled card back to its world rect; smoothing on for the
      // downsample so the packed glyphs don't alias).
      ctx.globalAlpha = holoAlpha;
      ctx.drawImage(cached.canvas, projX, projY, W, H);
      ctx.globalAlpha = 1;

      // Moving holographic scanning beam drifting down the display (stepped at 10 FPS)
      const scanOffset = ((animStep * 2 + nameHash * 5) % (H - 4)) + 2;
      ctx.fillStyle = active ? 'rgba(0, 229, 255, 0.22)' : 'rgba(0, 180, 255, 0.12)';
      ctx.fillRect(projX + 1, projY + scanOffset, W - 2, 2);
    }

    drawPlus(b) {
      const { ctx } = this;
      const p = b.plus;
      if (!p) return;
      const hover = this.hover && this.hover.type === 'plus' && this.hover.host === b.hostKey;
      const off = this.hostOff(b.hostKey);
      const s = p.s, r = 4;
      if (off) ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(p.x + r, p.y);
      ctx.arcTo(p.x + s, p.y, p.x + s, p.y + s, r);
      ctx.arcTo(p.x + s, p.y + s, p.x, p.y + s, r);
      ctx.arcTo(p.x, p.y + s, p.x, p.y, r);
      ctx.arcTo(p.x, p.y, p.x + s, p.y, r);
      ctx.closePath();
      ctx.fillStyle = hover ? '#00e5ff' : 'rgba(12, 18, 30, 0.94)';
      ctx.fill();
      ctx.strokeStyle = hover ? '#ffffff' : 'rgba(0, 229, 255, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const mx = p.x + s / 2, my = p.y + s / 2, a = s * 0.28;
      ctx.strokeStyle = hover ? '#0a0e18' : '#00e5ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx - a, my); ctx.lineTo(mx + a, my);
      ctx.moveTo(mx, my - a); ctx.lineTo(mx, my + a);
      ctx.stroke();
      if (off) ctx.globalAlpha = 1;
    }

    drawCenterBadge() {
      const { ctx } = this;
      const c = this.town.layout.center;
      if (!c) return;
      const hover = this.hover && this.hover.type === 'center';
      const cx = (c.x + c.w / 2) * TT, cy = c.y * TT + 12;
      const badge = hover ? this.centerBadgeHover : this.centerBadgeNormal;
      if (badge) ctx.drawImage(badge, cx - 13, cy - 13, 26, 26);
    }

    // Pre-bake static cargo carrier hull for Orbital Sessions (saves ~40 drawing ops per frame)
    bakeStorageShipHull(ship) {
      const { w, h } = ship;
      const padL = 14, padR = 14;
      const S = this.bakeS || 1; // HiDPI: bake the hull at 2x for crisp edges
      const c = document.createElement('canvas');
      c.width = (w + padL + padR) * S;
      c.height = (h + 10) * S;
      const ctx = c.getContext('2d');
      ctx.scale(S, S);
      const x = padL, y = 0;

      // Heavy Industrial Cargo / Data-Vault Freighter Hull
      ctx.fillStyle = '#141c2b';
      ctx.beginPath();
      ctx.moveTo(x + 24, y);
      ctx.lineTo(x + w - 24, y);
      ctx.lineTo(x + w, y + 24);
      ctx.lineTo(x + w, y + h - 20);
      ctx.lineTo(x + w - 30, y + h);
      ctx.lineTo(x + 30, y + h);
      ctx.lineTo(x, y + h - 20);
      ctx.lineTo(x, y + 24);
      ctx.closePath();
      ctx.fill();

      // Heavy durasteel outer border
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Glowing cyan deflector trim
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Cargo Container Pods on Left & Right Flanks
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x - 12, y + 35, 14, h - 70);
      ctx.strokeStyle = '#475569';
      ctx.strokeRect(x - 12, y + 35, 14, h - 70);
      ctx.fillStyle = '#f59e0b';
      for (let hy = y + 42; hy < y + h - 45; hy += 12) {
        ctx.fillRect(x - 10, hy, 10, 2);
      }

      ctx.fillStyle = '#1e293b';
      ctx.fillRect(x + w - 2, y + 35, 14, h - 70);
      ctx.strokeStyle = '#475569';
      ctx.strokeRect(x + w - 2, y + 35, 14, h - 70);
      ctx.fillStyle = '#f59e0b';
      for (let hy = y + 42; hy < y + h - 45; hy += 12) {
        ctx.fillRect(x + w, hy, 10, 2);
      }

      // Sublight Engine Thrusters at Bottom Stern
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(x + 50, y + h - 4, 30, 4);
      ctx.fillRect(x + w - 80, y + h - 4, 30, 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + 58, y + h - 2, 14, 2);
      ctx.fillRect(x + w - 72, y + h - 2, 14, 2);

      // Title Banner Header Box (Top)
      ctx.fillStyle = 'rgba(10, 16, 28, 0.95)';
      ctx.fillRect(x + 10, y + 8, w - 20, 24);
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 10, y + 8, w - 20, 24);

      ship.hullCanvas = c;
      ship.hullOffsetX = padL;
      ship.hullW = w + padL + padR; // logical (world-px) size of the bake
      ship.hullH = h + 10;
    }

    // Pre-calculate Orbital Sessions manifest positions & text measurements (runs in update(), not in render loop)
    updateStorageShipLayout() {
      if (!this.town || !this.town.storageShip) return;
      const ship = this.town.storageShip;
      const { x, y, w, h } = ship;
      // Every configured host gets a manifest row — including the ones hidden
      // from the map by the eye toggle (dimmed, but still the way back).
      const hosts = (this.hosts || []).map((hh) => hh.name);
      const rowH = Math.floor((h - 44) / Math.max(1, hosts.length));

      const measureCtx = (this._measureCtx ||= document.createElement('canvas').getContext('2d'));
      measureCtx.font = '600 11.5px "JetBrains Mono", monospace';

      const hostRows = [];
      const items = [];
      const hostItems = [];
      const visItems = [];

      hosts.forEach((hKey, idx) => {
        const rowY = 36 + idx * rowH;
        // eye + slide switch, left of the status dot
        const visItem = { host: hKey, x: x + 14, y: y + rowY + Math.round((rowH - 16) / 2), w: 42, h: 16 };
        visItems.push(visItem);
        // status dot + host name (click = toggle polling), right of the switch
        const hostItem = { host: hKey, x: x + 58, y: y + rowY + 2, w: 88, h: rowH - 6 };
        hostItems.push(hostItem);

        // ellipsise the callsign so it never runs into the session pills
        let label = hKey.toUpperCase();
        measureCtx.font = '700 13px "JetBrains Mono", monospace';
        if (measureCtx.measureText(label).width > 68) {
          while (label.length > 1 && measureCtx.measureText(label + '…').width > 68) label = label.slice(0, -1);
          label += '…';
        }

        const prefix = hKey + ':';
        const hostSessions = [];
        for (const [key, s] of this.sessions) {
          if (key.startsWith(prefix)) hostSessions.push({ key, name: s.name });
        }

        const pills = [];
        let pillX = 148;
        measureCtx.font = '600 11.5px "JetBrains Mono", monospace'; // pill face
        if (hostSessions.length > 0) {
          for (const s of hostSessions) {
            const label2 = s.name;
            const tw = measureCtx.measureText(label2).width;
            const pw = Math.round(tw + 18), ph = 20;
            const py = rowY + Math.round((rowH - ph) / 2) - 1;
            if (pillX + pw > w - 16) break;

            const pill = { key: s.key, name: label2, x: x + pillX, y: y + py, w: pw, h: ph, host: hKey };
            pills.push(pill);
            items.push(pill);
            pillX += pw + 8;
          }
        }

        hostRows.push({
          hostKey: hKey,
          nameLabel: label,
          rowY: y + rowY,
          rowH,
          hostItem,
          visItem,
          pills,
          hasSessions: hostSessions.length > 0,
        });
      });

      ship.hostRows = hostRows;
      ship.items = items;
      ship.hostItems = hostItems;
      ship.visItems = visItems;
      ship.totalSessions = this.sessions.size;
    }

    // Orbital Storage Starship / Data Vault to the left of the Town Hall (crisp native vector typography)
    drawStorageShip(ctx, t) {
      if (!this.town || !this.town.storageShip) return;
      const ship = this.town.storageShip;
      const { x, y, w, h } = ship;

      // 1. Blit pre-baked cargo freighter hull
      if (ship.hullCanvas) {
        ctx.drawImage(ship.hullCanvas, x - (ship.hullOffsetX || 14), y,
          ship.hullW || ship.hullCanvas.width, ship.hullH || ship.hullCanvas.height);
      }

      // 2. Title Banner Header Text (crisp vector font at native screen resolution)
      ctx.font = '700 13px "JetBrains Mono", monospace';
      ctx.fillStyle = '#00e5ff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('📦 ORBITAL SESSIONS // MANIFEST', x + 18, y + 20);

      ctx.textAlign = 'right';
      ctx.font = '700 12px "JetBrains Mono", monospace';
      ctx.fillStyle = '#f1fa8c';
      ctx.fillText((ship.totalSessions || 0) + ' ACTIVE SESSIONS', x + w - 18, y + 20);
      ctx.textAlign = 'left';

      // 3. Render manifest rows and pills with razor-sharp vector text
      const rows = ship.hostRows || [];
      for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const rowY = row.rowY, rowH = row.rowH, hKey = row.hostKey;
        const off = this.hostOff(hKey);
        const hidden = this.isHostHidden(hKey);
        const isHostHover = this.hover && this.hover.type === 'host-sign' && this.hover.host === hKey;
        const isVisHover = this.hover && this.hover.type === 'host-vis' && this.hover.host === hKey;

        // Row background strip
        ctx.fillStyle = idx % 2 === 0 ? 'rgba(15, 23, 42, 0.65)' : 'rgba(10, 16, 28, 0.65)';
        ctx.fillRect(x + 10, rowY, w - 20, rowH - 2);

        // hosts hidden from the map render dimmed (the eye toggle stays legible)
        if (hidden) ctx.globalAlpha = 0.55;

        // visibility slide switch + eye, left of the status dot
        this.drawVisSwitch(row.visItem, hidden, isVisHover);

        // Host name hover highlight
        if (isHostHover) {
          ctx.fillStyle = 'rgba(0, 229, 255, 0.18)';
          ctx.fillRect(row.hostItem.x, row.hostItem.y, row.hostItem.w, row.hostItem.h);
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(row.hostItem.x, row.hostItem.y, row.hostItem.w, row.hostItem.h);
        }

        // Host status dot & name
        ctx.fillStyle = off ? '#ef4444' : '#10b981';
        ctx.beginPath();
        ctx.arc(x + 64, rowY + rowH / 2 - 1, 4.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '700 13px "JetBrains Mono", monospace';
        ctx.fillStyle = off ? '#64748b' : isHostHover ? '#00e5ff' : '#38bdf8';
        ctx.fillText(row.nameLabel, x + 76, rowY + rowH / 2 - 1);

        if (!row.hasSessions) {
          ctx.font = 'italic 11px "JetBrains Mono", monospace';
          ctx.fillStyle = '#64748b';
          ctx.fillText(off ? '(offline / polling disabled)' : '(idle / no sessions)', x + 148, rowY + rowH / 2 - 1);
        } else {
          ctx.font = '600 11.5px "JetBrains Mono", monospace';
          for (const p of row.pills) {
            const isHover = this.hover && this.hover.type === 'manifest-session' && this.hover.key === p.key;
            const isActive = p.key === this.activeKey;
            const s = this.sessions.get(p.key);

            // Pill box
            ctx.fillStyle = isActive ? 'rgba(0, 229, 255, 0.28)' : isHover ? 'rgba(56, 189, 248, 0.24)' : 'rgba(8, 12, 22, 0.88)';
            ctx.fillRect(p.x, p.y, p.w, p.h);

            ctx.strokeStyle = isActive ? '#00e5ff' : isHover ? '#38bdf8' : 'rgba(0, 229, 255, 0.45)';
            ctx.lineWidth = 1;
            ctx.strokeRect(p.x, p.y, p.w, p.h);

            // Activity dot inside pill
            ctx.fillStyle = (s && s.activity) ? '#10b981' : '#64748b';
            ctx.fillRect(p.x + 5, p.y + p.h / 2 - 2, 4, 4);

            // Text (rendered with crisp subpixel antialiasing at native resolution)
            ctx.fillStyle = isActive ? '#00e5ff' : '#f8fafc';
            ctx.fillText(p.name, p.x + 13, p.y + p.h / 2);
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // The per-host visibility control in an ORBITAL SESSIONS row: an eye icon
    // plus a slide switch (knob right = shown on the map, knob left = hidden).
    // Vector under the camera transform — crisp at any dpr/zoom, ~15 ops/row.
    drawVisSwitch(v, hidden, hover) {
      const { ctx } = this;
      const cy = v.y + v.h / 2;

      // eye icon (almond outline + pupil; slashed through when hidden)
      const ex = v.x + 9;
      ctx.strokeStyle = hidden ? '#64748b' : hover ? '#7dd3fc' : '#00e5ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ex - 6, cy);
      ctx.quadraticCurveTo(ex, cy - 5.5, ex + 6, cy);
      ctx.quadraticCurveTo(ex, cy + 5.5, ex - 6, cy);
      ctx.stroke();
      ctx.fillStyle = hidden ? '#64748b' : '#00e5ff';
      ctx.beginPath();
      ctx.arc(ex, cy, 1.8, 0, Math.PI * 2);
      ctx.fill();
      if (hidden) {
        ctx.beginPath();
        ctx.moveTo(ex - 6.5, cy - 5);
        ctx.lineTo(ex + 6.5, cy + 5);
        ctx.stroke();
      }

      // slide track + knob
      const tx = v.x + 19, tw = 22, th = 10, ty = cy - th / 2;
      this.rr(tx, ty, tw, th, th / 2);
      ctx.fillStyle = hidden ? 'rgba(100, 116, 139, 0.25)' : 'rgba(0, 229, 255, 0.25)';
      ctx.fill();
      ctx.strokeStyle = hidden ? 'rgba(100, 116, 139, 0.6)' : hover ? '#7dd3fc' : 'rgba(0, 229, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const kx = hidden ? tx + th / 2 + 0.5 : tx + tw - th / 2 - 0.5;
      ctx.fillStyle = hidden ? '#94a3b8' : '#00e5ff';
      ctx.beginPath();
      ctx.arc(kx, cy, th / 2 - 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // rounded-rect path (single radius or [tl, tr, br, bl])
    rr(x, y, w, h, r) {
      const { ctx } = this;
      const [a, b, c, d] = Array.isArray(r) ? r : [r, r, r, r];
      ctx.beginPath();
      ctx.moveTo(x + a, y);
      ctx.lineTo(x + w - b, y); ctx.arcTo(x + w, y, x + w, y + b, b);
      ctx.lineTo(x + w, y + h - c); ctx.arcTo(x + w, y + h, x + w - c, y + h, c);
      ctx.lineTo(x + d, y + h); ctx.arcTo(x, y + h, x, y + h - d, d);
      ctx.lineTo(x, y + a); ctx.arcTo(x, y, x + a, y, a);
      ctx.closePath();
    }

    // a sci-fi holographic docking bay beacon; glowing red while someone waits
    drawBusStop(stop) {
      const { ctx } = this;
      const x = stop.wait.x, y = stop.wait.y;
      const waiting = this.busWaiting();
      // Docking beacon pylon
      ctx.fillStyle = '#1e293b'; ctx.fillRect(x + 11, y - 36, 4, 38);
      ctx.fillStyle = waiting ? '#ef4444' : '#00e5ff';
      ctx.fillRect(x + 9, y - 44, 8, 8); // glowing beacon light
      ctx.strokeStyle = waiting ? 'rgba(239, 68, 68, 0.6)' : 'rgba(0, 229, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 7, y - 46, 12, 12);
    }

    // a sci-fi space shuttle transport, floating with pulsing plasma thrusters & deflector
    drawBus(bus, t = performance.now() / 1000) {
      const { ctx } = this;
      ctx.save(); ctx.translate(Math.round(bus.x), Math.round(bus.y));
      const L = -34, T0 = -22, w = 68, h = 26;

      // Pulsing plasma engine exhaust plume
      const thrusterPulse = 10 + Math.sin(t * 25) * 4;
      const grad = ctx.createLinearGradient(L - thrusterPulse, T0 + h / 2, L, T0 + h / 2);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(0.5, 'rgba(0, 229, 255, 0.45)');
      grad.addColorStop(1, '#ffffff');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(L, T0 + h / 2 - 6);
      ctx.lineTo(L - thrusterPulse, T0 + h / 2);
      ctx.lineTo(L, T0 + h / 2 + 6);
      ctx.closePath();
      ctx.fill();

      // Anti-gravity repulsor field glow underneath
      ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
      ctx.beginPath();
      ctx.ellipse(0, T0 + h + 2, w / 2 - 4, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      // Shuttle Hull
      this.rr(L, T0, w, h, [14, 18, 5, 5]);
      ctx.fillStyle = '#151d2a'; ctx.fill();
      ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1.5; ctx.stroke();

      // Deflector nose shield arc
      ctx.strokeStyle = 'rgba(0, 255, 200, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(L + w - 4, T0 + h / 2, 10, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();

      // Cockpit & passenger observation window
      const deck = (x0, y0, ww, list) => {
        ctx.fillStyle = 'rgba(0, 229, 255, 0.25)'; ctx.fillRect(x0, y0, ww, 10);
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, ww, 10); ctx.clip();
        list.forEach((p, i) => {
          const look = typeof p === 'string' ? TA.townLookFor(p) : p;
          const pc = TA.townCharacter(look, 'right', 0, 'stand', false);
          ctx.drawImage(this.sprite2x(pc), x0 + 1 + i * 12, y0, pc.width, pc.height);
        });
        ctx.restore();
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
        ctx.strokeRect(x0, y0, ww, 10);
      };

      deck(L + 8, T0 + 7, w - 22, [...(bus.crew || []), ...(bus.riders || [])]);

      // Blinking wingtip beacons (port=red, starboard=green)
      const blink = Math.floor(t * 3) % 2 === 0;
      if (blink) {
        ctx.fillStyle = '#ef4444'; ctx.fillRect(L + 6, T0 + 2, 3, 2);
        ctx.fillStyle = '#22c55e'; ctx.fillRect(L + 6, T0 + h - 4, 3, 2);
      }

      // Hazard warning strobes when halted at the stop
      if (bus.hazard) {
        ctx.fillStyle = '#ffaa00';
        ctx.fillRect(L + w - 3, T0 + 3, 3, 3);
        ctx.fillRect(L + w - 3, T0 + h - 6, 3, 3);
      }
      ctx.restore();
    }

    // deep-space sky starfield with twinkling, colored stars, pre-baked nebulae and meteors
    drawSkyStars(ctx, w, h, t) {
      if (!this.skyStars) return;
      const { x: camx, y: camy } = this.cam;

      // Blit pre-baked cosmic nebulae gradients (zero per-frame gradient allocations)
      if (this.nebulaCanvas) {
        ctx.drawImage(this.nebulaCanvas, 0, 0);
      }

      for (const st of this.skyStars) {
        const px = Math.round(((st.x * 2560 - camx * 0.15) % w + w) % w);
        const py = Math.round(((st.y * 1600 - camy * 0.15) % h + h) % h);
        const alpha = Math.max(0.2, Math.min(1, 0.45 + 0.55 * Math.sin(t * st.freq + st.phase)));
        ctx.fillStyle = st.color;
        ctx.globalAlpha = alpha;
        if (st.spike) {
          ctx.fillRect(px - 3, py, 7, 1);
          ctx.fillRect(px, py - 3, 1, 7);
          ctx.fillRect(px - 1, py - 1, 3, 3);
        } else {
          ctx.fillRect(px, py, st.size, st.size);
        }
      }
      // shooting stars across the cosmic sky
      const meteorT = (t * 0.35) % 12;
      if (meteorT < 0.75) {
        const p = meteorT / 0.75;
        const mx = (w * 0.15 + p * w * 0.4) % w;
        const my = (h * 0.05 + p * h * 0.3) % h;
        ctx.strokeStyle = `rgba(0, 229, 255, ${1 - p})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mx - 32, my - 22);
        ctx.lineTo(mx, my);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // slowly rotating spiral galaxies in the sky (pre-baked to offscreen canvas)
    drawGalaxies(ctx, w, h, t) {
      if (!this.galaxies) return;
      const { x: camx, y: camy } = this.cam;
      for (const g of this.galaxies) {
        if (!g.canvas) continue;
        const gx = Math.round(w * g.nx - (camx - 800) * 0.03);
        const gy = Math.round(h * g.ny - (camy - 500) * 0.025);
        const rot = t * g.speed;

        ctx.translate(gx, gy);
        ctx.rotate(g.angle); // fixed tilt angle
        ctx.scale(1, g.tilt); // 3D inclination
        ctx.rotate(rot); // slow continuous cosmic rotation!
        ctx.drawImage(g.canvas, -g.offset, -g.offset, g.size, g.size);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      }
    }

    // iconic sci-fi space traffic: Millennium Falcon, X-Wing, Star Trek Enterprise (max 1 active at a time).
    // They fly in the distant sky (screen space) behind the town, not over the offices.
    updateSpaceTraffic(t) {
      if (!this.spaceTraffic || !this.cv) return;
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (!w || !h) return;
      const dt = this.trafficLastT ? Math.min(0.1, t - this.trafficLastT) : 0.016;
      this.trafficLastT = t;

      // Wrap boundaries around the viewport (screen space, with an off-screen margin)
      const minX = -140, maxX = w + 140;
      const minY = -120, maxY = h + 120;

      // Count currently active ships (strictly max 1 allowed simultaneously)
      let activeCount = 0;
      for (const ship of this.spaceTraffic) if (ship.active) activeCount++;

      for (const ship of this.spaceTraffic) {
        if (!ship.active) {
          // Ship is in hyperspace standby cooldown
          ship.cooldown = (ship.cooldown || 0) - dt;
          // Launch pass only when cooldown expired and NO OTHER ship is flying (strictly 1 at a time)
          if (ship.cooldown <= 0 && activeCount === 0) {
            ship.active = true;
            activeCount++;

            // Pick a scenic entry edge: 0=left, 1=right, 2=top, 3=bottom
            const side = Math.floor(Math.random() * 4);
            if (side === 0) {
              ship.x = minX;
              ship.y = minY + 0.15 * (maxY - minY) + Math.random() * 0.7 * (maxY - minY);
              ship.targetAngle = -0.3 + Math.random() * 0.6;
            } else if (side === 1) {
              ship.x = maxX;
              ship.y = minY + 0.15 * (maxY - minY) + Math.random() * 0.7 * (maxY - minY);
              ship.targetAngle = Math.PI - 0.3 + Math.random() * 0.6;
            } else if (side === 2) {
              ship.y = minY;
              ship.x = minX + 0.2 * (maxX - minX) + Math.random() * 0.6 * (maxX - minX);
              ship.targetAngle = Math.PI / 2 - 0.4 + Math.random() * 0.8;
            } else {
              ship.y = maxY;
              ship.x = minX + 0.2 * (maxX - minX) + Math.random() * 0.6 * (maxX - minX);
              ship.targetAngle = -Math.PI / 2 - 0.4 + Math.random() * 0.8;
            }
            ship.angle = ship.targetAngle;
            ship.timer = 0;
            ship.interval = 4 + Math.random() * 4;
            ship.passTimer = 0;
          }
          continue;
        }

        // Active ship in flight
        ship.passTimer = (ship.passTimer || 0) + dt;
        ship.timer += dt;
        if (ship.timer >= ship.interval) {
          ship.timer = 0;
          ship.interval = 3 + Math.random() * 4;
          ship.targetAngle += -0.25 + Math.random() * 0.5;
        }

        // Steer angle smoothly towards targetAngle
        let diff = (ship.targetAngle - ship.angle + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        ship.angle += Math.sign(diff) * Math.min(Math.abs(diff), 1.4 * dt);

        // Update velocity and position
        ship.vx = Math.cos(ship.angle) * ship.speed;
        ship.vy = Math.sin(ship.angle) * ship.speed;
        ship.x += ship.vx * dt;
        ship.y += ship.vy * dt;

        // Disappear once the ship exits the camera view after its scenic pass
        if (ship.passTimer > 2.5 && (ship.x < minX - 15 || ship.x > maxX + 15 || ship.y < minY - 15 || ship.y > maxY + 15)) {
          ship.active = false;
          activeCount--;
          ship.cooldown = 6 + Math.random() * 10; // 6-16s cooldown before next pass
        }
      }
    }

    drawSpaceTraffic(ctx, t) {
      if (!this.spaceTraffic || !this.town) return;
      const sp = this.town.sp;
      if (!sp) return;

      for (const ship of this.spaceTraffic) {
        if (!ship.active) continue; // Only draw active ships in flight!
        const sprite = sp[ship.id];
        if (!sprite) continue;

        ctx.save();
        ctx.translate(Math.round(ship.x), Math.round(ship.y));
        ctx.rotate(ship.angle);
        ctx.scale(1.6, 1.6); // Prominent, majestic scale

        // Sublight / ion / warp engine plume trail behind the ship
        const trailLen = 38 + Math.sin(t * 18 + ship.x) * 8;
        if (ship.trailCanvas) {
          ctx.drawImage(ship.trailCanvas, -trailLen, -3.5, trailLen, 7);
        }

        // Draw the spaceship sprite centered
        ctx.drawImage(this.sprite2x(sprite), -sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height);
        ctx.restore();
      }
    }

    // space station office module effects: blinking navigation beacons
    drawStationEffects(b, t) {
      const { ctx } = this;
      const lift = this.hostLift(b.hostKey);
      const dim = 1 - lift;

      // Offline hosts get a heavy shadow over the whole office, so a down host
      // reads as dark/powered-off at a glance rather than just a retracted roof.
      if (dim > 0.02) {
        ctx.globalAlpha = 0.65 * dim;
        ctx.fillStyle = '#03060c';
        ctx.fillRect(b.x * TT - 4, b.y * TT - 12, b.w * TT + 8, b.h * TT + 44);
        ctx.globalAlpha = 1;
      }

      // Under-glow: an online office hovers on its thrusters; the glow fades
      // as the host goes down and the ship settles.
      if (lift > 0.05) {
        const gx = b.x * TT + (b.w * TT) * 0.15;
        const gw = (b.w * TT) * 0.7;
        const gy = (b.y + b.h) * TT + 4;
        ctx.globalAlpha = 0.28 * lift;
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(gx, gy, gw, 2);
        ctx.globalAlpha = 0.14 * lift;
        ctx.fillRect(gx + gw * 0.12, gy + 2, gw * 0.76, 3);
        ctx.globalAlpha = 1;
      }

      // Blinking station anti-collision beacons on module corners. Offline
      // hosts flash only the red "grounded" beacon, slower.
      const off = lift <= 0.5;
      const blinkRed = off ? Math.floor(t * 0.35) % 2 === 0 : Math.floor(t * 0.6) % 2 === 0;
      const blinkCyan = !off && Math.floor(t * 0.6 + 0.5) % 2 === 0;
      ctx.globalAlpha = 0.5 + 0.5 * lift;
      if (blinkRed) {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(b.x * TT - 2, b.y * TT - 2, 4, 4);
        ctx.fillRect((b.x + b.w) * TT - 2, (b.y + b.h) * TT - 2, 4, 4);
      }
      if (blinkCyan) {
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect((b.x + b.w) * TT - 2, b.y * TT - 2, 4, 4);
        ctx.fillRect(b.x * TT - 2, (b.y + b.h) * TT - 2, 4, 4);
      }
      ctx.globalAlpha = 1;
    }

    // true while any agent is waiting at the main bus stop
    busWaiting() {
      const isWait = (nap) => nap && nap.phase === 'waiting-bus';
      for (const nap of this.naps.values()) if (isWait(nap)) return true;
      return false;
    }

    // Pre-bake host sign badges (eliminates per-frame measureText and software shadowBlur)
    bakeHostSigns(b) {
      const label = b.hostKey.toUpperCase();
      const padX = 20, h = 46;

      const measureCtx = (this._signMeasureCtx ||= document.createElement('canvas').getContext('2d'));
      measureCtx.font = '700 30px "JetBrains Mono", ui-monospace, Menlo, monospace';
      const tw = measureCtx.measureText(label).width;
      const w = Math.round(tw + padX * 2 + 18);

      const pad = 12; // margin for shadow blur
      const S = this.bakeS || 1; // HiDPI: bake the sign at 2x for razor-sharp text
      const renderSign = (off) => {
        const c = document.createElement('canvas');
        c.width = (w + pad * 2) * S;
        c.height = (h + pad * 2) * S;
        const sctx = c.getContext('2d');
        sctx.scale(S, S);
        const bx = pad, by = pad;

        sctx.save();
        sctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
        sctx.shadowBlur = 8;
        sctx.shadowOffsetY = 2;
        sctx.fillStyle = off ? 'rgba(15, 20, 30, 0.95)' : 'rgba(10, 14, 22, 0.95)';

        const r = 6;
        sctx.beginPath();
        sctx.moveTo(bx + r, by);
        sctx.lineTo(bx + w - r, by); sctx.arcTo(bx + w, by, bx + w, by + r, r);
        sctx.lineTo(bx + w, by + h - r); sctx.arcTo(bx + w, by + h, bx + w - r, by + h, r);
        sctx.lineTo(bx + r, by + h); sctx.arcTo(bx, by + h, bx, by + h - r, r);
        sctx.lineTo(bx, by + r); sctx.arcTo(bx, by, bx + r, by, r);
        sctx.closePath();
        sctx.fill();
        sctx.shadowColor = 'transparent';

        sctx.strokeStyle = off ? 'rgba(100, 116, 139, 0.4)' : 'rgba(0, 229, 255, 0.85)';
        sctx.lineWidth = 2;
        sctx.stroke();

        sctx.fillStyle = off ? '#ef4444' : '#10b981';
        sctx.beginPath();
        sctx.arc(bx + 18, by + h / 2, 6, 0, Math.PI * 2);
        sctx.fill();

        sctx.font = '700 30px "JetBrains Mono", ui-monospace, Menlo, monospace';
        sctx.fillStyle = off ? '#94a3b8' : '#ffffff';
        sctx.textAlign = 'left';
        sctx.textBaseline = 'middle';
        sctx.fillText(label, bx + 32, by + h / 2 + 1);
        sctx.restore();

        return c;
      };

      b.signCanvasOn = renderSign(false);
      b.signCanvasOff = renderSign(true);
      b.signW = w;
      b.signH = h;
      b.signPad = pad;
    }

    drawSign(b) {
      const { ctx } = this;
      const off = this.hostOff(b.hostKey);
      const canvas = off ? b.signCanvasOff : b.signCanvasOn;
      if (!canvas) return;
      const x = Math.round(b.x * TT + (b.w * TT) / 2), y = Math.round(b.y * TT - 34);
      const bx = Math.round(x - b.signW / 2), by = y - 28;
      ctx.drawImage(canvas, bx - b.signPad, by - b.signPad, b.signW + b.signPad * 2, b.signH + b.signPad * 2);
    }
  }

  window.TownView = TownView;
})();
