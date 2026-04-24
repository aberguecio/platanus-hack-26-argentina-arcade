// Strike and Stone — falling-sand miner for Platanus Hack 26.
// Engine v2: fixed-timestep ticks, block registry, per-category simulation.
// See CLAUDE.md for the architectural conventions you must follow.

// ============================================================
// 1. Config & constants
// ============================================================

const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const TILE = 10;
const VW = GAME_WIDTH / TILE;   // 80 viewport tiles wide
const VH = GAME_HEIGHT / TILE;  // 60 viewport tiles tall
const WORLD_W = 256;
const WORLD_H = 192;

// Fixed-timestep simulation. Movement constants (MOVE_SPEED, GRAVITY, …)
// are calibrated PER TICK, not per frame, so the game runs at the same
// world-speed regardless of monitor refresh rate.
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MAX_TICKS_PER_FRAME = 5;

const MOVE_SPEED = 1.2;     // px / tick
const JUMP_VELOCITY = -3.4; // px / tick
const GRAVITY = 0.18;       // px / tick²
const TERMINAL_VY = 4.5;

// Cell byte layout: bits 0–5 = type id (0–63), bit 6 = MOVED (cleared each
// tick), bit 7 = FALLING (mineral marked as detached, persists until BFS
// reanchors).
const TYPE_MASK = 0x3F;
const MOVED_FLAG = 0x40;
const FALLING_FLAG = 0x80;

// ============================================================
// 2. Block registry — single source of truth.
// To add a new block: append a row. If its behavior fits an existing
// category, no other code needs to change.
// ============================================================

const CAT_AIR = 0;
const CAT_LIQUID = 1;
const CAT_SANDLIKE = 2;
const CAT_SOLID = 3;
const CAT_MINERAL = 4;
const CAT_MAGIC = 5;

// Type ids — keep stable so a saved world (future feature) doesn't drift.
const AIR = 0, DIRT = 1, SAND = 2, WATER = 3, STONE = 4,
      GRAVEL = 5, LAVA = 6, COPPER = 7, IRON = 8, BORDER = 9;

// Colors are packed little-endian 0xAABBGGRR for direct Uint32 writes
// into the canvas ImageData buffer.
const BLOCKS = [
  // id, name, cat, color, fallTicks, hardness
  { id: AIR,    cat: CAT_AIR,      color: 0xff0a0d18, fallTicks: 0,  hardness: 0 },
  { id: DIRT,   cat: CAT_SOLID,    color: 0xff2c4f7a, fallTicks: 30, hardness: 1 },
  { id: SAND,   cat: CAT_SANDLIKE, color: 0xff5cd4e8, fallTicks: 20, hardness: 1 },
  { id: WATER,  cat: CAT_LIQUID,   color: 0xffd88030, fallTicks: 10, hardness: 1 },
  { id: STONE,  cat: CAT_MINERAL,  color: 0xff4a4a4a, fallTicks: 30, hardness: 2 },
  { id: GRAVEL, cat: CAT_SANDLIKE, color: 0xff6e7e95, fallTicks: 30, hardness: 2 },
  { id: LAVA,   cat: CAT_LIQUID,   color: 0xff1840f0, fallTicks: 60, hardness: 5 },
  { id: COPPER, cat: CAT_MINERAL,  color: 0xff2a8acc, fallTicks: 30, hardness: 4 },
  { id: IRON,   cat: CAT_MINERAL,  color: 0xff8090a0, fallTicks: 30, hardness: 6 },
  { id: BORDER, cat: CAT_MAGIC,    color: 0xff1a1a1a, fallTicks: 0,  hardness: 0 },
];

// Flat lookup tables for the hot path. 64-slot capacity (TYPE_MASK + 1).
const BLOCK_CAT = new Uint8Array(64);
const BLOCK_COLOR = new Uint32Array(64);
const BLOCK_FALL_TICKS = new Uint8Array(64);
const BLOCK_HARDNESS = new Uint8Array(64);
for (const b of BLOCKS) {
  BLOCK_CAT[b.id] = b.cat;
  BLOCK_COLOR[b.id] = b.color;
  BLOCK_FALL_TICKS[b.id] = b.fallTicks;
  BLOCK_HARDNESS[b.id] = b.hardness;
}

const GRASS_COLOR = 0xff2c8845; // visual-only: dirt with air above

// ============================================================
// 3. Cabinet input scaffolding (preserved verbatim).
// ============================================================

