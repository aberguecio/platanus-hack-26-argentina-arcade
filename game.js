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
// Decor category: pass-through (isSolidCell returns false), never falls,
// never mineable (hardness 0). Used for leaves, clouds, any ornament.
const CAT_DECOR = 6;

// Type ids — keep stable so a saved world (future feature) doesn't drift.
const AIR = 0, DIRT = 1, SAND = 2, WATER = 3, STONE = 4,
      GRAVEL = 5, LAVA = 6, COPPER = 7, IRON = 8, BORDER = 9,
      WOOD = 10, COPPER_INGOT = 11, IRON_INGOT = 12,
      FURNACE = 13, IRON_DOOR = 14,
      LEAVES = 15, CLOUD = 16;

// Colors are packed little-endian 0xAABBGGRR for direct Uint32 writes
// into the canvas ImageData buffer.
//
// Hardness and TIER_DAMAGE share a single damage-units scale:
//   fist = 2, wood pick = 10, stone pick = 20, copper pick = 30.
// So hardness=10 means "1 wood-pick hit"; hardness=4 means "0.4 wood-pick
// hits" (fists break it in 2 hits). Everything lives in Uint8Array.
const BLOCKS = [
  // id, name, cat, color, fallTicks, hardness (damage units)
  { id: AIR,    name: 'air',    cat: CAT_AIR,      color: 0xff0a0d18, fallTicks: 0,  hardness: 0  },
  { id: DIRT,   name: 'dirt',   cat: CAT_SOLID,    color: 0xff2c4f7a, fallTicks: 20, hardness: 10 },
  { id: SAND,   name: 'sand',   cat: CAT_SANDLIKE, color: 0xff5cd4e8, fallTicks: 15, hardness: 10 },
  { id: WATER,  name: 'water',  cat: CAT_LIQUID,   color: 0xffd88030, fallTicks: 6, hardness: 10 },
  { id: STONE,  name: 'stone',  cat: CAT_MINERAL,  color: 0xff4a4a4a, fallTicks: 20, hardness: 20 },
  { id: GRAVEL, name: 'gravel', cat: CAT_SANDLIKE, color: 0xff6e7e95, fallTicks: 15, hardness: 20 },
  { id: LAVA,   name: 'lava',   cat: CAT_LIQUID,   color: 0xff1840f0, fallTicks: 40, hardness: 50 },
  { id: COPPER, name: 'copper', cat: CAT_MINERAL,  color: 0xff2a8acc, fallTicks: 20, hardness: 40 },
  { id: IRON,   name: 'iron',   cat: CAT_MINERAL,  color: 0xff8090a0, fallTicks: 20, hardness: 60 },
  { id: BORDER, name: 'border', cat: CAT_MAGIC,    color: 0xff1a1a1a, fallTicks: 0,  hardness: 0  },
  { id: WOOD,         name: 'wood',         cat: CAT_SOLID,   color: 0xff1d3a6e, fallTicks: 20, hardness: 4 },
  // Inventory-only items (never appear in the world): ingots.
  { id: COPPER_INGOT, name: 'copper ingot', cat: CAT_AIR,     color: 0xff2a8ad8, fallTicks: 0,  hardness: 0 },
  { id: IRON_INGOT,   name: 'iron ingot',   cat: CAT_AIR,     color: 0xffc8d4de, fallTicks: 0,  hardness: 0 },
  // Placeable structures (magic, unbreakable in v3).
  { id: FURNACE,      name: 'furnace',      cat: CAT_MAGIC,   color: 0xff3a3a40, fallTicks: 0,  hardness: 0 },
  { id: IRON_DOOR,    name: 'iron door',    cat: CAT_MAGIC,   color: 0xffa0a8b4, fallTicks: 0,  hardness: 0 },
  // Decor — cosmetic only, pass-through, not mineable.
  { id: LEAVES,       name: 'leaves',       cat: CAT_DECOR,   color: 0xff4aa040, fallTicks: 0,  hardness: 0 },
  { id: CLOUD,        name: 'cloud',        cat: CAT_DECOR,   color: 0xffe8eef0, fallTicks: 0,  hardness: 0 },
];

// Flat lookup tables for the hot path. 64-slot capacity (TYPE_MASK + 1).
const BLOCK_CAT = new Uint8Array(64);
const BLOCK_COLOR = new Uint32Array(64);
const BLOCK_FALL_TICKS = new Uint8Array(64);
const BLOCK_HARDNESS = new Uint8Array(64);
const BLOCK_NAME = new Array(64);
for (const b of BLOCKS) {
  BLOCK_CAT[b.id] = b.cat;
  BLOCK_COLOR[b.id] = b.color;
  BLOCK_FALL_TICKS[b.id] = b.fallTicks;
  BLOCK_HARDNESS[b.id] = b.hardness;
  BLOCK_NAME[b.id] = b.name;
}

// ----- Tools: tier-based damage shared between picks and swords. -----
// Damage scale is × 10 so fist's 0.2 dmg keeps integer resolution. The
// player auto-uses their pick during the day and their sword at night
// (see getActiveTier). Pick and sword tiers are tracked separately so
// you can craft both independently.
const TIER_FIST = 0, TIER_WOOD = 1, TIER_STONE = 2, TIER_COPPER = 3, TIER_IRON = 4;
const TIER_DAMAGE      = [2, 10, 20, 30, 40];
const TIER_PICK_NAMES  = ['FISTS', 'WOODEN PICKAXE', 'STONE PICKAXE', 'COPPER PICKAXE', 'IRON PICKAXE'];
const TIER_SWORD_NAMES = ['FISTS', 'WOODEN SWORD',   'STONE SWORD',   'COPPER SWORD',   'IRON SWORD'];

// ----- Build recipes — split into two tabs in the menu. -----
// Tools are one-shot per tier slot (locked once crafted OR once a higher
// tier in the same slot is reached). Buildings can be crafted repeatedly.
const TOOL_RECIPES = [
  { name: 'WOODEN PICKAXE', cost: [[WOOD, 10]],          pickTier:  TIER_WOOD   },
  { name: 'STONE PICKAXE',  cost: [[STONE, 100]],        pickTier:  TIER_STONE  },
  { name: 'COPPER PICKAXE', cost: [[COPPER_INGOT, 100]], pickTier:  TIER_COPPER },
  { name: 'IRON PICKAXE',   cost: [[IRON_INGOT, 100]],   pickTier:  TIER_IRON   },
  { name: 'WOODEN SWORD',   cost: [[WOOD, 10]],          swordTier: TIER_WOOD   },
  { name: 'STONE SWORD',    cost: [[STONE, 100]],        swordTier: TIER_STONE  },
  { name: 'COPPER SWORD',   cost: [[COPPER_INGOT, 100]], swordTier: TIER_COPPER },
  { name: 'IRON SWORD',     cost: [[IRON_INGOT, 100]],   swordTier: TIER_IRON   },
];
const BUILDING_RECIPES = [
  { name: 'FURNACE',     cost: [[STONE, 50]],             place: 'furnace'    },
  { name: 'DIRT HOUSE',  cost: [[DIRT, 100], [WOOD, 10]], place: 'dirtHouse'  },
  { name: 'STONE HOUSE', cost: [[STONE, 1000]],           place: 'stoneHouse' },
  { name: 'IRON DOOR',   cost: [[IRON_INGOT, 10]],        place: 'ironDoor'   },
];

// ----- Furnace tuning -----
const TRANSFER_INTERVAL_TICKS = 8; // 1 unit every ~130ms at 60 TPS
const SMELT_TIME_TICKS = 60;       // 1 second per ingot
const FUEL_PER_SMELT = 1;          // 1 wood per ingot
const FURNACE_MAX_FUEL = 16;

