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
          sessions.set(h.name + ':' + s.name, { host: h, name: s.name, activity: !!s.activity, cwd: s.cwd || '' });
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
        g.drawImage(TA.paintTownFacade(b, theme), b.x * TT, (b.y + b.h) * TT);
        roofs.push({ host: b.hostKey, c: TA.paintTownRoof(b, theme, this.hostOff(b.hostKey)), x: b.x * TT - 4, y: b.y * TT - 12, b });
        b.rooms.forEach((r) => r.cells.forEach((cell) => { if (cell.deskKey) cells.set(cell.deskKey, { cell, b }); }));
      });
      this.town = { layout, base, M, sp, cells, roofs, Wp, Hp };
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

    /* ---------- input ---------- */

    screenToWorld(sx, sy) {
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      return [this.cam.x + (sx - w / 2) / this.cam.z, this.cam.y + (sy - h / 2) / this.cam.z];
    }

    podAt(wx, wy) {
      if (!this.town) return null;
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
      const b = this.buildingAt(wx, wy);
      if (b) this.zoomToBuilding(b);
      else this.fitCamera(false);
    }

    updateHover(e) {
      const rect = this.cv.getBoundingClientRect();
      const [wx, wy] = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const pod = this.podAt(wx, wy);
      const b = pod ? null : this.buildingAt(wx, wy);
      this.setHover(pod ? { type: 'pod', ...pod } : b ? { type: 'building', b } : null, e);
    }

    setHover(hover, e) {
      const changed = JSON.stringify(this.hoverKey()) !== JSON.stringify(hover ? (hover.type === 'pod' ? hover.key : hover.b.hostKey) : null);
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

    hoverKey() {
      return this.hover ? (this.hover.type === 'pod' ? this.hover.key : this.hover.b.hostKey) : null;
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

      const animate = !REDUCED && (this.town ? this.sessions.size : 0) > 0;
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

      // dynamic desk layer, depth-sorted
      const list = [];
      const frame = REDUCED ? 0 : Math.floor(t * 6);
      for (const [name, info] of T.cells) {
        const key = info.b.hostKey + ':' + name;
        const s = this.sessions.get(key);
        const state = s ? (s.activity ? 'working' : 'idle') : 'off';
        list.push([info.cell.y * TT + 52, () => this.drawPod(info, name, state, t, key, frame)]);
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

      // hover / active highlights
      if (this.hover && this.hover.type === 'pod') {
        const X = (this.hover.info.cell.x + 1) * TT, Y = this.hover.info.cell.y * TT;
        ctx.strokeStyle = 'rgba(122,162,247,.9)';
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(X - 7, Y - 5, 62, 62);
      }
      ctx.restore();
    }

    drawPod(info, name, state, t, key, frame) {
      const { ctx } = this;
      const { cell } = info;
      const X = (cell.x + 1) * TT, Y = cell.y * TT;
      const slot = TA.townDeskSlots(cell.seats)[0]; // solo seat, top (faces the viewer)
      const cx = X + slot.chairX + 7;
      const sp = this.town.sp;

      // seated agent — a pure function of the session name (film's drawPod:
      // person first, then the table over the lower body, then the device)
      if (state !== 'off') {
        const typing = state === 'working' && !REDUCED ? Math.floor(t * 7 + hash(name)) % 2 : 0;
        const c = TA.townCharacter(TA.townLookFor(name), 'down', typing, 'sit', state === 'idle');
        const cw = c.width * AS, ch = c.height * AS;
        ctx.drawImage(c, cx - cw / 2, Y + 25 - ch, cw, ch);
      }

      // table over the agent's lower body (also baked in the base canvas)
      const table = sp.tableSmall[this.deskColor(name)];
      if (table) ctx.drawImage(table, X + 14, Y + 17);

      // monitor on the desk — the session state is readable on it
      const screenFrame = state === 'working' ? frame % 7 : state === 'idle' ? frame % 2 : 0;
      ctx.drawImage(TA.townScreen(state, screenFrame), X + slot.chairX, Y + 13);

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