// DO NOT replace existing keys — they match the physical arcade cabinet
// wiring. Append extra keys to test locally.
const CABINET_KEYS = {
  P1_U: ['w'],
  P1_D: ['s'],
  P1_L: ['a'],
  P1_R: ['d'],
  P1_1: ['u', ' '],
  P1_2: ['i'],
  P1_3: ['o'],
  P1_4: ['j'],
  P1_5: ['k'],
  P1_6: ['l'],
  P2_U: ['ArrowUp'],
  P2_D: ['ArrowDown'],
  P2_L: ['ArrowLeft'],
  P2_R: ['ArrowRight'],
  P2_1: ['r'],
  P2_2: ['t'],
  P2_3: ['y'],
  P2_4: ['f'],
  P2_5: ['g'],
  P2_6: ['h'],
  START1: ['Enter'],
  START2: ['2'],
};

const KEYBOARD_TO_ARCADE = {};
for (const [arcadeCode, keys] of Object.entries(CABINET_KEYS)) {
  for (const key of keys) {
    KEYBOARD_TO_ARCADE[normalizeIncomingKey(key)] = arcadeCode;
  }
}

// ============================================================
// 4. Phaser bootstrap
// ============================================================

const config = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-root',
  backgroundColor: '#0a0d18',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
  },
  scene: { preload, create, update },
};

new Phaser.Game(config);

function preload() {}

function create() {
  const scene = this;

  // World grid: row-major, idx = y * WORLD_W + x. Damage array tracks how
  // many hits a tile has taken; reset when the cell becomes AIR.
  scene.world = new Uint8Array(WORLD_W * WORLD_H);
  scene.damage = new Uint8Array(WORLD_W * WORLD_H);

  generateWorld(scene.world);

  // Player spawn near surface mid-map. Visual ~2×3 tiles; AABB shrunk to
  // 18×26 so it doesn't straddle a 4th row/column at sub-tile positions.
  const spawnTx = WORLD_W >> 1;
  const surfaceY = findSurface(scene.world, spawnTx);
  scene.player = {
    x: spawnTx * TILE + TILE,
    y: surfaceY * TILE,
    vx: 0,
    vy: 0,
    w: 18,
    h: 26,
    onGround: false,
  };
  scene.facing = 1;
  scene.walkPhase = 0;
  scene.mineAnim = 0;
  scene.mineDx = 1;
  scene.mineDy = 0;

  // Tick / fixed-timestep state.
  scene.tickAcc = 0;
  scene.tickCount = 0;

  // Mineral stability scratch space.
  scene.bfsQueue = new Int32Array(VW * VH + 16);
  scene.visited = new Uint8Array(WORLD_W * WORLD_H);
  scene.visitedTag = 0;
  scene.dirtyMineral = true; // run BFS on first tick

  // Camera.
  scene.cam = { x: 0, y: 0 };
  updateCamera(scene);

  // World texture: VW+2 × VH+2 pixels (1 tile margin each side) so we can
  // scroll smoothly per pixel by offsetting the image. Avoids the 1-tile
  // visual misalignment between the tile grid and the player's smooth pos.
  const TW = VW + 2;
  const TH = VH + 2;
  scene.tex = scene.textures.createCanvas('world', TW, TH);
  scene.texCtx = scene.tex.getContext();
  scene.imgData = scene.texCtx.getImageData(0, 0, TW, TH);
  scene.pixels = new Uint32Array(scene.imgData.data.buffer);
  scene.worldImg = scene.add.image(0, 0, 'world').setOrigin(0).setScale(TILE);

  buildPlayerVisual(scene);

  scene.hud = scene.add
    .text(8, 6, '', { fontFamily: 'monospace', fontSize: '12px', color: '#ffffff' })
    .setDepth(20);

  createControls(scene);
}

// ============================================================
// 5. World generation
// ============================================================

function generateWorld(w) {
  let seed = 0x9e3779b1 >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const surfaceBase = 60;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const idx = y * WORLD_W + x;
      // World borders + bottom = BORDER (magic, unbreakable).
      if (x === 0 || x === WORLD_W - 1 || y === WORLD_H - 1) {
        w[idx] = BORDER;
        continue;
      }
      const wave = Math.sin(x * 0.06) * 3 + Math.sin(x * 0.21) * 2;
      const surfaceY = (surfaceBase + wave) | 0;
      if (y < surfaceY)             w[idx] = AIR;
      else if (y < surfaceY + 8)    w[idx] = DIRT;
      else if (y < WORLD_H - 22)    w[idx] = STONE;
      else                          w[idx] = STONE; // bedrock band, also stone
    }
  }

  // Pockets — use blob() to carve regions of `only` into `fill`.
  const pocket = (count, fill, only, yLo, yHi, rxMax, ryMax) => {
    for (let i = 0; i < count; i++) {
      const cx = 4 + ((rnd() * (WORLD_W - 8)) | 0);
      const cy = yLo + ((rnd() * (yHi - yLo)) | 0);
      const rx = 2 + ((rnd() * rxMax) | 0);
      const ry = 1 + ((rnd() * ryMax) | 0);
      blob(w, cx, cy, rx, ry, fill, only);
    }
  };

  pocket(45,  SAND,   STONE, 70,  150, 11, 7); // big sand deposits
  pocket(80,  GRAVEL, STONE, 80,  160, 3,  2);
  pocket(35,  WATER,  STONE, 70,  140, 9,  6); // big water reservoirs
  pocket(40,  LAVA,   STONE, 140, 168, 3,  2);
  pocket(60,  COPPER, STONE, 90,  165, 2,  2);
  pocket(35,  IRON,   STONE, 120, 165, 2,  2);
  pocket(50,  AIR,    STONE, 75,  165, 4,  2);
  pocket(25,  AIR,    DIRT,  60,  72,  3,  1); // little caverns near surface
}