// ----- Day/night tuning -----
const DAY_LENGTH_TICKS = 10 * 60 * TICK_RATE; // 10 minutes
const NIGHT_LENGTH_TICKS = 3 * 60 * TICK_RATE; // 3 minutes of monster-fighting

// ----- Player health -----
const PLAYER_MAX_HP = 10;
const DROWN_TICKS = 60;             // 1 dmg per 60 ticks fully submerged in water
const LAVA_TICKS = 30;              // 1 dmg per 30 ticks touching lava
const FALL_DAMAGE_PX = 15 * TILE;   // 1 dmg per 15 tiles of fall. Water cancels.
const PLAYER_FLASH_TICKS = 24;      // blink duration after any damage source
const PLAYER_INVULN_TICKS = 30;     // grace period from monster contact

// ----- Monsters -----
const MON_SLIME = 0, MON_ZOMBIE = 1, MON_FLYER = 2;
const MONSTER_SPAWN_INTERVAL = 90;  // attempt a spawn every 1.5s
const MONSTER_MAX = 10;

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

  // Inventory / tools / crafting state.
  scene.inventory = new Uint16Array(64);
  scene.discovered = new Uint8Array(64);
  scene.pick = TIER_FIST;
  scene.sword = TIER_FIST;
  scene.invDirty = true;
  scene.furnaces = [];
  scene.buildMenu = { open: false, cursor: 0, recipes: [], prevOnSurface: false };

  // Day/night + home. Home defaults to spawn; updated when a house is built.
  scene.dayTime = 0;
  scene.nightActive = false;
  scene.nightTicksRemaining = 0;
  scene.home = { x: scene.player.x, y: scene.player.y };
  scene.daysSurvived = 1;

  // Health + hazard counters (attached to player for clean grouping).
  scene.player.hp = PLAYER_MAX_HP;
  scene.player.maxHp = PLAYER_MAX_HP;
  scene.player.submergedTicks = 0;
  scene.player.lavaTicks = 0;
  scene.player.peakY = scene.player.y;
  scene.player.flashTicks = 0;
  scene.player.invulnTicks = 0;
  scene.gameOver = false;

  // Monsters (only present during night).
  scene.monsters = [];
  scene.monsterSpawnTimer = MONSTER_SPAWN_INTERVAL;

  buildHud(scene);

  // Tiny debug HUD in the top-right corner.
  scene.hud = scene.add
    .text(GAME_WIDTH - 8, 6, '', {
      fontFamily: 'monospace', fontSize: '10px', color: '#888888',
    })
    .setOrigin(1, 0)
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

  placeClouds(w, rnd);
  placeTrees(w, rnd);
}

function placeTrees(w, rnd) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const tx = 10 + ((rnd() * (WORLD_W - 20)) | 0);
    const surfY = findSurface(w, tx);
    if (surfY < 30 || surfY >= WORLD_H - 1) continue;
    if ((w[surfY * WORLD_W + tx] & TYPE_MASK) !== DIRT) continue;
    // Require air above so we don't plant inside a cavern ceiling.
    if (surfY < 4) continue;
    if ((w[(surfY - 1) * WORLD_W + tx] & TYPE_MASK) !== AIR) continue;
    const height = 4 + ((rnd() * 3) | 0); // 4..6
    let topY = surfY - height;
    for (let h = 1; h <= height; h++) {
      const y = surfY - h;
      if (y < 1) { topY = y + 1; break; }
      const idx = y * WORLD_W + tx;
      if ((w[idx] & TYPE_MASK) !== AIR) { topY = y + 1; break; }
      w[idx] = WOOD;
    }
    // Canopy of LEAVES: 5-wide rounded blob at the top of the trunk.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) === 2 && dy !== 0) continue; // round corners
        const cx = tx + dx;
        const cy = topY + dy;
        if (cx < 1 || cx >= WORLD_W - 1 || cy < 1) continue;
        const idx = cy * WORLD_W + cx;
        if ((w[idx] & TYPE_MASK) === AIR) w[idx] = LEAVES;
      }
    }
  }
}

function placeClouds(w, rnd) {
  for (let i = 0; i < 15; i++) {
    const cx = 4 + ((rnd() * (WORLD_W - 8)) | 0);
    const cy = 8 + ((rnd() * 35) | 0);      // upper sky band
    const rx = 3 + ((rnd() * 5) | 0);
    const ry = 1 + ((rnd() * 2) | 0);
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (x < 1 || x >= WORLD_W - 1 || y < 1 || y >= WORLD_H - 1) continue;
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        if (nx * nx + ny * ny <= 1) {
          const idx = y * WORLD_W + x;
          if ((w[idx] & TYPE_MASK) === AIR) w[idx] = CLOUD;
        }
      }
    }
  }
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
  // Skip AIR and CAT_DECOR (clouds, leaves) — they're pass-through, so the
  // "surface" is the first truly solid block beneath them. Without this the
  // player would spawn on a cloud at y=80 and take fall damage on game start.
  for (let y = 1; y < WORLD_H - 1; y++) {
    const t = w[y * WORLD_W + tx] & TYPE_MASK;
    const cat = BLOCK_CAT[t];
    if (cat !== CAT_AIR && cat !== CAT_DECOR) return y;
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
  renderMonsters(scene);
  if (scene.invDirty) {
    refreshInventoryHud(scene);
    scene.invDirty = false;
  }
  refreshDayTimer(scene);
  refreshHpHud(scene);
  scene.toolText.setText('TOOL: ' + getActiveToolName(scene));

  scene.hud.setText(
    `x ${scene.player.x | 0}  y ${scene.player.y | 0}  ` +
    `tick ${scene.tickCount}  fps ${(1000 / Math.max(delta, 1)) | 0}`,
  );
}

function runTick(scene) {
  handleInput(scene);
  // Build menu pauses gameplay entirely.
  if (scene.buildMenu.open) return;

  // Death freezes everything — waits on the restart modal.
  if (scene.gameOver) return;

  // Tick the player's invuln/flash counters every tick (so they expire
  // even if no fresh damage arrives this tick).
  if (scene.player.flashTicks > 0) scene.player.flashTicks--;

  movePlayer(scene);
  updatePlayerHazards(scene);

  // Night-only systems: monsters spawn, walk/jump/fly, and damage on touch.
  if (scene.nightActive) {
    spawnMonstersTick(scene);
    tickMonsters(scene);
    checkMonsterDamage(scene);
  }

  simulateViewport(scene);
  if (scene.dirtyMineral) {
    resolveMineralStability(scene);
    scene.dirtyMineral = false;
  }
  tickFurnaces(scene);
  updateCamera(scene);

  if (scene.nightActive) {
    scene.nightTicksRemaining--;
    if (scene.nightTicksRemaining <= 0) endNight(scene);
  } else {
    scene.dayTime++;
    if (scene.dayTime >= DAY_LENGTH_TICKS) goHome(scene);
  }
}

