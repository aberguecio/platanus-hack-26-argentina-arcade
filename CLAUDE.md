@AGENTS.md

# Engine architecture (v2) — read before editing game.js

This game is a falling-sand miner. The engine has a few non-obvious
conventions that the user has explicitly endorsed. Future agents must
follow them; do not reorganize without confirmation.

## Single-file modularization

All code lives in `game.js` because AGENTS.md forbids editing other files
and the platform forbids `import`/`require`. Modularity comes from clearly
delimited sections, small functions, and a single source of truth for
block data:

```
1. Config & constants            — GAME_*, TILE, VW/VH, WORLD_*, TICK_RATE …
2. Block registry                — BLOCKS array + flat lookup tables
3. Cabinet input scaffolding     — CABINET_KEYS (preserve verbatim)
4. Phaser bootstrap              — config + new Phaser.Game(...) + create()
5. World generation              — generateWorld, blob, findSurface
6. Tick loop & dispatch          — update, runTick
7. Falling-sand simulation       — simulateViewport + per-category helpers
                                   + resolveMineralStability
8. Player controller             — handleInput, movePlayer, collidesPlayer,
                                   getMineTargets, tryMine
9. Camera                        — updateCamera, clamp
10. Rendering                    — render, buildPlayerVisual, updatePlayerVisual
11. Controls scaffolding         — createControls (preserve verbatim)
12. Storage scaffolding          — getStorage, storageGet, storageSet
```

Keep functions ≤ ~40 lines. If a function grows past that, extract a helper
*in the same section*.

## Block registry — the single source of truth

Every block type is one row in `BLOCKS` with: `id, cat, color, fallTicks,
hardness`. The registry is then unpacked into flat typed-array lookups
(`BLOCK_CAT`, `BLOCK_COLOR`, `BLOCK_FALL_TICKS`, `BLOCK_HARDNESS`) used in
the hot path.

**Adding a new block type = appending one row.** No other code edits are
needed if the behavior fits an existing category. If it needs a new
behavior, add a `CAT_*` constant and a `tryX` helper in section 7.

### Categories

| Category    | Falling behavior                                                    | Examples            |
|-------------|---------------------------------------------------------------------|---------------------|
| `CAT_AIR`   | nothing                                                             | air                 |
| `CAT_LIQUID`| down → diagonal-down → sides (alternating bias by tick)             | water, lava         |
| `CAT_SANDLIKE`| down → diagonal-down. Sinks through liquid (swap)                  | sand, gravel        |
| `CAT_SOLID` | down only (no diagonal)                                             | dirt                |
| `CAT_MINERAL`| no falling while supported. Isolated minerals get `FALLING_FLAG` set by the BFS and then fall like sand while keeping their type id (and color). | stone, copper, iron |
| `CAT_MAGIC` | never falls; unbreakable                                            | borders             |

`fallTicks`: how many ticks between fall steps. `1` = every tick (water).
`4` = every 4th tick (lava → looks viscous). `0` for AIR/MAGIC.

`hardness`: hits required to mine the tile. `0` = unbreakable (MAGIC) or
trivially absent (AIR). Damage is tracked per-cell in `scene.damage`.

## Fixed-timestep simulation (framerate independence)

The game uses an accumulator loop with a global `TICK_RATE` (default 60).
Movement constants (`MOVE_SPEED`, `JUMP_VELOCITY`, `GRAVITY`,
`TERMINAL_VY`) are calibrated **per tick**, not per frame. Render runs
once per frame regardless of how many ticks fired. **Never multiply by
`dt` in the tick path** — that's exactly what the v1 bug we fixed was.

Catch-up cap: `MAX_TICKS_PER_FRAME = 5` prevents spiral-of-death after
the tab returns from background.

## Cell byte layout

```
bit 7 = FALLING_FLAG   (persistent — set by mineral stability BFS)
bit 6 = MOVED_FLAG     (per-tick — cleared at end of simulateViewport)
bits 0–5 = type id     (TYPE_MASK = 0x3F, up to 64 types)
```

Always read with `cell & TYPE_MASK` and write with `type | flags`.

## Hot-path rules (do not violate)

- **Use typed arrays** (`Uint8Array`, `Uint32Array`, `Int32Array`) for
  world data, damage, visited buffer, BFS queue.
- **Zero allocations in the tick or render loop.** No `new`, `{}`, `[]`,
  `Array.from`, no `forEach` callbacks. Pre-allocate scratch buffers on
  the scene at `create()`.
- **Use the BLOCK_* lookups, not the BLOCKS array,** in hot loops. The
  array is for setup only.
- **Render path** writes 32-bit color per tile via `Uint32Array` view on
  `ImageData.data.buffer`; one `putImageData` + `tex.refresh()` per
  frame. Don't call `fillRect` per tile.
- **Simulate the viewport, not the world.** Always clamp loops to
  `[camTx-2 .. camTx+VW+2]` × `[camTy-2 .. camTy+VH+2]`.

## Mineral stability is dirty-driven

`scene.dirtyMineral = true` is set when:
- a mineral tile is mined (cell becomes AIR), or
- a mineral tile moves while `FALLING_FLAG` is set.

The BFS runs at most once per tick at the end of `runTick`, only when
the flag is set. Don't poll it.

## Damage convention

`scene.damage[idx]` accumulates hits. Reset to `0` whenever a cell
transitions to AIR, anywhere (mining, gravity, generation). The render
darkens partially-damaged tiles (`factor = 1 - 0.45 * damage/hardness`).

## Files you can edit

`game.js`, `metadata.json`, `cover.png`, **and this `CLAUDE.md`**. Nothing
else (per AGENTS.md).
