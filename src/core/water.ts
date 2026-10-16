import { Material } from './materials';
import type { World } from './world';

/** Most water cells the world holds at once, to keep the simulation fast. */
export const MAX_WATER = 20000;
/** How far one water cell can slide sideways in a tick, looking for a way down. */
const SPREAD = 8;
/**
 * Chance per tick that a water cell resting on this material soaks into it.
 * Loose sand drinks water fast, clay and stone hold it, rock never lets it through.
 */
const SOAK: Partial<Record<Material, number>> = {
  [Material.Loose]: 1 / 500,
  [Material.Sand]: 1 / 1200,
  [Material.Soil]: 1 / 2000,
  [Material.Grass]: 1 / 2000,
};
/** Chance per tick that a sunlit puddle cell on the surface evaporates. */
const EVAPORATE = 1 / 6000;

/**
 * Falling-sand water: each cell falls, slides down slopes, and spreads
 * sideways along a level until it finds a lower spot, so puddles flatten,
 * tunnels flood from the bottom up and water pours down shafts. Puddles
 * slowly drain into the soil they sit on.
 */
export class Water {
  /** Every cell that holds water. */
  readonly cells = new Set<number>();
  private seed = 0x2545f491;

  constructor(private readonly world: World) {}

  get count(): number {
    return this.cells.size;
  }

  /** Fills the open cells of a disc with water. Returns how many cells were filled. */
  pour(cx: number, cy: number, radius: number): number {
    const w = this.world;
    let added = 0;
    const r = Math.max(0, radius);
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        if (this.cells.size >= MAX_WATER) return added;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r + 0.5 || w.get(x, y) !== Material.Air || !w.inBounds(x, y)) continue;
        w.set(x, y, Material.Water);
        this.cells.add(w.index(x, y));
        added++;
      }
    }
    return added;
  }

  /** Removes all water. */
  clear(): void {
    const w = this.world;
    for (const i of this.cells) {
      if (w.cells[i] === Material.Water) w.set(i % w.width, Math.floor(i / w.width), Material.Air);
    }
    this.cells.clear();
  }

  /** Something solid displaced water from this cell (falling sand, a dropped pellet). */
  forget(i: number): void {
    this.cells.delete(i);
  }

  /** Puts a water cell that was displaced back in the set. */
  track(i: number): void {
    this.cells.add(i);
  }

  /** Small deterministic random numbers, separate from the main generator. */
  private random(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0;
    return this.seed / 4294967296;
  }

  step(tick: number, sunny: boolean): void {
    if (this.cells.size === 0) return;
    const w = this.world;
    const width = w.width;
    const rightFirst = tick % 2 === 0;
    // Bottom rows first, so a column of water falls together; alternate the sweep along each row.
    const order = [...this.cells].sort((p, q) => {
      const rows = Math.floor(q / width) - Math.floor(p / width);
      return rows || (rightFirst ? q - p : p - q);
    });
    const open = (x: number, y: number) => w.get(x, y) === Material.Air;
    const move = (from: number, x: number, y: number) => {
      w.set(from % width, Math.floor(from / width), Material.Air);
      w.set(x, y, Material.Water);
      this.cells.delete(from);
      this.cells.add(w.index(x, y));
    };

    for (const i of order) {
      if (w.cells[i] !== Material.Water) {
        this.cells.delete(i);
        continue;
      }
      const x = i % width;
      const y = Math.floor(i / width);

      // Fall, two cells a tick when the way is clear.
      if (open(x, y + 1)) {
        move(i, x, open(x, y + 2) ? y + 2 : y + 1);
        continue;
      }
      const below = w.get(x, y + 1);
      const soak = SOAK[below];
      if (soak && this.random() < soak) {
        w.set(x, y, Material.Air);
        this.cells.delete(i);
        continue;
      }
      if (sunny && y < w.surface[x] && open(x, y - 1) && this.random() < EVAPORATE) {
        w.set(x, y, Material.Air);
        this.cells.delete(i);
        continue;
      }

      const first = (x + y + tick) % 2 === 0 ? 1 : -1;
      // Slide down a slope.
      let moved = false;
      for (const d of [first, -first]) {
        if (open(x + d, y) && open(x + d, y + 1)) {
          move(i, x + d, y + 1);
          moved = true;
          break;
        }
      }
      if (moved) continue;

      // Spread along the level: go to the nearest drop within reach, else as far as the water can go.
      let best = 0;
      let bestDrop = false;
      for (const d of [first, -first]) {
        for (let k = 1; k <= SPREAD; k++) {
          if (!open(x + d * k, y)) break;
          if (open(x + d * k, y + 1)) {
            if (!bestDrop || k < Math.abs(best)) {
              best = d * k;
              bestDrop = true;
            }
            break;
          }
          // Without a drop in sight, only edge outwards one step, so flat pools stay calm.
          if (!bestDrop && !best && k === 1 && !open(x - d, y)) best = d;
        }
      }
      // A lone drop on flat ground rolls about until it finds a hollow.
      if (!best && open(x + first, y) && open(x - first, y) && this.random() < 0.25) best = first;
      if (best) move(i, x + best, y);
    }
  }
}