function endNight(scene) {
  scene.nightActive = false;
  scene.dayTime = 0;
  scene.nightOverlay.setVisible(false);
  scene.daysSurvived++;
  scene.player.hp = scene.player.maxHp;
  despawnAllMonsters(scene);
  showToast(scene, 'DAY BREAKS!');
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

  // Death modal: U restarts, everything else absorbed.
  if (scene.gameOver) {
    if (c.pressed.P1_1) {
      c.pressed.P1_1 = false;
      scene.scene.restart();
      return;
    }
    c.pressed.P1_2 = false; c.pressed.P1_3 = false; c.pressed.P1_U = false;
    return;
  }

  // Build menu absorbs all input while open — gameplay pauses via runTick.
  if (scene.buildMenu.open) {
    handleBuildMenuInput(scene);
    return;
  }

  // P1_2 (I) toggles the build menu — any position.
  if (c.pressed.P1_2) {
    c.pressed.P1_2 = false;
    openBuildMenu(scene);
    scene.player.vx = 0;
    return;
  }

  // P1_3 (O) teleports player home and starts night.
  if (c.pressed.P1_3) {
    c.pressed.P1_3 = false;
    goHome(scene);
    return;
  }

  let vx = 0;
  if (c.held.P1_L) vx -= 1;
  if (c.held.P1_R) vx += 1;
  scene.player.vx = vx * MOVE_SPEED;
  if (vx !== 0) scene.facing = vx;

  // Jump — joystick UP only (P1_U / W). Ground-jump OR swim-stroke: when
  // in any liquid you can kick upward repeatedly to simulate swimming.
  if (c.pressed.P1_U) {
    if (scene.player.onGround || playerLiquidStatus(scene).inAnyLiquid) {
      scene.player.vy = JUMP_VELOCITY;
      scene.player.onGround = false;
    }
  }
  c.pressed.P1_U = false;

  // U (P1_1) — one press per action. Day: mine a tile (direction from
  // joystick, fallback to facing). Night: swing the sword at any monster
  // in front of the player. No mining at night by design.
  if (c.pressed.P1_1) {
    c.pressed.P1_1 = false;
    if (scene.nightActive) {
      tryAttack(scene);
    } else {
      let dx = 0, dy = 0;
      if (c.held.P1_D)      dy = 1;
      else if (c.held.P1_U) dy = -1;
      else if (c.held.P1_L) dx = -1;
      else if (c.held.P1_R) dx = 1;
      else                  dx = scene.facing;
      tryMine(scene, dx, dy);
    }
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

// Active tool selection: pick during day, sword at night. Both tracked
// independently so the player can craft them in whatever order.
function getActiveTier(scene) {
  return scene.nightActive ? scene.sword : scene.pick;
}
function getActiveToolName(scene) {
  return scene.nightActive
    ? TIER_SWORD_NAMES[scene.sword]
    : TIER_PICK_NAMES[scene.pick];
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

    // Hardness is in damage units (same scale as TIER_DAMAGE). Day → use
    // the player's pick; night → use their sword (auto-selected).
    damage[idx] = Math.min(255, damage[idx] + TIER_DAMAGE[getActiveTier(scene)]);
    if (damage[idx] >= hard) {
      w[idx] = AIR;
      damage[idx] = 0;
      scene.dirtyMineral = true;
      // Drop into inventory + discovery toast.
      scene.inventory[t]++;
      if (!scene.discovered[t]) {
        scene.discovered[t] = 1;
        showToast(scene, BLOCK_NAME[t].toUpperCase() + '!');
      }
      scene.invDirty = true;
    }
    return true;
  }
  return false;
}

// Night-only sword swing: hits monsters overlapping a hitbox in the
// direction the player is facing. Damage = sword tier damage (fists if
// no sword crafted). Iterates backwards so splicing during the loop is
// safe when a monster dies.
function tryAttack(scene) {
  const p = scene.player;
  const dmg = TIER_DAMAGE[scene.sword];
  scene.mineAnim = 14;
  scene.mineDx = scene.facing;
  scene.mineDy = 0;

  const reach = 14;
  const hxNear = p.x + scene.facing * (p.w / 2);
  const hxFar  = p.x + scene.facing * (p.w / 2 + reach);
  const hxMin = Math.min(hxNear, hxFar);
  const hxMax = Math.max(hxNear, hxFar);
  const hyMax = p.y + 2;
  const hyMin = p.y - p.h - 2;

  for (let i = scene.monsters.length - 1; i >= 0; i--) {
    const m = scene.monsters[i];
    const mx0 = m.x - m.w / 2, mx1 = m.x + m.w / 2;
    const my0 = m.y - m.h, my1 = m.y;
    if (mx0 < hxMax && mx1 > hxMin && my0 < hyMax && my1 > hyMin) {
      applyMonsterDamage(scene, m, dmg);
    }
  }
}

function movePlayer(scene) {
  const p = scene.player;
  const wasOnGround = p.onGround;
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

  // Fall-damage tracking: peakY is the minimum y (highest point) since the
  // player last left the ground. On landing, compute the drop and apply
  // damage unless water cushioned the fall.
  if (!p.onGround) {
    if (wasOnGround) p.peakY = p.y;        // just left ground → reset peak
    else if (p.y < p.peakY) p.peakY = p.y; // still rising
  } else if (!wasOnGround) {
    const fallPx = p.y - p.peakY;
    if (fallPx > FALL_DAMAGE_PX) {
      const st = playerLiquidStatus(scene);
      if (!st.touchingWater) {
        const dmg = (fallPx / FALL_DAMAGE_PX) | 0;
        applyPlayerDamage(scene, dmg);
      }
    }
    p.peakY = p.y;
  }
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
  const t = cell & TYPE_MASK;
  if (t === IRON_DOOR) return false; // player walks through their door
  const cat = BLOCK_CAT[t];
  return cat !== CAT_AIR && cat !== CAT_LIQUID && cat !== CAT_DECOR;
}

function playerOnSurface(scene) {
  // True when the player is near the top of the world (above the stone band).
  return scene.player.y < 90 * TILE;
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

// Richer status used by hazard logic + swim-jump + fall-damage cancel.
function playerLiquidStatus(scene) {
  const w = scene.world;
  const p = scene.player;
  const halfW = p.w / 2;
  const x0 = ((p.x - halfW) / TILE) | 0;
  const x1 = ((p.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((p.y - p.h) / TILE) | 0;
  const y1 = ((p.y - 0.001) / TILE) | 0;
  let waterCells = 0, lavaCells = 0, totalCells = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      totalCells++;
      if (y < 0 || y >= WORLD_H || x < 0 || x >= WORLD_W) continue;
      const t = w[y * WORLD_W + x] & TYPE_MASK;
      if (t === WATER) waterCells++;
      else if (t === LAVA) lavaCells++;
    }
  }
  return {
    fullyInWater: waterCells > 0 && waterCells === totalCells,
    touchingWater: waterCells > 0,
    touchingLava: lavaCells > 0,
    inAnyLiquid: (waterCells + lavaCells) > 0,
  };
}

function updatePlayerHazards(scene) {
  if (scene.gameOver) return;
  const p = scene.player;
  const st = playerLiquidStatus(scene);

  if (st.fullyInWater) {
    p.submergedTicks++;
    if (p.submergedTicks >= DROWN_TICKS) {
      p.submergedTicks = 0;
      applyPlayerDamage(scene, 1);
    }
  } else {
    p.submergedTicks = 0;
  }

  if (st.touchingLava) {
    p.lavaTicks++;
    if (p.lavaTicks >= LAVA_TICKS) {
      p.lavaTicks = 0;
      applyPlayerDamage(scene, 1);
    }
  } else {
    p.lavaTicks = 0;
  }
}

function applyPlayerDamage(scene, amt) {
  if (scene.gameOver || amt <= 0) return;
  const p = scene.player;
  p.hp -= amt;
  // Visual feedback for ANY damage (drown, lava, fall, monster touch).
  p.flashTicks = PLAYER_FLASH_TICKS;
  if (p.hp <= 0) {
    p.hp = 0;
    onPlayerDeath(scene);
  }
}

function onPlayerDeath(scene) {
  if (scene.gameOver) return;
  scene.gameOver = true;
  scene.deathModal.statsText.setText(
    'DAY ' + scene.daysSurvived + '\n' +
    'PICK: ' + TIER_PICK_NAMES[scene.pick] + '\n' +
    'SWORD: ' + TIER_SWORD_NAMES[scene.sword] + '\n' +
    'FURNACES BUILT: ' + scene.furnaces.length,
  );
  scene.deathModal.container.setVisible(true);
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
  // Paint the sky by overriding AIR's color each frame. The day/night cycle
  // blends amber sunrise → sky blue → sunset orange; the night overlay on
  // top darkens everything further when `nightActive`.
  BLOCK_COLOR[AIR] = getSkyColor(scene);

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

      // Damage tint: darken proportional to damage / hardness (both in
      // damage units).
      const dmg = damage[idx];
      if (dmg > 0) {
        const hard = BLOCK_HARDNESS[t];
        if (hard > 0) {
          let factor = 1 - 0.45 * dmg / hard;
          if (factor < 0) factor = 0;
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

// Base Y positions for upper-body parts. Lifted out of updatePlayerVisual
// so the hot path doesn't allocate a fresh object each frame.
const PLAYER_BASE_Y = {
  body: -13, belt: -8, beltBuckle: -8,
  head: -20, hair: -28,
  eye: -22,
  mustache: -17,
  beardMid: -14, beardShadow: -12,
  beardLow: -10, beardTip: -7,
};

function buildPlayerVisual(scene) {
  const c = scene.add.container(0, 0).setDepth(10);
  const parts = {};
  // Plain flat layers (no outlines). Beard tones lean grey rather than
  // pure white so the dwarf reads as older/silver-bearded.
  const pants = 0x2a3148, shirt = 0xc23a2a, belt = 0x5a3015,
        buckle = 0xe6c046,
        skin = 0xe4b593,
        hair = 0xc8c8c8, beard = 0xc8c8c8, beardShadow = 0x9a9a9a,
        eye = 0x101018,
        pickHandleColor = 0x6b4226, pickHeadColor = 0xb0b0b0;

  parts.legL         = scene.add.rectangle(-4, -3, 5, 6, pants);
  parts.legR         = scene.add.rectangle( 4, -3, 5, 6, pants);
  parts.body         = scene.add.rectangle( 0, -13, 14, 12, shirt);
  parts.belt         = scene.add.rectangle( 0, -8, 14, 2, belt);
  parts.beltBuckle   = scene.add.rectangle( 0, -8, 2,  2, buckle);
  parts.head         = scene.add.rectangle( 0, -20, 14, 14, skin);
  // Hair raised; bigger, taller cap on top of the head.
  parts.hair         = scene.add.rectangle( 0, -28, 12, 4, hair);
  // Single big eye; no pupil/nose details — face is too small for that.
  parts.eye          = scene.add.rectangle( 1, -22, 4, 4, eye);
  parts.mustache     = scene.add.rectangle( 0, -17, 12, 2, beard);
  parts.beardMid     = scene.add.rectangle( 0, -14, 14, 4, beard);
  parts.beardShadow  = scene.add.rectangle( 0, -12, 12, 1, beardShadow);
  // Lower beard sweeps strongly toward facing — looks "blown" that way.
  parts.beardLow     = scene.add.rectangle( 2, -10, 10, 3, beard);
  parts.beardTip     = scene.add.rectangle( 6, -7, 7, 2, beard);

  parts.pickHandle   = scene.add
    .rectangle(0, -14, 12, 2, pickHandleColor)
    .setOrigin(0, 0.5);
  parts.pickHead     = scene.add.rectangle(12, -14, 4, 5, pickHeadColor);
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

  // Damage flash: blink the player container while flashTicks ticks down.
  c.setAlpha(p.flashTicks > 0 && (p.flashTicks & 4) ? 0.25 : 1);

  let state;
  if (scene.mineAnim > 0)                           state = 'mine';
  else if (!p.onGround && p.vy < -0.1)              state = 'jump';
  else if (!p.onGround && p.vy > 0.1)               state = 'fall';
  else if (Math.abs(p.vx) > 0.05)                   state = 'walk';
  else                                              state = 'idle';

  const flip = scene.facing < 0 ? -1 : 1;

  // Reset legs (lower body lives at fixed y regardless of animation pose).
  parts.legL.x = -4; parts.legL.y = -3; parts.legL.scaleY = 1;
  parts.legR.x = 4;  parts.legR.y = -3; parts.legR.scaleY = 1;
  parts.body.scaleY = 1;

  // Big single eye drifts toward facing. Beard sweeps strongly the way
  // the dwarf is looking.
  parts.eye.x        = flip * 3;
  parts.mustache.x   = flip * 2;
  parts.beardMid.x   = flip * 2;
  parts.beardLow.x   = flip * 3;
  parts.beardTip.x   = flip * 7;
  parts.beltBuckle.x = flip * 4;

  let bob = 0;

  if (state === 'walk') {
    scene.walkPhase += 0.32;
    const s = Math.sin(scene.walkPhase);
    parts.legL.scaleY = 1 - Math.max(0, s) * 0.3;
    parts.legR.scaleY = 1 - Math.max(0, -s) * 0.3;
    bob = -Math.abs(s) * 0.7;
  } else if (state === 'jump') {
    parts.body.scaleY = 1.08;
    parts.legL.x = -2; parts.legR.x = 2;
    parts.legL.y = -1; parts.legR.y = -1;
    parts.legL.scaleY = 0.7; parts.legR.scaleY = 0.7;
    bob = -1;
  } else if (state === 'fall') {
    parts.legL.x = -5; parts.legR.x = 5;
    parts.body.scaleY = 0.95;
    bob = 1;
  }

  // Apply a single bob offset to every upper-body part so the head, face
  // and beard move as a unit. PLAYER_BASE_Y is the per-part idle Y.
  for (const k in PLAYER_BASE_Y) parts[k].y = PLAYER_BASE_Y[k] + bob;

  // Pickaxe (day) / sword (night) swing. Same rig, different colors.
  if (state === 'mine') {
    const t = (14 - scene.mineAnim) / 14;
    const swing = Math.sin(t * Math.PI);
    parts.pickHandle.visible = true;
    parts.pickHead.visible = true;
    if (scene.nightActive) {
      // Sword: grey grip, silver blade.
      parts.pickHandle.fillColor = 0x707070;
      parts.pickHead.fillColor   = 0xe0e8f0;
    } else {
      // Pickaxe: wooden handle, grey head.
      parts.pickHandle.fillColor = 0x6b4226;
      parts.pickHead.fillColor   = 0xb0b0b0;
    }

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
// 10.5. Inventory, tools, build menu, furnace
// ============================================================

function colorToRgb(abgr) {
  const b = (abgr >>> 16) & 0xff;
  const g = (abgr >>> 8) & 0xff;
  const r = abgr & 0xff;
  return (r << 16) | (g << 8) | b;
}

// Sky color driven by day progress. 0 = amber sunrise, 0.5 = sky blue,
// 1 = sunset orange. Returned as packed 0xAABBGGRR for ImageData writes.
function getSkyColor(scene) {
  const t = scene.nightActive
    ? 1
    : Math.min(1, scene.dayTime / DAY_LENGTH_TICKS);
  // Keyframes with a long blue "plateau" in the middle so most of the
  // day is clearly sky-blue; sunrise/sunset are short bookends that ease
  // IN and OUT of the plateau via smoothstep (cubic) so the merge feels
  // gradual instead of snapping at the boundary.
  //   0.0        sunrise yellow (255, 230, 130)
  //   0.2 – 0.8  midday  blue   (185, 220, 255)
  //   1.0        sunset  orange (255, 170, 100)
  let r, g, b;
  if (t < 0.2) {
    const raw = t / 0.2;
    const k = raw * raw * (3 - 2 * raw); // smoothstep
    r = (255 + (185 - 255) * k) | 0;
    g = (230 + (220 - 230) * k) | 0;
    b = (130 + (255 - 130) * k) | 0;
  } else if (t < 0.8) {
    r = 185; g = 220; b = 255;
  } else {
    const raw = (t - 0.8) / 0.2;
    const k = raw * raw * (3 - 2 * raw); // smoothstep
    r = (185 + (255 - 185) * k) | 0;
    g = (220 + (170 - 220) * k) | 0;
    b = (255 + (100 - 255) * k) | 0;
  }
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

function buildHud(scene) {
  scene.toolText = scene.add
    .text(8, 6, 'TOOL: ' + TIER_PICK_NAMES[TIER_FIST], {
      fontFamily: 'monospace', fontSize: '12px', color: '#ffe066', fontStyle: 'bold',
    })
    .setDepth(20);

  scene.dayText = scene.add
    .text(8, 22, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#a0c8ff',
    })
    .setDepth(20);

  scene.hpText = scene.add
    .text(8, 37, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#ff6666', fontStyle: 'bold',
    })
    .setDepth(20);

  scene.invHud = { container: scene.add.container(8, 56).setDepth(20), rows: [] };

  scene.toastText = scene.add
    .text(GAME_WIDTH / 2, GAME_HEIGHT / 3, '', {
      fontFamily: 'monospace', fontSize: '48px', color: '#ffe066', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 4, align: 'center',
    })
    .setOrigin(0.5)
    .setDepth(50)
    .setAlpha(0);

  // Night overlay — translucent dark blue tint so the player can still
  // see what they're doing while it's clearly night.
  scene.nightOverlay = scene.add
    .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x051030, 0.45)
    .setDepth(35)
    .setVisible(false);

  buildBuildMenuUi(scene);
  buildDeathModalUi(scene);
}

function buildDeathModalUi(scene) {
  const c = scene.add.container(0, 0).setDepth(60).setVisible(false);
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.85));
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 420, 240, 0x240010).setStrokeStyle(2, 0xff6666));
  c.add(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 80, 'YOU DIED', {
        fontFamily: 'monospace', fontSize: '36px', color: '#ff6666', fontStyle: 'bold',
      })
      .setOrigin(0.5),
  );
  const stats = scene.add
    .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 10, '', {
      fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', align: 'center', lineSpacing: 4,
    })
    .setOrigin(0.5);
  c.add(stats);
  c.add(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 80, 'PRESS U TO RESTART', {
        fontFamily: 'monospace', fontSize: '12px', color: '#a0a8b0',
      })
      .setOrigin(0.5),
  );
  scene.deathModal = { container: c, statsText: stats };
}