function blob(w, cx, cy, rx, ry, fill, only) {
  const x0 = Math.max(1, cx - rx);
  const x1 = Math.min(WORLD_W - 2, cx + rx);
  const y0 = Math.max(1, cy - ry);
  const y1 = Math.min(WORLD_H - 2, cy + ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const idx = y * WORLD_W + x;
        if (w[idx] === only) w[idx] = fill;
      }
    }
  }
}

function findSurface(w, tx) {
  for (let y = 1; y < WORLD_H - 1; y++) {
    if (w[y * WORLD_W + tx] !== AIR) return y;
  }
  return WORLD_H >> 1;
}

// ============================================================
// 6. Tick loop & dispatch
// ============================================================

function update(_time, delta) {
  const scene = this;
  if (!scene.world) return;

  scene.tickAcc += Math.min(delta, 100); // cap delta to avoid huge catch-up
  let n = 0;
  while (scene.tickAcc >= TICK_MS && n < MAX_TICKS_PER_FRAME) {
    scene.tickAcc -= TICK_MS;
    scene.tickCount++;
    runTick(scene);
    n++;
  }

  // Render once per frame regardless of tick count.
  render(scene);
  updatePlayerVisual(scene);

  scene.hud.setText(
    `x ${scene.player.x | 0}  y ${scene.player.y | 0}  ` +
    `tick ${scene.tickCount}  fps ${(1000 / Math.max(delta, 1)) | 0}`,
  );
}

function runTick(scene) {
  handleInput(scene);
  movePlayer(scene);
  simulateViewport(scene);
  if (scene.dirtyMineral) {
    resolveMineralStability(scene);
    scene.dirtyMineral = false;
  }
  updateCamera(scene);
}

// ============================================================
// 7. Falling-sand simulation (per-category, viewport only)
// ============================================================

function simulateViewport(scene) {
  const w = scene.world;
  const damage = scene.damage;
  const tick = scene.tickCount;

  const tx0 = clamp(((scene.cam.x / TILE) | 0) - 2, 1, WORLD_W - 1);
  const ty0 = clamp(((scene.cam.y / TILE) | 0) - 2, 1, WORLD_H - 1);
  const tx1 = clamp(tx0 + VW + 4, 1, WORLD_W - 1);
  const ty1 = clamp(ty0 + VH + 4, 1, WORLD_H - 1);

  // Bottom-up so a falling tile isn't processed twice in the same tick.
  for (let y = ty1 - 1; y >= ty0; y--) {
    const row = y * WORLD_W;
    for (let x = tx0; x < tx1; x++) {
      const idx = row + x;
      const cell = w[idx];
      if (cell & MOVED_FLAG) continue;
      const t = cell & TYPE_MASK;
      const fall = BLOCK_FALL_TICKS[t];
      if (fall === 0) continue;            // AIR or MAGIC
      if (tick % fall !== 0) continue;     // throttle (lava=4 → every 4th tick)
      const cat = BLOCK_CAT[t];
      if (cat === CAT_LIQUID)        tryLiquid(w, damage, idx, x, tick);
      else if (cat === CAT_SANDLIKE) trySandlike(w, damage, idx, x, tick);
      else if (cat === CAT_SOLID)    trySolid(w, damage, idx);
      else if (cat === CAT_MINERAL && (cell & FALLING_FLAG))
        tryMineral(scene, w, damage, idx, x, tick);
    }
  }

  // Clear MOVED_FLAG over the band; preserve FALLING_FLAG.
  for (let y = ty0; y < ty1; y++) {
    const row = y * WORLD_W;
    for (let x = tx0; x < tx1; x++) {
      w[row + x] &= ~MOVED_FLAG;
    }
  }
}

