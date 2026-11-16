/* space-art.js — Space Theme art: replaces Herdr Town graphics with sci-fi space station visuals */
(() => {
  const original = window.HerdrTownArt;
  if (!original) return;

  const TT = 16;

  // Custom Space Sprites
  function createSpaceSprites() {
    const sp = original.buildTownSprites();

    // Star Wars tactical command console: angled wings, dual readouts, indicator button bank
    const createConsole = (color) => {
      const c = document.createElement('canvas');
      c.width = 28; c.height = 18;
      const ctx = c.getContext('2d');

      // Heavy durasteel housing with angled chamfered wings
      ctx.fillStyle = '#141c2b';
      ctx.beginPath();
      ctx.moveTo(2, 6);
      ctx.lineTo(6, 2);
      ctx.lineTo(22, 2);
      ctx.lineTo(26, 6);
      ctx.lineTo(26, 17);
      ctx.lineTo(2, 17);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#2b3952';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Recessed central keyboard & data-pit
      ctx.fillStyle = '#0a0e17';
      ctx.fillRect(7, 4, 14, 11);

      // Angled tactical displays on left & right wings
      ctx.fillStyle = color || '#00e5ff';
      ctx.fillRect(3, 4, 3, 10);
      ctx.fillRect(22, 4, 3, 10);

      // Central holographic readout visor
      ctx.fillStyle = color || '#00e5ff';
      ctx.fillRect(8, 5, 12, 2);

      // Star Wars tactical indicator button bank (amber, red, green, cyan)
      ctx.fillStyle = '#ef4444'; ctx.fillRect(9, 8, 2, 2);
      ctx.fillStyle = '#f59e0b'; ctx.fillRect(12, 8, 2, 2);
      ctx.fillStyle = '#10b981'; ctx.fillRect(15, 8, 2, 2);
      ctx.fillStyle = '#06b6d4'; ctx.fillRect(18, 8, 2, 2);

      // Lower data input keys
      ctx.fillStyle = '#334155';
      ctx.fillRect(8, 11, 12, 3);

      return c;
    };

    sp.tableSmall = [
      createConsole('#00e5ff'),
      createConsole('#ffaa00'),
      createConsole('#bd93f9'),
      createConsole('#50fa7b'),
      createConsole('#ff5555'),
      createConsole('#ff79c6'),
    ];

    // High tech command chairs
    const createChair = () => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(2, 2, 12, 12);
      ctx.fillStyle = '#334155';
      ctx.fillRect(4, 4, 8, 8);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(5, 2, 6, 2);
      return c;
    };
    sp.chair = createChair();
    sp.chairBack = createChair();

    // Sci-fi plant / hydroponics
    const createHydro = () => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 24;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgba(0, 229, 255, 0.2)';
      ctx.fillRect(3, 4, 10, 16);
      ctx.strokeStyle = '#00e5ff';
      ctx.strokeRect(3, 4, 10, 16);
      ctx.fillStyle = '#50fa7b';
      ctx.fillRect(6, 8, 4, 10);
      return c;
    };
    sp.plant = createHydro();

    // Water cooler -> Nutrient Synthesizer
    const createSynth = () => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 24;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1e2638';
      ctx.fillRect(3, 6, 10, 18);
      ctx.fillStyle = '#ff79c6';
      ctx.fillRect(5, 8, 6, 6); // glowing tube
      return c;
    };
    sp.cooler = createSynth();

    // Star Wars Cantina / Millennium Falcon curved ribbed banquette booth
    const createStarWarsSofa = () => {
      const c = document.createElement('canvas');
      c.width = 50; c.height = 23;
      const ctx = c.getContext('2d');

      // Metallic backing hull / frame
      ctx.fillStyle = '#17202e';
      ctx.fillRect(2, 2, 46, 20);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(2, 2, 46, 20);

      // Ribbed leather padded backrest (slate/charcoal)
      ctx.fillStyle = '#2b3648';
      ctx.fillRect(4, 4, 42, 10);
      // Vertical cushion ribs (classic Star Wars / Dejarik booth style)
      ctx.fillStyle = '#1b2230';
      for (let x = 8; x < 46; x += 6) {
        ctx.fillRect(x, 4, 1, 10);
      }

      // Seat cushion (softer slate with piping)
      ctx.fillStyle = '#37455c';
      ctx.fillRect(4, 14, 42, 6);
      ctx.fillStyle = '#1e2636';
      ctx.fillRect(4, 19, 42, 1);

      // Under-seat ambient floor glow (warm amber / orange neon)
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(6, 21, 38, 1.5);

      // Rounded end armrests (metallic cylinders)
      ctx.fillStyle = '#475569';
      ctx.fillRect(1, 4, 3, 16);
      ctx.fillRect(46, 4, 3, 16);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(1, 4, 3, 1);
      ctx.fillRect(46, 4, 3, 1);

      return c;
    };
    sp.sofa = createStarWarsSofa();

    // Star Wars Dejarik holochess table with glowing holographic projector
    const createHolochessTable = () => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 26;
      const ctx = c.getContext('2d');

      // Base pedestal stand
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(6, 14, 4, 11);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(3, 24, 10, 2);

      // Circular metallic tabletop
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.ellipse(8, 14, 7, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#475569';
      ctx.stroke();

      // Checkered holographic game grid ring
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.ellipse(8, 14, 5, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Holographic projector light cone & miniature monster holograms
      ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
      ctx.beginPath();
      ctx.moveTo(8, 13);
      ctx.lineTo(2, 4);
      ctx.lineTo(14, 4);
      ctx.closePath();
      ctx.fill();

      // Tiny cyan / yellow holographic chess figures hovering
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(5, 5, 2, 3);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(9, 4, 2, 4);

      return c;
    };
    sp.coffee = createHolochessTable();

    // Holographic Ping Pong / Air Hockey Table
    const createPingPongTable = () => {
      const c = document.createElement('canvas');
      c.width = 54; c.height = 28;
      const ctx = c.getContext('2d');

      // Heavy metallic pedastal base & legs
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(8, 20, 6, 8);
      ctx.fillRect(40, 20, 6, 8);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(6, 26, 10, 2);
      ctx.fillRect(38, 26, 10, 2);

      // Metallic table frame
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(2, 6, 50, 15);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(2, 6, 50, 15);

      // Glowing holographic cyan playing surface
      ctx.fillStyle = 'rgba(6, 182, 212, 0.22)';
      ctx.fillRect(4, 8, 46, 11);

      // Outer boundary line
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(4, 8, 46, 11);

      // Center dividing net (vertical neon laser beam)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(26, 5, 2, 17);
      ctx.fillStyle = 'rgba(0, 229, 255, 0.6)';
      ctx.fillRect(25, 4, 4, 19);

      // Neon table center line
      ctx.fillStyle = 'rgba(0, 229, 255, 0.5)';
      ctx.fillRect(4, 13, 46, 1);

      // Cyan & Gold paddles on table
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(10, 11, 4, 4);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(40, 11, 4, 4);

      // Glowing bouncing holographic ping pong ball
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(20, 10, 2.5, 2.5);

      return c;
    };
    sp.pingpong = createPingPongTable();

    // sp.food removed — lounge width does not allow extra vending element; eating is routed to existing table

    // Custom Thought Bubbles for Idle Activities (Ping Pong, Eat, Drink, Holochess)
    const makeBubble = (drawContent) => {
      const c = document.createElement('canvas');
      c.width = 13; c.height = 14;
      const ctx = c.getContext('2d');
      // White bubble body
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(1, 1, 11, 9);
      ctx.fillRect(0, 2, 13, 7);
      // Pointer tail
      ctx.fillRect(2, 10, 3, 2);
      ctx.fillRect(1, 12, 2, 2);
      // Dark border
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 1.5, 12, 8);
      // Content inside (bounds: 2, 2, 9, 7)
      drawContent(ctx);
      return c;
    };

    sp.bubble.pingpong = makeBubble((ctx) => {
      // Cyan paddle + yellow ball
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(3, 3, 5, 4);
      ctx.fillStyle = '#64748b';
      ctx.fillRect(5, 7, 1.5, 2);
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(9, 4, 2, 2);
    });

    sp.bubble.eat = makeBubble((ctx) => {
      // Golden pizza slice / snack
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(3, 3); ctx.lineTo(10, 4); ctx.lineTo(6, 8); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(5, 4, 1.5, 1.5);
      ctx.fillRect(7, 5, 1.5, 1.5);
    });

    sp.bubble.drink = makeBubble((ctx) => {
      // Icy blue cup with straw
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(4, 4, 5, 5);
      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(3, 3, 7, 1.5);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(7, 1, 1.5, 3);
    });

    sp.bubble.chess = makeBubble((ctx) => {
      // Mini holochess alien monster
      ctx.fillStyle = '#bd93f9';
      ctx.fillRect(4, 3, 5, 4);
      ctx.fillRect(3, 5, 7, 2);
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(5, 4, 1, 1);
      ctx.fillRect(7, 4, 1, 1);
    });

    // Millennium Falcon (Star Wars YT-1300 light freighter)
    const createFalcon = () => {
      const c = document.createElement('canvas');
      c.width = 44; c.height = 34;
      const ctx = c.getContext('2d');

      // Main circular saucer hull
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.arc(19, 17, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Armor plating panels
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(12, 8, 4, 3);
      ctx.fillRect(12, 23, 4, 3);
      ctx.fillStyle = '#ef4444'; // Red hull accent markings
      ctx.fillRect(16, 9, 3, 2);
      ctx.fillRect(16, 23, 3, 2);

      // Forward cargo mandibles / prongs
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(24, 10, 15, 4); // Port mandible
      ctx.fillRect(24, 20, 15, 4); // Starboard mandible
      ctx.strokeStyle = '#64748b';
      ctx.strokeRect(24, 10, 15, 4);
      ctx.strokeRect(24, 20, 15, 4);

      // Central freight notch
      ctx.fillStyle = '#475569';
      ctx.fillRect(24, 14, 5, 6);

      // Starboard offset cockpit & access tube
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(17, 24, 10, 3); // tube
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.arc(28, 27, 4.5, 0, Math.PI * 2); // cockpit pod
      ctx.fill();
      ctx.strokeStyle = '#475569';
      ctx.stroke();
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(27, 25, 4, 3); // cockpit viewport glass

      // Round sensor / radar dish
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(14, 10, 3.5, 0, Math.PI * 2);
      ctx.stroke();

      // Quad laser cannon turret on top
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.arc(19, 17, 3, 0, Math.PI * 2);
      ctx.fill();

      // Rear curved blue sublight engine exhaust drive band
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(4, 10, 2.5, 14);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(5, 12, 1.5, 10);

      return c;
    };
    sp.falcon = createFalcon();

    // X-Wing Starfighter (Star Wars T-65B X-wing)
    const createXWing = () => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 32;
      const ctx = c.getContext('2d');

      // 4 S-Foils (wings locked in attack position)
      ctx.fillStyle = '#e2e8f0';
      // Upper wings
      ctx.beginPath();
      ctx.moveTo(14, 13);
      ctx.lineTo(6, 4);
      ctx.lineTo(26, 4);
      ctx.lineTo(22, 13);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#94a3b8';
      ctx.stroke();

      // Lower wings
      ctx.beginPath();
      ctx.moveTo(14, 19);
      ctx.lineTo(6, 28);
      ctx.lineTo(26, 28);
      ctx.lineTo(22, 19);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Red Squadron striping (Red 5!)
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(10, 4, 3, 2); ctx.fillRect(15, 4, 3, 2); ctx.fillRect(20, 4, 3, 2);
      ctx.fillRect(10, 26, 3, 2); ctx.fillRect(15, 26, 3, 2); ctx.fillRect(20, 26, 3, 2);

      // 4 Wingtip Laser Cannon Barrels
      ctx.fillStyle = '#475569';
      ctx.fillRect(6, 3, 28, 1.5);  // Top port
      ctx.fillRect(6, 27.5, 28, 1.5); // Bottom port
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(33, 3, 2, 1.5); // Tip laser charge
      ctx.fillRect(33, 27.5, 2, 1.5);

      // Long pointed fuselage / nose cone
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(8, 13);
      ctx.lineTo(36, 15);
      ctx.lineTo(38, 16);
      ctx.lineTo(36, 17);
      ctx.lineTo(8, 19);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#94a3b8';
      ctx.stroke();

      // Red nose flashes
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(28, 15, 4, 2);

      // Pilot canopy (dark cyan glass)
      ctx.fillStyle = '#0284c7';
      ctx.fillRect(20, 15, 5, 2);

      // Astromech droid (R2-D2!) socket
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(16, 15, 2.5, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(17, 15, 1, 1);

      // 4 Sublight Ion Engines with glowing pink/red exhaust
      ctx.fillStyle = '#334155';
      ctx.fillRect(7, 10, 6, 3);
      ctx.fillRect(7, 19, 6, 3);
      ctx.fillStyle = '#f43f5e';
      ctx.fillRect(5, 10.5, 2.5, 2);
      ctx.fillRect(5, 19.5, 2.5, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(6, 11, 1.5, 1);
      ctx.fillRect(6, 20, 1.5, 1);

      return c;
    };
    sp.xwing = createXWing();

    // Star Trek Federation Starship (USS Enterprise)
    const createEnterprise = () => {
      const c = document.createElement('canvas');
      c.width = 48; c.height = 30;
      const ctx = c.getContext('2d');

      // Primary Hull: Saucer Section (Front)
      ctx.fillStyle = '#f1f5f9';
      ctx.beginPath();
      ctx.ellipse(35, 15, 10, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Bridge module dome
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.arc(35, 15, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(34, 14, 2, 2);

      // Connecting Dorsal Neck
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(22, 14, 8, 2);

      // Secondary Engineering Hull
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(11, 12, 14, 6);
      ctx.strokeStyle = '#94a3b8';
      ctx.strokeRect(11, 12, 14, 6);

      // Glowing Navigational Deflector Dish (amber / cyan copper glow)
      const defGrad = ctx.createRadialGradient(24, 15, 1, 24, 15, 4);
      defGrad.addColorStop(0, '#ffffff');
      defGrad.addColorStop(0.5, '#f59e0b');
      defGrad.addColorStop(1, '#00e5ff');
      ctx.fillStyle = defGrad;
      ctx.beginPath();
      ctx.arc(24, 15, 3.5, 0, Math.PI * 2);
      ctx.fill();

      // Angled Warp Pylons
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(16, 12); ctx.lineTo(12, 6);
      ctx.moveTo(16, 18); ctx.lineTo(12, 24);
      ctx.stroke();

      // Dual Warp Nacelles
      const drawNacelle = (ny) => {
        // Nacelle body
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(5, ny, 21, 4);
        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1;
        ctx.strokeRect(5, ny, 21, 4);

        // Glowing Blue Warp Coil Strip
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(8, ny + 1, 14, 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(11, ny + 1.5, 8, 1);

        // Glowing Red Bussard Ramscoop at nacelle front
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(25, ny + 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fef08a';
        ctx.fillRect(24.5, ny + 1.5, 1, 1);
      };

      drawNacelle(4);
      drawNacelle(22);

      return c;
    };
    sp.enterprise = createEnterprise();

    return sp;
  }

  // Intercept HerdrTownArt
  window.HerdrTownArt = Object.assign({}, original, {
    buildTownSprites: createSpaceSprites,

    // Deep space background with twinkling stars and energy roads
    // Space Background (pure transparent, allowing full-viewport animated cosmic sky & galaxies to shine through without any rectangular boundaries)
    paintTownGround: () => document.createElement('canvas'),

    // Millennium Falcon-style hull silhouette: saucer deck, long forward
    // mandibles, a prominent starboard cockpit pod and a port radar dish.
    drawSpaceshipHullPath: (ctx, w, h) => {
      const cx = w / 2;
      const bowY = 10;                        // saucer deck top rim
      const mandW = Math.max(16, w * 0.085);  // bow prong width
      const gap = Math.max(15, w * 0.12);     // half the loading-jaw width
      ctx.beginPath();

      // Bow: long forward mandibles with a wide loading-jaw notch between them
      ctx.moveTo(cx - gap - mandW, bowY);
      ctx.lineTo(cx - gap - mandW, 2);
      ctx.lineTo(cx - gap, 2);
      ctx.lineTo(cx - gap, bowY);
      ctx.lineTo(cx + gap, bowY);
      ctx.lineTo(cx + gap, 2);
      ctx.lineTo(cx + gap + mandW, 2);
      ctx.lineTo(cx + gap + mandW, bowY);

      // Starboard flank with a prominent cylindrical cockpit-pod bump
      ctx.lineTo(w - 26, bowY);
      ctx.lineTo(w - 16, h * 0.30);
      ctx.lineTo(w - 5, h * 0.38);
      ctx.lineTo(w - 5, h * 0.64);
      ctx.lineTo(w - 16, h * 0.70);
      ctx.lineTo(w - 18, h - 24);

      // Stern engine nacelles (port & starboard) with a centre dock cutout
      ctx.lineTo(w - 18, h - 5);
      ctx.lineTo(cx + 34, h - 5);
      ctx.lineTo(cx + 24, h - 19);
      ctx.lineTo(cx - 24, h - 19);
      ctx.lineTo(cx - 34, h - 5);
      ctx.lineTo(18, h - 5);
      ctx.lineTo(18, h - 24);

      // Port flank with a prominent radar-dish bump
      ctx.lineTo(16, h * 0.70);
      ctx.lineTo(5, h * 0.64);
      ctx.lineTo(5, h * 0.38);
      ctx.lineTo(16, h * 0.30);
      ctx.lineTo(26, bowY);
      ctx.closePath();
    },

    // Space Station Interior (metallic deck & glowing floor lines, shaped as a Starship)
    paintTownInterior: function(b, theme, sprites) {
      const X = b.w * TT, Y = b.h * TT;
      const canvas = document.createElement('canvas');
      canvas.width = X; canvas.height = Y;
      const ctx = canvas.getContext('2d');

      ctx.save();
      this.drawSpaceshipHullPath(ctx, X, Y);
      ctx.clip(); // Clip interior deck to the spaceship hull shape!

      // Illuminated metallic deck base (titanium/alloy gray - distinct from the black space void)
      ctx.fillStyle = '#222938';
      ctx.fillRect(0, 0, X, Y);

      // Deck plating tiles (alternating subtle tone for realistic station flooring)
      for (let x = 0; x < X; x += 16) {
        for (let y = 0; y < Y; y += 16) {
          if ((Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 1) {
            ctx.fillStyle = '#262e3e';
            ctx.fillRect(x, y, 16, 16);
          }
        }
      }

      // Panel seam grid lines
      ctx.strokeStyle = '#1a202d';
      ctx.lineWidth = 1;
      for (let x = 0; x < X; x += 16) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, Y); ctx.stroke();
      }
      for (let y = 0; y < Y; y += 16) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(X, y); ctx.stroke();
      }

      // Bow docking bay between the forward mandibles
      const cx = X / 2;
      ctx.fillStyle = '#0b0f18';
      ctx.fillRect(cx - 18, 14, 36, 12);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(cx - 14, 18, 28, 2);

      // Top bulkhead neon strip
      ctx.fillStyle = '#2d374a';
      ctx.fillRect(0, 52, X, 8);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(0, 59, X, 1.5);

      // Control Room carpets / zones
      for (const r of b.rooms) {
        const rx = (r.x - b.x) * TT + 2;
        const ry = (r.y - b.y) * TT + 2;
        const rw = r.w * TT - 4;
        const rh = r.h * TT - 4;

        // Command deck floor (deep navy blue tech bay)
        ctx.fillStyle = '#161e2c';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(rx, ry, rw, rh);

        // Desks & consoles
        for (const cell of r.cells) {
          if (!cell.deskKey) continue;
          const dx = (cell.x + 1 - b.x) * TT;
          const dy = (cell.y - b.y) * TT;

          // Holographic terminal console
          ctx.fillStyle = '#0d131d';
          ctx.fillRect(dx + 10, dy + 16, 28, 18);
          ctx.fillStyle = '#00e5ff';
          ctx.fillRect(dx + 12, dy + 18, 24, 2);

          // Command chair
          ctx.fillStyle = '#334155';
          ctx.fillRect(dx + 16, dy + 2, 16, 12);
        }
      }

      // Star Wars Cantina / Crew Lounge bay demarcation
      const L = b.lounge;
      if (L && L.w > 0 && L.h > 0) {
        const lx = (L.x - b.x) * TT + 2;
        const ly = (L.y - b.y) * TT + 2;
        const lw = L.w * TT - 4;
        const lh = L.h * TT - 4;

        // Dark obsidian cantina bay deck
        ctx.fillStyle = '#141824';
        ctx.fillRect(lx, ly, lw, lh);

        // Amber neon perimeter guide border
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)';
        ctx.lineWidth = 1;
        ctx.strokeRect(lx, ly, lw, lh);

        // Cantina hazard grating lines
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.12)';
        for (let d = 0; d < lw + lh; d += 16) {
          ctx.beginPath();
          ctx.moveTo(Math.max(lx, lx + d - lh), Math.min(ly + lh, ly + d));
          ctx.lineTo(Math.min(lx + lw, lx + d), Math.max(ly, ly + d - lw));
          ctx.stroke();
        }

        // Amber corner brackets
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(lx, ly, 6, 2);
        ctx.fillRect(lx, ly, 2, 6);
        ctx.fillRect(lx + lw - 6, ly, 6, 2);
        ctx.fillRect(lx + lw - 2, ly, 2, 6);
        ctx.fillRect(lx, ly + lh - 2, 6, 2);
        ctx.fillRect(lx, ly + lh - 6, 2, 6);
        ctx.fillRect(lx + lw - 6, ly + lh - 2, 6, 2);
        ctx.fillRect(lx + lw - 2, ly + lh - 6, 2, 6);
      }

      // Stern engine vent strip (Falcon's distinctive rear glow band)
      const engY = Y - 12;
      ctx.fillStyle = '#0a121e';
      ctx.fillRect(16, engY - 2, X - 32, 12);
      ctx.fillStyle = '#00e5ff';
      for (let x = 20; x < X - 40; x += 22) ctx.fillRect(x, engY, 16, 8);
      ctx.fillStyle = '#ffffff';
      for (let x = 24; x < X - 40; x += 22) ctx.fillRect(x, engY + 2, 8, 4);

      ctx.restore(); // end clip

      // Armored Durasteel Starship Outer Hull Plating & Shield Border
      ctx.save();
      this.drawSpaceshipHullPath(ctx, X, Y);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // ---- Millennium Falcon surface details ----
      // Radar dish (port flank): mast + round dish with concentric rings
      ctx.fillStyle = '#64748b';
      ctx.fillRect(10, Y * 0.44, 3, Y * 0.07);
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.arc(12, Y * 0.38, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
      ctx.beginPath();
      ctx.arc(12, Y * 0.38, 5, 0, Math.PI * 2);
      ctx.stroke();

      // Cockpit pod (starboard flank): cylindrical body + panoramic canopy
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(X - 20, Y * 0.38, 14, Y * 0.26);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(X - 16, Y * 0.44, 7, Y * 0.12);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(X - 14, Y * 0.46, 3, Y * 0.06);

      // Dorsal quad-laser turret (upper deck)
      const dx = X * 0.20, dy = Y * 0.30;
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.arc(dx, dy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(dx - 1, dy - 9, 2, 5);
      ctx.fillRect(dx - 7, dy - 4, 3, 2);
      ctx.fillRect(dx + 4, dy - 4, 3, 2);

      // Concentric saucer ring lines (faint plate seams)
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(X / 2, Y * 0.52, X * 0.46, Y * 0.36, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(X / 2, Y * 0.52, X * 0.32, Y * 0.24, 0, 0, Math.PI * 2);
      ctx.stroke();

      // Patchwork hull greebles (subtle panel shading)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(X * 0.10, Y * 0.34, X * 0.12, 3);
      ctx.fillRect(X * 0.62, Y * 0.62, X * 0.14, 3);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
      ctx.fillRect(X * 0.24, Y * 0.64, X * 0.12, 3);
      ctx.fillRect(X * 0.55, Y * 0.30, X * 0.10, 3);

      return canvas;
    },

    // Space Station Exterior Facade (integrated into spaceship hull)
    paintTownFacade: (b, theme) => document.createElement('canvas'),

    // Space Station Roof / Energy Shield Dome
    paintTownRoof: function(b, theme, isOff) {
      const X = b.w * TT, Y = b.h * TT;
      const canvas = document.createElement('canvas');
      canvas.width = X; canvas.height = Y;
      const ctx = canvas.getContext('2d');

      ctx.save();
      this.drawSpaceshipHullPath(ctx, X, Y);
      ctx.fillStyle = isOff ? 'rgba(20, 25, 35, 0.45)' : 'rgba(0, 180, 255, 0.16)';
      ctx.fill();
      ctx.clip();

      ctx.strokeStyle = isOff ? 'rgba(60, 75, 100, 0.25)' : 'rgba(0, 229, 255, 0.4)';
      ctx.lineWidth = 1;
      for (let x = 0; x < X; x += 16) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, Y); ctx.stroke();
      }
      for (let y = 0; y < Y; y += 16) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(X, y); ctx.stroke();
      }
      ctx.restore();

      ctx.save();
      this.drawSpaceshipHullPath(ctx, X, Y);
      ctx.strokeStyle = isOff ? '#3a4454' : '#00e5ff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      return canvas;
    },

    // Star Wars Planetary Command Citadel Complex (Multi-building starfleet complex with skybridges)
    paintTownCenter: (width) => {
      const w = Math.max(380, width * TT), h = 230;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const cx = w / 2;

      // 1. Full-Width Heavy Fortified Bastion Platform
      ctx.fillStyle = '#111724';
      ctx.fillRect(cx - 165, 175, 330, 45);
      ctx.strokeStyle = '#222f47';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - 165, 175, 330, 45);

      // Approach runway guide lighting (cyan & amber)
      for (let x = cx - 155; x <= cx + 155; x += 15) {
        ctx.fillStyle = '#00e5ff'; ctx.fillRect(x, 214, 3, 2);
      }
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(cx - 162, 177, 324, 2); // hazard perimeter line

      // 2. West Wing: Deep-Space Communications & Radar Telemetry Station
      ctx.fillStyle = '#162030';
      ctx.fillRect(cx - 155, 125, 75, 50);
      ctx.strokeStyle = '#2c3a54';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - 155, 125, 75, 50);

      // West wing telemetry viewports
      ctx.fillStyle = '#38bdf8';
      for (let x = cx - 145; x <= cx - 95; x += 16) {
        ctx.fillRect(x, 138, 10, 4);
        ctx.fillRect(x, 154, 10, 4);
      }

      // West wing roof radar telemetry array
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 130, 125); ctx.lineTo(cx - 130, 100);
      ctx.moveTo(cx - 105, 125); ctx.lineTo(cx - 105, 105);
      ctx.stroke();
      ctx.strokeStyle = '#00e5ff';
      ctx.beginPath();
      ctx.arc(cx - 130, 98, 10, Math.PI * 0.7, Math.PI * 1.3);
      ctx.arc(cx - 105, 103, 8, Math.PI * 0.7, Math.PI * 1.3);
      ctx.stroke();

      // Pressurized Skybridge linking West Wing to Central Citadel
      ctx.fillStyle = '#1c2638';
      ctx.fillRect(cx - 80, 142, 28, 16);
      ctx.strokeStyle = '#384869';
      ctx.strokeRect(cx - 80, 142, 28, 16);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(cx - 78, 149, 24, 2); // skybridge observation slit

      // 3. East Wing: Planetary Shield Generator & Power Reactor Facility
      ctx.fillStyle = '#162030';
      ctx.fillRect(cx + 80, 125, 75, 50);
      ctx.strokeStyle = '#2c3a54';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + 80, 125, 75, 50);

      // East wing viewports & power hazard stripes
      ctx.fillStyle = '#38bdf8';
      for (let x = cx + 90; x <= cx + 140; x += 16) {
        ctx.fillRect(x, 154, 10, 4);
      }
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(cx + 82, 138, 71, 2); // warning stripe

      // East wing roof reactor core coil dome
      const reacGrad = ctx.createRadialGradient(cx + 118, 112, 1, cx + 118, 112, 14);
      reacGrad.addColorStop(0, '#ffffff');
      reacGrad.addColorStop(0.4, '#bd93f9');
      reacGrad.addColorStop(0.8, 'rgba(0, 229, 255, 0.4)');
      reacGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = reacGrad;
      ctx.beginPath();
      ctx.arc(cx + 118, 112, 14, 0, Math.PI * 2);
      ctx.fill();

      // Reactor containment coils
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx + 118, 112, 16, Math.PI, 0);
      ctx.stroke();

      // Pressurized Skybridge linking East Wing to Central Citadel
      ctx.fillStyle = '#1c2638';
      ctx.fillRect(cx + 52, 142, 28, 16);
      ctx.strokeStyle = '#384869';
      ctx.strokeRect(cx + 52, 142, 28, 16);
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(cx + 54, 149, 24, 2); // skybridge observation slit

      // 4. Central Grand Citadel Command Tower
      // Tier 1 Base Bunker
      ctx.fillStyle = '#182133';
      ctx.beginPath();
      ctx.moveTo(cx - 55, 175);
      ctx.lineTo(cx - 45, 120);
      ctx.lineTo(cx + 45, 120);
      ctx.lineTo(cx + 55, 175);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#2c3a54';
      ctx.stroke();

      // Tier 1 viewports
      ctx.fillStyle = '#38bdf8';
      for (let x = cx - 35; x <= cx + 35; x += 18) {
        ctx.fillRect(x, 134, 12, 4);
      }

      // Tier 2 Command Bridge Spire
      ctx.fillStyle = '#1e293f';
      ctx.beginPath();
      ctx.moveTo(cx - 38, 120);
      ctx.lineTo(cx - 28, 65);
      ctx.lineTo(cx + 28, 65);
      ctx.lineTo(cx + 38, 120);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#384869';
      ctx.stroke();

      // Panoramic glowing observation deck strip (cyan glass)
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(cx - 24, 72, 48, 7);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillRect(cx - 18, 73, 36, 2);

      // Central glowing planetary holosphere / defense reactor core
      const coreGrad = ctx.createRadialGradient(cx, 100, 2, cx, 100, 22);
      coreGrad.addColorStop(0, '#ffffff');
      coreGrad.addColorStop(0.3, '#38bdf8');
      coreGrad.addColorStop(0.8, 'rgba(0, 229, 255, 0.25)');
      coreGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, 100, 22, 0, Math.PI * 2);
      ctx.fill();

      // Planetary orbital ring around core
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, 100, 28, 8, -Math.PI / 8, 0, Math.PI * 2);
      ctx.stroke();

      // Orbital communications mast / sensor antenna
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, 65);
      ctx.lineTo(cx, 16);
      ctx.stroke();

      // High-gain satellite array dish
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, 14, 14, Math.PI * 0.7, Math.PI * 1.3);
      ctx.stroke();

      // Blinking red warning beacon at pinnacle
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(cx - 2, 4, 4, 4);

      return canvas;
    },

    // Detailed Sci-Fi Astronauts in Pressurized EVA Suits with Reflective Visors.
    // Cached: town.js calls this per agent per frame (drawPod/drawWalker/drawNapper/…).
    // The original art bundle (town-art.js c8/r9) keys its sprite cache
    // look|dir|frame|pose|eyes — this override must too; re-rendering a canvas on
    // every call was the largest per-frame CPU cost in the Space view.
    townCharacter: (() => {
      const cache = new Map();
      const render = (look, dir, frame, pose, eyesClosed) => {
      const canvas = document.createElement('canvas');
      canvas.width = 20; canvas.height = 24;
      const ctx = canvas.getContext('2d');

      const isSit = pose === 'sit';
      const legFrame = frame % 4;

      if (look && (look.isGuard || look.isImperial || look.empire)) {
        // Star Wars Imperial Station Security Guard ("Un Gardien")
        // 1. Imperial Charcoal / Black Under-tunic
        ctx.fillStyle = '#090d16';
        ctx.fillRect(5, 7, 10, 11);

        // 2. Reinforced Dark Slate Security Armor Breastplate
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(6, 8, 8, 8);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(6, 14, 8, 2);

        // Security Guard Sentinel Crest / Badge on chest (gold shield with cyan core)
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(7, 9.5, 3, 3);
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(8, 10.5, 1, 1);

        // Security Code / Rank Cylinders (crimson and silver)
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(11.5, 9.5, 1.5, 2);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(11.5, 12, 1.5, 1.5);

        // Imperial Commander Shoulder Pauldron (Orange pauldron on right shoulder)
        ctx.fillStyle = '#ea580c';
        ctx.fillRect(3, 8, 4, 4);
        ctx.fillStyle = '#f97316';
        ctx.fillRect(3.5, 8.5, 3, 3);

        // Left armored dark shoulder bell
        ctx.fillStyle = '#334155';
        ctx.fillRect(13, 8, 4, 4);

        // Armored Utility Belt
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(5, 16, 10, 2);
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(9, 16, 2, 2);

        // 3. Station Security Guard Helmet (Imperial Navy / Death Star Trooper Guard Blast Helmet)
        // Deep obsidian flared helmet dome
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(10, 5, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Wide Flared Protective Blast Rim across brow and ears
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(3.5, 4, 13, 2);

        // Sentry Tactical Visor: Glowing narrow slit HUD optic (colour cycles per poll)
        ctx.fillStyle = (look && look.visor) || '#00e5ff';
        ctx.fillRect(6.5, 5.5, 7, 1.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(8.5, 5.5, 3, 1);

        // Cheek protective armor plates
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(5, 7, 2, 2.5);
        ctx.fillRect(13, 7, 2, 2.5);

        // Ear Comms / Acoustic Sensor
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(4, 6.5, 1, 2);
        ctx.fillRect(15, 6.5, 1, 2);

        // Tactical Chin Vocoder & Breath Filtration Pod
        ctx.fillStyle = '#334155';
        ctx.fillRect(8, 7.5, 4, 2);
        ctx.fillStyle = '#475569';
        ctx.fillRect(7, 8.5, 1.5, 1.5);
        ctx.fillRect(11.5, 8.5, 1.5, 1.5);

        // Ribbed Black Neck Seal Gasket
        ctx.fillStyle = '#020617';
        ctx.fillRect(7, 9.5, 6, 1.5);

        // 4. Dark Armored Arms & Black Security Gloves (right arm raises to wave)
        const wave = (frame % 2) === 1;
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(3, 11, 3, 4);          // left arm (always at side)
        ctx.fillRect(14, 11, 3, 4);         // right arm
        ctx.fillStyle = '#020617';
        ctx.fillRect(3, 14, 3, 2);          // left glove
        if (wave) {
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(15, 5, 2, 6);        // raised forearm
          ctx.fillStyle = '#020617';
          ctx.fillRect(15, 3.5, 2, 2);      // raised glove (hand up)
        } else {
          ctx.fillRect(14, 14, 3, 2);       // right glove (at side)
        }

        // 5. Dark Armored Legs & Blast Boots
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(5, 18, 10, 3);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(4, 21, 5, 3);
        ctx.fillRect(11, 21, 5, 3);
        ctx.fillStyle = '#020617'; // black boot soles
        ctx.fillRect(4, 23, 5, 1);
        ctx.fillRect(11, 23, 5, 1);

        return canvas;
      }

      // Suit color theme: light blue combination for EVA repair crew, crisp white for standard crew
      const isRepair = !!(look && look.isRepair);
      const suitColor = isRepair ? '#38bdf8' : '#f8fafc';
      const suitShade = isRepair ? '#0284c7' : '#e2e8f0';
      const helmetColor = isRepair ? '#7dd3fc' : '#f1f5f9';
      const helmetTrim = isRepair ? '#0284c7' : '#cbd5e1';
      const limbColor = isRepair ? '#38bdf8' : '#f8fafc';
      const kneeColor = isRepair ? '#0284c7' : '#94a3b8';

      // 1. Life Support Backpack (PLSS)
      if (dir === 'down' || dir === 'up') {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(5, 7, 10, 10);
        ctx.fillStyle = '#334155';
        ctx.fillRect(6, 8, 8, 8);
        // Thruster nozzles
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(6, 17, 2, 2);
        ctx.fillRect(12, 17, 2, 2);
      } else if (dir === 'left') {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(14, 7, 4, 10);
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(15, 17, 2, 2);
      } else if (dir === 'right') {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(2, 7, 4, 10);
        ctx.fillStyle = '#00e5ff';
        ctx.fillRect(3, 17, 2, 2);
      }

      // 2. Pressurized Suit Torso
      ctx.fillStyle = suitColor;
      ctx.fillRect(5, 8, 10, 9);
      ctx.fillStyle = suitShade; // Torso shading
      ctx.fillRect(5, 15, 10, 2);

      // Chest Control Module (Telemetry & Oxygen telemetry)
      if (dir === 'down') {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(7, 10, 6, 5);
        // Telemetry LED indicator dots (green, amber, cyan)
        ctx.fillStyle = '#10b981'; ctx.fillRect(8, 11, 1.5, 1.5);
        ctx.fillStyle = '#f59e0b'; ctx.fillRect(10.5, 11, 1.5, 1.5);
        ctx.fillStyle = '#00e5ff'; ctx.fillRect(8, 13, 4, 1);
      } else if (dir === 'left') {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(5, 10, 3, 5);
        ctx.fillStyle = '#00e5ff'; ctx.fillRect(5, 12, 2, 1);
      } else if (dir === 'right') {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(12, 10, 3, 5);
        ctx.fillStyle = '#00e5ff'; ctx.fillRect(13, 12, 2, 1);
      }

      // Mission Insignia Stripe on shoulder
      ctx.fillStyle = isRepair ? '#0284c7' : (look && look.tone % 2 === 1) ? '#2563eb' : '#ef4444';
      if (dir === 'down' || dir === 'up') {
        ctx.fillRect(4, 9, 2, 3);
        ctx.fillRect(14, 9, 2, 3);
      } else if (dir === 'left') {
        ctx.fillRect(8, 9, 3, 2);
      } else if (dir === 'right') {
        ctx.fillRect(9, 9, 3, 2);
      }

      // 3. Spherical Pressurized EVA Helmet
      ctx.fillStyle = helmetColor;
      ctx.beginPath();
      ctx.arc(10, 5, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = helmetTrim;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Neck ring clamp
      ctx.fillStyle = isRepair ? '#0284c7' : '#64748b';
      ctx.fillRect(7, 7, 6, 1.5);

      // Helmet communications antenna / beacon light
      ctx.fillStyle = '#00e5ff';
      ctx.fillRect(13, 1, 1.5, 3);

      // 4. Reflective Gold / Amber Visor
      if (dir === 'down') {
        // Front curved golden visor
        ctx.fillStyle = '#d97706'; // darker border
        ctx.fillRect(6, 3, 8, 4.5);
        ctx.fillStyle = '#f59e0b'; // golden amber
        ctx.fillRect(7, 3.5, 6, 3.5);
        // Specular reflection highlight glint
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(7, 3.5, 3, 1.5);
      } else if (dir === 'left') {
        ctx.fillStyle = '#d97706';
        ctx.fillRect(5, 3, 6, 4.5);
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(5, 3.5, 5, 3.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(5, 3.5, 2, 1.5);
      } else if (dir === 'right') {
        ctx.fillStyle = '#d97706';
        ctx.fillRect(9, 3, 6, 4.5);
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(10, 3.5, 5, 3.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(12, 3.5, 2, 1.5);
      } else if (dir === 'up') {
        // Back of helmet
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(7, 3, 6, 4);
      }

      // 5. Utility Belt
      ctx.fillStyle = '#334155';
      ctx.fillRect(5, 16, 10, 2);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(9, 16, 2, 2); // metallic buckle

      // 6. Pressurized Legs & Magnetic EVA Boots
      if (isSit) {
        // Seated posture: legs bent forward
        ctx.fillStyle = suitShade;
        ctx.fillRect(5, 18, 10, 3);
        ctx.fillStyle = '#1e293b'; // boots
        ctx.fillRect(4, 21, 5, 3);
        ctx.fillRect(11, 21, 5, 3);
        ctx.fillStyle = '#00e5ff'; // boot mag-lock soles
        ctx.fillRect(4, 23, 5, 1);
        ctx.fillRect(11, 23, 5, 1);
      } else {
        // Standing / walking posture
        const legShift = (legFrame === 1) ? 1 : (legFrame === 3) ? -1 : 0;
        ctx.fillStyle = limbColor;
        ctx.fillRect(5, 18, 4, 3 + legShift);
        ctx.fillRect(11, 18, 4, 3 - legShift);

        // Knee articulators
        ctx.fillStyle = kneeColor;
        ctx.fillRect(5, 19 + legShift, 4, 1);
        ctx.fillRect(11, 19 - legShift, 4, 1);

        // Magnetic EVA utility boots
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(4, 21 + legShift, 5, 3);
        ctx.fillRect(11, 21 - legShift, 5, 3);
        ctx.fillStyle = '#00e5ff'; // mag-lock sole glow
        ctx.fillRect(4, 23 + legShift, 5, 1);
        ctx.fillRect(11, 23 - legShift, 5, 1);
      }

      // 7. Arms & Heavy EVA Gloves
      ctx.fillStyle = limbColor;
      if (isSit) {
        // Typing arms reaching forward
        ctx.fillRect(3, 10, 3, 5);
        ctx.fillRect(14, 10, 3, 5);
        ctx.fillStyle = '#475569'; // gloves
        ctx.fillRect(3, 15, 3, 2);
        ctx.fillRect(14, 15, 3, 2);
      } else {
        ctx.fillRect(3, 10, 2.5, 6);
        ctx.fillRect(14.5, 10, 2.5, 6);
        ctx.fillStyle = '#475569'; // gloves
        ctx.fillRect(3, 16, 2.5, 2);
        ctx.fillRect(14.5, 16, 2.5, 2);
      }

      return canvas;
      };
      return (look, dir, frame, pose, eyesClosed) => {
        // same key shape as the original cached impl (R0(look)|dir|frame|pose|eyes)
        const key = `${look && (look.isGuard || look.isImperial || look.empire) ? 'guard' : ''}${look && look.isRepair ? 'rep' : ''}${look && look.skin}${look && look.hair}${look && look.shirt}${look && look.pants}${look && look.style}${look && (look.outfit ?? "")}${look && (look.accessory ?? "")}${look && look.visor ? '~' + look.visor : ''}|${dir}|${frame}|${pose}|${eyesClosed ? 1 : 0}`;
        let c = cache.get(key);
        if (!c) { c = render(look, dir, frame, pose, eyesClosed); cache.set(key, c); }
        return c;
      };
    })(),

    // Holographic Terminal Screens (cached: town.js calls this per pod per frame;
    // variants are state × frame — working 0-6, idle 0-1, done, off)
    townScreen: (() => {
      const cache = new Map();
      const render = (state, frame) => {
      const canvas = document.createElement('canvas');
      canvas.width = 14; canvas.height = 9;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = 'rgba(0, 229, 255, 0.15)';
      ctx.fillRect(1, 1, 12, 7);

      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(1, 1, 12, 7);

      if (state === 'working') {
        ctx.fillStyle = '#00e5ff';
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(3, 2 + i * 2, (frame + i * 2) % 8 + 2, 1);
        }
      } else if (state === 'done') {
        ctx.fillStyle = '#50fa7b';
        ctx.fillRect(5, 4, 4, 2);
      } else {
        ctx.fillStyle = '#ffb86c';
        ctx.fillRect(6, 4, 2, 2);
      }

      return canvas;
      };
      return (state, frame) => {
        const key = state + '|' + frame;
        let c = cache.get(key);
        if (!c) { c = render(state, frame); cache.set(key, c); }
        return c;
      };
    })()
  });
})();