function refreshHpHud(scene) {
  const p = scene.player;
  const filled = '|'.repeat(p.hp);
  const empty = '.'.repeat(p.maxHp - p.hp);
  scene.hpText.setText('HP ' + p.hp + '/' + p.maxHp + ' [' + filled + empty + ']');
}

function refreshDayTimer(scene) {
  if (scene.nightActive) {
    scene.dayText.setText('NIGHT');
    scene.dayText.setColor('#8888ff');
    return;
  }
  const remainingTicks = Math.max(0, DAY_LENGTH_TICKS - scene.dayTime);
  const totalSec = remainingTicks / TICK_RATE;
  const mm = Math.floor(totalSec / 60);
  const ss = Math.floor(totalSec % 60);
  scene.dayText.setText('DAY ' + mm + ':' + (ss < 10 ? '0' : '') + ss);
  scene.dayText.setColor('#a0c8ff');
}

function goHome(scene) {
  scene.player.x = scene.home.x;
  scene.player.y = scene.home.y;
  scene.player.vx = 0;
  scene.player.vy = 0;
  scene.nightActive = true;
  scene.nightTicksRemaining = NIGHT_LENGTH_TICKS;
  scene.nightOverlay.setVisible(true);
  showToast(scene, 'NIGHT!');
  updateCamera(scene);
}