// down → diagonal-down (alternating bias) → sides (alternating bias)
function tryLiquid(w, damage, idx, x, tick) {
  const myType = w[idx] & TYPE_MASK;
  const dIdx = idx + WORLD_W;
  if ((w[dIdx] & TYPE_MASK) === AIR) {
    w[dIdx] = myType | MOVED_FLAG; w[idx] = AIR; damage[idx] = 0;
    return;
  }
  const bias = (tick & 1) ? 1 : -1;
  // Diagonal down
  for (let dir = 0; dir < 2; dir++) {
    const dx = (dir === 0) ? bias : -bias;
    const nx = x + dx;
    if (nx < 1 || nx >= WORLD_W - 1) continue;
    if ((w[dIdx + dx] & TYPE_MASK) === AIR) {
      w[dIdx + dx] = myType | MOVED_FLAG; w[idx] = AIR; damage[idx] = 0;
      return;
    }
  }
  // Sideways
  for (let dir = 0; dir < 2; dir++) {
    const dx = (dir === 0) ? bias : -bias;
    const nx = x + dx;
    if (nx < 1 || nx >= WORLD_W - 1) continue;
    if ((w[idx + dx] & TYPE_MASK) === AIR) {
      w[idx + dx] = myType | MOVED_FLAG; w[idx] = AIR; damage[idx] = 0;
      return;
    }
  }
}

// down → diagonal-down. Sandlike sinks through liquid (swap).
function trySandlike(w, damage, idx, x, tick) {
  const myType = w[idx] & TYPE_MASK;
  const dIdx = idx + WORLD_W;
  const bCat = BLOCK_CAT[w[dIdx] & TYPE_MASK];
  if (bCat === CAT_AIR) {
    w[dIdx] = myType | MOVED_FLAG; w[idx] = AIR; damage[idx] = 0;
    return;
  }
  if (bCat === CAT_LIQUID) {
    const liq = w[dIdx] & TYPE_MASK;
    w[dIdx] = myType | MOVED_FLAG; w[idx] = liq | MOVED_FLAG; damage[idx] = 0;
    return;
  }
  const bias = (tick & 1) ? 1 : -1;
  for (let dir = 0; dir < 2; dir++) {
    const dx = (dir === 0) ? bias : -bias;
    const nx = x + dx;
    if (nx < 1 || nx >= WORLD_W - 1) continue;
    if (BLOCK_CAT[w[dIdx + dx] & TYPE_MASK] === CAT_AIR) {
      w[dIdx + dx] = myType | MOVED_FLAG; w[idx] = AIR; damage[idx] = 0;
      return;
    }
  }
}

// down only — the "block"-style behavior (dirt).
function trySolid(w, damage, idx) {
  const myType = w[idx] & TYPE_MASK;
  const dIdx = idx + WORLD_W;
  if ((w[dIdx] & TYPE_MASK) === AIR) {
    w[dIdx] = myType | MOVED_FLAG; w[idx] = AIR; damage[idx] = 0;
  }
}

// MINERAL when isolated: behaves like SAND but keeps its type id (so colour
// is preserved) and the FALLING_FLAG persists across ticks until the BFS
// re-anchors it.
function tryMineral(scene, w, damage, idx, x, tick) {
  const myType = w[idx] & TYPE_MASK;
  const dIdx = idx + WORLD_W;
  const bCat = BLOCK_CAT[w[dIdx] & TYPE_MASK];
  if (bCat === CAT_AIR) {
    w[dIdx] = myType | MOVED_FLAG | FALLING_FLAG; w[idx] = AIR;
    damage[idx] = 0;
    scene.dirtyMineral = true;
    return;
  }
  if (bCat === CAT_LIQUID) {
    const liq = w[dIdx] & TYPE_MASK;
    w[dIdx] = myType | MOVED_FLAG | FALLING_FLAG;
    w[idx] = liq | MOVED_FLAG;
    damage[idx] = 0;
    scene.dirtyMineral = true;
    return;
  }
  const bias = (tick & 1) ? 1 : -1;
  for (let dir = 0; dir < 2; dir++) {
    const dx = (dir === 0) ? bias : -bias;
    const nx = x + dx;
    if (nx < 1 || nx >= WORLD_W - 1) continue;
    if (BLOCK_CAT[w[dIdx + dx] & TYPE_MASK] === CAT_AIR) {
      w[dIdx + dx] = myType | MOVED_FLAG | FALLING_FLAG; w[idx] = AIR;
      damage[idx] = 0;
      scene.dirtyMineral = true;
      return;
    }
  }
  // Stalled — leave FALLING_FLAG set; it'll re-try next tick. BFS will
  // clear the flag if it's now part of an anchored chain.
}

// ============================================================
//    Mineral stability BFS — generalized from v1's DIRT-only version.
// ============================================================

