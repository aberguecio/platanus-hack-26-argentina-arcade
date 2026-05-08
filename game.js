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

// Move + jump scale with armor: copper +1 tile jump / +0.1 spd, iron +2 / +0.2,
// mithril +3 / +0.3. Inlined at the input site to avoid extra consts.
const GRAVITY = 0.18;       // px / tick²
const TERMINAL_VY = 4.5;

// Cell byte layout: bits 0–5 = type id (0–63), bit 6 = MOVED (cleared each
// tick), bit 7 = FALLING (mineral marked as detached, persists until BFS
// reanchors).
const TYPE_MASK = 0x3F;
const MOVED_FLAG = 0x40;
const FALLING_FLAG = 0x80;

// ============================================================
// 1.5. High scores API (web/portfolio build)
// Replaces window.platanusArcadeStorage with a remote leaderboard.
// NOTE: this build breaks the cabinet's no-network / no-external-URL
// restriction. Keep this branch separate from `main`.
// ============================================================

const API_BASE = 'https://highscores.berguecio.cl';
const GAME_ID = 'g_e83fb25c1eec4c50';

const fetchHighScores = async () => {
  try {
    const res = await fetch(`${API_BASE}/games/${GAME_ID}/highscores?limit=5`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.highscores || []).map(h => {
      const parts = String(h.player_name).split('|');
      const d = parseInt(parts[1], 10);
      return { n: parts[0], s: h.score, d: Number.isFinite(d) ? d : 0 };
    });
  } catch (_) { return []; }
};