function refreshInventoryHud(scene) {
  const inv = scene.inventory;
  const rows = scene.invHud.rows;
  let row = 0;
  for (let id = 1; id < 64; id++) {
    const count = inv[id];
    if (count <= 0) continue;
    let r = rows[row];
    if (!r) {
      const icon = scene.add.rectangle(0, row * 14, 10, 10, 0).setOrigin(0).setDepth(20);
      const text = scene.add
        .text(14, row * 14 - 1, '', {
          fontFamily: 'monospace', fontSize: '11px', color: '#ffffff',
        })
        .setDepth(20);
      scene.invHud.container.add(icon);
      scene.invHud.container.add(text);
      r = { icon, text };
      rows.push(r);
    }
    r.icon.fillColor = colorToRgb(BLOCK_COLOR[id]);
    r.icon.visible = true;
    r.text.setText(`${BLOCK_NAME[id].toUpperCase()}  ${count}`);
    r.text.visible = true;
    row++;
  }
  for (let i = row; i < rows.length; i++) {
    rows[i].icon.visible = false;
    rows[i].text.visible = false;
  }
  scene.toolText.setText('TOOL: ' + getActiveToolName(scene));
}

function showToast(scene, text) {
  scene.toastText.setText(text);
  scene.toastText.setAlpha(1);
  scene.tweens.killTweensOf(scene.toastText);
  scene.tweens.add({
    targets: scene.toastText,
    alpha: 0,
    duration: 1500,
    delay: 800,
  });
}

// ----- Build menu -----

const BUILD_MENU_ROW_COUNT = 8; // max rows in either tab (TOOL_RECIPES is biggest)

function getCurrentRecipes(scene) {
  return scene.buildMenu.tab === 'tools' ? TOOL_RECIPES : BUILDING_RECIPES;
}

// Tool recipes lock once the player's slot reaches that tier (handles both
// "already crafted" and "skipped a lower tier"). Buildings never lock.
function isRecipeLocked(scene, recipe) {
  if (recipe.pickTier  != null) return scene.pick  >= recipe.pickTier;
  if (recipe.swordTier != null) return scene.sword >= recipe.swordTier;
  return false;
}

function findFirstUnlocked(scene, recipes) {
  for (let i = 0; i < recipes.length; i++) {
    if (!isRecipeLocked(scene, recipes[i])) return i;
  }
  return 0; // all locked → land on first row anyway
}

function findNextUnlocked(scene, recipes, fromIdx, dir) {
  const n = recipes.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((fromIdx + dir * i) % n) + n) % n;
    if (!isRecipeLocked(scene, recipes[idx])) return idx;
  }
  return -1; // all locked
}