function resolveMineralStability(scene) {
  const w = scene.world;
  const visited = scene.visited;
  const queue = scene.bfsQueue;

  scene.visitedTag = (scene.visitedTag + 1) & 0xff;
  if (scene.visitedTag === 0) {
    visited.fill(0);
    scene.visitedTag = 1;
  }
  const tag = scene.visitedTag;

  const tx0 = clamp(((scene.cam.x / TILE) | 0) - 2, 1, WORLD_W - 2);
  const ty0 = clamp(((scene.cam.y / TILE) | 0) - 2, 1, WORLD_H - 2);
  const tx1 = clamp(tx0 + VW + 4, 1, WORLD_W - 1);
  const ty1 = clamp(ty0 + VH + 4, 1, WORLD_H - 1);

  let qhead = 0, qtail = 0;

  // Seed: every MAGIC tile + minerals on the band's outer border (treated
  // as anchored to off-screen mass).
  for (let y = ty0; y < ty1; y++) {
    const row = y * WORLD_W;
    for (let x = tx0; x < tx1; x++) {
      const idx = row + x;
      const cat = BLOCK_CAT[w[idx] & TYPE_MASK];
      if (cat === CAT_MAGIC) {
        if (visited[idx] !== tag) { visited[idx] = tag; queue[qtail++] = idx; }
      } else if (cat === CAT_MINERAL) {
        const onBorder = x === tx0 || x === tx1 - 1 || y === ty0 || y === ty1 - 1;
        if (onBorder && visited[idx] !== tag) {
          visited[idx] = tag; queue[qtail++] = idx;
        }
      }
    }
  }

  // BFS through MINERAL tiles only.
  while (qhead < qtail) {
    const idx = queue[qhead++];
    const x = idx % WORLD_W;
    const y = (idx / WORLD_W) | 0;
    if (x < tx0 || x >= tx1 || y < ty0 || y >= ty1) continue;
    const nbrs = [idx - 1, idx + 1, idx - WORLD_W, idx + WORLD_W];
    for (let i = 0; i < 4; i++) {
      const n = nbrs[i];
      if (n < 0 || n >= w.length) continue;
      if (visited[n] === tag) continue;
      if (BLOCK_CAT[w[n] & TYPE_MASK] !== CAT_MINERAL) continue;
      if (qtail < queue.length) {
        visited[n] = tag;
        queue[qtail++] = n;
      }
    }
  }

  // Apply: anchored minerals → clear FALLING_FLAG; isolated → set it.
  for (let y = ty0; y < ty1; y++) {
    const row = y * WORLD_W;
    for (let x = tx0; x < tx1; x++) {
      const idx = row + x;
      const cell = w[idx];
      if (BLOCK_CAT[cell & TYPE_MASK] !== CAT_MINERAL) continue;
      if (visited[idx] === tag) w[idx] = cell & ~FALLING_FLAG;
      else                      w[idx] = cell | FALLING_FLAG;
    }
  }
}

// ============================================================
// 8. Player controller
// ============================================================

function handleInput(scene) {
  const c = scene.controls;
  let vx = 0;
  if (c.held.P1_L) vx -= 1;
  if (c.held.P1_R) vx += 1;
  scene.player.vx = vx * MOVE_SPEED;
  if (vx !== 0) scene.facing = vx;

  // Jump (P1_1 button or joystick UP, edge-triggered)
  if ((c.pressed.P1_1 || c.pressed.P1_U) && scene.player.onGround) {
    scene.player.vy = JUMP_VELOCITY;
    scene.player.onGround = false;
  }
  c.pressed.P1_1 = false;
  c.pressed.P1_U = false;

  // Mine — one hit per press. Direction from joystick, fallback to facing.
  if (c.pressed.P1_2) {
    c.pressed.P1_2 = false;
    let dx = 0, dy = 0;
    if (c.held.P1_D)      dy = 1;
    else if (c.held.P1_U) dy = -1;
    else if (c.held.P1_L) dx = -1;
    else if (c.held.P1_R) dx = 1;
    else                  dx = scene.facing;
    tryMine(scene, dx, dy);
  }
}

// Multi-step mining: priority list of candidate tiles based on direction.
// Down/up give 2 (left/right footprint), sideways gives 3 (mid → top → bot)
// so a single press carves a walkable opening.
function getMineTargets(scene, dx, dy, out) {
  const p = scene.player;
  // Center-based footprint: stable regardless of sub-tile p.x/p.y.
  const ptxL = Math.round(p.x / TILE) - 1;
  const ptxR = ptxL + 1;
  const ptyM = ((p.y - p.h / 2) / TILE) | 0;
  const ptyT = ptyM - 1;
  const ptyB = ptyM + 1;
  let n = 0;

  if (dy > 0) {
    if (scene.facing < 0) {
      out[n++] = ptxL; out[n++] = ptyB + 1;
      out[n++] = ptxR; out[n++] = ptyB + 1;
    } else {
      out[n++] = ptxR; out[n++] = ptyB + 1;
      out[n++] = ptxL; out[n++] = ptyB + 1;
    }
  } else if (dy < 0) {
    if (scene.facing < 0) {
      out[n++] = ptxL; out[n++] = ptyT - 1;
      out[n++] = ptxR; out[n++] = ptyT - 1;
    } else {
      out[n++] = ptxR; out[n++] = ptyT - 1;
      out[n++] = ptxL; out[n++] = ptyT - 1;
    }
  } else {
    const col = dx < 0 ? ptxL - 1 : ptxR + 1;
    out[n++] = col; out[n++] = ptyM;
    out[n++] = col; out[n++] = ptyT;
    out[n++] = col; out[n++] = ptyB;
  }
  return n;
}

