import { Ants, Item } from './ants';
import type { AntInput } from './input';
import { MATERIALS, Material, isDiggable } from './materials';
import { generateWorld } from './worldgen';
import type { World } from './world';

export const TICK_RATE = 30;

export interface SimOptions {
  seed: number;
  width: number;
  height: number;
}

export interface SimStats {
  dug: number;
  dropped: number;
}

/**
 * The shared simulation core. It knows nothing about rendering: the 2D and
 * voxel games both feed it inputs and draw what it holds. Same seed plus same
 * inputs always gives the same world.
 */
export class Simulation {
  readonly world: World;
  readonly ants = new Ants(64);
  readonly player: number;
  readonly stats: SimStats = { dug: 0, dropped: 0 };
  tick = 0;
  /** Loose soil cells that may still fall. */
  private settling = new Set<number>();

  constructor(readonly options: SimOptions) {
    this.world = generateWorld(options);
    const sx = Math.floor(options.width / 2);
    this.player = this.ants.spawn(sx, this.world.surface[sx] - 1);
  }

  step(playerInput: AntInput): void {
    this.updateAnt(this.player, playerInput);
    this.settleLooseSoil();
    this.tick++;
  }

  /** Can an ant stand here: open cell with something to grip on any side. */
  canStand(x: number, y: number, self: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, y) || w.solidAt(x, y)) return false;
    if (this.ants.occupied(x, y, self)) return false;
    return this.hasGrip(x, y);
  }

  hasGrip(x: number, y: number): boolean {
    const w = this.world;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && w.solidAt(x + dx, y + dy)) return true;
      }
    }
    return false;
  }

  /** The cell an ant will dig into or drop onto. */
  aimedCell(id: number, input: AntInput): { x: number; y: number } {
    const a = this.ants;
    const t = input.target;
    if (t && Math.max(Math.abs(t.x - a.x[id]), Math.abs(t.y - a.y[id])) === 1) return t;
    return { x: a.x[id] + a.aimX[id], y: a.y[id] + a.aimY[id] };
  }

  private updateAnt(id: number, input: AntInput): void {
    const a = this.ants;
    const w = this.world;

    if (input.moveX || input.moveY) {
      a.aimX[id] = input.moveX;
      a.aimY[id] = input.moveY;
      if (input.moveX) a.facing[id] = input.moveX;
    }

    // Falling: ants with nothing to hold drop one cell per tick.
    if (!this.hasGrip(a.x[id], a.y[id])) {
      const ny = a.y[id] + 1;
      if (!w.solidAt(a.x[id], ny) && !a.occupied(a.x[id], ny, id)) a.y[id] = ny;
      this.resetDig(id);
      return;
    }

    if (a.cooldown[id] > 0) a.cooldown[id]--;
    else if (input.moveX || input.moveY) this.tryMove(id, input.moveX, input.moveY);

    const aim = this.aimedCell(id, input);
    if (a.carrying[id] !== Item.None) {
      this.resetDig(id);
      if (input.drop) this.tryDrop(id, aim.x, aim.y);
    } else if (input.dig) {
      this.digStep(id, aim.x, aim.y);
    } else {
      this.resetDig(id);
    }
  }

  private tryMove(id: number, mx: number, my: number): void {
    const a = this.ants;
    const x = a.x[id];
    const y = a.y[id];
    // Straight ahead, then step up over a bump, then follow the ground down.
    const options: Array<[number, number]> = [[x + mx, y + my]];
    if (mx && !my) options.push([x + mx, y - 1], [x + mx, y + 1]);
    for (const [nx, ny] of options) {
      if (!this.canStand(nx, ny, id)) continue;
      // No squeezing diagonally between two solid corners.
      if (nx !== x && ny !== y && this.world.solidAt(nx, y) && this.world.solidAt(x, ny)) continue;
      a.x[id] = nx;
      a.y[id] = ny;
      a.steps[id]++;
      a.cooldown[id] = a.carrying[id] ? 3 : 2;
      this.resetDig(id);
      return;
    }
  }

  private digStep(id: number, x: number, y: number): void {
    const a = this.ants;
    const w = this.world;
    const m = w.get(x, y);
    if (!w.inBounds(x, y) || !isDiggable(m)) {
      this.resetDig(id);
      return;
    }
    const target = w.index(x, y);
    if (a.digTarget[id] !== target) {
      a.digTarget[id] = target;
      a.digProgress[id] = 0;
    }
    a.digProgress[id]++;
    if (a.digProgress[id] >= MATERIALS[m].digTicks) {
      w.set(x, y, Material.Air);
      a.carrying[id] = Item.Soil;
      this.stats.dug++;
      this.resetDig(id);
      this.wakeAround(x, y);
    }
  }

  private tryDrop(id: number, x: number, y: number): void {
    const w = this.world;
    if (!w.inBounds(x, y) || w.solidAt(x, y) || this.ants.occupied(x, y)) return;
    w.set(x, y, Material.Loose);
    this.ants.carrying[id] = Item.None;
    this.stats.dropped++;
    this.settling.add(w.index(x, y));
  }

  private resetDig(id: number): void {
    this.ants.digTarget[id] = -1;
    this.ants.digProgress[id] = 0;
  }

  /** Loose soil next to an opened cell may now be able to fall. */
  private wakeAround(x: number, y: number): void {
    const w = this.world;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (w.get(x + dx, y + dy) === Material.Loose) this.settling.add(w.index(x + dx, y + dy));
      }
    }
  }

  /** Sand rules for loose soil: fall straight down, else slide diagonally. */
  private settleLooseSoil(): void {
    if (this.settling.size === 0) return;
    const w = this.world;
    const active = [...this.settling].sort((p, q) => q - p); // bottom rows first
    this.settling.clear();
    const leftFirst = this.tick % 2 === 0;
    for (const i of active) {
      if (w.cells[i] !== Material.Loose) continue;
      const x = i % w.width;
      const y = Math.floor(i / w.width);
      const free = (cx: number, cy: number) =>
        w.inBounds(cx, cy) && !w.solidAt(cx, cy) && !this.ants.occupied(cx, cy);
      let to: [number, number] | null = null;
      if (free(x, y + 1)) to = [x, y + 1];
      else {
        const sides = leftFirst ? [-1, 1] : [1, -1];
        for (const s of sides) {
          if (free(x + s, y) && free(x + s, y + 1)) {
            to = [x + s, y + 1];
            break;
          }
        }
      }
      if (!to) continue;
      w.set(x, y, Material.Air);
      w.set(to[0], to[1], Material.Loose);
      this.settling.add(w.index(to[0], to[1]));
      this.wakeAround(x, y);
    }
  }

  /** FNV-1a hash of the full state, for determinism checks. */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
    };
    for (const c of this.world.cells) mix(c);
    const a = this.ants;
    for (let i = 0; i < a.count; i++) {
      for (const v of [a.x[i], a.y[i], a.carrying[i], a.digProgress[i], a.cooldown[i]]) {
        mix(v);
        mix(v >> 8);
      }
    }
    mix(this.tick);
    return h >>> 0;
  }
}