function buildBuildMenuUi(scene) {
  const c = scene.add.container(0, 0).setDepth(40);
  c.setVisible(false);
  scene.buildMenuContainer = c;

  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.75));
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 460, 380, 0x1a2238).setStrokeStyle(2, 0xffe066));

  c.add(
    scene.add.text(GAME_WIDTH / 2, 145, 'BUILD', {
      fontFamily: 'monospace', fontSize: '24px', color: '#ffe066', fontStyle: 'bold',
    }).setOrigin(0.5),
  );

  // Tab headers (active tab is highlighted; switch with L/R).
  scene.buildMenuTabs = {};
  scene.buildMenuTabs.tools = scene.add
    .text(GAME_WIDTH / 2 - 80, 178, '< TOOLS', {
      fontFamily: 'monospace', fontSize: '13px', color: '#ffe066', fontStyle: 'bold',
    })
    .setOrigin(0.5);
  scene.buildMenuTabs.buildings = scene.add
    .text(GAME_WIDTH / 2 + 80, 178, 'BUILDINGS >', {
      fontFamily: 'monospace', fontSize: '13px', color: '#7a7a82', fontStyle: 'bold',
    })
    .setOrigin(0.5);
  c.add(scene.buildMenuTabs.tools);
  c.add(scene.buildMenuTabs.buildings);

  // 8 row slots — accommodates TOOL_RECIPES (biggest tab). Unused rows
  // hidden when on BUILDINGS tab.
  scene.buildMenuRows = [];
  for (let i = 0; i < BUILD_MENU_ROW_COUNT; i++) {
    const row = {};
    const y = 215 + i * 25;
    row.bg = scene.add.rectangle(GAME_WIDTH / 2, y, 420, 22, 0x2a3555, 0).setOrigin(0.5);
    row.text = scene.add.text(GAME_WIDTH / 2 - 195, y, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#ffffff',
    }).setOrigin(0, 0.5);
    // 1-px line over the row text for crafted/skipped tools.
    row.strike = scene.add.rectangle(GAME_WIDTH / 2, y, 380, 1, 0x808080, 0).setOrigin(0.5);
    c.add(row.bg);
    c.add(row.text);
    c.add(row.strike);
    scene.buildMenuRows.push(row);
  }

  c.add(
    scene.add.text(GAME_WIDTH / 2, 445,
      'UP/DOWN PICK   L/R TAB   U CONFIRM   I CLOSE', {
      fontFamily: 'monospace', fontSize: '10px', color: '#a0a8b0',
    }).setOrigin(0.5),
  );
}

function openBuildMenu(scene) {
  scene.buildMenu.open = true;
  scene.buildMenu.tab = 'tools';
  const recipes = getCurrentRecipes(scene);
  scene.buildMenu.cursor = findFirstUnlocked(scene, recipes);
  scene.buildMenuContainer.setVisible(true);
  refreshBuildMenu(scene);
}

function closeBuildMenu(scene) {
  scene.buildMenu.open = false;
  scene.buildMenuContainer.setVisible(false);
}

function refreshBuildMenu(scene) {
  const inv = scene.inventory;
  const recipes = getCurrentRecipes(scene);

  // Tab highlight — active tab in yellow, inactive dim grey.
  scene.buildMenuTabs.tools.setColor(scene.buildMenu.tab === 'tools' ? '#ffe066' : '#7a7a82');
  scene.buildMenuTabs.buildings.setColor(scene.buildMenu.tab === 'buildings' ? '#ffe066' : '#7a7a82');

  for (let i = 0; i < scene.buildMenuRows.length; i++) {
    const row = scene.buildMenuRows[i];
    if (i >= recipes.length) {
      row.bg.visible = false; row.text.visible = false; row.strike.visible = false;
      continue;
    }
    const recipe = recipes[i];
    row.bg.visible = true; row.text.visible = true;

    let canAfford = true;
    let costStr = '';
    for (let k = 0; k < recipe.cost.length; k++) {
      const [id, amt] = recipe.cost[k];
      if (inv[id] < amt) canAfford = false;
      costStr += (k > 0 ? ' + ' : '') + amt + ' ' + BLOCK_NAME[id].toUpperCase();
    }
    row.text.setText(recipe.name.padEnd(16) + costStr);

    const locked = isRecipeLocked(scene, recipe);
    let color;
    if (locked)        color = '#5a5a5a';
    else if (!canAfford) color = '#7a7a82';
    else                 color = '#ffffff';
    row.text.setColor(color);

    // Strike line only for locked rows.
    row.strike.visible = locked;
    row.strike.fillAlpha = locked ? 0.8 : 0;

    const selected = !locked && i === scene.buildMenu.cursor;
    row.bg.setFillStyle(0x2a3555, selected ? 0.9 : 0);
    row.bg.setStrokeStyle(selected ? 2 : 0, 0xffe066);
  }
}

function handleBuildMenuInput(scene) {
  const c = scene.controls;
  if (c.pressed.P1_2 || c.pressed.START1) {
    c.pressed.P1_2 = false;
    c.pressed.START1 = false;
    closeBuildMenu(scene);
    return;
  }
  // L/R switches tab and snaps cursor to first unlocked.
  if (c.pressed.P1_L || c.pressed.P1_R) {
    c.pressed.P1_L = false;
    c.pressed.P1_R = false;
    scene.buildMenu.tab = scene.buildMenu.tab === 'tools' ? 'buildings' : 'tools';
    scene.buildMenu.cursor = findFirstUnlocked(scene, getCurrentRecipes(scene));
    refreshBuildMenu(scene);
    return;
  }
  // U/D moves cursor, skipping locked rows.
  if (c.pressed.P1_U || c.pressed.P1_D) {
    const dir = c.pressed.P1_U ? -1 : 1;
    c.pressed.P1_U = false; c.pressed.P1_D = false;
    const next = findNextUnlocked(scene, getCurrentRecipes(scene), scene.buildMenu.cursor, dir);
    if (next >= 0) scene.buildMenu.cursor = next;
    refreshBuildMenu(scene);
    return;
  }
  if (c.pressed.P1_1) {
    c.pressed.P1_1 = false;
    confirmBuildRecipe(scene);
  }
  c.pressed.P1_3 = false;
}

function confirmBuildRecipe(scene) {
  const recipes = getCurrentRecipes(scene);
  const recipe = recipes[scene.buildMenu.cursor];
  if (!recipe || isRecipeLocked(scene, recipe)) return;
  const inv = scene.inventory;
  for (const [id, amt] of recipe.cost) {
    if (inv[id] < amt) {
      showToast(scene, 'NOT ENOUGH!');
      return;
    }
  }

  // Pick / sword recipes → upgrade the relevant tool slot.
  if (recipe.pickTier != null) {
    if (scene.pick >= recipe.pickTier) {
      showToast(scene, 'ALREADY HAVE IT!');
      return;
    }
    for (const [id, amt] of recipe.cost) inv[id] -= amt;
    scene.pick = recipe.pickTier;
    scene.invDirty = true;
    showToast(scene, recipe.name + '!');
    closeBuildMenu(scene);
    return;
  }
  if (recipe.swordTier != null) {
    if (scene.sword >= recipe.swordTier) {
      showToast(scene, 'ALREADY HAVE IT!');
      return;
    }
    for (const [id, amt] of recipe.cost) inv[id] -= amt;
    scene.sword = recipe.swordTier;
    scene.invDirty = true;
    showToast(scene, recipe.name + '!');
    closeBuildMenu(scene);
    return;
  }

  // Structure recipe → place.
  const placed = placeRecipe(scene, recipe.place);
  if (!placed) {
    showToast(scene, 'NO SPACE!');
    return;
  }
  for (const [id, amt] of recipe.cost) inv[id] -= amt;
  scene.invDirty = true;
  scene.dirtyMineral = true; // new MAGIC tiles can anchor mineral chains
  showToast(scene, recipe.name + ' PLACED!');
  closeBuildMenu(scene);
}

function placeRecipe(scene, kind) {
  if (kind === 'furnace')    return placeFurnace(scene);
  if (kind === 'dirtHouse')  return placeHouse(scene, 6, 4, DIRT);
  if (kind === 'stoneHouse') return placeHouse(scene, 8, 5, STONE);
  if (kind === 'ironDoor')   return placeIronDoor(scene);
  return false;
}