const submitHighScore = async (n, s, d) => {
  try {
    await fetch(`${API_BASE}/games/${GAME_ID}/highscores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_name: `${n}|${d}`, score: s }),
    });
  } catch (_) {}
};

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
      FURNACE = 13, FURNACE_HARD = 14,
      LEAVES = 15, CLOUD = 16,
      // v4 building tiles — bricks are base/wall material, door/stair are
      // special pass-through semantics (see isSolidForPlayer/Monster).
      BRICK_DIRT = 17, BRICK_STONE = 18, BRICK_COPPER = 19, BRICK_IRON = 20,
      DOOR_WOOD = 21, STAIR_WOOD = 22,
      BED_WOOD = 23,
      OBSIDIAN = 25,
      HARD_ROCK = 26, // deep base layer, 2× stone hardness
      MITHRIL = 27,   // end-game tool material, deepest vein
      MITHRIL_INGOT = 28,
      DOOR_IRON = 29,
      BED_COPPER = 30,
      BRICK_HARD_ROCK = 31;

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
  // KEEP MATERIAL ORDER: BUILDING_RECIPES + TOOL_RECIPES come out in the
  // order materials appear here (dirt → wood → stone → copper → iron →
  // obsidian → mithril). Reorder these rows to reorder the menu tabs.
  { id: AIR,    name: 'air',    cat: CAT_AIR,      color: 0xff0a0d18 },
  { id: DIRT,   name: 'dirt',   cat: CAT_SOLID,    color: 0xff2c4f7a, fallTicks: 15, hardness: 10, flags: F_FOR_BUILD, brick: BRICK_DIRT },
  { id: WOOD,   name: 'wood',   cat: CAT_SOLID,    color: 0xff1d3a6e, fallTicks: 15, hardness: 4,  flags: F_FOR_TOOL, tier: 1, bed: BED_WOOD, door: DOOR_WOOD, doorCost: 10, extra: { name: 'STAIR', kind: 'stair', material: WOOD, tile: STAIR_WOOD, costPerTile: 10 } },
  { id: SAND,   name: 'sand',   cat: CAT_SANDLIKE, color: 0xff5cd4e8, fallTicks: 12, hardness: 10 },
  { id: WATER,  name: 'water',  cat: CAT_LIQUID,   color: 0xffd88030, fallTicks: 5,  hardness: 10 },
  { id: STONE,  name: 'stone',  cat: CAT_MINERAL,  color: 0xff4a4a4a, fallTicks: 15, hardness: 20, flags: F_FOR_TOOL | F_FOR_BUILD, tier: 2, brick: BRICK_STONE, extra: { name: 'FURNACE', kind: 'furnace', material: STONE, tile: FURNACE, costTotal: 50 } },
  { id: LAVA,   name: 'lava',   cat: CAT_LIQUID,   color: 0xff1840f0, fallTicks: 30, hardness: 50 },
  { id: COPPER,       name: 'copper',       cat: CAT_MINERAL, color: 0xff3070c0, fallTicks: 20, hardness: 40, flags: F_FOR_TOOL | F_FOR_BUILD | F_IS_VEIN | F_IS_MINERAL, tier: 3, brick: BRICK_COPPER },
  { id: COPPER_INGOT, name: 'copper ingot', cat: CAT_AIR,     color: 0xff3a80d0, bed: BED_COPPER, armor: 1 },
  { id: IRON,         name: 'iron',         cat: CAT_MINERAL, color: 0xff8090a0, fallTicks: 20, hardness: 80, flags: F_FOR_TOOL | F_FOR_BUILD | F_IS_VEIN | F_IS_MINERAL, tier: 4, brick: BRICK_IRON },
  { id: IRON_INGOT,   name: 'iron ingot',   cat: CAT_AIR,     color: 0xffc8d4de, door: DOOR_IRON, doorCost: 50, armor: 2 },
  { id: BORDER,       name: 'border',       cat: CAT_MAGIC,   color: 0xff1a1a1a },
  { id: FURNACE,      name: 'furnace',      cat: CAT_MAGIC,   color: 0xff3a3a40, hardness: 200, drop: STONE,     dropAmt: 40 },
  { id: FURNACE_HARD, name: 'hard furnace', cat: CAT_MAGIC,   color: 0xff2a2530, hardness: 400, drop: HARD_ROCK, dropAmt: 40 },
  { id: LEAVES,       name: 'leaves',       cat: CAT_DECOR,   color: 0xff4aa040 },
  { id: CLOUD,        name: 'cloud',        cat: CAT_DECOR,   color: 0xffe8eef0 },
  // Bricks generated below from a small table — F_IS_BRICK drives outlined
  // edge; hardness equals the raw mat; drop = 1 of the smelted form.
  { id: DOOR_WOOD,    name: 'door',         cat: CAT_MAGIC, color: 0xff2a5088, hardness: 12,  drop: WOOD       },
  { id: DOOR_IRON,    name: 'iron door',    cat: CAT_MAGIC, color: 0xff708090, hardness: 240, drop: IRON_INGOT },
  { id: STAIR_WOOD,   name: 'stair',        cat: CAT_MAGIC, color: 0xff3478b0, hardness: 4,  drop: WOOD       },
  { id: BED_WOOD,     name: 'bed',          cat: CAT_MAGIC, color: 0xff4050c0, hardness: 4,  drop: WOOD         },
  { id: BED_COPPER,   name: 'copper bed',   cat: CAT_MAGIC, color: 0xff8060d0, hardness: 40, drop: COPPER_INGOT },
  { id: OBSIDIAN,     name: 'obsidian',     cat: CAT_MAGIC, color: 0xff40182a, hardness: 480, flags: F_FOR_BUILD | F_IS_BRICK, brick: OBSIDIAN },
  // Hard rock: 2× stone hardness, the deep-world base layer below stone.
  { id: HARD_ROCK,    name: 'hard rock',    cat: CAT_MINERAL, color: 0xff353038, fallTicks: 15, hardness: 40, flags: F_FOR_BUILD, brick: BRICK_HARD_ROCK, extra: { name: 'HARD FURNACE', kind: 'furnace', material: HARD_ROCK, tile: FURNACE_HARD, costTotal: 50 } },
  { id: MITHRIL,      name: 'mithril',      cat: CAT_MINERAL, color: 0xffd0c8a8, fallTicks: 20, hardness: 160, flags: F_FOR_TOOL | F_IS_VEIN | F_IS_MINERAL, tier: 5 },
  { id: MITHRIL_INGOT,name: 'mithril ingot',cat: CAT_AIR,     color: 0xffe0e8f0, armor: 3 },
];
// Generate the 4 brick rows from a compact table (id, raw-mat name, color, hardness).
// Built walls/bases get 3× the raw material hardness.
for (const [id, n, color, hardness] of [
  [BRICK_DIRT,      'dirt',      0xff3a5880, 30],
  [BRICK_STONE,     'stone',     0xff8a8a90, 60],
  [BRICK_COPPER,    'copper',    0xff4080c8, 120],
  [BRICK_IRON,      'iron',      0xff708090, 240],
  [BRICK_HARD_ROCK, 'hard rock', 0xff5a5560, 120],
]) BLOCKS.push({ id, name: n + ' brick', cat: CAT_MAGIC, color, hardness, flags: F_IS_BRICK });

// raw mat → smelted equivalent (brick drops + tool tier costs + furnace).
// HARD_ROCK has no ingot — maps to itself so brick drops are raw hard_rock.
const MAT_TO_INGOT = { [DIRT]: DIRT, [STONE]: STONE, [COPPER]: COPPER_INGOT, [IRON]: IRON_INGOT, [MITHRIL]: MITHRIL_INGOT, [HARD_ROCK]: HARD_ROCK };
// Parallel arrays of smeltable ores → their ingot. Filled from BLOCKS.
const ORE_RAWS = [], ORE_INGOTS = [];
// Furnace tier gates: stone furnace smelts copper; hard furnace smelts iron + mithril.
const ORE_MASK_STONE = 1 << COPPER;
const ORE_MASK_HARD = (1 << IRON) | (1 << MITHRIL);
// brick id → its raw material. Built in the setup loop from `b.brick`.
const BRICK_MAT = {};

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
  // Materials list their brick id; build the inverse map for brick drops.
  if (b.brick) BRICK_MAT[b.brick] = b.id;
  // Bricks drop 1 of their raw mat's smelted form. Default amount = 1.
  if (b.flags & F_IS_BRICK) BLOCK_DROP_TYPE[b.id] = MAT_TO_INGOT[BRICK_MAT[b.id]] || b.id;
  else                      BLOCK_DROP_TYPE[b.id] = b.drop != null ? b.drop : b.id;
  BLOCK_DROP_AMOUNT[b.id] = b.dropAmt != null ? b.dropAmt : 1;
  BLOCK_NAME[b.id] = b.name;
  if (b.flags & F_IS_MINERAL) { ORE_RAWS.push(b.id); ORE_INGOTS.push(MAT_TO_INGOT[b.id]); }
}

// ----- Tools: tier-based damage shared between picks and swords. -----
// Day → pick, night → sword (auto via getActiveTier). Tool slots track
// independently. Tier 0 = fists.
const TIER_FIST = 0, TIER_WOOD = 1;
const TIER_DAMAGE = [2, 7, 15, 30, 50, 80];
const TIER_NAMES = ['FISTS', 'WOODEN', 'STONE', 'COPPER', 'IRON', 'MITHRIL'];
// Armor tiers (1=copper, 2=iron, 3=mithril) add to PLAYER_MAX_HP.
const ARMOR_BONUS = [0, 4, 8, 14];
const ARMOR_NAMES = ['NONE', 'COPPER', 'IRON', 'MITHRIL'];
const _AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const C_Y = '#ffe066', C_G = '#7a7a82', C_B = '#a0c8ff', C_R = '#ff6666', C_M = '#a0a8b0';
const FF = 'monospace', FW = '#ffffff';
const STY_B = { fontStyle: 'bold' };
const STY_BS = { fontStyle: 'bold', stroke: '#000000', strokeThickness: 4 };
const STY_HUD = { fontFamily: 'monospace', fontSize: '11px' };
// Button labels — flip these to change PC/cabinet UX. esbuild folds them
// into the strings at build time, so configurability is free at runtime.
const B1 = 'B1', B2 = 'B2', B3 = 'B3';
const tierToolName = (tier, suffix) => tier ? TIER_NAMES[tier] + suffix : 'FISTS';

// Tool + base/wall recipes are derived from BLOCKS.flags + .tier + .brick.
// Tools cost 10 of mat for tier 1 (wood — easy to start) and 100 for the
// rest. F_IS_MINERAL materials consume their smelted ingot.
const TOOL_RECIPES = [];
// All building recipes are derived from BLOCKS — bed/door from material
// fields, brick BASE/WALL from F_FOR_BUILD + brick, and singletons (stair,
// furnace) from a per-material `extra` recipe.
const BUILDING_RECIPES = [];
for (const b of BLOCKS) {
  const matId = MAT_TO_INGOT[b.id] || b.id;
  const NAME = b.name.toUpperCase();
  if ((b.flags & F_FOR_TOOL) && b.tier) {
    const cost = [[matId, b.tier === 1 ? 10 : 50]];
    TOOL_RECIPES.push({ name: TIER_NAMES[b.tier] + ' PICKAXE', cost, pickTier:  b.tier });
    TOOL_RECIPES.push({ name: TIER_NAMES[b.tier] + ' SWORD',   cost, swordTier: b.tier });
  }
  if (b.armor) TOOL_RECIPES.push({ name: ARMOR_NAMES[b.armor] + ' ARMOR', cost: [[b.id, 50]], armorTier: b.armor });
  if ((b.flags & F_FOR_BUILD) && b.brick) {
    BUILDING_RECIPES.push({ name: 'BASE ' + NAME, kind: 'base', material: matId, tile: b.brick, costPerTile: 10 });
    BUILDING_RECIPES.push({ name: 'WALL ' + NAME, kind: 'wall', material: matId, tile: b.brick, costPerTile: 10 });
  }
  if (b.bed) BUILDING_RECIPES.push({ name: NAME + ' BED', kind: 'bed', material: b.id, tile: b.bed, costTotal: 10 });
  if (b.door) BUILDING_RECIPES.push({ name: NAME + ' DOOR', kind: 'door', material: b.id, tile: b.door, costTotal: b.doorCost });
  if (b.extra) BUILDING_RECIPES.push(b.extra);
}
// TOOL_RECIPES already comes out tier-ordered from BLOCKS; no sort needed.

// Per-kind defaults for the placement mode. Tuple [minW, maxW, minH, maxH, resizeAxis].
// resizeAxis: 0 = W grows with U/D, 1 = H grows, 2 = fixed size.
const PLACEMENT_DEFAULTS = {
  base:    [2, 20, 1, 1,  0],
  wall:    [1, 1,  2, 16, 1],
  stair:   [1, 1,  2, 16, 1],
  door:    [1, 1,  2, 4,  1],
  furnace: [2, 2,  2, 2,  2],
  bed:     [2, 2,  1, 1,  2],
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
  'HIT A TREE WITH ' + B1 + ' FOR WOOD',
  'COLLECT 10 WOOD FOR PICKAXE',
  'OPEN MENU (' + B2 + ') TO CRAFT PICKAXE',
  'BUILD BASE: L/R MOVE, U/D SIZE, ' + B1 + ' PLACE',
  'PLACE A BED (YOUR HOME)',
  'AT NIGHT: ON BED, ' + B3 + ' x2 TO SLEEP',
  'FURNACE: WOOD FUELS ORE INTO INGOTS',
  'SEAL BASE - VILLAGERS COME AT DAWN',
  '+1 PER VILLAGER AT DAWN. GOOD LUCK!',
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
const BASE_SPAWN_INTERVAL = 120;
const BASE_MONSTER_MAX = 5;

// Bit i = type i unlocked by day d (param is daysSurvived - 1).
// d1-2 zombie, d3-4 +flyer, d5-6 +slime, d7+ +bomber. Ghost is its own spawner.
const nightMask = d => d < 2 ? 0b00010 : d < 4 ? 0b00110 : d < 6 ? 0b00111 : 0b10111;

// Stuck escalation — if a monster tries to move but hasn't made
// progress for STUCK_THRESHOLD_TICKS, it gets a bigger jump and is
// allowed to chew through natural tiles (see monsterAttackTiles).
const STUCK_THRESHOLD_TICKS = 30;
const STUCK_JUMP_VELOCITY = -5.0; // peak ≈ 6.9 tiles, clears most walls

// Per-type stats stored as parallel typed arrays. Adding a monster =
// one row in each table + one case in buildMonsterVisual.
// Flags: bitmask of behavior bits below. The AI mode (glide vs ground)
// and the jump trigger (timer vs blocked) live in the same bitmask.
const MF_GRAVITY = 1, MF_PHASE = 2, MF_KNOCK = 4, MF_ATK_TILES = 8,
      MF_EXPLODES = 16, MF_GLIDE = 32, MF_JUMP_TIMER = 64, MF_JUMP_BLOCKED = 128;
//                                       SLIME ZOMBIE FLYER GHOST BOMBER
const M_W        = new Uint8Array([        12,   12,   14,   12,   12]);
const M_H        = new Uint8Array([         8,   22,    8,   14,   14]);
const M_HP       = new Uint8Array([        25,   30,   25,   60,   35]);
const M_FLAGS    = new Uint8Array([
  MF_GRAVITY|MF_KNOCK|MF_ATK_TILES|MF_JUMP_TIMER,            // SLIME
  MF_GRAVITY|MF_KNOCK|MF_ATK_TILES|MF_JUMP_BLOCKED,          // ZOMBIE
  MF_KNOCK|MF_ATK_TILES|MF_GLIDE,                            // FLYER
  MF_PHASE|MF_GLIDE,                                         // GHOST
  MF_GRAVITY|MF_KNOCK|MF_EXPLODES|MF_JUMP_BLOCKED,           // BOMBER
]);
const M_WALK     = [0,    0.6,  0,    0,    0.4];
const M_AIR      = [1.2,  0.6,  0,    0,    0.4];
const M_GLIDE    = [0,    0,    0.8,  0.55, 0];
const M_JUMP_V   = [-3.5, -4.2, 0,    0,    -4.0];
// Slime is the only type with MF_JUMP_TIMER; min/max inline at use-site.
const M_ATK_DMG  = new Uint8Array([3, 3, 3, 0, 0]);
const M_CONTACT  = new Uint8Array([1, 1, 1, 2, 0]);
const M_FUSE     = new Uint8Array([0, 0, 0, 0, 45]);
const M_EXP_RAD  = new Uint8Array([0, 0, 0, 0, 4]);
const M_EXP_DMG  = new Uint8Array([0, 0, 0, 0, 5]);
const M_EXP_RNG  = 4 * TILE; // bomber fuse area = same as blast radius

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
  scene.bfsQueue = new Int32Array((VW + 4) * (VH + 4));
  // Bigger scratch queue for scanVillages (covers the whole map). Allocate
  // once to avoid a 500KB+ GC pause every dawn.
  scene.bigBfsQueue = new Int32Array(WORLD_W * WORLD_H);
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
  if (scene.textures.exists('world')) scene.textures.remove('world');
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
  scene.armor = 0;
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
  scene.score = 0;
  recomputeDayLengths(scene);

  // Health + hazard counters (attached to player for clean grouping).
  scene.player.maxHp = PLAYER_MAX_HP + ARMOR_BONUS[scene.armor];
  scene.player.hp = scene.player.maxHp;
  scene.player.submergedTicks = 0;
  scene.player.lavaTicks = 0;
  scene.player.peakY = scene.player.y;
  scene.player.flashTicks = 0;
  scene.player.invulnTicks = 0;
  scene.player.wasInWater = false;
  scene.gameOver = false;

  // Highscores (top 5, name 3 letters). Loaded async on boot from the
  // remote leaderboard (see section 1.5).
  scene.highscores = [];
  fetchHighScores().then(arr => {
    scene.highscores = arr.slice(0, 5);
    refreshHsText(scene);
  });

  // Web Audio context for procedural SFX + music. May be suspended
  // until a user gesture; we resume in startMusic / sfx.
  scene.audioCtx = (scene.sound && scene.sound.context) || null;
  scene.musicOn = false;

  // Monsters (only present during night).
  scene.monsters = [];
  scene.monsterSpawnTimer = BASE_SPAWN_INTERVAL;
  scene.ghostSpawnTimer = 10 * TICK_RATE;
  scene.bomberFlash = scene.add.rectangle(0, 0, 1, 1, 0xff8030, 0).setDepth(40).setVisible(false);

  // Villagers — populated by scanVillages at every dawn.
  scene.villagers = [];
  scene.villagerCount = 0;

  buildHud(scene);

  if (DEBUG_HUD) {
    scene.hud = scene.add
      .text(GAME_WIDTH - 8, 6, '', {
        fontFamily: FF, fontSize: '10px', color: '#888888',
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
    const hardRockY = (190 + wave) | 0;
    for (let y = 0; y < WORLD_H; y++) {
      const idx = y * WORLD_W + x;
      if (x === 0 || x === WORLD_W - 1 || y === WORLD_H - 1) w[idx] = BORDER;
      else if (y < surfaceY)          w[idx] = AIR;
      else if (y < surfaceY + 8)      w[idx] = DIRT;
      else if (y < hardRockY)         w[idx] = STONE;
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

  // count, fill, baseTarget, yLo, yHi, rxMax, ryMax — packed CSV.
  const VEINS = [
    15,CLOUD,AIR,8,43,5,2, 50,SAND,STONE,80,155,11,7,
    40,WATER,STONE,80,155,9,6, 25,LAVA,STONE,140,185,3,2,
    80,COPPER,STONE,115,178,2,2, 90,AIR,STONE,75,185,4,2,
    160,LAVA,HARD_ROCK,200,505,6,4, 90,WATER,HARD_ROCK,200,450,8,5,
    90,COPPER,HARD_ROCK,200,400,2,2, 180,IRON,HARD_ROCK,210,505,2,2,
    60,MITHRIL,HARD_ROCK,310,505,2,2, 140,AIR,HARD_ROCK,200,505,5,3,
  ];
  for (let i = 0; i < VEINS.length; i += 7)
    pocket(VEINS[i], VEINS[i+1], VEINS[i+2], VEINS[i+3], VEINS[i+4], VEINS[i+5], VEINS[i+6]);

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
  // Canopy: 5-wide rounded blob at trunk top, table-driven [dy,dx].
  const CANOPY = [-1,-1, -1,0, -1,1, 0,-2, 0,-1, 0,0, 0,1, 0,2, 1,-1, 1,0, 1,1];
  for (let i = 0; i < CANOPY.length; i += 2) {
    const cx = tx + CANOPY[i + 1];
    const cy = topY + CANOPY[i];
    if (cx < 1 || cx >= WORLD_W - 1 || cy < 1) continue;
    const idx = cy * WORLD_W + cx;
    if ((w[idx] & TYPE_MASK) === AIR) w[idx] = LEAVES;
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
  scene.toolText.setText('TOOL: ' + getActiveToolName(scene) + '  ARM: ' + ARMOR_NAMES[scene.armor]);
  scene.villagerText.setText('VILLAGERS: ' + scene.villagerCount);
  scene.scoreText.setText('SCORE: ' + scene.score);

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
    tickGhostSpawner(scene);
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
  // Score = villagers alive at dawn + 1 for the player (counts as a villager).
  scene.score += scene.villagerCount + 1;
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
        else if ((w[idx - 1] & TYPE_MASK) === opp) hit = idx - 1;
        else if ((w[idx + 1] & TYPE_MASK) === opp) hit = idx + 1;
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
  // 2. Swap with liquid below (sandlike, mineral). For minerals (FB_FALLING),
  // skip if the liquid was already moved this tick — prevents the cascade
  // that scrambles isolated mineral columns. Sand (no FB_FALLING) cascades
  // freely so it pours through water naturally.
  if ((fb & FB_SWAP_LIQUID) && downCat === CAT_LIQUID && (!(fb & FB_FALLING) || !(downCell & MOVED_FLAG))) {
    w[dIdx] = t | writeFlags;
    w[idx] = (downCell & TYPE_MASK) | MOVED_FLAG;
    damage[idx] = 0;
    if (dirty) scene.dirtyMineral = true;
    return;
  }
  const bias = (tick & 1) ? 1 : -1;
  // 3. Diagonal-down with alternating bias. Step into AIR; for FB_SWAP_LIQUID
  // actors (sand, minerals) also swap diagonally into liquid so piles spread.
  if (fb & FB_DIAGONAL) {
    for (let dir = 0; dir < 2; dir++) {
      const dx = (dir === 0) ? bias : -bias;
      const diagCell = w[dIdx + dx];
      const diagCat = BLOCK_CAT[diagCell & TYPE_MASK];
      if (diagCat === CAT_AIR) {
        w[dIdx + dx] = t | writeFlags; w[idx] = AIR; damage[idx] = 0;
        if (dirty) scene.dirtyMineral = true;
        return;
      }
      if ((fb & FB_SWAP_LIQUID) && diagCat === CAT_LIQUID && (!(fb & FB_FALLING) || !(diagCell & MOVED_FLAG))) {
        w[dIdx + dx] = t | writeFlags;
        w[idx] = (diagCell & TYPE_MASK) | MOVED_FLAG;
        damage[idx] = 0;
        if (dirty) scene.dirtyMineral = true;
        return;
      }
    }
  }
  // 4. Sideways (liquid only).
  if (fb & FB_SIDEWAYS) {
    for (let dir = 0; dir < 2; dir++) {
      const dx = (dir === 0) ? bias : -bias;
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
        // Seeded if on band border OR resting on a non-mineral anchor
        // (CAT_SOLID/SANDLIKE/MAGIC mask = 44). Minerals propagate via BFS chain.
        const onBorder = x === tx0 || x === tx1 - 1 || y === ty0 || y === ty1 - 1;
        if ((onBorder || ((44 >> BLOCK_CAT[w[idx + WORLD_W] & TYPE_MASK]) & 1)) && visited[idx] !== tag) {
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

  // Death modal: name entry first (if qualified), then U restarts.
  if (scene.gameOver) {
    const ne = scene.nameEntry;
    if (ne) {
      let dirty = false;
      const dh = (c.pressed.P1_R ? 1 : 0) - (c.pressed.P1_L ? 1 : 0);
      if (dh) { c.pressed.P1_L = c.pressed.P1_R = false; ne.cursor = (ne.cursor + dh + 3) % 3; dirty = true; }
      const dv = (c.pressed.P1_U ? 1 : 0) - (c.pressed.P1_D ? 1 : 0);
      if (dv) { c.pressed.P1_U = c.pressed.P1_D = false; ne.letters[ne.cursor] = (ne.letters[ne.cursor] + dv + 26) % 26; dirty = true; }
      if (c.pressed.P1_1) {
        const nm = _AZ[ne.letters[0]] + _AZ[ne.letters[1]] + _AZ[ne.letters[2]];
        submitHighScore(nm, scene.score, scene.daysSurvived).then(() =>
          fetchHighScores().then(arr => {
            scene.highscores = arr.slice(0, 5);
            refreshHsText(scene);
          })
        );
        scene.deathModal.container.setVisible(false);
        scene.scene.restart();
        return;
      }
      if (dirty) refreshDeathModal(scene);
      c.pressed.P1_2 = false; c.pressed.P1_3 = false;
      return;
    }
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
  scene.player.vx = vx * (1.2 + scene.armor * 0.2);
  if (vx !== 0) scene.facing = vx;

  // Jump — joystick UP only (P1_U / W). Ground-jump OR swim-stroke: when
  // in any liquid you can kick upward repeatedly to simulate swimming.
  if (c.pressed.P1_U) {
    if (scene.player.onGround || (liquidStatus(scene, scene.player) & LQ_ANY)) {
      scene.player.vy = -3.9 - scene.armor * 0.4;
      scene.player.onGround = false;
    }
  }
  c.pressed.P1_U = false;

  // U (P1_1) — single press fires immediately; holding U auto-repeats.
  // Default 4/sec (every 15 ticks). Copper 5/sec (12), iron 6/sec (10),
  // mithril 7.5/sec (8). Lower-tier tools stay at 15.
  if (c.held.P1_1) scene.holdU = (scene.holdU || 0) + 1;
  else scene.holdU = 0;
  const _at = getActiveTier(scene);
  if (c.pressed.P1_1 || scene.holdU >= (_at > 2 ? 18 - _at * 2 : 15)) {
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
    ? tierToolName(scene.sword, ' SWORD')
    : tierToolName(scene.pick,  ' PICKAXE');
}

// Accumulate `amt` damage on a tile and break it if past hardness. Shared
// by tryMine (player) and monsterAttackTiles (monster chip-attacks).
// Returns the original tile id if it broke this hit, else 0.
function applyTileDamage(scene, idx, amt) {
  const t = scene.world[idx] & TYPE_MASK;
  const hard = BLOCK_HARDNESS[t];
  if (hard === 0) return 0;
  const d = Math.min(65535, scene.damage[idx] + amt);
  if (d >= hard) {
    scene.world[idx] = AIR;
    scene.damage[idx] = 0;
    scene.dirtyMineral = true;
    return t;
  }
  scene.damage[idx] = d;
  return 0;
}

function tryMine(scene, dx, dy) {
  if (!scene._mineBuf) scene._mineBuf = new Int32Array(8);
  const buf = scene._mineBuf;
  const n = getMineTargets(scene, dx, dy, buf);

  for (let i = 0; i < n; i += 2) {
    const tx = buf[i];
    const ty = buf[i + 1];
    if (tx < 1 || tx >= WORLD_W - 1 || ty < 1 || ty >= WORLD_H - 1) continue;
    const idx = ty * WORLD_W + tx;
    const t = scene.world[idx] & TYPE_MASK;
    if (BLOCK_CAT[t] === CAT_LIQUID) continue; // skip liquids, try next solid
    if (BLOCK_HARDNESS[t] === 0) continue; // AIR or unbreakable (MAGIC)

    // Swing animation fires regardless of break/no-break.
    scene.mineAnim = 14; scene.mineDx = dx; scene.mineDy = dy;
    const broken = applyTileDamage(scene, idx, TIER_DAMAGE[getActiveTier(scene)]);
    if (broken) {
      const cat = BLOCK_CAT[broken];
      if (broken === WOOD)                               sfx(scene, 'mineWood');
      else if (cat === CAT_MINERAL || cat === CAT_MAGIC) sfx(scene, 'mineMineral');
      else if (cat === CAT_SANDLIKE)                     sfx(scene, 'mineSand');
      else                                               sfx(scene, 'mineSolid');
      const dropT = BLOCK_DROP_TYPE[broken];
      const dropN = BLOCK_DROP_AMOUNT[broken];
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
      if (!(st & LQ_TOUCH_W)) {
        const dmg = (fallPx / FALL_DAMAGE_PX) | 0;
        applyPlayerDamage(scene, dmg);
      }
    }
    p.peakY = p.y;
  }
}

// Passthrough bitmasks (bit i set = tile id i is non-solid for the actor).
// Player passes through doors/stairs/beds/furnace; monster only stairs.
const PT_PLAYER = (1 << DOOR_WOOD) | (1 << DOOR_IRON) | (1 << STAIR_WOOD) | (1 << BED_WOOD) | (1 << BED_COPPER) | (1 << FURNACE) | (1 << FURNACE_HARD);
const PT_MONSTER = 1 << STAIR_WOOD;

function isSolid(cell, ptMask) {
  const t = cell & TYPE_MASK;
  if (ptMask & (1 << t)) return false;
  const cat = BLOCK_CAT[t];
  return cat !== CAT_AIR && cat !== CAT_LIQUID && cat !== CAT_DECOR;
}
const isSolidForPlayer  = c => isSolid(c, PT_PLAYER);
const isSolidForMonster = c => isSolid(c, PT_MONSTER);

// Iterate every world tile that overlaps entity `e`'s AABB. `fn(t, w, idx)`
// is called per in-bounds tile; if it returns truthy, iteration stops and
// the value is returned. Out-of-world cells are skipped (clamped).
function forEachAABBTile(scene, e, fn) {
  const w = scene.world;
  const halfW = e.w / 2;
  const x0 = ((e.x - halfW) / TILE) | 0;
  const x1 = ((e.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((e.y - e.h) / TILE) | 0;
  const y1 = ((e.y - 0.001) / TILE) | 0;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= WORLD_H) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= WORLD_W) continue;
      const r = fn(w[y * WORLD_W + x] & TYPE_MASK, w, y * WORLD_W + x);
      if (r) return r;
    }
  }
  return 0;
}

// Returns the bed type (BED_WOOD/BED_COPPER) if overlapped, else 0.
function playerOverlapsBed(scene) {
  return forEachAABBTile(scene, scene.player, t => (t === BED_WOOD || t === BED_COPPER) ? t : 0);
}

// Double-press O: first press prompts, second press within ~1s commits.
function handleOPress(scene) {
  const night = scene.nightActive;
  const bed = night ? playerOverlapsBed(scene) : 0;
  if (night ? (scene.sleptThisNight || !bed) : (scene.dayTime < scene.dayLengthTicks / 2))
    return showToast(scene, night ? 'NO BED' : 'WAIT');
  const now = scene.tickCount | 0;
  if (scene.oArmed && now <= scene.oArmedUntil) {
    scene.oArmed = false;
    if (night) {
      scene.nightTicksRemaining -= bed === BED_COPPER ? (scene.nightLengthTicks / 2) | 0 : 30 * TICK_RATE;
      scene.sleptThisNight = true;
      scene.everSlept = true;
      showToast(scene, 'ZZZ...');
    } else goHome(scene);
    return;
  }
  showToast(scene, B3 + (night ? ': SLEEP' : ': SKIP'));
  scene.oArmed = true;
  scene.oArmedUntil = now + TICK_RATE;
}

function playerOverlapsStair(scene) {
  return !!forEachAABBTile(scene, scene.player, t => t === STAIR_WOOD);
}

// Slowest (max) fallTicks of any liquid tile overlapping the player AABB.
function playerLiquidFallTicks(scene) {
  let maxFall = 0;
  forEachAABBTile(scene, scene.player, t => {
    if (BLOCK_CAT[t] === CAT_LIQUID) {
      const ft = BLOCK_FALL_TICKS[t];
      if (ft > maxFall) maxFall = ft;
    }
  });
  return maxFall;
}

// Liquid status bitmask. Bits: 1=fullyInWater, 2=touchingWater, 4=touchingLava, 8=inAnyLiquid.
const LQ_FULL_W = 1, LQ_TOUCH_W = 2, LQ_TOUCH_LAVA = 4, LQ_ANY = 8;
function liquidStatus(scene, e) {
  const halfW = e.w / 2;
  const x0 = ((e.x - halfW) / TILE) | 0;
  const x1 = ((e.x + halfW - 0.001) / TILE) | 0;
  const y0 = ((e.y - e.h) / TILE) | 0;
  const y1 = ((e.y - 0.001) / TILE) | 0;
  const totalCells = (x1 - x0 + 1) * (y1 - y0 + 1);
  let waterCells = 0, lavaCells = 0;
  forEachAABBTile(scene, e, t => {
    if (t === WATER) waterCells++;
    else if (t === LAVA) lavaCells++;
  });
  let s = 0;
  if (waterCells > 0) s |= LQ_TOUCH_W;
  if (waterCells === totalCells && waterCells > 0) s |= LQ_FULL_W;
  if (lavaCells > 0) s |= LQ_TOUCH_LAVA;
  if (waterCells + lavaCells > 0) s |= LQ_ANY;
  return s;
}

function updatePlayerHazards(scene) {
  if (scene.gameOver) return;
  const p = scene.player;
  const st = liquidStatus(scene, scene.player);
  const tw = st & LQ_TOUCH_W;

  if (st & LQ_FULL_W) {
    p.submergedTicks++;
    if (p.submergedTicks >= DROWN_TICKS) {
      p.submergedTicks = 0;
      applyPlayerDamage(scene, 1);
    }
  } else {
    p.submergedTicks = 0;
  }

  if (st & LQ_TOUCH_LAVA) {
    p.lavaTicks++;
    if (p.lavaTicks >= LAVA_TICKS) {
      p.lavaTicks = 0;
      applyPlayerDamage(scene, 1);
    }
  } else {
    p.lavaTicks = 0;
  }

  if (tw && !p.wasInWater) sfx(scene, 'splash');
  p.wasInWater = !!tw;
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
  const hs = scene.highscores;
  if (hs.length < 5 || scene.score > hs[hs.length - 1].s) {
    scene.nameEntry = { letters: [0, 0, 0], cursor: 0 };
  }
  refreshDeathModal(scene);
  scene.deathModal.container.setVisible(true);
}

function refreshDeathModal(scene) {
  const ne = scene.nameEntry;
  let t = 'SCORE: ' + scene.score + ' D' + scene.daysSurvived;
  if (ne) {
    let r = '';
    for (let i = 0; i < 3; i++) {
      const c = _AZ[ne.letters[i]];
      r += i === ne.cursor ? '[' + c + ']' : ' ' + c + ' ';
    }
    t += '\nHIGH!\n' + r;
  }
  scene.deathModal.statsText.setText(t);
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

// Adds a full-screen dim + a centered box with stroke to container `c`.
// Used by death modal and build menu.
function addDimBox(scene, c, w, h, fill, stroke, dimAlpha) {
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, dimAlpha));
  c.add(scene.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, w, h, fill).setStrokeStyle(2, stroke));
}

// Center-anchored monospace text helper. `opts` extends the style object.
function mkText(scene, x, y, s, sz, col, opts) {
  return scene.add.text(x, y, s, { fontFamily: FF, fontSize: sz + 'px', color: col, ...opts }).setOrigin(0.5);
}

function buildHud(scene) {
  // Stats backdrop + 5 stacked single-line readouts.
  scene.add.rectangle(4, 4, 200, 74, 0x0a0d18, 0.7).setOrigin(0).setDepth(19);
  const STATS = [
    ['toolText',     6, C_Y],
    ['dayText',     20, C_B],
    ['hpText',      34, C_R],
    ['villagerText',48, '#a0e0a0'],
    ['scoreText',   62, C_Y],
  ];
  for (const [k, y, color] of STATS) {
    scene[k] = scene.add.text(8, y, '', { ...STY_HUD, color }).setDepth(20);
  }

  scene.invHud = { container: scene.add.container(8, 80).setDepth(20), rows: [] };

  scene.toastText = mkText(scene, GAME_WIDTH / 2, GAME_HEIGHT * 0.55, '', 48, C_Y,
    { ...STY_BS, align: 'center' })
    .setDepth(50).setAlpha(0);

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
  addDimBox(scene, c, 420, 240, 0x240010, 0xff6666, 0.85);
  const cx = GAME_WIDTH / 2, cy = GAME_HEIGHT / 2;
  c.add(mkText(scene, cx, cy - 80, 'YOU DIED', 36, C_R, STY_B));
  const stats = mkText(scene, cx, cy - 10, '', 14, FW, { align: 'center', lineSpacing: 4 });
  c.add(stats);
  c.add(mkText(scene, cx, cy + 80, B1 + ' TO RESTART', 12, C_M));
  scene.deathModal = { container: c, statsText: stats };
}

// ----- Title screen -----

function buildTitleUi(scene) {
  const c = scene.add.container(0, 0).setDepth(55);
  const cx = GAME_WIDTH / 2, cy = GAME_HEIGHT / 2;
  c.add(scene.add.rectangle(cx, cy, GAME_WIDTH, GAME_HEIGHT, 0x050810, 0.92));
  c.add(mkText(scene, cx, cy - 80, 'STRIKE AND STONE', 40, C_Y, STY_BS));
  c.add(mkText(scene, cx, cy - 30, 'mine by day, survive the night', 14, C_B));
  c.add(mkText(scene, cx, cy + 40, 'PRESS ' + B1 + ' TO START', 16, FW, STY_B));
  c.add(mkText(scene, cx, cy + 78, 'A/D move   W jump   ' + B1 + ' mine/attack   ' + B2 + ' menu   ' + B3 + ' home/sleep', 10, C_G));
  scene.hsText = mkText(scene, cx, cy + 130, '', 11, C_Y);
  c.add(scene.hsText);
  scene.titleContainer = c;
  refreshHsText(scene);
}

function refreshHsText(scene) {
  const hs = scene.highscores;
  let s = hs.length ? 'TOP 5' : '';
  for (let i = 0; i < hs.length; i++) s += `\n${i+1}. ${hs[i].n} ${hs[i].s} D${hs[i].d}`;
  scene.hsText.setText(s);
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
    ...STY_HUD, color: C_Y, fontStyle: 'bold', align: 'center', lineSpacing: 2,
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
    c.setScale(2); c.y = 180;
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

// Predicates indexed by step (1..N). Each returns truthy when the player
// completed that step's task. Aligned with TUTORIAL_STEPS.
const TUT_PRED = [
  null,
  s => s.inventory[WOOD] >= 1,
  s => s.inventory[WOOD] >= 10,
  s => s.pick >= TIER_WOOD,
  s => s.basePlaced,
  s => s.bedPlaced,
  s => s.everSlept,
  s => s.smeltedAny,
  s => s.villagerCount >= 1,
];

function tickTutorial(scene) {
  const t = scene.tutorial;
  const s = t.step;
  if (s === 0 || s >= TUTORIAL_STEPS.length - 1) return;
  const p = TUT_PRED[s];
  if (p && p(scene)) { setTutorialStep(scene, s + 1); return; }
  if (s === TUTORIAL_FINAL_STEP && scene.tickCount >= t.finalDismissTick) {
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
  const r = Math.max(0, night ? scene.nightTicksRemaining : scene.dayLengthTicks - scene.dayTime) / TICK_RATE | 0;
  const ss = r % 60;
  scene.dayText.setText((night ? 'NIGHT ' : 'DAY ') + (r / 60 | 0) + ':' + (ss < 10 ? '0' : '') + ss);
  scene.dayText.setColor(night ? '#8888ff' : C_B);
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
        .text(14, row * 14 - 1, '', { ...STY_HUD, color: FW })
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

const BUILD_MENU_ROW_COUNT = 20;
const BUILD_MENU_ROW_STEP = 15;

function getCurrentRecipes(scene) {
  return scene.buildMenu.tab === 'tools' ? TOOL_RECIPES : BUILDING_RECIPES;
}

// Tool recipes lock once the player's slot reaches that tier (handles both
// "already crafted" and "skipped a lower tier"). Buildings never lock.
function isRecipeLocked(scene, recipe) {
  if (recipe.pickTier  != null) return scene.pick  >= recipe.pickTier;
  if (recipe.swordTier != null) return scene.sword >= recipe.swordTier;
  if (recipe.armorTier != null) return scene.armor >= recipe.armorTier;
  return false;
}

// Build the cost string shown in the menu. Tools use the `cost` array;
// buildings use `costPerTile` / `costTotal` + `material`. Only runs on
// menu events, allocations are fine here.
function recipeCostLabel(r) {
  if (r.cost) return r.cost.map(([id, amt]) => amt + ' ' + BLOCK_NAME[id].toUpperCase()).join(' + ');
  const amt = r.costPerTile != null ? r.costPerTile : r.costTotal;
  return amt != null ? amt + ' ' + BLOCK_NAME[r.material].toUpperCase() : '';
}

// Cost of a building recipe at given size. Falls back to costPerTile.
function placementCost(r, w, h) {
  return r.costTotal != null ? r.costTotal : r.costPerTile * w * h;
}

// Does the player have enough materials right now? Works for both schemas.
function recipeAffordable(scene, recipe) {
  const inv = scene.inventory;
  if (recipe.cost) {
    for (const [id, amt] of recipe.cost) if (inv[id] < amt) return false;
    return true;
  }
  const d = PLACEMENT_DEFAULTS[recipe.kind];
  return inv[recipe.material] >= placementCost(recipe, d[0], d[2]);
}

// Walk recipes from `fromIdx` in `dir` direction, returning first
// unlocked index. -1 if all locked. `findFirstUnlocked` is just
// `findUnlocked(s, r, -1, 1)` with a clamp fallback.
function findUnlocked(scene, recipes, fromIdx, dir) {
  const n = recipes.length;
  for (let i = 1; i <= n; i++) {
    const idx = (((fromIdx + dir * i) % n) + n) % n;
    if (!isRecipeLocked(scene, recipes[idx])) return idx;
  }
  return -1;
}

function buildBuildMenuUi(scene) {
  const c = scene.add.container(0, 0).setDepth(40);
  c.setVisible(false);
  scene.buildMenuContainer = c;

  addDimBox(scene, c, 460, 488, 0x1a2238, 0xffe066, 0.75);

  c.add(mkText(scene, GAME_WIDTH / 2, 108, 'BUILD', 22, C_Y, STY_B));

  // Tab headers (active tab is highlighted; switch with L/R).
  scene.buildMenuTabs = {};
  scene.buildMenuTabs.tools = mkText(scene, GAME_WIDTH / 2 - 80, 140, '< TOOL', 13, C_Y, STY_B);
  scene.buildMenuTabs.buildings = mkText(scene, GAME_WIDTH / 2 + 80, 140, 'BUILD >', 13, C_G, STY_B);
  c.add(scene.buildMenuTabs.tools);
  c.add(scene.buildMenuTabs.buildings);

  // Row slots accommodate the largest tab (buildings). Tighter step so
  // all 15 recipes fit. Unused rows hidden when on TOOLS tab.
  scene.buildMenuRows = [];
  for (let i = 0; i < BUILD_MENU_ROW_COUNT; i++) {
    const row = {};
    const y = 165 + i * BUILD_MENU_ROW_STEP;
    row.bg = scene.add.rectangle(GAME_WIDTH / 2, y, 420, BUILD_MENU_ROW_STEP - 2, 0x2a3555, 0).setOrigin(0.5);
    row.text = scene.add.text(GAME_WIDTH / 2 - 195, y, '', { ...STY_HUD, color: FW }).setOrigin(0, 0.5);
    row.strike = scene.add.rectangle(GAME_WIDTH / 2, y, 380, 1, 0x808080, 0).setOrigin(0.5);
    c.add(row.bg);
    c.add(row.text);
    c.add(row.strike);
    scene.buildMenuRows.push(row);
  }

  c.add(mkText(scene, GAME_WIDTH / 2, 478, 'U/D PICK  L/R TAB  ' + B1 + ' OK  ' + B2 + ' X', 10, C_M));
}

function openBuildMenu(scene) {
  scene.buildMenu.open = true;
  scene.buildMenu.tab = 'tools';
  const recipes = getCurrentRecipes(scene);
  scene.buildMenu.cursor = Math.max(0, findUnlocked(scene, recipes, -1, 1));
  scene.buildMenuContainer.setVisible(true);
  refreshBuildMenu(scene);
}

function closeBuildMenu(scene) {
  scene.buildMenu.open = false;
  scene.buildMenuContainer.setVisible(false);
}

function refreshBuildMenu(scene) {
  const recipes = getCurrentRecipes(scene);

  scene.buildMenuTabs.tools.setColor(scene.buildMenu.tab === 'tools' ? C_Y : C_G);
  scene.buildMenuTabs.buildings.setColor(scene.buildMenu.tab === 'buildings' ? C_Y : C_G);

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
    else if (!canAfford) color = C_G;
    else                 color = FW;
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
    scene.buildMenu.cursor = Math.max(0, findUnlocked(scene, getCurrentRecipes(scene), -1, 1));
    refreshBuildMenu(scene);
    return;
  }
  // U/D moves cursor, skipping locked rows.
  if (c.pressed.P1_U || c.pressed.P1_D) {
    const dir = c.pressed.P1_U ? -1 : 1;
    c.pressed.P1_U = false; c.pressed.P1_D = false;
    const next = findUnlocked(scene, getCurrentRecipes(scene), scene.buildMenu.cursor, dir);
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
  if (recipe.cost && !recipeAffordable(scene, recipe)) {
    showToast(scene, 'NOT ENOUGH!');
    return;
  }

  // Pick / sword / armor recipes → upgrade the relevant slot. Lock-check
  // already covered "already have higher tier", so we just consume + assign.
  const tier = recipe.pickTier != null ? recipe.pickTier
             : recipe.swordTier != null ? recipe.swordTier
             : recipe.armorTier;
  if (tier != null) {
    for (const [id, amt] of recipe.cost) inv[id] -= amt;
    if (recipe.pickTier != null) scene.pick = tier;
    else if (recipe.swordTier != null) scene.sword = tier;
    else {
      scene.armor = tier;
      scene.player.maxHp = PLAYER_MAX_HP + ARMOR_BONUS[tier];
      scene.player.hp = scene.player.maxHp;
    }
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

// Bitmask of placed-building tiles — bricks, furniture, doors, stairs. These
// can all be built on top of (they provide support for the next layer).
const STRUCT_MASK = (1 << BRICK_DIRT) | (1 << BRICK_STONE) | (1 << BRICK_COPPER) |
  (1 << BRICK_IRON) | (1 << BRICK_HARD_ROCK) | (1 << OBSIDIAN) | (1 << FURNACE) |
  (1 << FURNACE_HARD) | (1 << DOOR_WOOD) | (1 << DOOR_IRON) | (1 << STAIR_WOOD) |
  (1 << BED_WOOD) | (1 << BED_COPPER);
const isStructuralTile = cell => STRUCT_MASK & (1 << (cell & TYPE_MASK));

function enterPlacement(scene, recipe) {
  const cfg = PLACEMENT_DEFAULTS[recipe.kind];
  const p = scene.player;
  // Start the preview centered in front of the player so they can see it.
  const startCenterTx = Math.round(p.x / TILE) + scene.facing * 2;
  const p_ = scene.placement;
  p_.active = true;
  p_.recipe = recipe;
  p_.w = cfg[0];
  p_.h = cfg[2];
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

// Compute ty + validity. Unified scan from feet upward: first row whose
// footprint is all AIR and whose row-below satisfies the support rule.
//   base    → ANY column structural OR solid (allows floating roofs)
//   furnace → ALL columns structural OR solid
//   else    → ALL columns structural (built tiles only)
function refreshPlacement(scene) {
  const w = scene.world;
  const p_ = scene.placement;
  const recipe = p_.recipe;
  const feetTy = ((scene.player.y - 0.001) / TILE) | 0;
  const acceptSolid = recipe.kind === 'base' || recipe.kind === 'furnace';
  const anyColumn = recipe.kind === 'base';

  let valid = false;
  for (let y = feetTy + 1; y >= p_.h; y--) {
    let footprintOk = true;
    for (let yy = y - p_.h + 1; yy <= y && footprintOk; yy++) {
      if (yy < 1 || yy >= WORLD_H - 1) { footprintOk = false; break; }
      for (let x = p_.tx; x < p_.tx + p_.w; x++) {
        if (x < 1 || x >= WORLD_W - 1) { footprintOk = false; break; }
        if ((w[yy * WORLD_W + x] & TYPE_MASK) !== AIR) { footprintOk = false; break; }
      }
    }
    if (!footprintOk) continue;
    let anyOk = false, allOk = true;
    for (let x = p_.tx; x < p_.tx + p_.w; x++) {
      if (x < 1 || x >= WORLD_W - 1) { allOk = false; continue; }
      const c = w[(y + 1) * WORLD_W + x];
      const ok = isStructuralTile(c) || (acceptSolid && isSolidForPlayer(c));
      if (ok) anyOk = true; else allOk = false;
    }
    if (anyColumn ? anyOk : allOk) { p_.ty = y; valid = true; break; }
  }
  if (!valid) p_.ty = feetTy;

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
  if (valid && scene.inventory[recipe.material] < placementCost(recipe, p_.w, p_.h)) valid = false;

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
  if (cfg[4] === 0) {
    if (c.pressed.P1_U) { c.pressed.P1_U = false; p_.w = Math.min(cfg[1], p_.w + 1); p_.tx = Math.min(p_.tx, WORLD_W - p_.w - 1); }
    if (c.pressed.P1_D) { c.pressed.P1_D = false; p_.w = Math.max(cfg[0], p_.w - 1); }
  } else if (cfg[4] === 1) {
    if (c.pressed.P1_U) { c.pressed.P1_U = false; p_.h = Math.min(cfg[3], p_.h + 1); }
    if (c.pressed.P1_D) { c.pressed.P1_D = false; p_.h = Math.max(cfg[2], p_.h - 1); }
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
  const cost = placementCost(recipe, p_.w, p_.h);
  if (scene.inventory[recipe.material] < cost) { showToast(scene, 'NOT ENOUGH!'); return; }
  scene.inventory[recipe.material] -= cost;

  const w = scene.world;
  for (let x = p_.tx; x < p_.tx + p_.w; x++) {
    for (let y = p_.ty - p_.h + 1; y <= p_.ty; y++) {
      w[y * WORLD_W + x] = recipe.tile;
    }
  }

  // Furnace instance tracking (a 2×2 of FURNACE tiles + proximity state).
  // acceptMask gates which ores this tier can smelt (stone vs hard rock).
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
      acceptMask: recipe.tile === FURNACE_HARD ? ORE_MASK_HARD : ORE_MASK_STONE,
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
  const tick = scene.tickCount;
  const slots = ORE_RAWS.length;
  const w = scene.world;
  // Backward iteration so we can splice broken clusters mid-loop.
  for (let fi = scene.furnaces.length - 1; fi >= 0; fi--) {
    const f = scene.furnaces[fi];
    const b = f.cy * WORLD_W + f.cx;
    // Cluster integrity: if any of the 2x2 tiles is AIR, the player broke it.
    if (!w[b] || !w[b+1] || !w[b+WORLD_W] || !w[b+WORLD_W+1]) {
      f.indicator.destroy();
      scene.furnaces.splice(fi, 1);
      continue;
    }
    // Fuel + ore consumed up-front so breaking mid-smelt doesn't refund.
    if (f.smeltIdx < 0) {
      for (let i = 0; i < slots; i++) {
        if (!(f.acceptMask & (1 << ORE_RAWS[i]))) continue;
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
      if (!(f.acceptMask & (1 << ore))) continue;
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

// Difficulty scale applied to HP and damage. Days 1–2 are flat 1×; day 3 is
// the baseline (= old day 1). Curve stretched ~1.7× so cap (2.5×) lands at day 20.
function monsterScale(scene) {
  const d = scene.daysSurvived;
  if (d <= 2) return 1;
  const s = 1 + (d - 3) * 0.09;
  return s > 2.5 ? 2.5 : s;
}

const _typesBuf = new Uint8Array(5);
function spawnMonstersTick(scene) {
  scene.monsterSpawnTimer--;
  if (scene.monsterSpawnTimer > 0) return;
  const d = scene.daysSurvived;
  // Day 1 = 3 mons / 3s; day 2 = 4 mons / 2.5s; day 3 = baseline (5 / 2s);
  // day 20 = cap (24 mons / 1s). Floor on interval = 60 ticks (1 second).
  let maxMons;
  if (d === 1)      { scene.monsterSpawnTimer = 180; maxMons = 3; }
  else if (d === 2) { scene.monsterSpawnTimer = 150; maxMons = 4; }
  else {
    const e = d - 3;
    scene.monsterSpawnTimer = Math.max(60, 120 - ((e * 60 / 17) | 0));
    maxMons = Math.min(24, 5 + ((e * 20 / 17) | 0));
  }
  if (scene.monsters.length >= maxMons) return;
  // Pick uniformly from the types unlocked this night.
  const mask = nightMask(d - 1);
  let n = 0;
  for (let i = 0; i < 5; i++) if (mask & (1 << i)) _typesBuf[n++] = i;
  if (n === 0) return;
  const chosen = _typesBuf[(Math.random() * n) | 0];
  // Slime "rains" — spawn 3 at once from the sky.
  const count = chosen === MON_SLIME ? 3 : 1;
  for (let k = 0; k < count && scene.monsters.length < maxMons; k++) spawnMonster(scene, chosen);
}

// True when player is below row 72 (y = 720 px) — bajo la capa de dirt.
// Triggers ghost spawn altiro al entrar a stone, sin importar superficie local.
function isPlayerUnderground(scene) {
  return scene.player.y > 72 * TILE;
}

function tickGhostSpawner(scene) {
  if (!isPlayerUnderground(scene)) { scene.ghostSpawnTimer = 0; return; }
  if (--scene.ghostSpawnTimer > 0) return;
  scene.ghostSpawnTimer = 60;
  let g = 0;
  for (const m of scene.monsters) if (m.type === MON_GHOST && ++g >= 5) return;
  // Spawn at the left or right edge of the viewport, in its lower half
  // (creepy "emerging from below" feel). Phase flag lets them ignore tiles.
  const x = scene.cam.x + (Math.random() < 0.5 ? TILE : GAME_WIDTH - TILE);
  const y = scene.cam.y + GAME_HEIGHT / 2 + Math.random() * GAME_HEIGHT / 2;
  scene.monsters.push(createMonster(scene, MON_GHOST, x, y));
}

function spawnMonster(scene, type) {
  const p = scene.player;
  let x, y;
  if (type === MON_SLIME) {
    // Sky-rain: viewport split in 3 slots so consecutive slimes spread out.
    x = clamp(scene.cam.x + (scene.monsters.length % 3 + Math.random()) * (GAME_WIDTH / 3),
              2 * TILE, (WORLD_W - 2) * TILE);
    y = Math.max(2 * TILE, scene.cam.y - 20);
  } else {
    const side = Math.random() < 0.5 ? -1 : 1;
    x = Math.max(2 * TILE, Math.min((WORLD_W - 2) * TILE, p.x + side * (GAME_WIDTH / 2 + 24)));
    if (type === MON_FLYER || type === MON_GHOST) {
      y = Math.max(8 * TILE, p.y - GAME_HEIGHT * 0.4);
    } else {
      const tx = Math.max(1, Math.min(WORLD_W - 2, (x / TILE) | 0));
      y = findSurface(scene.world, tx) * TILE;
    }
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

// Monster visual: flat [bodyW, bodyH, bodyY, bodyColor, eyeColor] × 5.
const MON_VIS = [
  12, 7,  -4,  0x44a060, 0x101018,   // slime
  10, 14, -7,  0x4a5d2a, 0x101018,   // zombie torso (head added in builder)
  14, 7,  -4,  0x6a2a30, 0xff6060,   // flyer
  10, 12, -8,  0xc4dcf2, 0x101018,   // ghost
  12, 12, -8,  0x5aaa30, 0x101018,   // bomber
];
function buildMonsterVisual(scene, type) {
  const c = scene.add.container(0, 0).setDepth(9);
  const o = type * 5;
  const by = MON_VIS[o + 2];
  c.add(scene.add.rectangle(0, by, MON_VIS[o], MON_VIS[o + 1], MON_VIS[o + 3]));
  // Zombie: distinct head on top of the torso so it doesn't read as a slime.
  if (type === MON_ZOMBIE) {
    c.add(scene.add.rectangle(0, by - 11, 8, 7, 0x7a8c4c));
    c.add(scene.add.rectangle(2, by - 12, 2, 2, MON_VIS[o + 4]));
  } else {
    c.add(scene.add.rectangle(2, by - 1, 2, 2, MON_VIS[o + 4]));
  }
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
  // Iterate front column, then tile below feet (so a monster standing on
  // a built block still chews it).
  const fx = ((m.x + m.facing * (m.w / 2 + 1)) / TILE) | 0;
  const yStart = ((m.y - m.h) / TILE) | 0;
  const yEnd = ((m.y - 0.001) / TILE) | 0;
  const yFeet = (m.y / TILE) | 0;
  for (let i = yStart; i <= yEnd + 1; i++) {
    const tx = i <= yEnd ? fx : (m.x / TILE) | 0;
    const ty = i <= yEnd ? i : yFeet;
    if (tx < 1 || tx >= WORLD_W - 1 || ty < 1 || ty >= WORLD_H - 1) continue;
    const idx = ty * WORLD_W + tx;
    const cell = scene.world[idx];
    const t = cell & TYPE_MASK;
    if (isStructuralTile(cell) || t === WOOD ||
        (m.stuck && (t === DIRT || t === STONE || t === SAND))) {
      applyTileDamage(scene, idx, (M_ATK_DMG[m.type] * m.dmgScale) | 0);
      return;
    }
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

  if (flags & MF_GLIDE) {
    const dy = (p.y - p.h / 2) - (m.y - m.h / 2);
    const dist = Math.hypot(dx, dy) || 1;
    const sp = M_GLIDE[type];
    m.vx = (dx / dist) * sp;
    m.vy = (dy / dist) * sp;
    if (phases) { m.x += m.vx; m.y += m.vy; }
    else        { moveBox(scene, m, isSolidForMonster, 0, 0); }
  } else {
    const onGround = monsterOnGround(scene, m);
    const fuseBurning = (flags & MF_EXPLODES) && m.fuseTicks > 0;

    if (!fuseBurning) {
      let jumpNow = false;
      if ((flags & MF_JUMP_TIMER) && onGround) {
        m.jumpTimer--;
        if (m.jumpTimer <= 0) {
          jumpNow = true;
          // Only slime has MF_JUMP_TIMER; range 30..60.
          m.jumpTimer = 30 + ((Math.random() * 30) | 0);
        }
      } else if ((flags & MF_JUMP_BLOCKED) && onGround && monsterBlockedAhead(scene, m)) {
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
  // Pooled visual flash sized to the blast radius.
  const flash = scene.bomberFlash;
  flash.setPosition((cx + 0.5) * TILE - scene.cam.x, (cy + 0.5) * TILE - scene.cam.y);
  flash.setSize(r * 2 * TILE, r * 2 * TILE);
  flash.setAlpha(0.7);
  flash.setVisible(true);
  scene.tweens.killTweensOf(flash);
  scene.tweens.add({ targets: flash, alpha: 0, duration: 350, onComplete: () => flash.setVisible(false) });
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

function killMonGfx(m) {
  m.sprite.destroy();
  if (m.hpBarBg) m.hpBarBg.destroy();
  if (m.hpBarFg) m.hpBarFg.destroy();
}

// Centralized cleanup so sprite + HP bar + array entry go together.
function destroyMonster(scene, m) {
  killMonGfx(m);
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
  for (let i = 0; i < scene.monsters.length; i++) killMonGfx(scene.monsters[i]);
  scene.monsters.length = 0;
  scene.monsterSpawnTimer = BASE_SPAWN_INTERVAL;
}

// ----- Villagers: 9..80-cell rooms with ≥1 bed and ≥1 built wall.
const VILLAGER_BODY_COLORS = [0x4060a0, 0xa04060];

// Per-bed BFS: for each bed in the world, flood the AIR pocket adjacent
// to it (cap 100 cells). If the flood reaches the world border or exceeds
// the cap → open. If it ends within bounds AND saw a built wall → valid
// closed room. Each bed uses its own visitedTag so floods don't interfere.
function scanVillages(scene) {
  const w = scene.world;
  const visited = scene.visited;
  const N = w.length;
  const Q = scene.bigBfsQueue;
  const out = [];
  const beds = [];
  // 1) One linear pass to find every bed in the world.
  for (let i = 0; i < N; i++) {
    const t = w[i] & TYPE_MASK;
    if (t === BED_WOOD || t === BED_COPPER) beds.push(i, t);
  }
  // 2) Per-bed local flood with its own tag. Caps at 80 cells so we never
  //    explore the whole sky.
  for (let bi = 0; bi < beds.length; bi += 2) {
    scene.visitedTag = (scene.visitedTag + 1) & 0xff;
    if (scene.visitedTag === 0) { visited.fill(0); scene.visitedTag = 1; }
    const tag = scene.visitedTag;
    const bedIdx = beds[bi];
    // Seed from any AIR cell touching the bed.
    let qh = 0, qt = 0;
    const seeds = [bedIdx - WORLD_W, bedIdx + WORLD_W, bedIdx - 1, bedIdx + 1];
    for (const s of seeds) {
      if (s >= 0 && s < N && (w[s] & TYPE_MASK) === AIR && visited[s] !== tag) {
        visited[s] = tag;
        Q[qt++] = s;
      }
    }
    if (qt === 0) continue;
    let vol = 0, ok = 1, builtWalls = 0;
    while (qh < qt) {
      const idx = Q[qh++];
      if (++vol > 100) { ok = 0; break; }
      const x = idx % WORLD_W, y = (idx / WORLD_W) | 0;
      if (x <= 0 || x >= WORLD_W - 1 || y <= 0 || y >= WORLD_H - 1) { ok = 0; break; }
      const nbrs = [idx - 1, idx + 1, idx - WORLD_W, idx + WORLD_W];
      for (let k = 0; k < 4; k++) {
        const n = nbrs[k];
        if (n < 0 || n >= N || visited[n] === tag) continue;
        const nt = w[n] & TYPE_MASK;
        const cat = BLOCK_CAT[nt];
        if (cat === CAT_AIR || cat === CAT_DECOR) { visited[n] = tag; Q[qt++] = n; }
        else if (isStructuralTile(w[n])) builtWalls++;
      }
    }
    if (ok && vol >= 9 && builtWalls > 0) out.push(bedIdx, beds[bi + 1]);
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
    let dead = st & (LQ_TOUCH_LAVA | LQ_FULL_W);
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
  g.gain.setValueAtTime(1e-4, t);
  g.gain.linearRampToValueAtTime(peak, t + (atk || 0.005));
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
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
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
  let node = src;
  if (filterType) {
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = filterFreq;
    src.connect(f); node = f;
  }
  node.connect(g); g.connect(ctx.destination);
  src.start(t); src.stop(t + dur);
}

const SFX_FNS = {
  mineMineral: ctx => { toneBurst(ctx, 900, 0.07, 'square',  0.06, 0.003); noiseBurst(ctx, 0.05, 0.04, 'lowpass',  300); },
  mineSolid:   ctx => { noiseBurst(ctx, 0.09, 0.09, 'lowpass', 400); },
  mineSand:    ctx => { noiseBurst(ctx, 0.12, 0.10, 'bandpass', 1500); },
  mineWood:    ctx => { toneBurst(ctx, 180, 0.08, 'square', 0.07, 0.004); noiseBurst(ctx, 0.04, 0.06, 'bandpass', 600); },
  playerHurt:  ctx => { toneBurst(ctx, 220, 0.22, 'sawtooth', 0.10, 0.008); },
  monsterHurt: ctx => { toneBurst(ctx, 700, 0.08, 'sawtooth', 0.06, 0.004); },
  explosion:   ctx => {
    const o = ctx.createOscillator(); o.type = 'sine';
    const tt = ctx.currentTime;
    o.frequency.setValueAtTime(200, tt);
    o.frequency.exponentialRampToValueAtTime(35, tt + 0.45);
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0.20, tt);
    gg.gain.exponentialRampToValueAtTime(1e-4, tt + 0.45);
    o.connect(gg); gg.connect(ctx.destination);
    o.start(tt); o.stop(tt + 0.5);
    noiseBurst(ctx, 0.5, 0.20, 'lowpass', 450);
  },
  splash:     ctx => { noiseBurst(ctx, 0.35, 0.08, 'highpass', 1800); },
  bomberFuse: ctx => { toneBurst(ctx, 900, 0.05, 'square', 0.04, 0.002); },
};

function sfx(scene, name) {
  const ctx = scene.audioCtx;
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  SFX_FNS[name](ctx);
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
  g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
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