function tryMine(scene, dx, dy) {
  if (!scene._mineBuf) scene._mineBuf = new Int32Array(8);
  const buf = scene._mineBuf;
  const w = scene.world;
  const damage = scene.damage;
  const n = getMineTargets(scene, dx, dy, buf);

  for (let i = 0; i < n; i += 2) {
    const tx = buf[i];
    const ty = buf[i + 1];
    if (tx < 1 || tx >= WORLD_W - 1 || ty < 1 || ty >= WORLD_H - 1) continue;
    const idx = ty * WORLD_W + tx;
    const t = w[idx] & TYPE_MASK;
    if (BLOCK_CAT[t] === CAT_LIQUID) continue; // skip liquids, try next solid
    const hard = BLOCK_HARDNESS[t];
    if (hard === 0) continue; // AIR or unbreakable (MAGIC)

    // Trigger swing animation regardless (player gets feedback).
    scene.mineAnim = 14;
    scene.mineDx = dx;
    scene.mineDy = dy;

    damage[idx]++;
    if (damage[idx] >= hard) {
      w[idx] = AIR;
      damage[idx] = 0;
      scene.dirtyMineral = true; // re-evaluate stability
    }
    return true;
  }
  return false;
}

function movePlayer(scene) {
  const p = scene.player;
  p.vy += GRAVITY;
  if (p.vy > TERMINAL_VY) p.vy = TERMINAL_VY;
  if (p.vy < -8) p.vy = -8;

  // If the player is submerged in a liquid, cap downward speed to that
  // liquid's own fall speed (TILE / fallTicks). Water (fallTicks=10) →
  // 1 px/tick; lava (60) → ~0.17 px/tick. Upward motion (jump) is not
  // capped — players can still kick out.
  const liqFall = playerLiquidFallTicks(scene);
  if (liqFall > 0 && p.vy > 0) {
    const cap = TILE / liqFall;
    if (p.vy > cap) p.vy = cap;
  }

  // Sub-step to avoid tunneling through thin tiles.
  const steps = Math.max(1, (Math.max(Math.abs(p.vx), Math.abs(p.vy)) / 2) | 0) + 1;
  const sx = p.vx / steps;
  const sy = p.vy / steps;

  for (let s = 0; s < steps; s++) {
    p.x += sx;
    if (collidesPlayer(scene, p)) { p.x -= sx; p.vx = 0; }
    p.y += sy;
    if (collidesPlayer(scene, p)) {
      p.y -= sy;
      if (sy > 0) {
        p.onGround = true;
        // Snap to tile boundary so AABB never carries a sub-tile fraction
        // (otherwise it can occupy a 4th row and refuse to fit through
        // side-mined channels).
        p.y = Math.ceil(p.y / TILE) * TILE;
      }
      p.vy = 0;
    } else if (sy > 0) {
      p.onGround = false;
    }
  }

  // Cave-in protection: if a tile spawned on top of player, shove up.
  let safety = 0;
  while (collidesPlayer(scene, p) && safety < 24) {
    p.y -= 1; p.vy = 0; safety++;
  }

  // Refresh ground status by probing 1 px below.
  p.y += 1;
  p.onGround = collidesPlayer(scene, p);
  p.y -= 1;
}

function collidesPlayer(scene, p) {
  const w = scene.world;
  const halfW = p.w / 2;
  const x0 = ((p.x - halfW) / TILE) | 0;
  const x1 = ((p.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((p.y - p.h) / TILE) | 0;
  const y1 = ((p.y - 0.001) / TILE) | 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) return true;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) return true;
      if (isSolidCell(w[y * WORLD_W + x])) return true;
    }
  }
  return false;
}

function isSolidCell(cell) {
  const cat = BLOCK_CAT[cell & TYPE_MASK];
  return cat !== CAT_AIR && cat !== CAT_LIQUID;
}

// Returns the slowest (max) fallTicks of any liquid tile overlapping the
// player AABB, or 0 if the player isn't in any liquid. Used to cap the
// player's fall speed inside water (fast) vs. lava (slow).
function playerLiquidFallTicks(scene) {
  const w = scene.world;
  const p = scene.player;
  const halfW = p.w / 2;
  const x0 = ((p.x - halfW) / TILE) | 0;
  const x1 = ((p.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((p.y - p.h) / TILE) | 0;
  const y1 = ((p.y - 0.001) / TILE) | 0;
  let maxFall = 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) continue;
      const t = w[y * WORLD_W + x] & TYPE_MASK;
      if (BLOCK_CAT[t] === CAT_LIQUID) {
        const ft = BLOCK_FALL_TICKS[t];
        if (ft > maxFall) maxFall = ft;
      }
    }
  }
  return maxFall;
}