function placeFurnace(scene) {
  // 2×2 anchored on the 2-wide footprint below the player's feet.
  const p = scene.player;
  const ptxL = Math.round(p.x / TILE) - 1;
  const ptxR = ptxL + 1;
  const ptyB = ((p.y - 0.001) / TILE) | 0;
  const targets = [
    [ptxL, ptyB - 1], [ptxR, ptyB - 1],
    [ptxL, ptyB],     [ptxR, ptyB],
  ];
  for (const [tx, ty] of targets) {
    if (tx < 1 || tx >= WORLD_W - 1 || ty < 1 || ty >= WORLD_H - 1) return false;
    const idx = ty * WORLD_W + tx;
    const cat = BLOCK_CAT[scene.world[idx] & TYPE_MASK];
    if (cat !== CAT_AIR) return false;
  }
  for (const [tx, ty] of targets) {
    scene.world[ty * WORLD_W + tx] = FURNACE;
  }
  scene.furnaces.push({
    cx: ptxL, cy: ptyB - 1, // top-left of the 2×2
    input: new Uint16Array(2),  // [copper, iron]
    fuel: 0,
    output: new Uint16Array(2), // [copper ingot, iron ingot]
    smeltIdx: -1,
    smeltProgress: 0,
  });
  return true;
}

function placeHouse(scene, w, h, wallType) {
  const p = scene.player;
  const centerTx = Math.round(p.x / TILE);
  const bottomTy = ((p.y - 0.001) / TILE) | 0;
  const x0 = centerTx - (w >> 1);
  const x1 = x0 + w - 1;
  const y1 = bottomTy;
  const y0 = y1 - (h - 1);
  // Check bounds.
  if (x0 < 1 || x1 >= WORLD_W - 1 || y0 < 1 || y1 >= WORLD_H - 1) return false;
  // Place walls (perimeter only). Leave a 1×2 doorway on the facing side.
  const doorX = scene.facing < 0 ? x0 : x1;
  const doorTopY = y1 - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const onBorder = x === x0 || x === x1 || y === y0 || y === y1;
      if (!onBorder) continue;
      // Doorway: skip two tiles on the facing wall at foot + torso level.
      if (x === doorX && (y === y1 || y === doorTopY)) continue;
      const idx = y * WORLD_W + x;
      const cat = BLOCK_CAT[scene.world[idx] & TYPE_MASK];
      if (cat === CAT_MAGIC) return false; // can't overwrite magic (borders, other bases)
      scene.world[idx] = wallType;
    }
  }
  // Register home at the floor-center of the new house so night teleports
  // land the player standing on the house's ground.
  scene.home.x = ((x0 + x1) / 2 + 0.5) * TILE;
  scene.home.y = y1 * TILE;
  return true;
}

function placeIronDoor(scene) {
  const p = scene.player;
  const ptyM = ((p.y - p.h / 2) / TILE) | 0;
  const ptyB = ((p.y - 0.001) / TILE) | 0;
  const ptxL = Math.round(p.x / TILE) - 1;
  const ptxR = ptxL + 1;
  const col = scene.facing < 0 ? ptxL - 1 : ptxR + 1;
  // Place two door tiles (torso + feet) so you can walk through.
  const targets = [[col, ptyM], [col, ptyB]];
  for (const [tx, ty] of targets) {
    if (tx < 1 || tx >= WORLD_W - 1 || ty < 1 || ty >= WORLD_H - 1) return false;
    const idx = ty * WORLD_W + tx;
    if (BLOCK_CAT[scene.world[idx] & TYPE_MASK] !== CAT_AIR) return false;
  }
  for (const [tx, ty] of targets) {
    scene.world[ty * WORLD_W + tx] = IRON_DOOR;
  }
  return true;
}

// ----- Furnace tick (smelt + proximity transfer) -----

function tickFurnaces(scene) {
  const n = scene.furnaces.length;
  if (n === 0) return;
  const tick = scene.tickCount;
  for (let fi = 0; fi < n; fi++) {
    const f = scene.furnaces[fi];
    // 1) Smelt progress (independent of proximity).
    if (f.smeltIdx < 0) {
      for (let i = 0; i < 2; i++) {
        if (f.input[i] > 0 && f.fuel >= FUEL_PER_SMELT) {
          f.smeltIdx = i;
          f.smeltProgress = 0;
          break;
        }
      }
    }
    if (f.smeltIdx >= 0) {
      f.smeltProgress++;
      if (f.smeltProgress >= SMELT_TIME_TICKS) {
        f.input[f.smeltIdx]--;
        f.fuel -= FUEL_PER_SMELT;
        f.output[f.smeltIdx]++;
        f.smeltIdx = -1;
      }
    }

    // 2) Proximity transfer: only when player is near AND on the right tick.
    if (!nearFurnace(scene, f)) continue;
    if (tick % TRANSFER_INTERVAL_TICKS !== 0) continue;

    // Prefer: pull ores → pull fuel → push ingots back.
    const inv = scene.inventory;
    let moved = false;
    // Ores: copper (idx 0), iron (idx 1)
    const oreTypes = [COPPER, IRON];
    for (let i = 0; i < 2 && !moved; i++) {
      if (inv[oreTypes[i]] > 0) {
        inv[oreTypes[i]]--;
        f.input[i]++;
        moved = true;
      }
    }
    if (!moved && inv[WOOD] > 0 && f.fuel < FURNACE_MAX_FUEL) {
      inv[WOOD]--;
      f.fuel++;
      moved = true;
    }
    if (!moved) {
      const ingotTypes = [COPPER_INGOT, IRON_INGOT];
      for (let i = 0; i < 2 && !moved; i++) {
        if (f.output[i] > 0) {
          f.output[i]--;
          inv[ingotTypes[i]]++;
          if (!scene.discovered[ingotTypes[i]]) {
            scene.discovered[ingotTypes[i]] = 1;
            showToast(scene, BLOCK_NAME[ingotTypes[i]].toUpperCase() + '!');
          }
          moved = true;
        }
      }
    }
    if (moved) scene.invDirty = true;
  }
}

function nearFurnace(scene, f) {
  // Player vs. the 2×2 cluster's center point.
  const fcx = (f.cx + 1) * TILE;
  const fcy = (f.cy + 1) * TILE;
  const dx = Math.abs(scene.player.x - fcx);
  const dy = Math.abs(scene.player.y - fcy);
  return dx < 3 * TILE && dy < 3 * TILE;
}

// ============================================================
// 10.6. Monsters (slime / zombie / flyer)
// ============================================================

// Generic AABB collision against the world. Used by player AND monsters.
// p has .x/.y bottom-center + .w/.h.
function collidesBox(scene, cx, cy, w, h) {
  const halfW = w / 2;
  const x0 = ((cx - halfW) / TILE) | 0;
  const x1 = ((cx + halfW - 0.001) / TILE) | 0;
  const y0 = ((cy - h) / TILE) | 0;
  const y1 = ((cy - 0.001) / TILE) | 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) return true;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) return true;
      if (isSolidCell(scene.world[y * WORLD_W + x])) return true;
    }
  }
  return false;
}

function spawnMonstersTick(scene) {
  scene.monsterSpawnTimer--;
  if (scene.monsterSpawnTimer > 0) return;
  scene.monsterSpawnTimer = MONSTER_SPAWN_INTERVAL;
  if (scene.monsters.length >= MONSTER_MAX) return;
  // Pick a random type. Slimes a bit more common than the others.
  const r = Math.random();
  const type = r < 0.45 ? MON_SLIME : r < 0.8 ? MON_ZOMBIE : MON_FLYER;
  spawnMonster(scene, type);
}

function spawnMonster(scene, type) {
  const p = scene.player;
  const side = Math.random() < 0.5 ? -1 : 1;
  const offset = GAME_WIDTH / 2 + 24;
  let x = p.x + side * offset;
  // Clamp to world.
  x = Math.max(2 * TILE, Math.min((WORLD_W - 2) * TILE, x));
  let y;
  if (type === MON_FLYER) {
    // Flyers spawn above the player, at the upper edge of the viewport.
    y = Math.max(8 * TILE, p.y - GAME_HEIGHT * 0.4);
  } else {
    // Ground monsters: snap to surface at that x.
    const tx = Math.max(1, Math.min(WORLD_W - 2, (x / TILE) | 0));
    const surfY = findSurface(scene.world, tx);
    y = surfY * TILE;
  }
  scene.monsters.push(createMonster(scene, type, x, y));
}

