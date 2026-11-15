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

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

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
      this.nav = new Map();  // hostKey -> TA.TownNavigation (A* through the building)
      this.needsRedraw = true;
      this.raf = null;
      this.pointers = new Map();
      this.drag = null;

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
      this.needsRedraw = true;
    }

    /* ---------- data ---------- */

    update(hosts, activeKey) {
      this.activeKey = activeKey;
      const sessions = new Map();
      const sigHosts = [], sigRooms = [];
      for (const h of hosts) {
        sigHosts.push(h.name + (h.enabled === false ? ':off' : ''));
        const names = (h.sessions || []).map((s) => s.name);
        sigRooms.push(h.name + ':' + names.join(','));
        for (const s of h.sessions || []) {
          sessions.set(h.name + ':' + s.name, { host: h, name: s.name, activity: !!s.activity, cwd: s.cwd || '', preview: s.preview || '' });
        }
      }
      this.sessions = sessions;
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
      this.needsRedraw = true;
    }

    deskColor(name) {
      return DESK_COLORS[hash(name) % DESK_COLORS.length];
    }

    hostOff(name) {
      const h = (this.hosts || []).find((x) => x.name === name);
      return !h || h.enabled === false || h.state === 'offline' || !!h.error;
    }

    /* ---------- building the static scene ---------- */

    buildTown(hosts) {
      if (!hosts.length) { this.town = null; return; }
      const input = {
        hosts: hosts.map((h, i) => ({ key: h.name, displayOrder: i })),
        rooms: hosts.map((h, i) => ({
          key: 'main', hostKey: h.name, order: i,
          deskKeys: (h.sessions || []).map((s) => s.name),
          deskSeats: (h.sessions || []).map(() => 1),
        })),
      };
      const { layout } = TA.layoutTown(input, 'wide');
      const sp = TA.buildTownSprites();
      const M = 32; // margin around the layout (the film uses spec.margin * TT)
      const Wp = layout.width * TT + 2 * M, Hp = layout.height * TT + 2 * M;
      const base = document.createElement('canvas');
      base.width = Wp; base.height = Hp;
      const g = base.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(TA.paintTownGround(layout, { x: -M, y: -M, w: Wp, h: Hp }), 0, 0);
      g.translate(M, M);

      // plaza fountain (from the film)
      const fx = layout.plaza.x * TT + 8, fy = layout.plaza.y * TT + 4;
      const ell = (x, y, rx, ry, c) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = c; g.fill(); };
      ell(fx + 2, fy + 6, 26, 12, 'rgba(0,0,0,.18)');
      ell(fx, fy + 2, 25, 11, '#9d978c');
      ell(fx, fy, 25, 11, '#b9b2a5');
      ell(fx, fy, 20, 8, '#4f9fd3');
      ell(fx, fy - 1, 15, 5, '#6fb9e6');
      g.fillStyle = '#9d978c'; g.fillRect(fx - 3, fy - 14, 6, 14);
      g.fillStyle = '#b9b2a5'; g.fillRect(fx - 5, fy - 16, 10, 3);

      // landscape + town center, depth-sorted by feet y
      const items = [];
      layout.lamps.forEach((l) => items.push([l.y * TT + 8, () => g.drawImage(sp.lamp, l.x * TT + 5, l.y * TT - 22)]));
      layout.bushes.forEach((b) => items.push([b.y * TT + 13, () => g.drawImage(sp.bush, b.x * TT - 2, b.y * TT + 2)]));
      layout.benches.forEach((b) => items.push([b.y * TT + 12, () => g.drawImage(sp.bench, b.x * TT, b.y * TT + 2)]));
      items.push([layout.board.y * TT + 14, () => g.drawImage(sp.board, layout.board.x * TT - 8, layout.board.y * TT - 16)]);
      const center = layout.center;
      items.push([(center.y + center.h) * TT, () => g.drawImage(TA.paintTownCenter(center.w), center.x * TT, center.y * TT)]);
      items.sort((a, b) => a[0] - b[0]).forEach((i) => i[1]());

      // buildings: interior (floors, walls, desks' furniture), lounge, facade;
      // roofs are kept for the per-frame layer (they fade when you look inside)
      const cells = new Map(), roofs = [];
      layout.buildings.forEach((b, i) => {
        const theme = TA.TOWN_HOST_THEMES[i % TA.TOWN_HOST_THEMES.length];
        g.drawImage(TA.paintTownInterior(b, theme, {
          table: sp.table, tableSmall: sp.tableSmall, chair: sp.chair, chairBack: sp.chairBack,
          colorFor: (k) => this.deskColor(k),
        }), b.x * TT, b.y * TT);
        b.plants.forEach((p) => g.drawImage(sp.plant, p.x * TT, (p.y + 1) * TT - 24));
        const L = b.lounge;
        g.drawImage(sp.sofa, (L.x + 1) * TT - 1, (L.y + 1) * TT - 8);
        g.drawImage(sp.coffee, (L.x + 7) * TT + 1, (L.y + 1) * TT - 10);
        g.drawImage(sp.cooler, (L.x + 8) * TT + 2, (L.y + 1) * TT - 12);
        const cx = b.doorX * TT, cy = (b.counter.y + 1) * TT - 8;
        g.drawImage(sp.chair, cx - 7, cy - 14);
        g.drawImage(TA.townCharacter(TA.townLookFor('you'), 'down', 0, 'sit', false), cx - 7, cy - 11);
        g.drawImage(sp.counter, cx - 41, cy);
        // "+" new-session button: right of the reception counter, where the
        // receptionist sits. Clicking it opens +New with this host preselected.
        b.plus = { x: cx + 44, y: cy - 3, s: 18 };
        g.drawImage(TA.paintTownFacade(b, theme), b.x * TT, (b.y + b.h) * TT);
        roofs.push({ host: b.hostKey, c: TA.paintTownRoof(b, theme, this.hostOff(b.hostKey)), x: b.x * TT - 4, y: b.y * TT - 12, b });
        b.rooms.forEach((r) => r.cells.forEach((cell) => { if (cell.deskKey) cells.set(cell.deskKey, { cell, b }); }));
      });
      this.town = { layout, base, M, sp, cells, roofs, Wp, Hp };
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
        riders: [],     // agent names aboard the current bus
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
      return { x, y: b.roadY, hazard, riders: b.riders };
    }

    // waypoints from a point inside the building out to the main bus stop's
    // queue (out the door, up to the road, along the road to the stop)
    busWaypoints(b, from, spot) {
      const stop = this.bus.stop;
      const ex = b.entryX * TT + 8;
      const entry = { x: ex, y: (b.y + 1) * TT + 13 };
      const doorTop = { x: ex, y: b.y * TT + 2 };
      const roadPt = { x: ex, y: stop.wait.y };
      const dest = spot || stop.wait;
      return [from, entry, doorTop, roadPt, dest];
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
      if (isHalt && !this._busHalt) this.boardBus();
      if (this._busVisible && !isVisible) { this.bus.riders = []; this.busRode.clear(); }
      this._busHalt = isHalt;
      this._busVisible = isVisible;
    }

    /* ---------- idle agents: front-desk check-in (✓), then nap / water / bus ---------- */

    // how long the ✓ ("report done") shows at the front desk
    checkMs() { return 1800; }
    // how long an agent lingers at its idle activity before it would cycle
    activityMs(a) { return a === 'water' ? 6000 : 14000; }

    // stand to the left of the reception counter, facing it — the report spot
    frontPos(b) {
      const cx = b.doorX * TT, cy = (b.counter.y + 1) * TT - 8;
      return { x: cx - 26, y: cy + 4 };
    }

    // the water cooler in the lounge (drawn in the base canvas)
    coolerPos(b) {
      const L = b.lounge;
      return { x: (L.x + 8) * TT + 2, y: (L.y + 1) * TT - 2 };
    }

    sofaSpots(b) {
      // two nappers on the sofa (drawn at the film's lounge position)
      const L = b.lounge;
      const sx = (L.x + 1) * TT - 1, sy = (L.y + 1) * TT - 8;
      return [
        { x: sx + 14, y: sy + 9, side: -1 },
        { x: sx + 34, y: sy + 9, side: 1 },
      ];
    }

    // deterministic idle activity for an agent (by name): mostly nap, some
    // water, a few catch the bus
    activityFor(name) {
      const h = hash(name);
      if (this.bus && h % 7 === 0) return 'bus';
      if (h % 5 === 0) return 'water';
      return 'nap';
    }

    // the idle plan: which idle agents leave the desk, with what activity, and
    // where they go. nap is limited to the sofa spots, water to the cooler;
    // overflow stays at the desk (Zzz in the chair, no walk).
    idlePlan() {
      const plan = new Map(); // key -> { activity, spot, b }
      if (!this.town) return plan;
      let busI = 0; // global queue index at the main bus stop
      for (const b of this.town.layout.buildings) {
        if (this.hostOff(b.hostKey)) continue;
        const sofa = this.sofaSpots(b);
        const idle = [];
        for (const [name, info] of this.town.cells) {
          if (info.b.hostKey !== b.hostKey) continue;
          const key = b.hostKey + ':' + name;
          const s = this.sessions.get(key);
          if (s && !s.activity) idle.push(key);
        }
        idle.sort();
        let sofaI = 0, waterI = 0;
        for (const key of idle) {
          const name = key.slice(b.hostKey.length + 1);
          let activity = this.activityFor(name);
          let spot = null;
          if (activity === 'bus' && this.bus && busI < 4) {
            spot = { ...TA.townQueueSpot(this.bus.stop, busI++) };
          } else if (activity === 'water' && waterI < 2) { spot = { ...this.coolerPos(b) }; waterI++; }
          else { activity = 'nap'; if (sofaI < sofa.length) spot = sofa[sofaI++]; }
          if (spot) plan.set(key, { activity, spot, b });
        }
      }
      return plan;
    }

    deskFeet(key) {
      const s = this.sessions.get(key);
      const info = s && this.town && this.town.cells.get(s.name);
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

    buildWalk(b, waypoints) {
      // A* between consecutive waypoints where the grid allows it (the film's
      // TownNavigation); a straight segment where it doesn't (inside a cell)
      let nav = this.nav.get(b.hostKey);
      if (!nav) this.nav.set(b.hostKey, nav = new TA.TownNavigation(b));
      const raw = [waypoints[0]];
      for (let i = 1; i < waypoints.length; i++) {
        const a = waypoints[i - 1], c = waypoints[i];
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
      // killed sessions: their agent checks in at the front desk, then takes
      // the bus (whether it was at the desk or already idle)
      const current = new Set(this.sessions.keys());
      for (const [key, info] of [...this.lastSessions]) {
        if (current.has(key)) continue; // still alive
        this.lastSessions.delete(key);
        if (!this.bus) { this.naps.delete(key); continue; } // no bus: agent leaves
        const b = this.town.layout.buildings.find((x) => x.hostKey === info.b.hostKey) || this.town.layout.buildings[0];
        if (!b) continue;
        const fp = this.frontPos(b);
        const p = { activity: 'bus', spot: this.bus.stop.wait, b };
        const existing = this.naps.get(key);
        if (existing) {
          // already idle: redirect from the current position to the front desk
          const r = this.napPos(existing, t);
          this.naps.set(key, { ...this.makeWalk(key, 'to-front', [[r[0], r[1]], [fp.x, fp.y]], p, b), name: info.name, leaving: true });
        } else {
          // at the desk: walk out
          this.naps.set(key, { ...this.makeWalk(key, 'to-front', [info.feet, info.entry, [fp.x, fp.y]], p, b), name: info.name, leaving: true });
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
          // went idle again mid-return: head to the front desk
          const from = posOf(key);
          const fp = this.frontPos(at.b);
          this.startWalk(key, 'to-front', [from, at.entry, [fp.x, fp.y]], p, at.b);
        } else if (nap.phase === 'to-activity') {
          // reassigned to a different spot mid-walk
          if (nap.p && (nap.p.spot.x !== p.spot.x || nap.p.spot.y !== p.spot.y)) {
            const from = posOf(key);
            const fp = this.frontPos(at.b);
            this.startWalk(key, 'to-activity', [from, [fp.x, fp.y], [p.spot.x, p.spot.y]], p, at.b);
          }
        } else if (nap.phase === 'activity') {
          if (nap.p && (nap.p.spot.x !== p.spot.x || nap.p.spot.y !== p.spot.y)) {
            this.startWalk(key, 'to-activity', [[nap.p.spot.x, nap.p.spot.y], [p.spot.x, p.spot.y]], p, at.b);
          }
        }
        // 'to-front' and 'checking' advance in frame()
      }
      // fresh idle sessions: leave the desk for the front desk (check-in)
      for (const [key, p] of plan) {
        if (this.naps.has(key)) continue;
        const at = this.deskFeet(key);
        if (!at) continue;
        const fp = this.frontPos(at.b);
        this.startWalk(key, 'to-front', [at.feet, at.entry, [fp.x, fp.y]], p, at.b);
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
        else this.startWalk(key, 'to-front', [from, at.entry, [this.frontPos(at.b).x, this.frontPos(at.b).y]], p, at.b);
      }
    }

    /* ---------- camera ---------- */

    initialCamera() {
      if (!this.town) return;
      const b = this.town.layout.buildings[0];
      if (!b) { this.fitCamera(true); return; }
      // Street level on the first host's building: show a part of the town,
      // not all of it. Wheel/pinch to zoom, click empty ground to fit-all.
      this.cam = { x: b.x * TT + (b.w * TT) / 2, y: b.y * TT + (b.h * TT) / 2 + 6, z: 1 };
      this.target = null;
      this.needsRedraw = true;
    }

    fitCamera(instant) {
      if (!this.town) return;
      const L = this.town.layout;
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (!w || !h) return;
      // leave room for the floating header at the top
      const z = clamp(Math.min(w / (L.width * TT + 140), (h - 60) / (L.height * TT + 60)), Z_MIN, 1.5);
      const t = { x: (L.width * TT) / 2, y: (L.height * TT) / 2 + 20, z };
      if (instant) { this.cam = { ...t }; this.target = null; }
      else this.target = t;
      this.needsRedraw = true;
    }

    zoomToBuilding(b) {
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      // desk-level view: at z >= 1.6 the pods are big enough to read
      const z = clamp(Math.min(w * 0.9 / (b.w * TT), (h - 60) * 0.9 / ((b.h + 2) * TT)), 1.6, 2.6);
      this.target = { x: b.x * TT + (b.w * TT) / 2, y: b.y * TT + (b.h * TT) / 2, z };
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
      // moving agents first: a napper on the sofa or a walker in between is
      // the same session as its desk
      for (const [key, nap] of this.naps) {
        let px, py;
        if (nap.phase === 'checking') { const fp = this.frontPos(nap.b); px = fp.x; py = fp.y; }
        else if ((nap.phase === 'activity' || nap.phase === 'waiting-bus') && nap.p) { px = nap.p.spot.x; py = nap.p.spot.y; }
        else { const r = this.napPos(nap, performance.now() / 1000); px = r[0]; py = r[1]; }
        if (wx >= px - 15 && wx <= px + 15 && wy >= py - 16 && wy <= py + 10) {
          const s = this.sessions.get(key);
          const info = s && this.town.cells.get(s.name);
          if (info) return { name: s.name, info, key };
        }
      }
      for (const [name, info] of this.town.cells) {
        const X = (info.cell.x + 1) * TT, Y = info.cell.y * TT;
        if (wx >= X - 6 && wx <= X + 56 && wy >= Y - 6 && wy <= Y + 58) {
          return { name, info, key: info.b.hostKey + ':' + name };
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

    // The "+" new-session button at a building's reception (a little click
    // padding so it's easy to hit at desk-level zoom).
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
      const pod = this.podAt(wx, wy);
      const plus = pod ? null : this.plusAt(wx, wy);
      const b = pod || plus ? null : this.buildingAt(wx, wy);
      const c = pod || plus || b ? null : this.centerAt(wx, wy);
      this.setHover(pod ? { type: 'pod', ...pod } : plus ? { type: 'plus', host: plus } : b ? { type: 'building', b } : c ? { type: 'center' } : null, e);
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
          tip.innerHTML = '<b></b><span class="dim"> · ' + hover.info.b.hostKey + ' · ' + st + (s && s.cwd ? ' · ' + s.cwd : '') + '</span>';
          tip.firstChild.textContent = hover.name;
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
              map.set(key, this.makeWalk(key, 'to-activity', wps, p, nap.b));
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

      const animate = !REDUCED && !!this.town && (this.sessions.size > 0 || !!this.bus);
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
      ctx.fillStyle = '#080b12';
      ctx.fillRect(0, 0, w, h);
      if (!this.town) {
        ctx.fillStyle = '#858faa';
        ctx.font = '12px ' + 'Silkscreen, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('no hosts — add one in ⚙ config', w / 2, h / 2);
        ctx.textAlign = 'left';
        return;
      }
      const T = this.town;
      const { x: camx, y: camy, z } = this.cam;
      const ox = w / 2, oy = h / 2;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(z, z);
      ctx.translate(-camx, -camy);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(T.base, -T.M, -T.M);

      // dynamic desk layer, depth-sorted (pods and the moving agents together)
      const list = [];
      const bubbles = [];
      const frame = REDUCED ? 0 : Math.floor(t * 6);
      for (const [name, info] of T.cells) {
        const key = info.b.hostKey + ':' + name;
        const s = this.sessions.get(key);
        const state = s ? (s.activity ? 'working' : 'idle') : 'off';
        const nap = this.naps.get(key);
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
        if (bus) list.push([bus.y + 8, () => this.drawBus(bus)]);
      }
      list.sort((a, b) => a[0] - b[0]).forEach((e) => e[1]());

      // roofs (light glass — the desks stay visible underneath)
      const ra = this.roofAlpha();
      for (const r of T.roofs) {
        ctx.save();
        ctx.globalAlpha = ra;
        ctx.drawImage(r.c, r.x, r.y);
        ctx.restore();
      }

      // host signs above the buildings
      for (const r of T.roofs) this.drawSign(r.b);

      // "+" new-session buttons at each reception, and the ⚙ badge on the
      // town center (settings) — drawn over the roof so they stay crisp
      for (const b of T.layout.buildings) this.drawPlus(b);
      this.drawCenterBadge();

      // hover / active highlights
      if (this.hover && this.hover.type === 'pod') {
        const X = (this.hover.info.cell.x + 1) * TT, Y = this.hover.info.cell.y * TT;
        ctx.strokeStyle = 'rgba(122,162,247,.9)';
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(X - 7, Y - 5, 62, 62);
      }
      ctx.restore();

      // thought bubbles in screen space: constant size at every zoom, like the film
      for (const [x, y, kind] of bubbles) {
        const img = T.sp.bubble[kind];
        if (!img) continue;
        const sx = ox + (x - camx) * z, sy = oy + (y - camy) * z;
        const near = z >= 1.4;
        const bs = near ? clamp(Math.round(z * 1.5), 2, 4) : z < 0.7 ? 1 : 2;
        ctx.drawImage(img, Math.round(sx - img.width * bs / 2), Math.round(sy - 2 - img.height * bs), img.width * bs, img.height * bs);
      }
    }

    drawNapper(key, nap, bubbles) {
      const look = this.agentLook(key);
      const spot = (nap.p && nap.p.spot) || nap.spot;
      if (!spot) return;
      const { ctx } = this;
      const c = TA.townCharacter(look, 'down', 0, 'stand', true); // eyes closed
      const w = c.width * AS, h = c.height * AS;
      const x = spot.x, y = spot.y;
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.fillRect(x - 14, y + 8, 28, 3);
      // lying along the sofa, head to one side (the film's floor-nap, on the couch)
      ctx.save();
      ctx.translate(Math.round(x), Math.round(y));
      ctx.rotate((spot.side || 0) * Math.PI / 2);
      ctx.drawImage(c, -w / 2, -h / 2, w, h);
      ctx.restore();
      bubbles.push([x + (spot.side || 0) * 16, y - 12, 'sleep']);
    }

    // an agent standing still at a spot: checking in at the front desk (✓) or
    // at the water cooler (coffee). Naps are drawn by drawNapper instead.
    drawAgentAt(key, nap, pos, bubbles) {
      const look = this.agentLook(key);
      const { ctx } = this;
      const x = pos.x, y = pos.y;
      const c = TA.townCharacter(look, 'down', 0, 'stand', false);
      const w = c.width * AS, h = c.height * AS;
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.fillRect(Math.round(x) - 5, Math.round(y) - 1, 10, 3);
      ctx.drawImage(c, Math.round(x) - w / 2, Math.round(y) - h + 1, w, h);
      if (nap.phase === 'checking') bubbles.push([x, y - h - 4, 'done']);
      else if (nap.p && nap.p.activity === 'water') bubbles.push([x, y - h - 4, 'idle']);
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
      ctx.drawImage(c, Math.round(x) - w / 2, Math.round(y) - h + 1 + bob, w, h);
    }

    drawPod(info, name, state, t, key, frame, seated, bubbles) {
      const { ctx } = this;
      const { cell } = info;
      const X = (cell.x + 1) * TT, Y = cell.y * TT;
      const slot = TA.townDeskSlots(cell.seats)[0]; // solo seat, top (faces the viewer)
      const cx = X + slot.chairX + 7;
      const sp = this.town.sp;

      // seated agent — a pure function of the session name (film's drawPod:
      // person first, then the table over the lower body, then the device).
      // Absent (seated=false) while the agent is walking or napping on the sofa.
      if (seated && state !== 'off') {
        const typing = state === 'working' && !REDUCED ? Math.floor(t * 7 + hash(name)) % 2 : 0;
        const c = TA.townCharacter(TA.townLookFor(name), 'down', typing, 'sit', state === 'idle');
        const cw = c.width * AS, ch = c.height * AS;
        ctx.drawImage(c, cx - cw / 2, Y + 25 - ch, cw, ch);
        if (state === 'idle' && bubbles) bubbles.push([cx, Y - 3, 'sleep']); // Zzz in the chair (sofa full)
      }

      // table over the agent's lower body (also baked in the base canvas)
      const table = sp.tableSmall[this.deskColor(name)];
      if (table) ctx.drawImage(table, X + 14, Y + 17);

      // monitor on the desk — the session state is readable on it
      const screenFrame = state === 'working' ? frame % 7 : state === 'idle' ? frame % 2 : 0;
      ctx.drawImage(TA.townScreen(state, screenFrame), X + slot.chairX, Y + 13);

      // tiny live preview: the session's last lines, floating above the monitor
      const s = this.sessions.get(key);
      if (s && s.preview) this.drawPreview(X + slot.chairX, Y, s.preview, name);

      // glow: working (blue), active session (accent, steady)
      const isActive = key === this.activeKey;
      if (state === 'working' || isActive) {
        const rgb = isActive ? '122,162,247' : '111,195,255';
        const pulse = REDUCED ? 0.5 : state === 'working' ? 0.5 + 0.08 * Math.sin(t * 23 + hash(name) % 7) : 0.55;
        const g = ctx.createRadialGradient(cx, Y + 12, 0, cx, Y + 12, 20);
        g.addColorStop(0, 'rgba(' + rgb + ',' + (pulse * 0.55).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + rgb + ',0)');
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = g;
        ctx.fillRect(cx - 20, Y - 8, 40, 40);
        ctx.restore();
      }
      if (isActive) {
        ctx.strokeStyle = 'rgba(169,194,255,.55)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(X - 6.5, Y - 4.5, 61, 61);
      }
    }

    // tiny live preview: the session's last lines, floating above the monitor.
    // A small dark terminal with a few lines of the live pane text.
    drawPreview(mx, Y, preview, name) {
      const { ctx } = this;
      const W = 46, H = 30, pad = 2, fs = 5, lh = 5;
      // last non-empty lines
      const lines = preview.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0);
      const shown = lines.slice(-5);
      if (!shown.length) return;
      const maxChars = Math.floor((W - pad * 2) / (fs * 0.62));
      // position: above the monitor (mx is the monitor's left edge)
      const x = mx - 15, y = Y - 18 - H;
      // background + border
      ctx.save();
      ctx.fillStyle = 'rgba(10,12,20,0.92)';
      ctx.strokeStyle = 'rgba(120,140,180,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x + 0.5, y + 0.5, W, H);
      ctx.fill();
      ctx.stroke();
      // a little pointer down to the monitor
      ctx.fillStyle = 'rgba(10,12,20,0.92)';
      ctx.beginPath();
      ctx.moveTo(mx + 3, y + H);
      ctx.lineTo(mx + 9, y + H);
      ctx.lineTo(mx + 6, y + H + 3);
      ctx.closePath();
      ctx.fill();
      // text
      ctx.font = fs + 'px ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'top';
      shown.forEach((l, i) => {
        let txt = l.length > maxChars ? '…' + l.slice(-(maxChars - 1)) : l;
        // color: prompt lines ($ or >) brighter, dim otherwise
        const isPrompt = /^[$>\u276f#%]/.test(l.trim()) || /\$\s/.test(l);
        ctx.fillStyle = isPrompt ? '#9fe89f' : '#8a93a8';
        ctx.fillText(txt, x + pad, y + pad + i * lh);
      });
      ctx.restore();
    }

    drawPlus(b) {
      const { ctx } = this;
      const p = b.plus;
      if (!p) return;
      const hover = this.hover && this.hover.type === 'plus' && this.hover.host === b.hostKey;
      const off = this.hostOff(b.hostKey);
      const s = p.s, r = 4;
      ctx.save();
      ctx.globalAlpha = off ? 0.4 : 1;
      ctx.beginPath();
      ctx.moveTo(p.x + r, p.y);
      ctx.arcTo(p.x + s, p.y, p.x + s, p.y + s, r);
      ctx.arcTo(p.x + s, p.y + s, p.x, p.y + s, r);
      ctx.arcTo(p.x, p.y + s, p.x, p.y, r);
      ctx.arcTo(p.x, p.y, p.x + s, p.y, r);
      ctx.closePath();
      ctx.fillStyle = hover ? 'rgba(122,162,247,.95)' : 'rgba(20,26,40,.92)';
      ctx.fill();
      ctx.strokeStyle = hover ? '#cdd9ff' : 'rgba(122,162,247,.85)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const mx = p.x + s / 2, my = p.y + s / 2, a = s * 0.27;
      ctx.strokeStyle = hover ? '#0a0e18' : '#9db4e8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(mx - a, my); ctx.lineTo(mx + a, my);
      ctx.moveTo(mx, my - a); ctx.lineTo(mx, my + a);
      ctx.stroke();
      ctx.restore();
    }

    drawCenterBadge() {
      const { ctx } = this;
      const c = this.town.layout.center;
      if (!c) return;
      const hover = this.hover && this.hover.type === 'center';
      const cx = (c.x + c.w / 2) * TT, cy = c.y * TT + 12;
      const R = 8;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R + 3, 0, Math.PI * 2);
      ctx.fillStyle = hover ? 'rgba(122,162,247,.95)' : 'rgba(20,26,40,.88)';
      ctx.fill();
      ctx.strokeStyle = hover ? '#cdd9ff' : 'rgba(167,181,218,.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const gc = hover ? '#0a0e18' : '#c9d4f0';
      ctx.strokeStyle = gc;
      ctx.fillStyle = gc;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (R - 2), cy + Math.sin(a) * (R - 2));
        ctx.lineTo(cx + Math.cos(a) * (R + 1), cy + Math.sin(a) * (R + 1));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
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

    // a London bus stop: a dark pole and a white flag with the red roundel;
    // red while someone waits
    drawBusStop(stop) {
      const { ctx } = this;
      const x = stop.wait.x, y = stop.wait.y;
      const waiting = this.busWaiting();
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 12, y + 1, 5, 2);
      ctx.fillStyle = '#3b3b3b'; ctx.fillRect(x + 12, y - 43, 3, 44);
      this.rr(x + 1, y - 66, 26, 22, 2);
      ctx.fillStyle = waiting ? '#d4252b' : '#f6f2e6'; ctx.fill();
      ctx.strokeStyle = '#3b3b3b'; ctx.lineWidth = 1; ctx.stroke();
      const ring = waiting ? '#fff' : '#d4252b';
      ctx.beginPath(); ctx.arc(x + 14, y - 55, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = ring; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = ring; ctx.fillRect(x + 5, y - 56.5, 18, 3);
    }

    // a red London double-decker, side on, its riders in the windows
    drawBus(bus) {
      const { ctx } = this;
      ctx.save(); ctx.translate(Math.round(bus.x), Math.round(bus.y));
      const L = -31, T0 = -34, w = 62, h = 42;
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(L + 3, T0 + h + 2, w - 6, 4);
      ctx.fillStyle = '#222';
      [L + 12, L + 44].forEach((cx) => { ctx.beginPath(); ctx.arc(cx, T0 + h + 1, 5, 0, Math.PI * 2); ctx.fill(); });
      this.rr(L, T0, w, h, [7, 10, 2, 2]); ctx.fillStyle = '#d4252b'; ctx.fill();
      ctx.fillStyle = '#f6f2e6'; ctx.fillRect(L + 1, T0 + h * .44, w - 2, 3);
      const deck = (x0, y0, ww, list) => {
        ctx.fillStyle = '#bfe3f2'; ctx.fillRect(x0, y0, ww, 11);
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, ww, 11); ctx.clip();
        list.forEach((k, i) => ctx.drawImage(TA.townCharacter(TA.townLookFor(k), 'right', 0, 'stand', false), x0 + 1 + i * 12, y0 + 1));
        ctx.restore();
        ctx.fillStyle = '#d4252b';
        for (let px = x0 + 9; px < x0 + ww; px += 11) ctx.fillRect(px, y0, 2, 11);
      };
      deck(L + 4, T0 + 4, w - 16, bus.riders.slice(0, 4));
      deck(L + 4, T0 + 22, w - 19, bus.riders.slice(4));
      ctx.fillStyle = '#222'; ctx.fillRect(L + w - 10, T0 + 3, 8, 4);
      ctx.fillStyle = '#bfe3f2'; ctx.fillRect(L + w - 10, T0 + 9, 8, 4); ctx.fillRect(L + w - 10, T0 + 21, 8, 4);
      this.rr(L, T0, w, h, [7, 10, 2, 2]); ctx.strokeStyle = '#3b3b3b'; ctx.lineWidth = 2; ctx.stroke();
      if (bus.hazard) { this.rr(L - 3, T0 - 3, w + 6, h + 6, 9); ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.restore();
    }

    // true while any agent is waiting at the main bus stop
    busWaiting() {
      const isWait = (nap) => nap && nap.phase === 'waiting-bus';
      for (const nap of this.naps.values()) if (isWait(nap)) return true;
      return false;
    }

    drawSign(b) {
      const { ctx } = this;
      const off = this.hostOff(b.hostKey);
      const label = b.hostKey;
      ctx.font = '700 10px Silkscreen, monospace';
      const tw = ctx.measureText(label).width;
      const x = b.x * TT + (b.w * TT) / 2, y = b.y * TT - 22;
      ctx.fillStyle = off ? 'rgba(10,13,20,.72)' : 'rgba(16,21,33,.78)';
      ctx.fillRect(x - tw / 2 - 8, y - 11, tw + 16, 17);
      ctx.strokeStyle = off ? 'rgba(133,143,170,.35)' : 'rgba(167,181,218,.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - tw / 2 - 8, y - 11, tw + 16, 17);
      ctx.fillStyle = off ? '#5b6478' : '#f5f7ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y - 2);
      // state dot (not the only signal: the label text and the roof shade carry it too)
      ctx.fillStyle = off ? '#5b6478' : '#54d17a';
      ctx.fillRect(x - tw / 2 - 4, y - 5, 3, 3);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  window.TownView = TownView;
})();
