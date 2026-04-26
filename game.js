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
const WORLD_H = 512;

// Fixed-timestep simulation. Movement constants (MOVE_SPEED, GRAVITY, …)
// are calibrated PER TICK, not per frame, so the game runs at the same
// world-speed regardless of monitor refresh rate.
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MAX_TICKS_PER_FRAME = 5;

// Dev-only x/y/tick/fps overlay. Flip to `true` for debugging — the
// minifier DCEs the `if (DEBUG_HUD)` branches when false, so release
// builds pay zero bytes.
const DEBUG_HUD = false;

const MOVE_SPEED = 1.2;     // px / tick
const JUMP_VELOCITY = -3.9; // px / tick — peak ≈ 4.2 tiles
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
// Decor category: pass-through, never falls, never mineable (hardness 0).
// Used for leaves, clouds, any ornament.
const CAT_DECOR = 6;

// Type ids — keep stable so a saved world (future feature) doesn't drift.
const AIR = 0, DIRT = 1, SAND = 2, WATER = 3, STONE = 4,
      LAVA = 6, COPPER = 7, IRON = 8, BORDER = 9,
      WOOD = 10, COPPER_INGOT = 11, IRON_INGOT = 12,
      FURNACE = 13,
      LEAVES = 15, CLOUD = 16,
      // v4 building tiles — bricks are base/wall material, door/stair are
      // special pass-through semantics (see isSolidForPlayer/Monster).
      BRICK_DIRT = 17, BRICK_STONE = 18, BRICK_COPPER = 19, BRICK_IRON = 20,
      DOOR_WOOD = 21, STAIR_WOOD = 22,
      BED_WOOD = 23, BED_IRON = 24,
      OBSIDIAN = 25,
      HARD_ROCK = 26, // deep base layer, 2× stone hardness
      MITHRIL = 27,   // end-game tool material, deepest vein
      MITHRIL_INGOT = 28;

// Per-block flags. Drive procedural recipe generation and the
// render-time texture pattern (brick edge / vein inset square).
const F_FOR_TOOL = 1;
const F_FOR_BUILD = 2;
const F_IS_VEIN = 4;      // generated as small pockets inside a base
const F_IS_BRICK = 8;     // placed-building tile — render with outlined edge
const F_IS_MINERAL = 16;  // smeltable in furnace (raw → MAT_TO_INGOT[id])

// Colors are packed little-endian 0xAABBGGRR for direct Uint32 writes.
// Hardness/TIER_DAMAGE share a damage-units scale (fist=2, wood pick=10,
// stone=20, copper=30, iron=50). All lookups live in Uint8/Uint16 arrays.
// Each material with F_FOR_TOOL + tier auto-generates pickaxe + sword
// recipes (10 of mat for tier 1, 100 for higher tiers). With F_FOR_BUILD
// + brick, auto-generates BASE/WALL recipes (10 mat per tile). Adding
// mithril = one row here + one BRICK_MITHRIL row + tier:5/brick set.
const BLOCKS = [
  // id, name, cat, color, fallTicks, hardness, flags, [tier], [brick]
  { id: AIR,    name: 'air',    cat: CAT_AIR,      color: 0xff0a0d18, fallTicks: 0,  hardness: 0,  flags: 0 },
  { id: DIRT,   name: 'dirt',   cat: CAT_SOLID,    color: 0xff2c4f7a, fallTicks: 15, hardness: 10, flags: F_FOR_BUILD, brick: BRICK_DIRT },
  { id: SAND,   name: 'sand',   cat: CAT_SANDLIKE, color: 0xff5cd4e8, fallTicks: 12, hardness: 10, flags: 0 },
  { id: WATER,  name: 'water',  cat: CAT_LIQUID,   color: 0xffd88030, fallTicks: 5,  hardness: 10, flags: 0 },
  { id: STONE,  name: 'stone',  cat: CAT_MINERAL,  color: 0xff4a4a4a, fallTicks: 15, hardness: 20, flags: F_FOR_TOOL | F_FOR_BUILD, tier: 2, brick: BRICK_STONE },
  { id: LAVA,   name: 'lava',   cat: CAT_LIQUID,   color: 0xff1840f0, fallTicks: 30, hardness: 50, flags: 0 },
  { id: COPPER, name: 'copper', cat: CAT_MINERAL,  color: 0xff3070c0, fallTicks: 20, hardness: 40, flags: F_FOR_TOOL | F_FOR_BUILD | F_IS_VEIN | F_IS_MINERAL, tier: 3, brick: BRICK_COPPER },
  { id: IRON,   name: 'iron',   cat: CAT_MINERAL,  color: 0xff8090a0, fallTicks: 20, hardness: 80, flags: F_FOR_TOOL | F_FOR_BUILD | F_IS_VEIN | F_IS_MINERAL, tier: 4, brick: BRICK_IRON },
  { id: BORDER, name: 'border', cat: CAT_MAGIC,    color: 0xff1a1a1a, fallTicks: 0,  hardness: 0,  flags: 0 },
  { id: WOOD,         name: 'wood',         cat: CAT_SOLID, color: 0xff1d3a6e, fallTicks: 15, hardness: 4,  flags: F_FOR_TOOL, tier: 1 },
  { id: COPPER_INGOT, name: 'copper ingot', cat: CAT_AIR,   color: 0xff3a80d0, fallTicks: 0,  hardness: 0,  flags: 0 },
  { id: IRON_INGOT,   name: 'iron ingot',   cat: CAT_AIR,   color: 0xffc8d4de, fallTicks: 0,  hardness: 0,  flags: 0 },
  { id: FURNACE,      name: 'furnace',      cat: CAT_MAGIC, color: 0xff3a3a40, fallTicks: 0,  hardness: 200, flags: 0, drop: STONE, dropAmt: 40 },
  { id: LEAVES,       name: 'leaves',       cat: CAT_DECOR, color: 0xff4aa040, fallTicks: 0,  hardness: 0,  flags: 0 },
  { id: CLOUD,        name: 'cloud',        cat: CAT_DECOR, color: 0xffe8eef0, fallTicks: 0,  hardness: 0,  flags: 0 },
  // Bricks: F_IS_BRICK drives outlined-edge texture. Hardness equals raw mat —
  // a wall costs 10× to build but breaks like 1× of the raw block. Drop = 1.
  { id: BRICK_DIRT,   name: 'dirt brick',   cat: CAT_MAGIC, color: 0xff3a5880, fallTicks: 0, hardness: 10, flags: F_IS_BRICK },
  { id: BRICK_STONE,  name: 'stone brick',  cat: CAT_MAGIC, color: 0xff8a8a90, fallTicks: 0, hardness: 20, flags: F_IS_BRICK },
  { id: BRICK_COPPER, name: 'copper brick', cat: CAT_MAGIC, color: 0xff4080c8, fallTicks: 0, hardness: 40, flags: F_IS_BRICK },
  { id: BRICK_IRON,   name: 'iron brick',   cat: CAT_MAGIC, color: 0xff708090, fallTicks: 0, hardness: 80, flags: F_IS_BRICK },
  { id: DOOR_WOOD,    name: 'door',         cat: CAT_MAGIC, color: 0xff2a5088, fallTicks: 0, hardness: 4,  flags: 0, drop: WOOD,       dropAmt: 1 },
  { id: STAIR_WOOD,   name: 'stair',        cat: CAT_MAGIC, color: 0xff3478b0, fallTicks: 0, hardness: 4,  flags: 0, drop: WOOD,       dropAmt: 1 },
  { id: BED_WOOD,     name: 'bed',          cat: CAT_MAGIC, color: 0xff4050c0, fallTicks: 0, hardness: 4,  flags: 0, drop: WOOD,       dropAmt: 1 },
  { id: BED_IRON,     name: 'iron bed',     cat: CAT_MAGIC, color: 0xff606890, fallTicks: 0, hardness: 80, flags: 0, drop: IRON_INGOT, dropAmt: 1 },
  { id: OBSIDIAN,     name: 'obsidian',     cat: CAT_MAGIC, color: 0xff40182a, fallTicks: 0, hardness: 160, flags: F_FOR_BUILD | F_IS_BRICK, brick: OBSIDIAN },
  // Hard rock: 2× stone hardness, the deep-world base layer below stone.
  { id: HARD_ROCK,    name: 'hard rock',    cat: CAT_MINERAL, color: 0xff353038, fallTicks: 15, hardness: 40, flags: 0 },
  { id: MITHRIL,      name: 'mithril',      cat: CAT_MINERAL, color: 0xffd0c8a8, fallTicks: 20, hardness: 160, flags: F_FOR_TOOL | F_IS_VEIN | F_IS_MINERAL, tier: 5 },
  { id: MITHRIL_INGOT,name: 'mithril ingot',cat: CAT_AIR,     color: 0xffe0e8f0, fallTicks: 0,  hardness: 0,   flags: 0 },
];

// raw mat → smelted equivalent (brick drops + tool tier costs + furnace).
const MAT_TO_INGOT = { [DIRT]: DIRT, [STONE]: STONE, [COPPER]: COPPER_INGOT, [IRON]: IRON_INGOT, [MITHRIL]: MITHRIL_INGOT };
// Parallel arrays of smeltable ores → their ingot. Filled from BLOCKS.
const ORE_RAWS = [], ORE_INGOTS = [];
// brick id → its raw material. Drops 10× of MAT_TO_INGOT[mat].
const BRICK_MAT = { [BRICK_DIRT]: DIRT, [BRICK_STONE]: STONE, [BRICK_COPPER]: COPPER, [BRICK_IRON]: IRON };

// Flat lookup tables for the hot path. 64-slot capacity (TYPE_MASK + 1).
const BLOCK_CAT = new Uint8Array(64);
const BLOCK_COLOR = new Uint32Array(64);
const BLOCK_FALL_TICKS = new Uint8Array(64);
const BLOCK_HARDNESS = new Uint16Array(64);
const BLOCK_FLAGS = new Uint8Array(64);
const BLOCK_DROP_TYPE = new Uint8Array(64);
const BLOCK_DROP_AMOUNT = new Uint16Array(64);
const BLOCK_NAME = new Array(64);
for (const b of BLOCKS) {
  BLOCK_CAT[b.id] = b.cat;
  BLOCK_COLOR[b.id] = b.color;
  BLOCK_FALL_TICKS[b.id] = b.fallTicks;
  BLOCK_HARDNESS[b.id] = b.hardness;
  BLOCK_FLAGS[b.id] = b.flags;
  // bricks drop 1 of their raw mat's smelted form (you paid 10 to build, get 1 back)
  if (b.flags & F_IS_BRICK) {
    BLOCK_DROP_TYPE[b.id] = MAT_TO_INGOT[BRICK_MAT[b.id]];
    BLOCK_DROP_AMOUNT[b.id] = 1;
  } else {
    BLOCK_DROP_TYPE[b.id] = b.drop != null ? b.drop : b.id;
    BLOCK_DROP_AMOUNT[b.id] = b.dropAmt != null ? b.dropAmt : 1;
  }
  BLOCK_NAME[b.id] = b.name;
  if (b.flags & F_IS_MINERAL) { ORE_RAWS.push(b.id); ORE_INGOTS.push(MAT_TO_INGOT[b.id]); }
}

// ----- Tools: tier-based damage shared between picks and swords. -----
// Day → pick, night → sword (auto via getActiveTier). Tool slots track
// independently. Tier 0 = fists.
const TIER_FIST = 0, TIER_WOOD = 1;
const TIER_DAMAGE = [2, 7, 15, 30, 50, 80];
const TIER_NAMES = ['FISTS', 'WOODEN', 'STONE', 'COPPER', 'IRON', 'MITHRIL'];
const TIER_PICK_NAMES  = TIER_NAMES.map((n, i) => i === 0 ? 'FISTS' : n + ' PICKAXE');
const TIER_SWORD_NAMES = TIER_NAMES.map((n, i) => i === 0 ? 'FISTS' : n + ' SWORD');

// Tool + base/wall recipes are derived from BLOCKS.flags + .tier + .brick.
// Tools cost 10 of mat for tier 1 (wood — easy to start) and 100 for the
// rest. F_IS_MINERAL materials consume their smelted ingot.
const TOOL_RECIPES = [];
// Wood-cost builds first — these are what a new player can craft right
// after the wooden pickaxe. Then BASE/WALL by tier (dirt → obsidian).
// Advanced singletons (need stone/iron) at the end.
const BUILDING_RECIPES = [
  { name: 'DOOR',  kind: 'door',  material: WOOD, tile: DOOR_WOOD,  costTotal: 10 },
  { name: 'STAIR', kind: 'stair', material: WOOD, tile: STAIR_WOOD, costPerTile: 10 },
  { name: 'BED',   kind: 'bed',   material: WOOD, tile: BED_WOOD,   costTotal: 10 },
];
for (const b of BLOCKS) {
  const matId = MAT_TO_INGOT[b.id] || b.id;
  const NAME = b.name.toUpperCase();
  if ((b.flags & F_FOR_TOOL) && b.tier) {
    const cost = [[matId, b.tier === 1 ? 10 : 50]];
    TOOL_RECIPES.push({ name: TIER_PICK_NAMES[b.tier],  cost, pickTier:  b.tier });
    TOOL_RECIPES.push({ name: TIER_SWORD_NAMES[b.tier], cost, swordTier: b.tier });
  }
  if ((b.flags & F_FOR_BUILD) && b.brick) {
    BUILDING_RECIPES.push({ name: 'BASE ' + NAME, kind: 'base', material: matId, tile: b.brick, costPerTile: 10 });
    BUILDING_RECIPES.push({ name: 'WALL ' + NAME, kind: 'wall', material: matId, tile: b.brick, costPerTile: 10 });
  }
}
// BLOCKS lists wood after the minerals, so the tool loop produces them
// out of progression order. Sort by tier so wooden tools come first.
TOOL_RECIPES.sort((a, b) => (a.pickTier || a.swordTier) - (b.pickTier || b.swordTier));
BUILDING_RECIPES.push(
  { name: 'FURNACE', kind: 'furnace', material: STONE,      tile: FURNACE,  costTotal: 50 },
  { name: 'IRON BED',kind: 'bed',     material: IRON_INGOT, tile: BED_IRON, costTotal: 10 },
);