// ============================================================
// 9. Camera
// ============================================================

function updateCamera(scene) {
  const targetX = scene.player.x - GAME_WIDTH / 2;
  const targetY = scene.player.y - GAME_HEIGHT / 2;
  scene.cam.x = clamp(targetX, 0, WORLD_W * TILE - GAME_WIDTH);
  scene.cam.y = clamp(targetY, 0, WORLD_H * TILE - GAME_HEIGHT);
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

// ============================================================
// 10. Rendering — world texture + per-tile damage tint
// ============================================================

function render(scene) {
  const w = scene.world;
  const damage = scene.damage;
  const px = scene.pixels;
  const TW = VW + 2;
  const TH = VH + 2;
  const camTx = ((scene.cam.x / TILE) | 0) - 1;
  const camTy = ((scene.cam.y / TILE) | 0) - 1;

  for (let vy = 0; vy < TH; vy++) {
    const wy = camTy + vy;
    const baseV = vy * TW;
    if (wy < 0 || wy >= WORLD_H) {
      for (let vx = 0; vx < TW; vx++) px[baseV + vx] = BLOCK_COLOR[AIR];
      continue;
    }
    const rowW = wy * WORLD_W;
    for (let vx = 0; vx < TW; vx++) {
      const wx = camTx + vx;
      if (wx < 0 || wx >= WORLD_W) {
        px[baseV + vx] = BLOCK_COLOR[AIR];
        continue;
      }
      const idx = rowW + wx;
      const t = w[idx] & TYPE_MASK;
      let color = BLOCK_COLOR[t];

      // Grass tint: surface dirt (dirt with air directly above).
      if (t === DIRT && wy > 0 && (w[idx - WORLD_W] & TYPE_MASK) === AIR) {
        color = GRASS_COLOR;
      }

      // Damage tint: darken proportional to damage/hardness.
      const dmg = damage[idx];
      if (dmg > 0) {
        const hard = BLOCK_HARDNESS[t];
        if (hard > 0) {
          const factor = 1 - 0.45 * dmg / hard;
          const b = (((color >>> 16) & 0xff) * factor) | 0;
          const g = (((color >>> 8) & 0xff) * factor) | 0;
          const r = ((color & 0xff) * factor) | 0;
          color = (color & 0xff000000) | (b << 16) | (g << 8) | r;
        }
      }

      px[baseV + vx] = color;
    }
  }

  scene.texCtx.putImageData(scene.imgData, 0, 0);
  scene.tex.refresh();

  // Sub-tile camera offset so the tile grid lines up with the player's
  // continuous position.
  scene.worldImg.setPosition(
    camTx * TILE - scene.cam.x,
    camTy * TILE - scene.cam.y,
  );
}

// ----- Player visual (container of sub-rectangles, animated procedurally)

function buildPlayerVisual(scene) {
  const c = scene.add.container(0, 0).setDepth(10);
  const parts = {};
  // Local coords: container origin is at the player's bottom-center.
  // y=0 is the feet line; negative y goes up.
  const skin = 0x6f7a44, shirt = 0xc23a2a, pants = 0x2a3148,
        helmet = 0xf2c200, eye = 0xffffff,
        pickHandleColor = 0x6b4226, pickHeadColor = 0xb0b0b0;

  parts.legL = scene.add.rectangle(-4, -3, 5, 6, pants);
  parts.legR = scene.add.rectangle(4, -3, 5, 6, pants);
  parts.body = scene.add.rectangle(0, -13, 14, 12, shirt);
  parts.head = scene.add.rectangle(0, -22, 12, 6, skin);
  parts.helmet = scene.add.rectangle(0, -25, 14, 3, helmet);
  parts.eye = scene.add.rectangle(2, -22, 2, 2, eye);
  parts.pickHandle = scene.add
    .rectangle(0, -14, 12, 2, pickHandleColor)
    .setOrigin(0, 0.5);
  parts.pickHead = scene.add.rectangle(12, -14, 4, 5, pickHeadColor);
  parts.pickHandle.visible = false;
  parts.pickHead.visible = false;

  for (const k in parts) c.add(parts[k]);
  scene.playerContainer = c;
  scene.playerParts = parts;
}

function updatePlayerVisual(scene) {
  const p = scene.player;
  const parts = scene.playerParts;
  const c = scene.playerContainer;
  c.setPosition(p.x - scene.cam.x, p.y - scene.cam.y);

  let state;
  if (scene.mineAnim > 0)                           state = 'mine';
  else if (!p.onGround && p.vy < -0.1)              state = 'jump';
  else if (!p.onGround && p.vy > 0.1)               state = 'fall';
  else if (Math.abs(p.vx) > 0.05)                   state = 'walk';
  else                                              state = 'idle';

  const flip = scene.facing < 0 ? -1 : 1;

  // Reset to base pose every frame.
  parts.legL.x = -4; parts.legL.y = -3; parts.legL.scaleY = 1;
  parts.legR.x = 4;  parts.legR.y = -3; parts.legR.scaleY = 1;
  parts.body.y = -13; parts.body.scaleY = 1;
  parts.head.y = -22;
  parts.helmet.y = -25;
  parts.eye.x = flip * 2;
  parts.eye.y = -22;

  if (state === 'walk') {
    scene.walkPhase += 0.32;
    const s = Math.sin(scene.walkPhase);
    parts.legL.scaleY = 1 - Math.max(0, s) * 0.3;
    parts.legR.scaleY = 1 - Math.max(0, -s) * 0.3;
    const bob = Math.abs(s) * 0.7;
    parts.body.y = -13 - bob;
    parts.head.y = -22 - bob;
    parts.helmet.y = -25 - bob;
    parts.eye.y = -22 - bob;
  } else if (state === 'jump') {
    parts.body.scaleY = 1.08;
    parts.body.y = -14;
    parts.legL.x = -2; parts.legR.x = 2;
    parts.legL.y = -1; parts.legR.y = -1;
    parts.legL.scaleY = 0.7; parts.legR.scaleY = 0.7;
  } else if (state === 'fall') {
    parts.legL.x = -5; parts.legR.x = 5;
    parts.body.scaleY = 0.95;
    parts.body.y = -12;
  }

  // Pickaxe swing for mining.
  if (state === 'mine') {
    const t = (14 - scene.mineAnim) / 14;
    const swing = Math.sin(t * Math.PI);
    parts.pickHandle.visible = true;
    parts.pickHead.visible = true;

    if (scene.mineDy === 0) {
      parts.pickHandle.x = flip * 5;
      parts.pickHandle.y = -14;
      parts.pickHandle.scaleX = flip;
      const a = -60 + swing * 120;
      parts.pickHandle.angle = a;
      const rad = a * Math.PI / 180;
      parts.pickHead.x = flip * (5 + Math.cos(rad) * 12);
      parts.pickHead.y = -14 + Math.sin(rad) * 12;
    } else if (scene.mineDy > 0) {
      parts.pickHandle.x = flip * 3;
      parts.pickHandle.y = -10;
      parts.pickHandle.scaleX = flip;
      const a = -30 + swing * 110;
      parts.pickHandle.angle = a;
      const rad = a * Math.PI / 180;
      parts.pickHead.x = flip * (3 + Math.cos(rad) * 12);
      parts.pickHead.y = -10 + Math.sin(rad) * 12;
    } else {
      parts.pickHandle.x = flip * 3;
      parts.pickHandle.y = -19;
      parts.pickHandle.scaleX = flip;
      const a = 30 - swing * 110;
      parts.pickHandle.angle = a;
      const rad = a * Math.PI / 180;
      parts.pickHead.x = flip * (3 + Math.cos(rad) * 12);
      parts.pickHead.y = -19 + Math.sin(rad) * 12;
    }
    scene.mineAnim--;
  } else {
    parts.pickHandle.visible = false;
    parts.pickHead.visible = false;
  }
}

// ============================================================
// 11. Controls scaffolding (preserved verbatim)
// ============================================================

function createControls(scene) {
  scene.controls = {
    held: Object.create(null),
    pressed: Object.create(null),
  };

  const onKeyDown = (event) => {
    const key = normalizeIncomingKey(event.key);
    if (!key) return;
    const arcadeCode = KEYBOARD_TO_ARCADE[key];
    if (!arcadeCode) return;
    if (!scene.controls.held[arcadeCode]) {
      scene.controls.pressed[arcadeCode] = true;
    }
    scene.controls.held[arcadeCode] = true;
  };

  const onKeyUp = (event) => {
    const key = normalizeIncomingKey(event.key);
    if (!key) return;
    const arcadeCode = KEYBOARD_TO_ARCADE[key];
    if (!arcadeCode) return;
    scene.controls.held[arcadeCode] = false;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  scene.events.once('shutdown', () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  });
}

function normalizeIncomingKey(key) {
  if (typeof key !== 'string' || key.length === 0) return '';
  if (key === ' ') return 'space';
  return key.toLowerCase();
}

// ============================================================
// 12. Storage scaffolding (preserved; not used yet)
// ============================================================

function getStorage() {
  if (window.platanusArcadeStorage) return window.platanusArcadeStorage;
  return {
    async get(key) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null
          ? { found: false, value: null }
          : { found: true, value: JSON.parse(raw) };
      } catch {
        return { found: false, value: null };
      }
    },
    async set(key, value) {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
  };
}

async function storageGet(key) { return getStorage().get(key); }
async function storageSet(key, value) { return getStorage().set(key, value); }