function createMonster(scene, type, x, y) {
  const m = {
    type, x, y, vx: 0, vy: 0,
    facing: 1, jumpTimer: 0,
    flashTicks: 0,
  };
  // HP scales so that each sword tier meaningfully cuts kill time:
  //   slime 12 hp  → fists 6, wood 2, stone 1
  //   zombie 30 hp → fists 15, wood 3, stone 2, copper 1
  //   flyer 6 hp   → fists 3, wood 1
  if (type === MON_SLIME)       { m.w = 12; m.h = 8;  m.hp = 12; }
  else if (type === MON_ZOMBIE) { m.w = 12; m.h = 22; m.hp = 30; }
  else                          { m.w = 14; m.h = 8;  m.hp = 6;  }
  m.sprite = buildMonsterVisual(scene, type);
  return m;
}

// Damage a monster, with knockback + flash + death cleanup. Caller is
// responsible for iterating backwards if they call this inside a loop.
function applyMonsterDamage(scene, m, dmg) {
  m.hp -= dmg;
  m.flashTicks = 12;
  // Knockback away from the player.
  const knockDir = m.x < scene.player.x ? -1 : 1;
  m.vx = knockDir * 1.6;
  if (m.type !== MON_FLYER) m.vy = -1.4;
  if (m.hp <= 0) {
    m.sprite.destroy();
    const idx = scene.monsters.indexOf(m);
    if (idx >= 0) scene.monsters.splice(idx, 1);
  }
}

function buildMonsterVisual(scene, type) {
  const c = scene.add.container(0, 0).setDepth(9);
  if (type === MON_SLIME) {
    c.add(scene.add.rectangle(0, -1.5, 12, 3, 0x44a060));
    c.add(scene.add.rectangle(0, -4.5, 10, 3, 0x44a060));
    c.add(scene.add.rectangle(0, -7,    6, 2, 0x44a060));
    c.add(scene.add.rectangle(-2, -5, 1, 1, 0x101018));
    c.add(scene.add.rectangle( 2, -5, 1, 1, 0x101018));
  } else if (type === MON_ZOMBIE) {
    c.add(scene.add.rectangle(-3, -3, 4, 6, 0x3a4530));      // leg L
    c.add(scene.add.rectangle( 3, -3, 4, 6, 0x3a4530));      // leg R
    c.add(scene.add.rectangle( 0, -11, 12, 10, 0x5a7042));   // body
    c.add(scene.add.rectangle( 0, -19, 10, 8, 0x9eb585));    // head
    c.add(scene.add.rectangle(-2, -19, 1, 1, 0x101018));     // eye L
    c.add(scene.add.rectangle( 2, -19, 1, 1, 0x101018));     // eye R
    c.add(scene.add.rectangle( 0, -16, 4, 1, 0x301010));     // mouth
  } else {
    c.add(scene.add.rectangle(-6, -5, 5, 3, 0x501818));      // wing L
    c.add(scene.add.rectangle( 6, -5, 5, 3, 0x501818));      // wing R
    c.add(scene.add.rectangle( 0, -4, 6, 6, 0x6a2a30));      // body
    c.add(scene.add.rectangle(-1, -5, 1, 1, 0xff6060));      // eye L
    c.add(scene.add.rectangle( 1, -5, 1, 1, 0xff6060));      // eye R
  }
  return c;
}

function tickMonsters(scene) {
  const p = scene.player;
  for (let i = 0; i < scene.monsters.length; i++) {
    tickMonster(scene, scene.monsters[i], p);
  }
}

function tickMonster(scene, m, p) {
  if (m.flashTicks > 0) m.flashTicks--;
  const dx = p.x - m.x;
  m.facing = dx >= 0 ? 1 : -1;

  if (m.type === MON_SLIME) {
    m.vy += GRAVITY;
    m.jumpTimer--;
    if (m.jumpTimer <= 0 && monsterOnGround(scene, m)) {
      m.vy = -3.0;
      m.vx = m.facing * 1.2;
      m.jumpTimer = 50 + ((Math.random() * 30) | 0);
    }
    moveMonsterWithCollision(scene, m);
  } else if (m.type === MON_ZOMBIE) {
    m.vy += GRAVITY;
    m.vx = m.facing * 0.6;
    if (monsterOnGround(scene, m) && monsterBlockedAhead(scene, m)) {
      m.vy = -3.2;
    }
    moveMonsterWithCollision(scene, m);
  } else { // MON_FLYER — no gravity, glides toward player center
    const dy = (p.y - p.h / 2) - (m.y - m.h / 2);
    const dist = Math.hypot(dx, dy) || 1;
    m.vx = (dx / dist) * 0.8;
    m.vy = (dy / dist) * 0.8;
    m.x += m.vx;
    m.y += m.vy;
  }
}

function monsterOnGround(scene, m) {
  m.y += 1;
  const c = collidesBox(scene, m.x, m.y, m.w, m.h);
  m.y -= 1;
  return c;
}

function monsterBlockedAhead(scene, m) {
  const probeX = m.x + m.facing * (m.w / 2 + 1);
  return collidesBox(scene, probeX, m.y - 1, 2, m.h - 2);
}

function moveMonsterWithCollision(scene, m) {
  if (m.vy > TERMINAL_VY) m.vy = TERMINAL_VY;
  if (m.vy < -8) m.vy = -8;
  m.x += m.vx;
  if (collidesBox(scene, m.x, m.y, m.w, m.h)) { m.x -= m.vx; m.vx = 0; }
  m.y += m.vy;
  if (collidesBox(scene, m.x, m.y, m.w, m.h)) {
    m.y -= m.vy;
    if (m.vy > 0) m.y = Math.ceil(m.y / TILE) * TILE;
    m.vy = 0;
  }
}

function checkMonsterDamage(scene) {
  const p = scene.player;
  if (p.invulnTicks > 0) { p.invulnTicks--; return; }
  for (let i = 0; i < scene.monsters.length; i++) {
    const m = scene.monsters[i];
    if (aabbOverlap(p, m)) {
      const dmg = m.type === MON_ZOMBIE ? 2 : 1;
      applyPlayerDamage(scene, dmg);
      p.invulnTicks = PLAYER_INVULN_TICKS;
      return;
    }
  }
}

function aabbOverlap(a, b) {
  const ax0 = a.x - a.w / 2, ax1 = a.x + a.w / 2;
  const ay0 = a.y - a.h, ay1 = a.y;
  const bx0 = b.x - b.w / 2, bx1 = b.x + b.w / 2;
  const by0 = b.y - b.h, by1 = b.y;
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
}

function renderMonsters(scene) {
  for (let i = 0; i < scene.monsters.length; i++) {
    const m = scene.monsters[i];
    m.sprite.setPosition(m.x - scene.cam.x, m.y - scene.cam.y);
    m.sprite.setScale(m.facing < 0 ? -1 : 1, 1);
    // Flash on hit: blink alpha while flashTicks > 0.
    m.sprite.setAlpha(m.flashTicks > 0 && (m.flashTicks & 4) ? 0.3 : 1);
  }
}

function despawnAllMonsters(scene) {
  for (let i = 0; i < scene.monsters.length; i++) {
    scene.monsters[i].sprite.destroy();
  }
  scene.monsters.length = 0;
  scene.monsterSpawnTimer = MONSTER_SPAWN_INTERVAL;
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