// Per-kind defaults for the placement mode. `resize` says which axis
// grows with U/D; null means fixed size.
const PLACEMENT_DEFAULTS = {
  base:    { minW: 2, maxW: 20, minH: 1, maxH: 1,  resize: 'w' },
  wall:    { minW: 1, maxW: 1,  minH: 2, maxH: 16, resize: 'h' },
  stair:   { minW: 1, maxW: 1,  minH: 2, maxH: 16, resize: 'h' },
  door:    { minW: 1, maxW: 1,  minH: 2, maxH: 4,  resize: 'h' },
  furnace: { minW: 2, maxW: 2,  minH: 2, maxH: 2,  resize: null },
  bed:     { minW: 2, maxW: 2,  minH: 1, maxH: 1,  resize: null },
};

// ----- Furnace tuning -----
const TRANSFER_INTERVAL_TICKS = 8; // 1 unit every ~130ms at 60 TPS
const SMELT_TIME_TICKS = 60;       // 1 second per ingot
const FUEL_PER_SMELT = 1;          // 1 wood per ingot
const FURNACE_MAX_FUEL = 16;

// ----- Day/night tuning -----
// Day starts at 2 minutes; each day survived adds 10 s (so night adds 5 s).
// Cached per day in `scene.dayLengthTicks` / `scene.nightLengthTicks`.
const DAY_BASE_SECONDS = 120;
const DAY_INCREMENT_SECONDS = 10;

// ----- Tutorial steps -----
// Step 0 = no banner. Each step auto-advances when its check fires.
// Last step holds for TUTORIAL_FINAL_HOLD_TICKS, then hides.
const TUTORIAL_STEPS = [
  '',
  'HIT A TREE WITH U',
  'GET 10 WOOD TOTAL',
  'OPEN MENU (I), CRAFT WOODEN PICKAXE',
  'BUILD A BASE: U/D RESIZE, L/R MOVE, U TO PLACE',
  'PLACE A BED ON THE BASE',
  'AT NIGHT, DOUBLE-TAP O ON A BED TO SLEEP',
  'BUILD A FURNACE AND SMELT ORE WITH WOOD',
  'CLOSE OFF THE BASE — VILLAGERS ARRIVE AT DAWN',
  '+1 POINT PER VILLAGER ALIVE EACH NIGHT. GOOD LUCK!',
  '',
];
const TUTORIAL_FINAL_HOLD_TICKS = 8 * TICK_RATE;
const TUTORIAL_FINAL_STEP = TUTORIAL_STEPS.length - 2;

// ----- Leaf decay -----
// Leaves not connected (via WOOD + LEAVES chain) to a trunk wither away.
// The BFS runs every LEAF_SCAN_INTERVAL ticks; each disconnected leaf
// accumulates a counter and disappears once it crosses the threshold.
const LEAF_SCAN_INTERVAL = 12;     // 5 scans per second at 60 tps
const LEAF_DECAY_THRESHOLD = 15;   // 15 scans × 12 ticks ≈ 3 s

// ----- Player health -----
const PLAYER_MAX_HP = 10;
const DROWN_TICKS = 60;             // 1 dmg per 60 ticks fully submerged in water
const LAVA_TICKS = 30;              // 1 dmg per 30 ticks touching lava
const FALL_DAMAGE_PX = 15 * TILE;   // 1 dmg per 15 tiles of fall. Water cancels.
const PLAYER_FLASH_TICKS = 24;      // blink duration after any damage source
const PLAYER_INVULN_TICKS = 30;     // grace period from monster contact

// ----- Monsters -----
const MON_SLIME = 0, MON_ZOMBIE = 1, MON_FLYER = 2,
      MON_GHOST = 3, MON_BOMBER = 4;
const BASE_SPAWN_INTERVAL = 90;
const BASE_MONSTER_MAX = 10;

// Bitmask of allowed types per night (index = daysSurvived - 1, clamped
// to the last entry). Bit i = type i. Adding a new monster = update
// these masks. Stats scale separately (see monsterScale).
const NIGHT_TYPES = new Uint8Array([
  0b00010, // n1: zombie only
  0b00110, // n2: + flyer
  0b00111, // n3: + slime
  0b00111, // n4
  0b00111, // n5
  0b01111, // n6: + ghost
  0b01111, // n7
  0b11111, // n8+: + bomber
]);

// Stuck escalation — if a monster tries to move but hasn't made
// progress for STUCK_THRESHOLD_TICKS, it gets a bigger jump and is
// allowed to chew through natural tiles (see monsterAttackTiles).
const STUCK_THRESHOLD_TICKS = 30;
const STUCK_JUMP_VELOCITY = -5.0; // peak ≈ 6.9 tiles, clears most walls

// Per-type stats stored as parallel typed arrays. Adding a monster =
// one row in each table + one case in buildMonsterVisual. AI: 0=ground,
// 1=glide. jumpTrigger: 0=none, 1=timer, 2=blocked. Flags: bitmask of
// MF_GRAVITY|MF_PHASE|MF_KNOCK|MF_ATK_TILES|MF_EXPLODES.
const MF_GRAVITY = 1, MF_PHASE = 2, MF_KNOCK = 4, MF_ATK_TILES = 8, MF_EXPLODES = 16;
//                                       SLIME ZOMBIE FLYER GHOST BOMBER
const M_W        = new Uint8Array([        12,   12,   14,   12,   12]);
const M_H        = new Uint8Array([         8,   22,    8,   14,   14]);
const M_HP       = new Uint8Array([        25,   45,   25,   22,   35]);
const M_AI       = new Uint8Array([         0,    0,    1,    1,    0]);
const M_FLAGS    = new Uint8Array([
  MF_GRAVITY|MF_KNOCK|MF_ATK_TILES,
  MF_GRAVITY|MF_KNOCK|MF_ATK_TILES,
  MF_KNOCK|MF_ATK_TILES,
  MF_PHASE,
  MF_GRAVITY|MF_KNOCK|MF_EXPLODES,
]);
const M_WALK     = [0,    0.6,  0,    0,    0.4];
const M_AIR      = [1.2,  0.6,  0,    0,    0.4];
const M_GLIDE    = [0,    0,    0.8,  0.55, 0];
const M_JUMP_V   = [-3.5, -4.2, 0,    0,    -4.0];
const M_JUMP_TR  = new Uint8Array([1, 2, 0, 0, 2]);
const M_JUMP_MIN = new Uint8Array([30, 0, 0, 0, 0]);
const M_JUMP_MAX = new Uint8Array([60, 0, 0, 0, 0]);
const M_ATK_DMG  = new Uint8Array([3, 5, 3, 0, 0]);
const M_CONTACT  = new Uint8Array([1, 2, 1, 2, 0]);
const M_FUSE     = new Uint8Array([0, 0, 0, 0, 45]);
const M_EXP_RAD  = new Uint8Array([0, 0, 0, 0, 3]);
const M_EXP_DMG  = new Uint8Array([0, 0, 0, 0, 5]);
const M_EXP_RNG  = 2.2 * TILE; // bomber-only constant

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
  // leafDecay counts scans a leaf has been disconnected from any trunk.
  scene.world = new Uint8Array(WORLD_W * WORLD_H);
  scene.damage = new Uint16Array(WORLD_W * WORLD_H); // up to 600 for iron brick
  scene.leafDecay = new Uint8Array(WORLD_W * WORLD_H);

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

  // World texture: real-pixel resolution. Each tile occupies TILE×TILE
  // sub-pixels so render() can draw outlined bricks and inset mineral
  // squares. 1 tile margin each side enables sub-tile camera offsets.
  const TW = (VW + 2) * TILE;
  const TH = (VH + 2) * TILE;
  scene.tex = scene.textures.createCanvas('world', TW, TH);
  scene.texCtx = scene.tex.getContext();
  scene.imgData = scene.texCtx.getImageData(0, 0, TW, TH);
  scene.pixels = new Uint32Array(scene.imgData.data.buffer);
  scene.worldImg = scene.add.image(0, 0, 'world').setOrigin(0).setScale(1);

  buildPlayerVisual(scene);

  // Inventory / tools / crafting state.
  scene.inventory = new Uint16Array(64);
  scene.discovered = new Uint8Array(64);
  scene.pick = TIER_FIST;
  scene.sword = TIER_FIST;
  scene.invDirty = true;
  scene.furnaces = [];
  scene.buildMenu = { open: false, tab: 'tools', cursor: 0 };
  scene.placement = {
    active: false, recipe: null,
    tx: 0, ty: 0, w: 1, h: 1, valid: false,
  };

  // Day/night + home. Home defaults to spawn; updated when a house is built.
  scene.dayTime = 0;
  scene.nightActive = false;
  scene.nightTicksRemaining = 0;
  scene.home = { x: scene.player.x, y: scene.player.y };
  scene.daysSurvived = 1;
  recomputeDayLengths(scene);

  // Health + hazard counters (attached to player for clean grouping).
  scene.player.hp = PLAYER_MAX_HP;
  scene.player.maxHp = PLAYER_MAX_HP;
  scene.player.submergedTicks = 0;
  scene.player.lavaTicks = 0;
  scene.player.peakY = scene.player.y;
  scene.player.flashTicks = 0;
  scene.player.invulnTicks = 0;
  scene.player.wasInWater = false;
  scene.gameOver = false;

  // Web Audio context for procedural SFX + music. May be suspended
  // until a user gesture; we resume in startMusic / sfx.
  scene.audioCtx = (scene.sound && scene.sound.context) || null;
  scene.musicOn = false;

  // Monsters (only present during night).
  scene.monsters = [];
  scene.monsterSpawnTimer = BASE_SPAWN_INTERVAL;

  // Villagers — populated by scanVillages at every dawn.
  scene.villagers = [];
  scene.villagerCount = 0;

  buildHud(scene);

  if (DEBUG_HUD) {
    scene.hud = scene.add
      .text(GAME_WIDTH - 8, 6, '', {
        fontFamily: 'monospace', fontSize: '10px', color: '#888888',
      })
      .setOrigin(1, 0)
      .setDepth(20);
  }

  createControls(scene);
}

// ============================================================
// 5. World generation
// ============================================================

function generateWorld(w) {
  const rnd = makeRng((Math.random() * 0xffffffff) >>> 0);

  // Stratify the world: sky / dirt skin / stone / hard rock at depth.
  // The sine wave gives the surface a gentle rolling profile.
  for (let x = 0; x < WORLD_W; x++) {
    const wave = Math.sin(x * 0.06) * 3 + Math.sin(x * 0.21) * 2;
    const surfaceY = (60 + wave) | 0;
    for (let y = 0; y < WORLD_H; y++) {
      const idx = y * WORLD_W + x;
      if (x === 0 || x === WORLD_W - 1 || y === WORLD_H - 1) w[idx] = BORDER;
      else if (y < surfaceY)          w[idx] = AIR;
      else if (y < surfaceY + 8)      w[idx] = DIRT;
      else if (y < 160)               w[idx] = STONE;
      else                            w[idx] = HARD_ROCK;
    }
  }

  // Single helper: scatter `count` blobs of `fill` into existing `only`
  // cells, within the y-band [yLo, yHi]. Used for veins, water/lava
  // pockets, caves, AND clouds (filling AIR up high with CLOUD).
  const pocket = (count, fill, only, yLo, yHi, rxMax, ryMax) => {
    for (let i = 0; i < count; i++) {
      const cx = 4 + ((rnd() * (WORLD_W - 8)) | 0);
      const cy = yLo + ((rnd() * (yHi - yLo)) | 0);
      const rx = 2 + ((rnd() * rxMax) | 0);
      const ry = 1 + ((rnd() * ryMax) | 0);
      blob(w, cx, cy, rx, ry, fill, only);
    }
  };

  // [count, fill, baseTarget, yLo, yHi, rxMax, ryMax]
  const VEINS = [
    [15,  CLOUD,   AIR,       8,   43,  5,  2],
    [50,  SAND,    STONE,     70,  155, 11, 7],
    [40,  WATER,   STONE,     70,  155, 9,  6],
    [25,  LAVA,    STONE,     140, 160, 3,  2],
    [80,  COPPER,  STONE,     90,  158, 2,  2],
    [90,  AIR,     STONE,     75,  160, 4,  2],
    [110, LAVA,    HARD_ROCK, 165, 505, 4,  3],
    [50,  WATER,   HARD_ROCK, 165, 400, 6,  4],
    [90,  COPPER,  HARD_ROCK, 165, 400, 2,  2],
    [180, IRON,    HARD_ROCK, 280, 505, 2,  2],
    [60,  MITHRIL, HARD_ROCK, 400, 505, 2,  2],
    [140, AIR,     HARD_ROCK, 165, 505, 5,  3],
  ];
  for (const v of VEINS) pocket(v[0], v[1], v[2], v[3], v[4], v[5], v[6]);

  for (let a = 0; a < 60; a++) plantTree(w, rnd, 10 + ((rnd() * (WORLD_W - 20)) | 0));
}

