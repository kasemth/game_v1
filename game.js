(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const TILE = 40;
  const COLS = 15;
  const ROWS = 13;

  const WALL = 1;      // indestructible
  const BLOCK = 2;     // destructible
  const FLOOR = 0;

  const DIRS = {
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
  };

  // ---------- Sound (synthesized, no audio files needed) ----------

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  const audioCtx = AudioCtor ? new AudioCtor() : null;
  let muted = false;

  function unlockAudio() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }

  function beep({ freq = 440, sweep = null, duration = 0.15, type = 'square', volume = 0.15, delay = 0 }) {
    if (!audioCtx || muted) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(sweep, t0 + duration);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  function noiseBurst({ duration = 0.3, volume = 0.25, delay = 0 } = {}) {
    if (!audioCtx || muted) return;
    const t0 = audioCtx.currentTime + delay;
    const size = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
    const buffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / size);
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    noise.connect(filter).connect(gain).connect(audioCtx.destination);
    noise.start(t0);
    noise.stop(t0 + duration + 0.02);
  }

  const sfx = {
    place: () => beep({ freq: 220, sweep: 440, duration: 0.08, type: 'square', volume: 0.12 }),
    explosion: () => noiseBurst({ duration: 0.35, volume: 0.3 }),
    hit: () => beep({ freq: 180, sweep: 60, duration: 0.12, type: 'square', volume: 0.1 }),
    powerup: () => {
      [523.25, 659.25, 783.99].forEach((f, i) => beep({ freq: f, duration: 0.09, type: 'square', volume: 0.14, delay: i * 0.08 }));
    },
    death: () => beep({ freq: 300, sweep: 70, duration: 0.5, type: 'sawtooth', volume: 0.18 }),
    win: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => beep({ freq: f, duration: 0.16, type: 'square', volume: 0.16, delay: i * 0.12 }));
    },
    gameover: () => {
      [392, 349.23, 293.66, 196].forEach((f, i) => beep({ freq: f, duration: 0.22, type: 'triangle', volume: 0.16, delay: i * 0.15 }));
    },
  };

  const hudLevel = document.getElementById('hud-level');
  const hudLives = document.getElementById('hud-lives');
  const hudScore = document.getElementById('hud-score');
  const hudBombs = document.getElementById('hud-bombs');
  const hudPower = document.getElementById('hud-power');
  const overlay = document.getElementById('overlay');
  const btnStart = document.getElementById('btn-start');

  let grid = [];
  let bombs = [];
  let explosions = [];
  let enemies = [];
  let powerups = {};
  let doorPos = null;
  let doorRevealed = false;
  let doorOpen = false;

  let player;
  let level = 1;
  let score = 0;
  let lives = 3;
  let paused = false;
  let gameState = 'menu'; // menu | playing | dead | win | gameover
  let keys = {};
  let lastTime = 0;

  function key(c, r) { return c + ',' + r; }

  function inBounds(c, r) {
    return c >= 0 && r >= 0 && c < COLS && r < ROWS;
  }

  function buildLevel(lvl) {
    grid = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        if (r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1) {
          row.push(WALL);
        } else if (r % 2 === 0 && c % 2 === 0) {
          row.push(WALL);
        } else {
          row.push(FLOOR);
        }
      }
      grid.push(row);
    }

    const safeZones = [
      [1, 1], [1, 2], [2, 1],
      [COLS - 2, 1], [COLS - 2, 2], [COLS - 3, 1],
      [1, ROWS - 2], [1, ROWS - 3], [2, ROWS - 2],
      [COLS - 2, ROWS - 2], [COLS - 2, ROWS - 3], [COLS - 3, ROWS - 2],
    ];
    const isSafe = (c, r) => safeZones.some(([sc, sr]) => sc === c && sr === r);

    const blockChance = 0.72;
    const blockCells = [];
    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < COLS - 1; c++) {
        if (grid[r][c] === FLOOR && !isSafe(c, r)) {
          if (Math.random() < blockChance) {
            grid[r][c] = BLOCK;
            blockCells.push([c, r]);
          }
        }
      }
    }

    powerups = {};
    doorRevealed = false;
    doorOpen = false;
    doorPos = blockCells.length
      ? blockCells[Math.floor(Math.random() * blockCells.length)]
      : [1, 1];

    const powerupTypes = ['bomb', 'power', 'speed'];
    const powerupCount = Math.min(6, Math.floor(blockCells.length * 0.22));
    const shuffled = blockCells
      .filter(([c, r]) => !(c === doorPos[0] && r === doorPos[1]))
      .sort(() => Math.random() - 0.5);
    for (let i = 0; i < powerupCount && i < shuffled.length; i++) {
      const [c, r] = shuffled[i];
      powerups[key(c, r)] = powerupTypes[Math.floor(Math.random() * powerupTypes.length)];
    }

    player = {
      x: 1 * TILE, y: 1 * TILE,
      col: 1, row: 1,
      dir: 'down',
      moving: false,
      walkFrame: 0,
      speed: 130,
      maxBombs: 1,
      power: 1,
      alive: true,
      invincible: 1200,
      punch: 0,
    };

    enemies = [];
    const enemyCount = Math.min(2 + lvl, 8);
    const spawnCorners = [
      [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2],
      [COLS - 4, ROWS - 4], [4, 4], [COLS - 6, 3], [3, ROWS - 6], [COLS - 3, ROWS - 5],
    ];
    for (let i = 0; i < enemyCount; i++) {
      const [ec, er] = spawnCorners[i % spawnCorners.length];
      grid[er][ec] = FLOOR;
      enemies.push({
        x: ec * TILE, y: er * TILE,
        col: ec, row: er,
        dir: ['up', 'down', 'left', 'right'][Math.floor(Math.random() * 4)],
        speed: 55 + Math.min(lvl * 6, 40) + Math.random() * 20,
        alive: true,
        changeDirTimer: 0,
        type: i % 3,
      });
    }

    bombs = [];
    explosions = [];
  }

  function tileAt(c, r) {
    if (!inBounds(c, r)) return WALL;
    return grid[r][c];
  }

  const HITBOX_MARGIN = 6;

  // Tiles the entity's hitbox currently overlaps (it can straddle up to 4
  // tiles mid-move). Bombs under any of these stay walkable until the
  // hitbox has fully left them, otherwise a bomb the player is still
  // standing on can suddenly re-solidify mid-step and trap them.
  function overlappingTiles(x, y) {
    const pts = [
      [x + HITBOX_MARGIN, y + HITBOX_MARGIN],
      [x + TILE - HITBOX_MARGIN, y + HITBOX_MARGIN],
      [x + HITBOX_MARGIN, y + TILE - HITBOX_MARGIN],
      [x + TILE - HITBOX_MARGIN, y + TILE - HITBOX_MARGIN],
    ];
    const seen = new Set();
    const tiles = [];
    for (const [px, py] of pts) {
      const c = Math.floor(px / TILE);
      const r = Math.floor(py / TILE);
      const k = c + ',' + r;
      if (!seen.has(k)) { seen.add(k); tiles.push([c, r]); }
    }
    return tiles;
  }

  function canMoveTo(entity, nx, ny, isPlayer) {
    const corners = [
      [nx + HITBOX_MARGIN, ny + HITBOX_MARGIN],
      [nx + TILE - HITBOX_MARGIN, ny + HITBOX_MARGIN],
      [nx + HITBOX_MARGIN, ny + TILE - HITBOX_MARGIN],
      [nx + TILE - HITBOX_MARGIN, ny + TILE - HITBOX_MARGIN],
    ];
    const ignoreTiles = isPlayer ? overlappingTiles(entity.x, entity.y) : null;
    for (const [px, py] of corners) {
      const c = Math.floor(px / TILE);
      const r = Math.floor(py / TILE);
      const t = tileAt(c, r);
      if (t === WALL || t === BLOCK) return false;
      if (bombs.some(b => b.col === c && b.row === r)) {
        const ignored = ignoreTiles && ignoreTiles.some(([ic, ir]) => ic === c && ir === r);
        if (!ignored) return false;
      }
    }
    return true;
  }

  function updatePlayer(dt) {
    if (!player.alive) return;
    if (player.invincible > 0) player.invincible -= dt;

    let dx = 0, dy = 0;
    if (keys['up'] || keys['w']) { dy = -1; player.dir = 'up'; }
    else if (keys['down'] || keys['s']) { dy = 1; player.dir = 'down'; }
    else if (keys['left'] || keys['a']) { dx = -1; player.dir = 'left'; }
    else if (keys['right'] || keys['d']) { dx = 1; player.dir = 'right'; }

    player.moving = dx !== 0 || dy !== 0;
    if (player.moving) {
      player.walkFrame += dt * 0.01;
      const dist = player.speed * (dt / 1000);
      const nx = player.x + dx * dist;
      const ny = player.y + dy * dist;
      if (dx !== 0 && canMoveTo(player, nx, player.y, true)) player.x = nx;
      if (dy !== 0 && canMoveTo(player, player.x, ny, true)) player.y = ny;
      player.col = Math.round(player.x / TILE);
      player.row = Math.round(player.y / TILE);
    }

    if (player.punch > 0) player.punch -= dt;

    const pk = key(Math.round(player.x / TILE), Math.round(player.y / TILE));
    if (powerups[pk]) {
      applyPowerup(powerups[pk]);
      delete powerups[pk];
      score += 50;
    }

    if (doorOpen) {
      const c = Math.round(player.x / TILE), r = Math.round(player.y / TILE);
      if (c === doorPos[0] && r === doorPos[1]) {
        winLevel();
      }
    }
  }

  function applyPowerup(type) {
    if (type === 'bomb') player.maxBombs = Math.min(player.maxBombs + 1, 8);
    if (type === 'power') player.power = Math.min(player.power + 1, 8);
    if (type === 'speed') player.speed = Math.min(player.speed + 25, 260);
    updateHud();
    sfx.powerup();
  }

  function placeBomb() {
    if (!player.alive || gameState !== 'playing') return;
    const c = Math.round(player.x / TILE);
    const r = Math.round(player.y / TILE);
    if (bombs.some(b => b.col === c && b.row === r)) return;
    if (bombs.filter(b => b.owner === 'player').length >= player.maxBombs) return;
    bombs.push({ col: c, row: r, timer: 2000, power: player.power, owner: 'player' });
    player.punch = 220;
    sfx.place();
  }

  function explodeBomb(bomb) {
    const cells = [[bomb.col, bomb.row]];
    for (const dirName of Object.keys(DIRS)) {
      const { dx, dy } = DIRS[dirName];
      for (let i = 1; i <= bomb.power; i++) {
        const c = bomb.col + dx * i;
        const r = bomb.row + dy * i;
        if (!inBounds(c, r)) break;
        const t = grid[r][c];
        if (t === WALL) break;
        cells.push([c, r]);
        if (t === BLOCK) {
          grid[r][c] = FLOOR;
          if (doorPos && c === doorPos[0] && r === doorPos[1]) {
            doorRevealed = true;
          }
          if (!powerups[key(c, r)]) {
            // block destroyed, nothing hidden here
          }
          score += 10;
          break;
        }
        const chained = bombs.find(b => b !== bomb && b.col === c && b.row === r && b.timer > 0);
        if (chained) chained.timer = Math.min(chained.timer, 1);
      }
    }
    for (const [c, r] of cells) {
      explosions.push({ col: c, row: r, timer: 450 });
    }
    sfx.explosion();
  }

  function updateBombs(dt) {
    for (const b of bombs) {
      b.timer -= dt;
    }
    const exploding = bombs.filter(b => b.timer <= 0);
    for (const b of exploding) explodeBomb(b);
    bombs = bombs.filter(b => b.timer > 0);
  }

  function updateExplosions(dt) {
    for (const e of explosions) e.timer -= dt;
    explosions = explosions.filter(e => e.timer > 0);

    if (player.alive && player.invincible <= 0) {
      const pc = Math.round(player.x / TILE), pr = Math.round(player.y / TILE);
      if (explosions.some(e => e.col === pc && e.row === pr)) {
        killPlayer();
      }
    }

    for (const en of enemies) {
      if (!en.alive) continue;
      const ec = Math.round(en.x / TILE), er = Math.round(en.y / TILE);
      if (explosions.some(e => e.col === ec && e.row === er)) {
        en.alive = false;
        score += 200;
        sfx.hit();
      }
    }
  }

  function killPlayer() {
    player.alive = false;
    lives -= 1;
    updateHud();
    sfx.death();
    setTimeout(() => {
      if (lives <= 0) {
        gameState = 'gameover';
        sfx.gameover();
        showOverlay('💀 เกมจบแล้ว', `น้องนักมวยหมดแรงแล้ว! คะแนนสุดท้าย: ${score}`, 'เล่นใหม่', () => {
          level = 1; score = 0; lives = 3;
          startLevel();
        });
      } else {
        respawnPlayer();
      }
    }, 700);
  }

  function respawnPlayer() {
    player.x = TILE; player.y = TILE;
    player.col = 1; player.row = 1;
    player.alive = true;
    player.invincible = 1800;
  }

  function winLevel() {
    if (gameState !== 'playing') return;
    gameState = 'win';
    score += 500;
    updateHud();
    sfx.win();
    showOverlay('🏆 ผ่านด่าน!', `เก่งมาก! ไปด่านต่อไปกันเลย`, 'ด่านถัดไป', () => {
      level += 1;
      startLevel();
    });
  }

  function updateEnemies(dt) {
    for (const en of enemies) {
      if (!en.alive) continue;
      en.changeDirTimer -= dt;
      const { dx, dy } = DIRS[en.dir];
      const dist = en.speed * (dt / 1000);
      const nx = en.x + dx * dist;
      const ny = en.y + dy * dist;
      let blocked = !canMoveTo(en, nx, ny, false);
      if (blocked || en.changeDirTimer <= 0) {
        const options = Object.keys(DIRS).filter(d => {
          const nd = DIRS[d];
          return canMoveTo(en, en.x + nd.dx * dist, en.y + nd.dy * dist, false);
        });
        if (options.length) {
          en.dir = options[Math.floor(Math.random() * options.length)];
        }
        en.changeDirTimer = 500 + Math.random() * 900;
      } else {
        en.x = nx; en.y = ny;
      }
      en.col = Math.round(en.x / TILE);
      en.row = Math.round(en.y / TILE);

      if (player.alive && player.invincible <= 0) {
        const pcx = player.x + TILE / 2, pcy = player.y + TILE / 2;
        const ecx = en.x + TILE / 2, ecy = en.y + TILE / 2;
        const dd = Math.hypot(pcx - ecx, pcy - ecy);
        if (dd < TILE * 0.55) {
          killPlayer();
        }
      }
    }

    if (enemies.length && enemies.every(e => !e.alive) && !doorOpen) {
      doorOpen = true;
      doorRevealed = true;
    }
  }

  // ---------- Rendering ----------

  function drawFloor() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const shade = (r + c) % 2 === 0 ? '#4cd164' : '#3fb854';
        ctx.fillStyle = shade;
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
  }

  function drawGrid() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = grid[r][c];
        const x = c * TILE, y = r * TILE;
        if (t === WALL) {
          ctx.fillStyle = '#c7ccd6';
          ctx.fillRect(x, y, TILE, TILE);
          ctx.strokeStyle = '#8b909c';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
          ctx.fillStyle = '#e8ecf2';
          ctx.fillRect(x + 4, y + 4, TILE - 8, (TILE - 8) / 2 - 2);
        } else if (t === BLOCK) {
          if (doorPos && c === doorPos[0] && r === doorPos[1] && doorRevealed) {
            drawDoor(x, y);
            continue;
          }
          ctx.fillStyle = '#c97a34';
          ctx.fillRect(x, y, TILE, TILE);
          ctx.strokeStyle = '#7a4a1e';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
          ctx.beginPath();
          ctx.moveTo(x + 6, y + 6); ctx.lineTo(x + TILE - 6, y + TILE - 6);
          ctx.moveTo(x + TILE - 6, y + 6); ctx.lineTo(x + 6, y + TILE - 6);
          ctx.strokeStyle = 'rgba(122,74,30,0.6)';
          ctx.stroke();
        } else {
          if (doorPos && c === doorPos[0] && r === doorPos[1] && doorRevealed) {
            drawDoor(x, y);
          }
        }
      }
    }
  }

  function drawDoor(x, y) {
    ctx.fillStyle = doorOpen ? '#ffd23d' : '#2b3a67';
    ctx.fillRect(x + 6, y + 4, TILE - 12, TILE - 8);
    ctx.fillStyle = doorOpen ? '#7a5a00' : '#141f42';
    ctx.fillRect(x + 10, y + 10, TILE - 20, TILE - 14);
    if (doorOpen) {
      ctx.fillStyle = '#fff6d9';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('★', x + TILE / 2, y + TILE / 2 + 6);
    }
  }

  function drawPowerups() {
    for (const k in powerups) {
      const [c, r] = k.split(',').map(Number);
      if (grid[r][c] !== FLOOR) continue;
      const x = c * TILE, y = r * TILE;
      const type = powerups[k];
      ctx.save();
      ctx.translate(x + TILE / 2, y + TILE / 2);
      if (type === 'bomb') {
        ctx.fillStyle = '#222';
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff8a3d';
        ctx.fillRect(-2, -18, 4, 8);
      } else if (type === 'power') {
        ctx.fillStyle = '#ff5d73';
        ctx.beginPath();
        ctx.moveTo(0, -12); ctx.lineTo(10, 10); ctx.lineTo(-10, 10);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.fillStyle = '#3dd6ff';
        ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#0f0a17';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('S', 0, 4);
      }
      ctx.restore();
    }
  }

  function drawBombs(t) {
    for (const b of bombs) {
      const x = b.col * TILE + TILE / 2, y = b.row * TILE + TILE / 2;
      const pulse = 1 + Math.sin(t / 90) * 0.06 * (1 - Math.min(b.timer / 2000, 1) * 0.5 + 0.5);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffd23d';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(6, -12); ctx.quadraticCurveTo(14, -20, 10, -26); ctx.stroke();
      ctx.fillStyle = '#ff5d3d';
      ctx.beginPath(); ctx.arc(10, -26, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function drawExplosions() {
    for (const e of explosions) {
      const x = e.col * TILE, y = e.row * TILE;
      const alpha = Math.max(e.timer / 450, 0);
      ctx.fillStyle = `rgba(230, 57, 70, ${0.55 * alpha + 0.2})`;
      ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
      ctx.fillStyle = `rgba(255, 210, 61, ${0.65 * alpha})`;
      ctx.fillRect(x + 10, y + 10, TILE - 20, TILE - 20);
      ctx.fillStyle = `rgba(255, 250, 230, ${0.7 * alpha})`;
      ctx.fillRect(x + 16, y + 16, TILE - 32, TILE - 32);
    }
  }

  function drawEnemy(en) {
    if (!en.alive) return;
    const x = en.x + TILE / 2, y = en.y + TILE / 2;
    const colors = [
      ['#5ad1e6', '#2c95a8'],
      ['#c15aff', '#7c2fa8'],
      ['#ffd15a', '#c48a1a'],
    ];
    const [body, dark] = colors[en.type % colors.length];
    const wob = Math.sin(Date.now() / 150 + en.col + en.row) * 2;
    ctx.save();
    ctx.translate(x, y + wob);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 4, 14, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.ellipse(0, 10, 14, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-5, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(5, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(-5, 1, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(5, 1, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawPlayer() {
    if (!player.alive) return;
    if (player.invincible > 0 && Math.floor(player.invincible / 100) % 2 === 0) return;

    const x = player.x + TILE / 2;
    const y = player.y + TILE / 2;
    const step = player.moving ? Math.sin(player.walkFrame) : 0;
    const facing = player.dir;
    const punching = player.punch > 0;

    ctx.save();
    ctx.translate(x, y);

    // legs
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(-8, 10 + Math.max(0, step * 3), 6, 9);
    ctx.fillRect(2, 10 + Math.max(0, -step * 3), 6, 9);

    // body (dark gray tee, like the reference photo)
    ctx.fillStyle = '#4a4a55';
    ctx.beginPath();
    ctx.moveTo(-10, -4);
    ctx.lineTo(10, -4);
    ctx.lineTo(9, 12);
    ctx.lineTo(-9, 12);
    ctx.closePath();
    ctx.fill();

    // arms + boxing gloves (white), pose depends on direction / punch
    const glove = (gx, gy, r) => {
      ctx.fillStyle = '#f2f2f2';
      ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#c9c9c9';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    if (facing === 'left') {
      glove(-13, punching ? -10 : -2, 6);
      glove(-6, 6, 5.5);
    } else if (facing === 'right') {
      glove(13, punching ? -10 : -2, 6);
      glove(6, 6, 5.5);
    } else if (facing === 'up') {
      glove(-9, punching ? -14 : -6, 6);
      glove(9, punching ? -14 : -6, 6);
    } else {
      glove(-10, punching ? -12 : -1, 6);
      glove(10, punching ? -12 : -1, 6);
    }

    // head
    ctx.fillStyle = '#f2c48a';
    ctx.beginPath();
    ctx.arc(0, -16, 9.5, 0, Math.PI * 2);
    ctx.fill();

    // hair (short, dark, side-swept like reference)
    ctx.fillStyle = '#1c1712';
    ctx.beginPath();
    ctx.arc(0, -19, 9.8, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-9.5, -18);
    ctx.quadraticCurveTo(-2, -26, 8, -20);
    ctx.quadraticCurveTo(4, -22, -9.5, -18);
    ctx.fill();

    // face direction accents
    ctx.fillStyle = '#2b2018';
    if (facing !== 'up') {
      const eoff = facing === 'left' ? -2 : facing === 'right' ? 2 : 0;
      ctx.beginPath(); ctx.arc(-3 + eoff, -16, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(3 + eoff, -16, 1.3, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }

  function render(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFloor();
    drawGrid();
    drawPowerups();
    drawBombs(t);
    drawExplosions();
    for (const en of enemies) drawEnemy(en);
    drawPlayer();
  }

  // ---------- HUD / Overlay ----------

  function updateHud() {
    hudLevel.textContent = level;
    hudLives.textContent = '❤'.repeat(Math.max(lives, 0)) || '💀';
    hudScore.textContent = score;
    hudBombs.textContent = player.maxBombs;
    hudPower.textContent = player.power;
  }

  function showOverlay(title, msg, btnLabel, onClick) {
    overlay.innerHTML = `
      <div class="panel">
        <h1>${title}</h1>
        <p>${msg}</p>
        <button id="overlay-btn">${btnLabel}</button>
      </div>`;
    overlay.hidden = false;
    document.getElementById('overlay-btn').addEventListener('click', () => {
      overlay.hidden = true;
      onClick();
    }, { once: true });
  }

  function startLevel() {
    buildLevel(level);
    gameState = 'playing';
    updateHud();
  }

  // ---------- Input ----------

  const keyMap = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  window.addEventListener('keydown', (e) => {
    unlockAudio();
    if (keyMap[e.key]) { keys[keyMap[e.key]] = true; e.preventDefault(); }
    if (e.key === ' ') { placeBomb(); e.preventDefault(); }
    if (e.key === 'p' || e.key === 'P') togglePause();
  });
  window.addEventListener('keyup', (e) => {
    if (keyMap[e.key]) { keys[keyMap[e.key]] = false; }
  });

  function bindHold(id, dir) {
    const el = document.getElementById(id);
    const on = (e) => { e.preventDefault(); keys[dir] = true; };
    const off = (e) => { e.preventDefault(); keys[dir] = false; };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off);
    el.addEventListener('mousedown', on);
    el.addEventListener('mouseup', off);
    el.addEventListener('mouseleave', off);
  }
  bindHold('t-up', 'up');
  bindHold('t-down', 'down');
  bindHold('t-left', 'left');
  bindHold('t-right', 'right');
  document.getElementById('t-bomb').addEventListener('click', placeBomb);

  function togglePause() {
    if (gameState !== 'playing' && gameState !== 'paused') return;
    if (gameState === 'playing') {
      gameState = 'paused';
      showOverlay('⏸ หยุดชั่วคราว', 'กด "เล่นต่อ" เพื่อไปต่อ', 'เล่นต่อ', () => {
        gameState = 'playing';
      });
    }
  }

  btnStart.addEventListener('click', () => {
    unlockAudio();
    overlay.hidden = true;
    level = 1; score = 0; lives = 3;
    startLevel();
  });

  const btnMute = document.getElementById('btn-mute');
  btnMute.addEventListener('click', () => {
    unlockAudio();
    muted = !muted;
    btnMute.textContent = muted ? '🔇' : '🔊';
  });

  // ---------- Main loop ----------

  function loop(t) {
    const dt = Math.min(t - lastTime, 50);
    lastTime = t;

    if (gameState === 'playing') {
      updatePlayer(dt);
      updateBombs(dt);
      updateExplosions(dt);
      updateEnemies(dt);
      updateHud();
    }
    render(t);
    requestAnimationFrame(loop);
  }

  buildLevel(level);
  updateHud();
  requestAnimationFrame(loop);
})();