// Linear-congruential generator factory shared by world gen + regrow.
function makeRng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Plant a single tree at column `tx`. Returns true on success. Shared
// by the initial generation pass and by regrowTrees at dawn.
function plantTree(w, rnd, tx) {
  const surfY = findSurface(w, tx);
  if (surfY < 30 || surfY >= WORLD_H - 1) return false;
  if ((w[surfY * WORLD_W + tx] & TYPE_MASK) !== DIRT) return false;
  // Require air above so we don't plant inside a cavern ceiling.
  if (surfY < 4) return false;
  if ((w[(surfY - 1) * WORLD_W + tx] & TYPE_MASK) !== AIR) return false;
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
  return true;
}

// At dawn, sprinkle a handful of fresh trees so monster chew doesn't
// deforest the map over a few days. Deterministic seed (per-day) keeps
// the regrowth pattern reproducible.
function regrowTrees(scene, count) {
  const rnd = makeRng(((scene.tickCount + scene.daysSurvived * 9973) * 0x9e3779b1) >>> 0);
  let planted = 0;
  for (let a = 0; a < count * 8 && planted < count; a++) {
    if (plantTree(scene.world, rnd, 10 + ((rnd() * (WORLD_W - 20)) | 0))) planted++;
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
  // "Surface" = first tile that solid-for-player rules would land on.
  // Skips air, decor (clouds/leaves), and pass-throughs (doors/stairs).
  for (let y = 1; y < WORLD_H - 1; y++) {
    if (isSolidForPlayer(w[y * WORLD_W + tx])) return y;
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
  renderVillagers(scene);
  renderFurnaces(scene);
  if (scene.placement.active) {
    scene.placementPreview.setPosition(-scene.cam.x, -scene.cam.y);
  }
  if (scene.invDirty) {
    refreshInventoryHud(scene);
    scene.invDirty = false;
  }
  refreshDayTimer(scene);
  refreshHpHud(scene);
  scene.toolText.setText('TOOL: ' + getActiveToolName(scene));
  scene.villagerText.setText('VILLAGERS: ' + scene.villagerCount);
  scene.scoreText.setText('SCORE: ' + (scene.score || 0));

  if (DEBUG_HUD) {
    scene.hud.setText(
      `x ${scene.player.x | 0}  y ${scene.player.y | 0}  ` +
      `tick ${scene.tickCount}  fps ${(1000 / Math.max(delta, 1)) | 0}`,
    );
  }
}

function runTick(scene) {
  handleInput(scene);
  // Title screen + menu + placement mode pause gameplay entirely.
  if (scene.titleOpen) return;
  if (scene.buildMenu.open) return;
  if (scene.placement.active) return;

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
  tickVillagers(scene);

  simulateViewport(scene);
  if (scene.dirtyMineral) {
    resolveMineralStability(scene);
    scene.dirtyMineral = false;
  }
  tickLeafDecay(scene);
  tickFurnaces(scene);
  tickTutorial(scene);
  updateCamera(scene);

  if (scene.nightActive) {
    scene.nightTicksRemaining--;
    if (scene.nightTicksRemaining <= 0) endNight(scene);
  } else {
    scene.dayTime++;
    if (scene.dayTime >= scene.dayLengthTicks) goHome(scene);
  }
}

function endNight(scene) {
  scene.nightActive = false;
  scene.dayTime = 0;
  scene.nightOverlay.setVisible(false);
  scene.daysSurvived++;
  recomputeDayLengths(scene); // day gets 10 s longer, night 5 s
  scene.player.hp = scene.player.maxHp;
  despawnAllMonsters(scene);
  regrowTrees(scene, 4); // compensate for whatever monsters chewed
  syncVillagers(scene, scanVillages(scene));
  // Score = sum of villagers alive at every dawn.
  scene.score = (scene.score || 0) + scene.villagerCount;
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
      // Lava ↔ water contact → both cool into obsidian. Runs ungated so
      // conversion is immediate; check is cheap (early-out on type).
      if (t === LAVA || t === WATER) {
        const opp = t === LAVA ? WATER : LAVA;
        let hit = -1;
        if ((w[idx - WORLD_W] & TYPE_MASK) === opp) hit = idx - WORLD_W;
        else if ((w[idx + WORLD_W] & TYPE_MASK) === opp) hit = idx + WORLD_W;
        else if (x > 1 && (w[idx - 1] & TYPE_MASK) === opp) hit = idx - 1;
        else if (x < WORLD_W - 1 && (w[idx + 1] & TYPE_MASK) === opp) hit = idx + 1;
        if (hit >= 0) {
          w[idx] = OBSIDIAN | MOVED_FLAG;
          w[hit] = OBSIDIAN | MOVED_FLAG;
          damage[idx] = 0; damage[hit] = 0;
          continue;
        }
      }
      const fall = BLOCK_FALL_TICKS[t];
      if (fall === 0) continue;            // AIR or MAGIC
      if (tick % fall !== 0) continue;     // throttle (lava=4 → every 4th tick)
      const cat = BLOCK_CAT[t];
      // MINERAL only falls while flagged isolated. Other physics cats
      // pick up their behavior bitmask from FALL_BEHAVIOR[cat].
      if (cat === CAT_MINERAL && !(cell & FALLING_FLAG)) continue;
      const fb = FALL_BEHAVIOR[cat];
      if (fb !== undefined) tryFall(scene, w, damage, idx, x, tick, t, fb);
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

// Unified fall behavior. Each category gets a bitmask describing which
// of the 4 ordered steps it tries: down → swap-liquid → diagonal-down →
// sideways. SOLID has no flags (only step 1). MINERAL adds FB_FALLING
// to persist FALLING_FLAG and signal the stability BFS.
const FB_DIAGONAL    = 1;
const FB_SIDEWAYS    = 2;
const FB_SWAP_LIQUID = 4;
const FB_FALLING     = 8;

const FALL_BEHAVIOR = new Uint8Array(7);
FALL_BEHAVIOR[CAT_LIQUID]   = FB_DIAGONAL | FB_SIDEWAYS;
FALL_BEHAVIOR[CAT_SANDLIKE] = FB_DIAGONAL | FB_SWAP_LIQUID;
FALL_BEHAVIOR[CAT_SOLID]    = 0;
FALL_BEHAVIOR[CAT_MINERAL]  = FB_DIAGONAL | FB_SWAP_LIQUID | FB_FALLING;

function tryFall(scene, w, damage, idx, x, tick, t, fb) {
  const dIdx = idx + WORLD_W;
  const downCell = w[dIdx];
  const downCat = BLOCK_CAT[downCell & TYPE_MASK];
  const writeFlags = MOVED_FLAG | ((fb & FB_FALLING) ? FALLING_FLAG : 0);
  const dirty = fb & FB_FALLING;

  // 1. Straight down.
  if (downCat === CAT_AIR) {
    w[dIdx] = t | writeFlags; w[idx] = AIR; damage[idx] = 0;
    if (dirty) scene.dirtyMineral = true;
    return;
  }
  // 2. Swap with liquid below (sandlike, mineral).
  if ((fb & FB_SWAP_LIQUID) && downCat === CAT_LIQUID) {
    w[dIdx] = t | writeFlags;
    w[idx] = (downCell & TYPE_MASK) | MOVED_FLAG;
    damage[idx] = 0;
    if (dirty) scene.dirtyMineral = true;
    return;
  }
  const bias = (tick & 1) ? 1 : -1;
  // 3. Diagonal-down with alternating bias.
  if (fb & FB_DIAGONAL) {
    for (let dir = 0; dir < 2; dir++) {
      const dx = (dir === 0) ? bias : -bias;
      const nx = x + dx;
      if (nx < 1 || nx >= WORLD_W - 1) continue;
      if (BLOCK_CAT[w[dIdx + dx] & TYPE_MASK] === CAT_AIR) {
        w[dIdx + dx] = t | writeFlags; w[idx] = AIR; damage[idx] = 0;
        if (dirty) scene.dirtyMineral = true;
        return;
      }
    }
  }
  // 4. Sideways (liquid only).
  if (fb & FB_SIDEWAYS) {
    for (let dir = 0; dir < 2; dir++) {
      const dx = (dir === 0) ? bias : -bias;
      const nx = x + dx;
      if (nx < 1 || nx >= WORLD_W - 1) continue;
      if ((w[idx + dx] & TYPE_MASK) === AIR) {
        w[idx + dx] = t | writeFlags; w[idx] = AIR; damage[idx] = 0;
        return;
      }
    }
  }
}

// ============================================================
//    Mineral stability BFS — generalized from v1's DIRT-only version.
// ============================================================

// Leaves not connected to a trunk (via a chain of WOOD + LEAVES) decay
// after ~3 seconds. Runs every LEAF_SCAN_INTERVAL ticks inside the
// viewport band. Reuses scene.visited / scene.bfsQueue (safe as long as
// this runs strictly after resolveMineralStability in the same tick).
function tickLeafDecay(scene) {
  if ((scene.tickCount % LEAF_SCAN_INTERVAL) !== 0) return;
  const w = scene.world;
  const decay = scene.leafDecay;

  const tx0 = clamp(((scene.cam.x / TILE) | 0) - 2, 1, WORLD_W - 1);
  const ty0 = clamp(((scene.cam.y / TILE) | 0) - 2, 1, WORLD_H - 1);
  const tx1 = clamp(tx0 + VW + 4, 1, WORLD_W - 1);
  const ty1 = clamp(ty0 + VH + 4, 1, WORLD_H - 1);

  const visited = scene.visited;
  scene.visitedTag = (scene.visitedTag + 1) & 0xff;
  if (scene.visitedTag === 0) { visited.fill(0); scene.visitedTag = 1; }
  const tag = scene.visitedTag;
  const queue = scene.bfsQueue;
  let qh = 0, qt = 0;

  // Seed from every WOOD tile in the band.
  for (let y = ty0; y < ty1; y++) {
    const row = y * WORLD_W;
    for (let x = tx0; x < tx1; x++) {
      const idx = row + x;
      if ((w[idx] & TYPE_MASK) === WOOD && visited[idx] !== tag) {
        visited[idx] = tag;
        queue[qt++] = idx;
      }
    }
  }

  // BFS through WOOD + LEAVES chains.
  while (qh < qt) {
    const idx = queue[qh++];
    const x = idx % WORLD_W;
    const y = (idx / WORLD_W) | 0;
    if (x < tx0 || x >= tx1 || y < ty0 || y >= ty1) continue;
    const nbrs = [idx - 1, idx + 1, idx - WORLD_W, idx + WORLD_W];
    for (let i = 0; i < 4; i++) {
      const n = nbrs[i];
      if (n < 0 || n >= w.length) continue;
      if (visited[n] === tag) continue;
      const t = w[n] & TYPE_MASK;
      if (t !== WOOD && t !== LEAVES) continue;
      if (qt < queue.length) {
        visited[n] = tag;
        queue[qt++] = n;
      }
    }
  }

  // For each LEAVES tile in the band: reset decay if reached, else bump
  // the counter and evaporate at the threshold.
  for (let y = ty0; y < ty1; y++) {
    const row = y * WORLD_W;
    for (let x = tx0; x < tx1; x++) {
      const idx = row + x;
      if ((w[idx] & TYPE_MASK) !== LEAVES) continue;
      if (visited[idx] === tag) {
        decay[idx] = 0;
      } else if (++decay[idx] >= LEAF_DECAY_THRESHOLD) {
        w[idx] = AIR;
        decay[idx] = 0;
      }
    }
  }
}

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
        // Mineral is anchored if it's on the band border, OR sitting on
        // any solid tile (dirt/sand/gravel/bricks/magic). This matches
        // intuition: a stone chunk resting on sand doesn't fall just
        // because it isn't in a pure mineral chain.
        const onBorder = x === tx0 || x === tx1 - 1 || y === ty0 || y === ty1 - 1;
        const belowIdx = idx + WORLD_W;
        const restsOnSolid = belowIdx < w.length && isSolidForPlayer(w[belowIdx]);
        if ((onBorder || restsOnSolid) && visited[idx] !== tag) {
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

  // Title screen: U starts the game and kicks off the tutorial.
  if (scene.titleOpen) {
    if (c.pressed.P1_1) {
      c.pressed.P1_1 = false;
      scene.titleOpen = false;
      scene.titleContainer.setVisible(false);
      setTutorialStep(scene, 1);
      startMusic(scene); // U press counts as user gesture → unsuspends audio
    }
    c.pressed.P1_2 = false; c.pressed.P1_3 = false; c.pressed.P1_U = false;
    return;
  }

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

  // Placement mode (after picking a building recipe) absorbs input until
  // the player confirms with U or cancels with I / START.
  if (scene.placement.active) {
    handlePlacementInput(scene);
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

  // P1_3 (O): double-press to fast-forward to night (day) or sleep in a
  // bed (night). First press shows a confirmation prompt; second press
  // within ~1s commits. Sleep is limited to once per night.
  if (c.pressed.P1_3) {
    c.pressed.P1_3 = false;
    handleOPress(scene);
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
    if (scene.player.onGround || liquidStatus(scene, scene.player).inAnyLiquid) {
      scene.player.vy = JUMP_VELOCITY;
      scene.player.onGround = false;
    }
  }
  c.pressed.P1_U = false;

  // U (P1_1) — single press fires immediately; holding U auto-repeats
  // 4 times per second (every 15 ticks). Day: mine. Night: sword swing.
  if (c.held.P1_1) scene.holdU = (scene.holdU || 0) + 1;
  else scene.holdU = 0;
  if (c.pressed.P1_1 || scene.holdU >= 15) {
    c.pressed.P1_1 = false;
    scene.holdU = 0;
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
    damage[idx] = Math.min(65535, damage[idx] + TIER_DAMAGE[getActiveTier(scene)]);
    if (damage[idx] >= hard) {
      w[idx] = AIR;
      damage[idx] = 0;
      scene.dirtyMineral = true;
      // SFX by tile category: picota for minerals+structures, thud for
      // solids, crunchy for sandlike, hacha for wood.
      const cat = BLOCK_CAT[t];
      if (t === WOOD)                                    sfx(scene, 'mineWood');
      else if (cat === CAT_MINERAL || cat === CAT_MAGIC) sfx(scene, 'mineMineral');
      else if (cat === CAT_SANDLIKE)                     sfx(scene, 'mineSand');
      else                                               sfx(scene, 'mineSolid');
      // Drops are configured per block; bricks/doors/stairs return their
      // original raw material × 10 instead of the placed tile itself.
      const dropT = BLOCK_DROP_TYPE[t];
      const dropN = BLOCK_DROP_AMOUNT[t];
      scene.inventory[dropT] = Math.min(65535, scene.inventory[dropT] + dropN);
      if (!scene.discovered[dropT]) {
        scene.discovered[dropT] = 1;
        showToast(scene, BLOCK_NAME[dropT].toUpperCase() + '!');
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

  // Stair ladder behaviour: if any STAIR tile overlaps the player AABB,
  // hold → override gravity and move up/down at CLIMB_SPEED. Releasing
  // keeps you suspended on the stair (vy=0). Horizontal input still works.
  const onStair = playerOverlapsStair(scene);
  if (onStair) {
    const CLIMB_SPEED = 1.5;
    const c = scene.controls;
    if (c.held.P1_U)      p.vy = -CLIMB_SPEED;
    else if (c.held.P1_D) p.vy = CLIMB_SPEED;
    else                   p.vy = 0;
  } else {
    p.vy += GRAVITY;
    if (p.vy > TERMINAL_VY) p.vy = TERMINAL_VY;
    if (p.vy < -8) p.vy = -8;
  }

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
    if (collidesBox(scene, p.x, p.y, p.w, p.h)) { p.x -= sx; p.vx = 0; }
    p.y += sy;
    if (collidesBox(scene, p.x, p.y, p.w, p.h)) {
      p.y -= sy;
      if (sy > 0) {
        p.onGround = true;
        // Snap to tile boundary so AABB never carries a sub-tile fraction.
        p.y = Math.ceil(p.y / TILE) * TILE;
      }
      p.vy = 0;
    } else if (sy > 0) {
      p.onGround = false;
    }
  }

  // Cave-in protection: if a tile spawned on top of player, shove up.
  let safety = 0;
  while (collidesBox(scene, p.x, p.y, p.w, p.h) && safety < 24) {
    p.y -= 1; p.vy = 0; safety++;
  }

  // Refresh ground status by probing 1 px below.
  p.y += 1;
  p.onGround = collidesBox(scene, p.x, p.y, p.w, p.h);
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
      const st = liquidStatus(scene, scene.player);
      if (!st.touchingWater) {
        const dmg = (fallPx / FALL_DAMAGE_PX) | 0;
        applyPlayerDamage(scene, dmg);
      }
    }
    p.peakY = p.y;
  }
}

// Player passes through doors + stairs + beds (beds + stairs feel like
// furniture: you stand inside the tile).
function isSolidForPlayer(cell) {
  const t = cell & TYPE_MASK;
  if (t === DOOR_WOOD || t === STAIR_WOOD ||
      t === BED_WOOD || t === BED_IRON || t === FURNACE) return false;
  const cat = BLOCK_CAT[t];
  return cat !== CAT_AIR && cat !== CAT_LIQUID && cat !== CAT_DECOR;
}

// Monsters: doors + beds block them (shelter); stairs are passable (they
// can't climb anyway).
function isSolidForMonster(cell) {
  const t = cell & TYPE_MASK;
  if (t === STAIR_WOOD) return false;
  const cat = BLOCK_CAT[t];
  return cat !== CAT_AIR && cat !== CAT_LIQUID && cat !== CAT_DECOR;
}

// Returns the bed type (BED_WOOD / BED_IRON) overlapping the player, or 0.
function playerOverlapsBed(scene) {
  const w = scene.world;
  const p = scene.player;
  const halfW = p.w / 2;
  const x0 = ((p.x - halfW) / TILE) | 0;
  const x1 = ((p.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((p.y - p.h) / TILE) | 0;
  const y1 = ((p.y - 0.001) / TILE) | 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) continue;
      const t = w[y * WORLD_W + x] & TYPE_MASK;
      if (t === BED_WOOD || t === BED_IRON) return t;
    }
  }
  return 0;
}

// Double-press O: first press prompts, second press within ~1s commits.
function handleOPress(scene) {
  const night = scene.nightActive;
  const bed = night ? playerOverlapsBed(scene) : 0;
  if (night ? (scene.sleptThisNight || !bed) : (scene.dayTime < scene.dayLengthTicks / 2))
    return showToast(scene, night ? 'NO BED / SLEPT' : 'NOT TIRED');
  const now = scene.tickCount | 0;
  if (scene.oArmed && now <= scene.oArmedUntil) {
    scene.oArmed = false;
    if (night) {
      scene.nightTicksRemaining -= bed === BED_IRON ? (scene.nightLengthTicks / 2) | 0 : 30 * TICK_RATE;
      scene.sleptThisNight = true;
      scene.everSlept = true;
      scene.home.x = scene.player.x; scene.home.y = scene.player.y;
      showToast(scene, 'ZZZ...');
    } else goHome(scene);
    return;
  }
  showToast(scene, night ? 'O AGAIN: SLEEP' : 'O AGAIN: SKIP');
  scene.oArmed = true;
  scene.oArmedUntil = now + TICK_RATE;
}

function playerOverlapsStair(scene) {
  const w = scene.world;
  const p = scene.player;
  const halfW = p.w / 2;
  const x0 = ((p.x - halfW) / TILE) | 0;
  const x1 = ((p.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((p.y - p.h) / TILE) | 0;
  const y1 = ((p.y - 0.001) / TILE) | 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) continue;
      if ((w[y * WORLD_W + x] & TYPE_MASK) === STAIR_WOOD) return true;
    }
  }
  return false;
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

// Richer liquid status: works for any entity with {x, y, w, h}.
// Used by hazards (player + villagers), swim-jump, fall-damage cancel.
function liquidStatus(scene, e) {
  const w = scene.world;
  const halfW = e.w / 2;
  const x0 = ((e.x - halfW) / TILE) | 0;
  const x1 = ((e.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((e.y - e.h) / TILE) | 0;
  const y1 = ((e.y - 0.001) / TILE) | 0;
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
  const st = liquidStatus(scene, scene.player);

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

  if (st.touchingWater && !p.wasInWater) sfx(scene, 'splash');
  p.wasInWater = st.touchingWater;
}

function applyPlayerDamage(scene, amt) {
  if (scene.gameOver || amt <= 0) return;
  const p = scene.player;
  p.hp -= amt;
  // Visual feedback for ANY damage (drown, lava, fall, monster touch).
  p.flashTicks = PLAYER_FLASH_TICKS;
  sfx(scene, 'playerHurt');
  if (p.hp <= 0) {
    p.hp = 0;
    onPlayerDeath(scene);
  }
}

function onPlayerDeath(scene) {
  if (scene.gameOver) return;
  scene.gameOver = true;
  scene.deathModal.statsText.setText(
    'SCORE: ' + (scene.score || 0) + '\nDAYS: ' + scene.daysSurvived,
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

// Multiply each RGB channel of a packed 0xAABBGGRR color by `f`. Clamps
// to [0,255] so it serves both darken (f<1) and lighten (f>1).
function tintColor(c, f) {
  let b = (((c >>> 16) & 0xff) * f) | 0; if (b > 255) b = 255;
  let g = (((c >>> 8) & 0xff) * f) | 0;  if (g > 255) g = 255;
  let r = ((c & 0xff) * f) | 0;          if (r > 255) r = 255;
  return (c & 0xff000000) | (b << 16) | (g << 8) | r;
}

function render(scene) {
  // Sky color drives AIR each frame.
  BLOCK_COLOR[AIR] = getSkyColor(scene);

  const w = scene.world;
  const damage = scene.damage;
  const px = scene.pixels;
  const SUB = TILE;
  const TW = VW + 2;
  const TH = VH + 2;
  const PXW = TW * SUB;
  const camTx = ((scene.cam.x / TILE) | 0) - 1;
  const camTy = ((scene.cam.y / TILE) | 0) - 1;
  const sky = BLOCK_COLOR[AIR];

  for (let vy = 0; vy < TH; vy++) {
    const wy = camTy + vy;
    const outOfRangeY = wy < 0 || wy >= WORLD_H;
    const rowW = wy * WORLD_W;
    for (let vx = 0; vx < TW; vx++) {
      const wx = camTx + vx;
      let baseColor, pattern = 0;
      if (outOfRangeY || wx < 0 || wx >= WORLD_W) {
        baseColor = sky;
      } else {
        const idx = rowW + wx;
        const t = w[idx] & TYPE_MASK;
        const flags = BLOCK_FLAGS[t];
        baseColor = BLOCK_COLOR[t];
        if (t === DIRT && wy > 0 && (w[idx - WORLD_W] & TYPE_MASK) === AIR) {
          baseColor = GRASS_COLOR;
        }
        const dmg = damage[idx];
        if (dmg > 0) {
          const hard = BLOCK_HARDNESS[t];
          if (hard > 0) {
            let factor = 1 - 0.45 * dmg / hard;
            if (factor < 0) factor = 0;
            baseColor = tintColor(baseColor, factor);
          }
        }
        if (flags & F_IS_BRICK) pattern = 1;
        else if (flags & F_IS_VEIN) pattern = 2;
      }

      // Write SUB×SUB pixels for this tile.
      const startPx = (vy * SUB) * PXW + vx * SUB;
      if (pattern === 0) {
        for (let py = 0; py < SUB; py++) {
          const off = startPx + py * PXW;
          for (let dx = 0; dx < SUB; dx++) px[off + dx] = baseColor;
        }
      } else if (pattern === 1) {
        const edge = tintColor(baseColor, 0.6);
        for (let py = 0; py < SUB; py++) {
          const off = startPx + py * PXW;
          const edgeRow = py === 0 || py === SUB - 1;
          for (let dx = 0; dx < SUB; dx++) {
            px[off + dx] = (edgeRow || dx === 0 || dx === SUB - 1) ? edge : baseColor;
          }
        }
      } else {
        // Vein: full tile in mineral color + brighter 4×4 inset spot.
        const spot = tintColor(baseColor, 1.6);
        for (let py = 0; py < SUB; py++) {
          const off = startPx + py * PXW;
          for (let dx = 0; dx < SUB; dx++) px[off + dx] = baseColor;
        }
        for (let py = 3; py < 7; py++) {
          const off = startPx + py * PXW;
          for (let dx = 3; dx < 7; dx++) px[off + dx] = spot;
        }
      }
    }
  }

  scene.texCtx.putImageData(scene.imgData, 0, 0);
  scene.tex.refresh();
  scene.worldImg.setPosition(
    camTx * TILE - scene.cam.x,
    camTy * TILE - scene.cam.y,
  );
}

// ----- Human visual (shared by player and villagers): legs, body, head, eye.

function buildHumanVisual(scene, depth, bodyColor) {
  const c = scene.add.container(0, 0).setDepth(depth);
  const parts = {};
  parts.legs = scene.add.rectangle(0, -3, 10, 6, 0x2a3148);
  parts.body = scene.add.rectangle(0, -13, 14, 12, bodyColor);
  parts.head = scene.add.rectangle(0, -20, 12, 10, 0xe4b593);
  parts.eye  = scene.add.rectangle(2, -20, 3, 3, 0x101018);
  for (const k in parts) c.add(parts[k]);
  return { c, parts };
}

function buildPlayerVisual(scene) {
  const { c, parts } = buildHumanVisual(scene, 10, 0xc23a2a);
  parts.pickHandle = scene.add.rectangle(0, -14, 12, 2, 0x6b4226).setOrigin(0, 0.5);
  parts.pickHead   = scene.add.rectangle(12, -14, 4, 5, 0xb0b0b0);
  parts.pickHandle.visible = false;
  parts.pickHead.visible = false;
  c.add(parts.pickHandle);
  c.add(parts.pickHead);
  scene.playerContainer = c;
  scene.playerParts = parts;
}

// Mine swing pose table indexed by (mineDy + 1) → [hx, hy, angleStart, angleSweep].
const SWING_POSES = [
  [3, -19,  30, -110],
  [5, -14, -60,  120],
  [3, -10, -30,  110],
];

function updatePlayerVisual(scene) {
  const p = scene.player;
  const parts = scene.playerParts;
  const c = scene.playerContainer;
  c.setPosition(p.x - scene.cam.x, p.y - scene.cam.y);
  c.setAlpha(p.flashTicks > 0 && (p.flashTicks & 4) ? 0.25 : 1);

  const flip = scene.facing < 0 ? -1 : 1;
  parts.eye.x = flip * 3;

  let bob = 0;
  parts.legs.scaleY = 1;
  parts.body.scaleY = 1;
  if (Math.abs(p.vx) > 0.05 && p.onGround) {
    scene.walkPhase += 0.32;
    const s = Math.sin(scene.walkPhase);
    parts.legs.scaleY = 1 - Math.abs(s) * 0.25;
    bob = -Math.abs(s) * 0.7;
  } else if (!p.onGround && p.vy < -0.1) {
    parts.body.scaleY = 1.08; bob = -1;
  } else if (!p.onGround && p.vy > 0.1) {
    parts.body.scaleY = 0.95; bob = 1;
  }
  parts.body.y = -13 + bob;
  parts.head.y = -20 + bob;
  parts.eye.y  = -20 + bob;

  if (scene.mineAnim > 0) {
    const t = (14 - scene.mineAnim) / 14;
    const swing = Math.sin(t * Math.PI);
    parts.pickHandle.visible = true;
    parts.pickHead.visible = true;
    const pose = SWING_POSES[scene.mineDy + 1];
    const a = pose[2] + swing * pose[3];
    parts.pickHandle.x = flip * pose[0];
    parts.pickHandle.y = pose[1];
    parts.pickHandle.scaleX = flip;
    parts.pickHandle.angle = a;
    const rad = a * Math.PI / 180;
    parts.pickHead.x = flip * (pose[0] + Math.cos(rad) * 12);
    parts.pickHead.y = pose[1] + Math.sin(rad) * 12;
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
    : Math.min(1, scene.dayTime / scene.dayLengthTicks);
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
  // Stats backdrop + 5 stacked single-line readouts.
  scene.add.rectangle(4, 4, 168, 74, 0x0a0d18, 0.7).setOrigin(0).setDepth(19);
  const STATS = [
    ['toolText',     6, '#ffe066'],
    ['dayText',     20, '#a0c8ff'],
    ['hpText',      34, '#ff6666'],
    ['villagerText',48, '#a0e0a0'],
    ['scoreText',   62, '#ffe066'],
  ];
  for (const [k, y, color] of STATS) {
    scene[k] = scene.add.text(8, y, '', {
      fontFamily: 'monospace', fontSize: '11px', color,
    }).setDepth(20);
  }

  scene.invHud = { container: scene.add.container(8, 80).setDepth(20), rows: [] };

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
  buildPlacementUi(scene);
  buildDeathModalUi(scene);
  buildTutorialUi(scene);
  buildTitleUi(scene);
  scene.titleOpen = true;
  scene.tutorial = { step: 0, finalDismissTick: 0 };
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

// ----- Title screen -----

function buildTitleUi(scene) {
  const c = scene.add.container(0, 0).setDepth(55);
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x050810, 0.92));
  c.add(
    scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 80, 'STRIKE AND STONE', {
      fontFamily: 'monospace', fontSize: '40px', color: '#ffe066', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5),
  );
  c.add(
    scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 30, 'a falling-sand miner', {
      fontFamily: 'monospace', fontSize: '14px', color: '#a0c8ff',
    }).setOrigin(0.5),
  );
  c.add(
    scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 40, 'PRESS U TO START', {
      fontFamily: 'monospace', fontSize: '16px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5),
  );
  c.add(
    scene.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 78,
      'A/D move   W jump   U mine/attack   I menu   O home/sleep', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7a7a82',
    }).setOrigin(0.5),
  );
  scene.titleContainer = c;
}

// ----- Tutorial banner -----

function buildTutorialUi(scene) {
  // Compact banner near the top, narrow enough to leave the left-column
  // stats visible.
  const c = scene.add.container(GAME_WIDTH / 2, 18).setDepth(30);
  c.setVisible(false);
  const bg = scene.add.rectangle(0, 0, 460, 26, 0x0a0d18, 0.88).setOrigin(0.5);
  bg.setStrokeStyle(2, 0xffe066);
  const text = scene.add.text(0, 0, '', {
    fontFamily: 'monospace', fontSize: '11px', color: '#ffe066',
    fontStyle: 'bold', align: 'center', lineSpacing: 2,
  }).setOrigin(0.5);
  c.add(bg);
  c.add(text);
  scene.tutorialContainer = c;
  scene.tutorialText = text;
}

function setTutorialStep(scene, step) {
  scene.tutorial.step = step;
  const txt = TUTORIAL_STEPS[step];
  if (txt) {
    scene.tutorialText.setText(txt);
    const c = scene.tutorialContainer;
    c.setVisible(true);
    // Pop big & centered, then shrink up after 2s so it doesn't block stats.
    c.setScale(1.7); c.y = 70;
    scene.tweens.killTweensOf(c);
    scene.tweens.add({
      targets: c, scaleX: 1, scaleY: 1, y: 18,
      duration: 350, delay: 2000, ease: 'Quad.easeIn',
    });
    if (step === TUTORIAL_FINAL_STEP) {
      scene.tutorial.finalDismissTick = scene.tickCount + TUTORIAL_FINAL_HOLD_TICKS;
    }
  } else {
    scene.tutorialContainer.setVisible(false);
  }
}

function tickTutorial(scene) {
  const t = scene.tutorial;
  if (t.step === 0 || t.step >= TUTORIAL_STEPS.length - 1) return;
  const inv = scene.inventory;
  if (t.step === 1 && inv[WOOD] >= 1) { setTutorialStep(scene, 2); return; }
  if (t.step === 2 && inv[WOOD] >= 10) { setTutorialStep(scene, 3); return; }
  if (t.step === 3 && scene.pick >= TIER_WOOD) { setTutorialStep(scene, 4); return; }
  if (t.step === 4 && scene.basePlaced) { setTutorialStep(scene, 5); return; }
  if (t.step === 5 && scene.bedPlaced) { setTutorialStep(scene, 6); return; }
  if (t.step === 6 && scene.everSlept) { setTutorialStep(scene, 7); return; }
  if (t.step === 7 && scene.smeltedAny) { setTutorialStep(scene, 8); return; }
  if (t.step === 8 && scene.villagerCount >= 1) { setTutorialStep(scene, 9); return; }
  if (t.step === TUTORIAL_FINAL_STEP && scene.tickCount >= t.finalDismissTick) {
    setTutorialStep(scene, TUTORIAL_FINAL_STEP + 1);
  }
}

function refreshHpHud(scene) {
  const p = scene.player;
  const filled = '|'.repeat(p.hp);
  const empty = '.'.repeat(p.maxHp - p.hp);
  scene.hpText.setText('HP ' + p.hp + '/' + p.maxHp + ' [' + filled + empty + ']');
}

function refreshDayTimer(scene) {
  const night = scene.nightActive;
  const remainingTicks = Math.max(0,
    night ? scene.nightTicksRemaining : scene.dayLengthTicks - scene.dayTime);
  const totalSec = remainingTicks / TICK_RATE;
  const mm = Math.floor(totalSec / 60);
  const ss = Math.floor(totalSec % 60);
  scene.dayText.setText((night ? 'NIGHT ' : 'DAY ') + mm + ':' + (ss < 10 ? '0' : '') + ss);
  scene.dayText.setColor(night ? '#8888ff' : '#a0c8ff');
}

function recomputeDayLengths(scene) {
  const secs = DAY_BASE_SECONDS + (scene.daysSurvived - 1) * DAY_INCREMENT_SECONDS;
  scene.dayLengthTicks = secs * TICK_RATE;
  scene.nightLengthTicks = (scene.dayLengthTicks / 2) | 0;
}

function goHome(scene) {
  scene.player.x = scene.home.x;
  scene.player.y = scene.home.y;
  scene.player.vx = 0;
  scene.player.vy = 0;
  scene.nightActive = true;
  scene.nightTicksRemaining = scene.nightLengthTicks;
  scene.nightOverlay.setVisible(true);
  scene.sleptThisNight = false;
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

const BUILD_MENU_ROW_COUNT = 15;
const BUILD_MENU_ROW_STEP = 18;

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

// Build the cost string shown in the menu. Tools use the old `cost` array;
// buildings use `costPerTile` / `costTotal` + `material`.
function recipeCostLabel(recipe) {
  if (recipe.cost) {
    let s = '';
    for (let k = 0; k < recipe.cost.length; k++) {
      const [id, amt] = recipe.cost[k];
      s += (k > 0 ? ' + ' : '') + amt + ' ' + BLOCK_NAME[id].toUpperCase();
    }
    return s;
  }
  const matName = BLOCK_NAME[recipe.material].toUpperCase();
  const amt = recipe.costPerTile != null ? recipe.costPerTile : recipe.costTotal;
  return amt != null ? amt + ' ' + matName : '';
}

// Does the player have enough materials right now? Works for both schemas.
function recipeAffordable(scene, recipe) {
  const inv = scene.inventory;
  if (recipe.cost) {
    for (const [id, amt] of recipe.cost) if (inv[id] < amt) return false;
    return true;
  }
  // Building recipe: min cost is one unit's worth; resizable ones eat
  // more at placement time, checked again in attemptPlacement.
  const minCost = recipe.costTotal != null ? recipe.costTotal : recipe.costPerTile * (PLACEMENT_DEFAULTS[recipe.kind].minW * PLACEMENT_DEFAULTS[recipe.kind].minH);
  return inv[recipe.material] >= minCost;
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
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 460, 470, 0x1a2238).setStrokeStyle(2, 0xffe066));

  c.add(
    scene.add.text(GAME_WIDTH / 2, 108, 'BUILD', {
      fontFamily: 'monospace', fontSize: '22px', color: '#ffe066', fontStyle: 'bold',
    }).setOrigin(0.5),
  );

  // Tab headers (active tab is highlighted; switch with L/R).
  scene.buildMenuTabs = {};
  scene.buildMenuTabs.tools = scene.add
    .text(GAME_WIDTH / 2 - 80, 140, '< TOOLS', {
      fontFamily: 'monospace', fontSize: '13px', color: '#ffe066', fontStyle: 'bold',
    })
    .setOrigin(0.5);
  scene.buildMenuTabs.buildings = scene.add
    .text(GAME_WIDTH / 2 + 80, 140, 'BUILDINGS >', {
      fontFamily: 'monospace', fontSize: '13px', color: '#7a7a82', fontStyle: 'bold',
    })
    .setOrigin(0.5);
  c.add(scene.buildMenuTabs.tools);
  c.add(scene.buildMenuTabs.buildings);

  // Row slots accommodate the largest tab (buildings). Tighter step so
  // all 15 recipes fit. Unused rows hidden when on TOOLS tab.
  scene.buildMenuRows = [];
  for (let i = 0; i < BUILD_MENU_ROW_COUNT; i++) {
    const row = {};
    const y = 165 + i * BUILD_MENU_ROW_STEP;
    row.bg = scene.add.rectangle(GAME_WIDTH / 2, y, 420, BUILD_MENU_ROW_STEP - 2, 0x2a3555, 0).setOrigin(0.5);
    row.text = scene.add.text(GAME_WIDTH / 2 - 195, y, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#ffffff',
    }).setOrigin(0, 0.5);
    row.strike = scene.add.rectangle(GAME_WIDTH / 2, y, 380, 1, 0x808080, 0).setOrigin(0.5);
    c.add(row.bg);
    c.add(row.text);
    c.add(row.strike);
    scene.buildMenuRows.push(row);
  }

  c.add(
    scene.add.text(GAME_WIDTH / 2, 460,
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
  const recipes = getCurrentRecipes(scene);

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

    const canAfford = recipeAffordable(scene, recipe);
    row.text.setText(recipe.name.padEnd(15) + recipeCostLabel(recipe));

    const locked = isRecipeLocked(scene, recipe);
    let color;
    if (locked)        color = '#5a5a5a';
    else if (!canAfford) color = '#7a7a82';
    else                 color = '#ffffff';
    row.text.setColor(color);

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
  // Generic cost check for tool recipes (they carry a `recipe.cost`
  // array). Building recipes validate affordability in attemptPlacement
  // once the player has chosen final size.
  if (recipe.cost) {
    for (const [id, amt] of recipe.cost) {
      if (inv[id] < amt) {
        showToast(scene, 'NOT ENOUGH!');
        return;
      }
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

  // Building recipe → enter interactive placement mode (menu closes, world
  // stays paused; player positions + resizes a preview and confirms with U).
  if (recipe.kind) {
    closeBuildMenu(scene);
    enterPlacement(scene, recipe);
    return;
  }
}

// ============================================================
// 10.7. Interactive placement mode
// ============================================================
//
// After picking a building recipe, the menu closes but the world stays
// paused. The player moves a ghost preview with L/R, resizes it with
// U/D (if the recipe is resizable), and confirms with U to write tiles
// and consume materials. I / START cancels.

// Any placed-building tile — bricks, furniture, doors, stairs. These
// can all be built on top of (they provide support for the next layer).
function isStructuralTile(cell) {
  const t = cell & TYPE_MASK;
  return t === BRICK_DIRT || t === BRICK_STONE || t === BRICK_COPPER || t === BRICK_IRON ||
    t === OBSIDIAN || t === FURNACE || t === DOOR_WOOD ||
    t === STAIR_WOOD || t === BED_WOOD || t === BED_IRON;
}

function enterPlacement(scene, recipe) {
  const cfg = PLACEMENT_DEFAULTS[recipe.kind];
  const p = scene.player;
  // Start the preview centered in front of the player so they can see it.
  const startCenterTx = Math.round(p.x / TILE) + scene.facing * 2;
  const p_ = scene.placement;
  p_.active = true;
  p_.recipe = recipe;
  p_.w = cfg.minW;
  p_.h = cfg.minH;
  p_.tx = clamp(startCenterTx - ((p_.w / 2) | 0), 1, WORLD_W - p_.w - 1);
  p_.ty = 0; // recalculated in refreshPlacement
  p_.valid = false;
  scene.placementPreview.setVisible(true);
  refreshPlacement(scene);
}

function exitPlacement(scene) {
  scene.placement.active = false;
  scene.placementPreview.setVisible(false);
}

// Scan a horizontal range [tx0, tx1] and return the highest (lowest y
// value) tile row that can support a base. A tile supports a base if it
// is solid-for-player OR a placed-building tile (doors/stairs/beds let
// the player build above them). Returns -1 if nothing supports anywhere.
function highestSupportInRange(scene, tx0, tx1, searchCeiling) {
  const w = scene.world;
  let highest = -1;
  const topY = Math.max(1, searchCeiling | 0);
  for (let x = tx0; x <= tx1; x++) {
    if (x < 1 || x >= WORLD_W - 1) continue;
    for (let y = topY; y < WORLD_H - 1; y++) {
      const cell = w[y * WORLD_W + x];
      if (isSolidForPlayer(cell) || isStructuralTile(cell)) {
        if (highest < 0 || y < highest) highest = y;
        break;
      }
    }
  }
  return highest;
}

// Compute ty + validity for the current placement state.
function refreshPlacement(scene) {
  const w = scene.world;
  const p_ = scene.placement;
  const recipe = p_.recipe;

  // Player feet row drives the wall/stair/door/bed/furnace search so they
  // anchor on whichever floor the player is standing on (own floor, roof
  // when climbed onto it, etc.) instead of always snapping to the highest
  // structure in the column. BASE keeps the global search so a tall wall
  // can receive a roof placed alongside it.
  const feetTy = ((scene.player.y - 0.001) / TILE) | 0;

  // Derive ty from the anchor rule for this kind.
  let valid = true;
  if (recipe.kind === 'base') {
    const support = highestSupportInRange(scene, p_.tx, p_.tx + p_.w - 1, 0);
    if (support < 0) {
      valid = false;
      p_.ty = feetTy; // fallback for preview
    } else {
      p_.ty = support - 1; // base sits one row above support
    }
  } else {
    // wall/stair/door/bed/furnace: bottom must sit on a structural tile
    // (brick / existing door / stair / bed / furnace) — or solid floor
    // for furnace, which traditionally sits directly on the ground.
    const maxBottom = WORLD_H - 2;
    let bestY = -1;
    for (let y = feetTy; y < maxBottom; y++) {
      let allSupported = true;
      for (let x = p_.tx; x < p_.tx + p_.w; x++) {
        if (x < 1 || x >= WORLD_W - 1) { allSupported = false; break; }
        const belowCell = w[(y + 1) * WORLD_W + x];
        const ok = isStructuralTile(belowCell)
          || (recipe.kind === 'furnace' && isSolidForPlayer(belowCell));
        if (!ok) { allSupported = false; break; }
      }
      if (allSupported) { bestY = y; break; }
    }
    if (bestY < 0) { valid = false; p_.ty = ((scene.player.y - 0.001) / TILE) | 0; }
    else p_.ty = bestY;
  }

  // Check every preview cell is AIR.
  for (let x = p_.tx; x < p_.tx + p_.w && valid; x++) {
    for (let y = p_.ty - p_.h + 1; y <= p_.ty && valid; y++) {
      if (x < 1 || x >= WORLD_W - 1 || y < 1 || y >= WORLD_H - 1) { valid = false; break; }
      const t = w[y * WORLD_W + x] & TYPE_MASK;
      if (t !== AIR) valid = false;
    }
  }

  // Player must not be inside the placement area.
  if (valid) {
    const pxMin = scene.player.x - scene.player.w / 2;
    const pxMax = scene.player.x + scene.player.w / 2;
    const pyMin = scene.player.y - scene.player.h;
    const pyMax = scene.player.y;
    const bxMin = p_.tx * TILE;
    const bxMax = (p_.tx + p_.w) * TILE;
    const byMin = (p_.ty - p_.h + 1) * TILE;
    const byMax = (p_.ty + 1) * TILE;
    if (pxMin < bxMax && pxMax > bxMin && pyMin < byMax && pyMax > byMin) {
      valid = false;
    }
  }

  // Enough materials?
  if (valid) {
    const needed = recipe.costTotal != null
      ? recipe.costTotal
      : recipe.costPerTile * p_.w * p_.h;
    if (scene.inventory[recipe.material] < needed) valid = false;
  }

  p_.valid = valid;
  drawPlacementPreview(scene);
}

function drawPlacementPreview(scene) {
  const p_ = scene.placement;
  const pool = scene.placementPreviewCells;
  const color = p_.valid ? 0x40ff60 : 0xff4040;
  let i = 0;
  for (let x = p_.tx; x < p_.tx + p_.w; x++) {
    for (let y = p_.ty - p_.h + 1; y <= p_.ty; y++) {
      if (i >= pool.length) break;
      const cell = pool[i++];
      cell.visible = true;
      cell.fillColor = color;
      cell.x = x * TILE + TILE / 2;
      cell.y = y * TILE + TILE / 2;
    }
  }
  for (; i < pool.length; i++) pool[i].visible = false;
}

function handlePlacementInput(scene) {
  const c = scene.controls;
  const p_ = scene.placement;
  const cfg = PLACEMENT_DEFAULTS[p_.recipe.kind];

  if (c.pressed.P1_2 || c.pressed.START1) {
    c.pressed.P1_2 = false; c.pressed.START1 = false;
    exitPlacement(scene);
    return;
  }
  if (c.pressed.P1_1) {
    c.pressed.P1_1 = false;
    attemptPlacement(scene);
    return;
  }
  if (c.pressed.P1_L) { c.pressed.P1_L = false; p_.tx = clamp(p_.tx - 1, 1, WORLD_W - p_.w - 1); }
  if (c.pressed.P1_R) { c.pressed.P1_R = false; p_.tx = clamp(p_.tx + 1, 1, WORLD_W - p_.w - 1); }
  if (cfg.resize === 'w') {
    if (c.pressed.P1_U) { c.pressed.P1_U = false; p_.w = Math.min(cfg.maxW, p_.w + 1); p_.tx = Math.min(p_.tx, WORLD_W - p_.w - 1); }
    if (c.pressed.P1_D) { c.pressed.P1_D = false; p_.w = Math.max(cfg.minW, p_.w - 1); }
  } else if (cfg.resize === 'h') {
    if (c.pressed.P1_U) { c.pressed.P1_U = false; p_.h = Math.min(cfg.maxH, p_.h + 1); }
    if (c.pressed.P1_D) { c.pressed.P1_D = false; p_.h = Math.max(cfg.minH, p_.h - 1); }
  } else {
    c.pressed.P1_U = false; c.pressed.P1_D = false;
  }
  c.pressed.P1_3 = false;
  refreshPlacement(scene);
}

function attemptPlacement(scene) {
  const p_ = scene.placement;
  if (!p_.valid) { showToast(scene, 'INVALID!'); return; }
  const recipe = p_.recipe;
  const cost = recipe.costTotal != null ? recipe.costTotal : recipe.costPerTile * p_.w * p_.h;
  if (scene.inventory[recipe.material] < cost) { showToast(scene, 'NOT ENOUGH!'); return; }
  scene.inventory[recipe.material] -= cost;

  const w = scene.world;
  for (let x = p_.tx; x < p_.tx + p_.w; x++) {
    for (let y = p_.ty - p_.h + 1; y <= p_.ty; y++) {
      w[y * WORLD_W + x] = recipe.tile;
    }
  }

  // Furnace instance tracking (a 2×2 of FURNACE tiles + proximity state).
  if (recipe.kind === 'furnace') {
    const indicator = scene.add.rectangle(0, 0, 6, 6, 0xff4020).setDepth(9);
    indicator.setVisible(false);
    scene.furnaces.push({
      cx: p_.tx, cy: p_.ty - 1,
      input: new Uint16Array(ORE_RAWS.length),
      fuel: 0,
      output: new Uint16Array(ORE_RAWS.length),
      smeltIdx: -1,
      smeltProgress: 0,
      indicator,
    });
  }

  // The bed is the player's home: night teleports to the most recently
  // placed bed (or the spawn if none).
  if (recipe.kind === 'base') scene.basePlaced = true;
  if (recipe.kind === 'bed') {
    scene.home.x = (p_.tx + p_.w / 2) * TILE;
    scene.home.y = p_.ty * TILE;
    scene.bedPlaced = true;
  }

  scene.invDirty = true;
  scene.dirtyMineral = true;
  showToast(scene, recipe.name + ' PLACED!');
  exitPlacement(scene);
}

function buildPlacementUi(scene) {
  const c = scene.add.container(0, 0).setDepth(38);
  c.setVisible(false);
  scene.placementPreview = c;
  scene.placementPreviewCells = [];
  // Pool large enough for max base (20 tiles) + safety.
  for (let i = 0; i < 24; i++) {
    const r = scene.add.rectangle(0, 0, TILE, TILE, 0x40ff60, 0.4).setOrigin(0.5);
    r.visible = false;
    c.add(r);
    scene.placementPreviewCells.push(r);
  }
}

// ----- Furnace tick (smelt + proximity transfer) -----

function tickFurnaces(scene) {
  const n = scene.furnaces.length;
  if (n === 0) return;
  const tick = scene.tickCount;
  const slots = ORE_RAWS.length;
  for (let fi = 0; fi < n; fi++) {
    const f = scene.furnaces[fi];
    // Fuel + ore consumed up-front so breaking mid-smelt doesn't refund.
    if (f.smeltIdx < 0) {
      for (let i = 0; i < slots; i++) {
        if (f.input[i] > 0 && f.fuel >= FUEL_PER_SMELT) {
          f.smeltIdx = i;
          f.smeltProgress = 0;
          f.input[i]--;
          f.fuel -= FUEL_PER_SMELT;
          break;
        }
      }
    }
    if (f.smeltIdx >= 0 && ++f.smeltProgress >= SMELT_TIME_TICKS) {
      f.output[f.smeltIdx]++;
      f.smeltIdx = -1;
      scene.smeltedAny = true;
    }

    if (!nearFurnace(scene, f)) continue;
    if (tick % TRANSFER_INTERVAL_TICKS !== 0) continue;
    const inv = scene.inventory;
    let dirty = 0;
    for (let i = 0; i < slots; i++) {
      if (f.output[i] > 0) { f.output[i]--; inv[ORE_INGOTS[i]]++; dirty = 1; break; }
    }
    let pulled = 0;
    for (let i = 0; i < slots; i++) {
      const ore = ORE_RAWS[i];
      if (inv[ore] > 0) { inv[ore]--; f.input[i]++; pulled = 1; break; }
    }
    if (!pulled && inv[WOOD] > 0 && f.fuel < FURNACE_MAX_FUEL) { inv[WOOD]--; f.fuel++; pulled = 1; }
    if (dirty || pulled) scene.invDirty = true;
  }
}

function renderFurnaces(scene) {
  for (let i = 0; i < scene.furnaces.length; i++) {
    const f = scene.furnaces[i];
    f.indicator.visible = f.smeltIdx >= 0;
    if (f.smeltIdx >= 0) {
      f.indicator.x = (f.cx + 1) * TILE - scene.cam.x;
      f.indicator.y = (f.cy + 1) * TILE - scene.cam.y;
      f.indicator.alpha = 0.55 + 0.35 * Math.sin(scene.tickCount * 0.2);
    }
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

// Generic AABB collision against the world. `solidFn` decides which tiles
// count as solid for the actor — player passes through doors and stairs,
// monsters are blocked by doors but still ignore stairs.
function collidesBox(scene, cx, cy, w, h, solidFn) {
  const solid = solidFn || isSolidForPlayer;
  const halfW = w / 2;
  const x0 = ((cx - halfW) / TILE) | 0;
  const x1 = ((cx + halfW - 0.001) / TILE) | 0;
  const y0 = ((cy - h) / TILE) | 0;
  const y1 = ((cy - 0.001) / TILE) | 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) return true;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) return true;
      if (solid(scene.world[y * WORLD_W + x])) return true;
    }
  }
  return false;
}

// Difficulty scale applied to HP and damage. +15%/day, capped at 2.5×.
function monsterScale(scene) {
  const s = 1 + (scene.daysSurvived - 1) * 0.15;
  return s > 2.5 ? 2.5 : s;
}

const _typesBuf = new Uint8Array(5);
function spawnMonstersTick(scene) {
  scene.monsterSpawnTimer--;
  if (scene.monsterSpawnTimer > 0) return;
  const d = scene.daysSurvived;
  scene.monsterSpawnTimer = Math.max(40, BASE_SPAWN_INTERVAL - (d - 1) * 5);
  const maxMons = Math.min(BASE_MONSTER_MAX + d - 1, 24);
  if (scene.monsters.length >= maxMons) return;
  // Pick uniformly from the types unlocked this night.
  const mask = NIGHT_TYPES[Math.min(d - 1, NIGHT_TYPES.length - 1)];
  let n = 0;
  for (let i = 0; i < 5; i++) if (mask & (1 << i)) _typesBuf[n++] = i;
  if (n === 0) return;
  spawnMonster(scene, _typesBuf[(Math.random() * n) | 0]);
}

function spawnMonster(scene, type) {
  const p = scene.player;
  const side = Math.random() < 0.5 ? -1 : 1;
  const offset = GAME_WIDTH / 2 + 24;
  let x = p.x + side * offset;
  x = Math.max(2 * TILE, Math.min((WORLD_W - 2) * TILE, x));
  let y;
  if (type === MON_FLYER || type === MON_GHOST) {
    // Aerial monsters spawn near the upper edge of the viewport.
    y = Math.max(8 * TILE, p.y - GAME_HEIGHT * 0.4);
  } else {
    const tx = Math.max(1, Math.min(WORLD_W - 2, (x / TILE) | 0));
    const surfY = findSurface(scene.world, tx);
    y = surfY * TILE;
  }
  scene.monsters.push(createMonster(scene, type, x, y));
}

function createMonster(scene, type, x, y) {
  const w = M_W[type];
  const scale = monsterScale(scene);
  const m = {
    type, x, y, vx: 0, vy: 0,
    w, h: M_H[type], hp: (M_HP[type] * scale) | 0,
    hpMax: (M_HP[type] * scale) | 0,
    dmgScale: scale,
    facing: 1, jumpTimer: 0,
    flashTicks: 0, stunTicks: 0,
    prevX: x, stuckTicks: 0, stuck: false,
    fuseTicks: (M_FLAGS[type] & MF_EXPLODES) ? -1 : 0,
  };
  m.sprite = buildMonsterVisual(scene, type);
  m.hpBarBg = scene.add.rectangle(0, 0, w, 1, 0x400010)
    .setOrigin(0, 0.5).setDepth(11);
  m.hpBarFg = scene.add.rectangle(0, 0, w, 1, 0x60e060)
    .setOrigin(0, 0.5).setDepth(11);
  return m;
}

// Damage a monster, with knockback + flash + death cleanup. Caller is
// responsible for iterating backwards if they call this inside a loop.
// Knockback scales with the player's sword tier (fist 2.0 → iron 4.0)
// and is held for `stunTicks` ticks so monster AI can't overwrite vx
// the very next frame.
function applyMonsterDamage(scene, m, dmg) {
  m.hp -= dmg;
  m.flashTicks = 12;
  sfx(scene, 'monsterHurt');
  if (M_FLAGS[m.type] & MF_KNOCK) {
    m.stunTicks = 10;
    const knockDir = m.x < scene.player.x ? -1 : 1;
    const strength = 2 + scene.sword * 0.5;
    m.vx = knockDir * strength;
    m.vy = -strength * 0.6;
  }
  if (m.hp <= 0) destroyMonster(scene, m);
}

// Monster visual: simple body + eye, body color/shape per type.
// [bodyW, bodyH, bodyY, bodyColor, eyeColor]
const MON_VIS = [
  [12, 7,  -4,  0x44a060, 0x101018], // slime
  [12, 18, -10, 0x5a7042, 0x101018], // zombie
  [14, 7,  -4,  0x6a2a30, 0xff6060], // flyer
  [10, 12, -8,  0xc4dcf2, 0x101018], // ghost
  [12, 12, -8,  0x5aaa30, 0x101018], // bomber
];
function buildMonsterVisual(scene, type) {
  const c = scene.add.container(0, 0).setDepth(9);
  const v = MON_VIS[type];
  c.add(scene.add.rectangle(0, v[2], v[0], v[1], v[3]));
  c.add(scene.add.rectangle(2, v[2] - 1, 2, 2, v[4]));
  if (type === MON_GHOST) c.setAlpha(0.82);
  return c;
}

function tickMonsters(scene) {
  const p = scene.player;
  for (let i = 0; i < scene.monsters.length; i++) {
    tickMonster(scene, scene.monsters[i], p);
  }
}

// Monsters deal damage to structural tiles they're blocked by. Ground
// monsters scan the tile in front of them at mid-height; flyers don't
// attack walls (they tend to pass through anyway). Scheduled every
// MONSTER_ATTACK_INTERVAL ticks to feel like chipping away, not
// instant-break. Tile damage goes through the shared scene.damage
// array, so sword mining and monster attack stack naturally.
const MONSTER_ATTACK_INTERVAL = 30; // 0.5 s between chip attacks
function monsterAttackTiles(scene, m) {
  if (!(M_FLAGS[m.type] & MF_ATK_TILES)) return;
  if ((scene.tickCount % MONSTER_ATTACK_INTERVAL) !== 0) return;
  const probeX = m.x + m.facing * (m.w / 2 + 1);
  const tx = (probeX / TILE) | 0;
  if (tx < 1 || tx >= WORLD_W - 1) return;
  const yStart = ((m.y - m.h) / TILE) | 0;
  const yEnd = ((m.y - 0.001) / TILE) | 0;
  for (let ty = yStart; ty <= yEnd; ty++) {
    if (ty < 1 || ty >= WORLD_H - 1) continue;
    const idx = ty * WORLD_W + tx;
    const cell = scene.world[idx];
    const t = cell & TYPE_MASK;
    // Structures are always fair game. Trees (WOOD) too — monsters
    // always chew through. Raw terrain only when the monster is stuck
    // so they don't raze the landscape on the way to the player.
    const attackable =
      isStructuralTile(cell) ||
      t === WOOD ||
      (m.stuck && (t === DIRT || t === STONE || t === SAND));
    if (!attackable) continue;
    const hard = BLOCK_HARDNESS[t];
    if (hard === 0) continue;
    scene.damage[idx] = Math.min(65535, scene.damage[idx] + (M_ATK_DMG[m.type] * m.dmgScale) | 0);
    if (scene.damage[idx] >= hard) {
      scene.world[idx] = AIR;
      scene.damage[idx] = 0;
      scene.dirtyMineral = true;
    }
    return; // one tile per attack
  }
}

function tickMonster(scene, m, p) {
  if (m.flashTicks > 0) m.flashTicks--;
  const type = m.type;
  const flags = M_FLAGS[type];
  const phases = flags & MF_PHASE;

  if (m.stunTicks > 0) {
    m.stunTicks--;
    if (phases) {
      m.x += m.vx; m.y += m.vy;
      m.vx *= 0.85; m.vy *= 0.85;
    } else {
      moveBox(scene, m, isSolidForMonster, 0, flags & MF_GRAVITY);
    }
    return;
  }

  const dx = p.x - m.x;
  m.facing = dx >= 0 ? 1 : -1;

  if (M_AI[type]) {
    // glide
    const dy = (p.y - p.h / 2) - (m.y - m.h / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const sp = M_GLIDE[type];
    m.vx = (dx / dist) * sp;
    m.vy = (dy / dist) * sp;
    if (phases) { m.x += m.vx; m.y += m.vy; }
    else        { moveBox(scene, m, isSolidForMonster, 0, 0); }
  } else {
    // ground
    const onGround = monsterOnGround(scene, m);
    const fuseBurning = (flags & MF_EXPLODES) && m.fuseTicks > 0;

    if (!fuseBurning) {
      let jumpNow = false;
      const trig = M_JUMP_TR[type];
      if (trig === 1 && onGround) {
        m.jumpTimer--;
        if (m.jumpTimer <= 0) {
          jumpNow = true;
          const lo = M_JUMP_MIN[type], hi = M_JUMP_MAX[type];
          m.jumpTimer = lo + ((Math.random() * (hi - lo)) | 0);
        }
      } else if (trig === 2 && onGround && monsterBlockedAhead(scene, m)) {
        jumpNow = true;
      }
      if (jumpNow) m.vy = m.stuck ? STUCK_JUMP_VELOCITY : M_JUMP_V[type];

      m.vx = m.facing * (onGround ? M_WALK[type] : M_AIR[type]);
    } else {
      m.vx = 0;
    }

    moveBox(scene, m, isSolidForMonster, 0, 1);
  }

  if (!phases) {
    const moved = Math.abs(m.x - m.prevX) > 0.1;
    if (!moved && Math.abs(m.vx) > 0.05) m.stuckTicks++;
    else                                  m.stuckTicks = 0;
    m.stuck = m.stuckTicks >= STUCK_THRESHOLD_TICKS;
    m.prevX = m.x;
  }

  monsterAttackTiles(scene, m);
  if (flags & MF_EXPLODES) tickBomberFuse(scene, m, p);
}

// Bomber proximity fuse. fuseTicks < 0 means "armed but not burning";
// once the player gets within explosionRange, it starts counting down
// and the bomber freezes. When it hits 0 the blast fires.
function tickBomberFuse(scene, m, p) {
  if (m.fuseTicks == null) m.fuseTicks = -1;
  if (m.fuseTicks < 0) {
    const dx = p.x - m.x;
    const dy = (p.y - p.h / 2) - (m.y - m.h / 2);
    if (Math.hypot(dx, dy) <= M_EXP_RNG) {
      m.fuseTicks = M_FUSE[m.type];
      sfx(scene, 'bomberFuse');
    }
    return;
  }
  m.fuseTicks--;
  if (m.fuseTicks <= 0) bomberExplode(scene, m);
}

function bomberExplode(scene, m) {
  sfx(scene, 'explosion');
  const cx = (m.x / TILE) | 0;
  const cy = ((m.y - m.h / 2) / TILE) | 0;
  const r = M_EXP_RAD[m.type];
  const r2 = r * r;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const tx = cx + dx, ty = cy + dy;
      if (tx < 1 || tx >= WORLD_W - 1 || ty < 1 || ty >= WORLD_H - 1) continue;
      const idx = ty * WORLD_W + tx;
      const t = scene.world[idx] & TYPE_MASK;
      const cat = BLOCK_CAT[t];
      if (cat === CAT_AIR || cat === CAT_LIQUID || cat === CAT_DECOR) continue;
      if (t === BORDER) continue;
      scene.world[idx] = AIR;
      scene.damage[idx] = 0;
    }
  }
  scene.dirtyMineral = true;

  // Damage the player if caught in the radius.
  const p = scene.player;
  const centerX = (cx + 0.5) * TILE;
  const centerY = (cy + 0.5) * TILE;
  const pdx = p.x - centerX;
  const pdy = (p.y - p.h / 2) - centerY;
  const radPx = r * TILE;
  if (pdx * pdx + pdy * pdy <= radPx * radPx && p.invulnTicks <= 0) {
    applyPlayerDamage(scene, Math.max(1, (M_EXP_DMG[m.type] * m.dmgScale) | 0));
    p.invulnTicks = PLAYER_INVULN_TICKS;
  }

  destroyMonster(scene, m);
}

// Centralized cleanup so sprite + HP bar + array entry go together.
function destroyMonster(scene, m) {
  m.sprite.destroy();
  if (m.hpBarBg) m.hpBarBg.destroy();
  if (m.hpBarFg) m.hpBarFg.destroy();
  const idx = scene.monsters.indexOf(m);
  if (idx >= 0) scene.monsters.splice(idx, 1);
}

function monsterOnGround(scene, m) {
  m.y += 1;
  const c = collidesBox(scene, m.x, m.y, m.w, m.h, isSolidForMonster);
  m.y -= 1;
  return c;
}

// Jump trigger: wall ahead OR a 4-tile-deep pit ahead (so step-downs of
// 1-3 tiles are walked, not jumped).
function monsterBlockedAhead(scene, m) {
  const probeX = m.x + m.facing * (m.w / 2 + 1);
  if (collidesBox(scene, probeX, m.y - 1, 2, m.h - 2, isSolidForMonster)) return true;
  return !collidesBox(scene, probeX, m.y + 4 * TILE, 2, 4 * TILE, isSolidForMonster);
}

// Shared physics step: optional gravity + axis-resolved AABB collision.
// `bounce` flips e.facing on a horizontal hit (villager wander) instead
// of stopping (monster). `gravity` truthy = apply GRAVITY pre-move.
function moveBox(scene, e, solidFn, bounce, gravity) {
  if (gravity) e.vy = Math.min(TERMINAL_VY, e.vy + GRAVITY);
  if (e.vy < -8) e.vy = -8;
  e.x += e.vx;
  if (collidesBox(scene, e.x, e.y, e.w, e.h, solidFn)) {
    e.x -= e.vx;
    if (bounce) e.facing = -e.facing;
    e.vx = 0;
  }
  e.y += e.vy;
  if (collidesBox(scene, e.x, e.y, e.w, e.h, solidFn)) {
    e.y -= e.vy;
    if (e.vy > 0) e.y = Math.ceil(e.y / TILE) * TILE;
    e.vy = 0;
  }
}

function checkMonsterDamage(scene) {
  const p = scene.player;
  if (p.invulnTicks > 0) { p.invulnTicks--; return; }
  for (let i = 0; i < scene.monsters.length; i++) {
    const m = scene.monsters[i];
    if (aabbOverlap(p, m)) {
      applyPlayerDamage(scene, Math.max(1, (M_CONTACT[m.type] * m.dmgScale) | 0));
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
    const type = m.type;
    m.sprite.setPosition(m.x - scene.cam.x, m.y - scene.cam.y);
    m.sprite.setScale(m.facing < 0 ? -1 : 1, 1);
    let alpha = (type === MON_GHOST) ? 0.82 : 1;
    if (m.fuseTicks > 0) {
      alpha = (m.fuseTicks & 6) < 3 ? 0.45 : 1;
    } else if (m.flashTicks > 0 && (m.flashTicks & 4)) {
      alpha = 0.3;
    }
    m.sprite.setAlpha(alpha);

    const barX = m.x - scene.cam.x - m.w / 2;
    const barY = m.y - m.h - 3 - scene.cam.y;
    m.hpBarBg.setPosition(barX, barY);
    m.hpBarFg.setPosition(barX, barY);
    m.hpBarFg.scaleX = Math.max(0, m.hp / m.hpMax);
  }
}

function despawnAllMonsters(scene) {
  for (let i = 0; i < scene.monsters.length; i++) {
    const m = scene.monsters[i];
    m.sprite.destroy();
    if (m.hpBarBg) m.hpBarBg.destroy();
    if (m.hpBarFg) m.hpBarFg.destroy();
  }
  scene.monsters.length = 0;
  scene.monsterSpawnTimer = BASE_SPAWN_INTERVAL;
}

// ----- Villagers: 9..80-cell rooms with ≥1 bed and ≥1 built wall.
const VILLAGER_BODY_COLORS = [0x4060a0, 0xa04060];

// Returns [bedIdx, bedKind] pairs, one per bed in a valid sealed room.
//
// Two-pass strategy (the only correct way to detect a sealed pocket):
//   1) Flood-fill from the world's outer ring, marking every AIR/decor
//      cell connected to the world border. Anything reachable from the
//      outside is "open air".
//   2) Any AIR cell still unmarked is in a SEALED pocket. For each pocket
//      flood it, count volume, beds, and structural walls. If it meets
//      the size + bed + wall thresholds, it's a valid house.
//
// Why two passes: a one-pass flood that bails on `vol > 80` leaves
// "scarred" visited cells that can fake-seal a partially-open room when
// the next flood meets the scar. The border-first pass guarantees that
// if there's any path to the outside, the room is correctly marked open.
function scanVillages(scene) {
  const w = scene.world;
  const visited = scene.visited;
  scene.visitedTag = (scene.visitedTag + 1) & 0xff;
  if (scene.visitedTag === 0) { visited.fill(0); scene.visitedTag = 1; }
  const tag = scene.visitedTag;
  const out = [];
  // Larger queue than bfsQueue; the outside flood may hold most of the sky.
  const Q = new Int32Array(WORLD_W * WORLD_H);
  let qh = 0, qt = 0;
  const enq = (i) => {
    if (visited[i] === tag) return;
    const cat = BLOCK_CAT[w[i] & TYPE_MASK];
    if (cat === CAT_AIR || cat === CAT_DECOR) { visited[i] = tag; Q[qt++] = i; }
  };
  // Pass 1: seed from the inner ring (one tile inside the BORDER frame).
  for (let x = 1; x < WORLD_W - 1; x++) {
    enq(WORLD_W + x);
    enq((WORLD_H - 2) * WORLD_W + x);
  }
  for (let y = 1; y < WORLD_H - 1; y++) {
    enq(y * WORLD_W + 1);
    enq(y * WORLD_W + WORLD_W - 2);
  }
  while (qh < qt) {
    const idx = Q[qh++];
    enq(idx - 1); enq(idx + 1);
    enq(idx - WORLD_W); enq(idx + WORLD_W);
  }
  // Pass 2: any AIR still unmarked is a sealed pocket.
  for (let s = WORLD_W; s < (WORLD_H - 1) * WORLD_W; s++) {
    if (visited[s] === tag) continue;
    if ((w[s] & TYPE_MASK) !== AIR) continue;
    qh = 0; qt = 0;
    Q[qt++] = s; visited[s] = tag;
    let vol = 0, builtWalls = 0;
    const beds = [];
    while (qh < qt && vol <= 80) {
      const idx = Q[qh++];
      vol++;
      const nbrs = [idx - 1, idx + 1, idx - WORLD_W, idx + WORLD_W];
      for (let k = 0; k < 4; k++) {
        const n = nbrs[k];
        if (visited[n] === tag) continue;
        const nt = w[n] & TYPE_MASK;
        const cat = BLOCK_CAT[nt];
        if (cat === CAT_AIR || cat === CAT_DECOR) { visited[n] = tag; Q[qt++] = n; }
        else if (nt === BED_WOOD || nt === BED_IRON) { visited[n] = tag; beds.push(n, nt); }
        else if (isStructuralTile(w[n])) builtWalls++;
      }
    }
    if (vol <= 80 && vol >= 9 && beds.length && builtWalls > 0)
      for (let i = 0; i < beds.length; i += 2) out.push(beds[i], beds[i + 1]);
  }
  return out;
}

// Reconcile villagers with the bed list (pairs of [idx, kind]).
function syncVillagers(scene, beds) {
  const list = scene.villagers;
  for (let i = list.length - 1; i >= 0; i--) {
    let found = 0;
    for (let j = 0; j < beds.length; j += 2) if (beds[j] === list[i].bedIdx) { found = 1; break; }
    if (!found) { list[i].sprite.destroy(); list.splice(i, 1); }
  }
  for (let j = 0; j < beds.length; j += 2) {
    const idx = beds[j];
    let exists = 0;
    for (const v of list) if (v.bedIdx === idx) { exists = 1; break; }
    if (exists) continue;
    const color = VILLAGER_BODY_COLORS[(j / 2) % VILLAGER_BODY_COLORS.length];
    const c = buildHumanVisual(scene, 9, color).c;
    list.push({
      x: (idx % WORLD_W) * TILE + TILE / 2,
      y: ((idx / WORLD_W) | 0) * TILE + TILE,
      w: 14, h: 26,
      vx: 0, vy: 0, facing: 1, dirTimer: 30,
      bedIdx: idx, sprite: c,
    });
  }
  scene.villagerCount = list.length;
}

function killVillager(scene, v) {
  v.sprite.destroy();
  scene.villagers.splice(scene.villagers.indexOf(v), 1);
  scene.villagerCount = scene.villagers.length;
}

function tickVillagers(scene) {
  const night = scene.nightActive;
  for (let i = scene.villagers.length - 1; i >= 0; i--) {
    const v = scene.villagers[i];
    if (night) {
      v.x = (v.bedIdx % WORLD_W) * TILE + TILE / 2;
      v.y = ((v.bedIdx / WORLD_W) | 0) * TILE + TILE;
      v.vx = 0; v.vy = 0;
    } else {
      if (--v.dirTimer <= 0) {
        v.facing = Math.random() < 0.5 ? -1 : 1;
        v.dirTimer = 60 + (Math.random() * 120 | 0);
      }
      v.vx = v.facing * 0.4;
      moveBox(scene, v, isSolidForPlayer, 1, 1);
    }
    const st = liquidStatus(scene, v);
    let dead = st.touchingLava || st.fullyInWater;
    if (!dead) for (const m of scene.monsters) if (aabbOverlap(v, m)) { dead = 1; break; }
    if (dead) killVillager(scene, v);
  }
}

function renderVillagers(scene) {
  for (let i = 0; i < scene.villagers.length; i++) {
    const v = scene.villagers[i];
    v.sprite.setPosition(v.x - scene.cam.x, v.y - scene.cam.y);
    v.sprite.setScale(v.facing < 0 ? -1 : 1, 1);
  }
}

// ============================================================
// 10.8. Audio — procedural SFX + music (Web Audio API)
// ============================================================

function toneBurst(ctx, freq, dur, type, peak, atk) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + (atk || 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t); osc.stop(t + dur + 0.05);
}

function noiseBurst(ctx, dur, peak, filterType, filterFreq) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = src;
  if (filterType) {
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = filterFreq;
    src.connect(f); node = f;
  }
  node.connect(g); g.connect(ctx.destination);
  src.start(t); src.stop(t + dur);
}

function sfx(scene, name) {
  const ctx = scene.audioCtx;
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if      (name === 'mineMineral') { toneBurst(ctx, 900, 0.07, 'square',  0.06, 0.003); noiseBurst(ctx, 0.05, 0.04, 'lowpass',  300); }
  else if (name === 'mineSolid')   { noiseBurst(ctx, 0.09, 0.09, 'lowpass', 400); }
  else if (name === 'mineSand')    { noiseBurst(ctx, 0.12, 0.10, 'bandpass', 1500); }
  else if (name === 'mineWood')    { toneBurst(ctx, 180, 0.08, 'square', 0.07, 0.004); noiseBurst(ctx, 0.04, 0.06, 'bandpass', 600); }
  else if (name === 'playerHurt')  { toneBurst(ctx, 220, 0.22, 'sawtooth', 0.10, 0.008); }
  else if (name === 'monsterHurt') { toneBurst(ctx, 700, 0.08, 'sawtooth', 0.06, 0.004); }
  else if (name === 'explosion')   {
    const o = ctx.createOscillator(); o.type = 'sine';
    const tt = ctx.currentTime;
    o.frequency.setValueAtTime(200, tt);
    o.frequency.exponentialRampToValueAtTime(35, tt + 0.45);
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0.20, tt);
    gg.gain.exponentialRampToValueAtTime(0.0001, tt + 0.45);
    o.connect(gg); gg.connect(ctx.destination);
    o.start(tt); o.stop(tt + 0.5);
    noiseBurst(ctx, 0.5, 0.20, 'lowpass', 450);
  }
  else if (name === 'splash')      { noiseBurst(ctx, 0.35, 0.08, 'highpass', 1800); }
  else if (name === 'bomberFuse')  { toneBurst(ctx, 900, 0.05, 'square', 0.04, 0.002); }
}

const MUSIC_DAY   = [57, 60, 64, 67, 64, 60, 55, 52, 57, 60, 64, 67];
const MUSIC_NIGHT = [45, 48, 51, 48, 45, 43, 40, 43, 48, 51, 48, 43];

function midiToFreq(n) { return 440 * Math.pow(2, (n - 69) / 12); }

function playMusicNote(ctx, freq, dur, peak) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(t); osc.stop(t + dur + 0.1);
}

function startMusic(scene) {
  if (scene.musicOn || !scene.audioCtx) return;
  scene.musicOn = true;
  scene.musicIdx = 0;
  if (scene.audioCtx.state === 'suspended') scene.audioCtx.resume();
  scheduleNextNote(scene);
}

function scheduleNextNote(scene) {
  if (!scene.musicOn || !scene.audioCtx) return;
  const isNight = scene.nightActive;
  const pattern = isNight ? MUSIC_NIGHT : MUSIC_DAY;
  const noteMs = isNight ? 300 : 520;
  const freq = midiToFreq(pattern[scene.musicIdx % pattern.length]);
  scene.musicIdx++;
  playMusicNote(scene.audioCtx, freq, noteMs / 1000, 0.04);
  playMusicNote(scene.audioCtx, freq / 2, noteMs / 1000, 0.018);
  scene.time.delayedCall(noteMs, () => scheduleNextNote(scene));
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

