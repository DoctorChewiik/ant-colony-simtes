import { Ants, CASTES, Caste, Item } from './ants';
import { Brood, STAGE_TICKS, Stage } from './brood';
import { IDLE, type AntInput, type Axis } from './input';
import { MATERIALS, Material, isDiggable } from './materials';
import { Rng } from './rng';
import { generateWorld } from './worldgen';
import type { World } from './world';

export const TICK_RATE = 30;

/** What happens to soil an ant digs out. */
export enum DigDisposal {
  /** The soil is carried up and piled on the surface on its own. */
  Surface = 0,
  /** The soil simply disappears. */
  Vanish = 1,
  /** The ant carries the pellet and drops it by hand. */
  Carry = 2,
}

/** Chance per tick that a piece of food appears somewhere on the surface. */
export const FOOD_SPAWN_CHANCE = 1 / 90;
export const MAX_FOOD_ON_MAP = 40;
/** Reserve gained when an ant eats one piece of food. */
export const FOOD_VALUE = 3;
/** Reserve a founding queen starts with, from her own body fat. */
export const STARTING_FOOD = 5;
export const LAY_COOLDOWN = 30;
/** Chance per tick that an AI ant picks a new direction to wander in. */
const WANDER_TURN_CHANCE = 0.04;

export interface SimOptions {
  seed: number;
  width: number;
  height: number;
}

export interface SimStats {
  dug: number;
  dropped: number;
  laid: number;
  hatched: number;
  eaten: number;
}

/**
 * The shared simulation core. It knows nothing about rendering: the 2D and
 * voxel games both feed it inputs and draw what it holds. Same seed plus same
 * inputs always gives the same world.
 */
export class Simulation {
  readonly world: World;
  readonly ants = new Ants(1024);
  readonly brood = new Brood(1024);
  readonly player: number;
  readonly stats: SimStats = { dug: 0, dropped: 0, laid: 0, hatched: 0, eaten: 0 };
  readonly colony = { food: STARTING_FOOD };
  digDisposal = DigDisposal.Surface;
  tick = 0;
  foodOnMap = 0;
  private readonly rng: Rng;
  /** Loose soil and food cells that may still fall. */
  private settling = new Set<number>();
  private readonly layCooldown: Uint16Array;
  private readonly wanderX: Int8Array;
  private readonly wanderY: Int8Array;

  constructor(readonly options: SimOptions) {
    this.world = generateWorld(options);
    this.rng = new Rng(options.seed ^ 0x9e3779b9);
    this.layCooldown = new Uint16Array(this.ants.capacity);
    this.wanderX = new Int8Array(this.ants.capacity);
    this.wanderY = new Int8Array(this.ants.capacity);
    const sx = Math.floor(options.width / 2);
    // The player starts as a founding queen, alone, about to dig her first nest.
    this.player = this.ants.spawn(sx, this.world.surface[sx] - 1, Caste.Queen);
  }

  step(playerInput: AntInput): void {
    this.updateAnt(this.player, playerInput);
    for (let id = 0; id < this.ants.count; id++) {
      if (id !== this.player) this.updateAnt(id, this.wander(id));
    }
    this.updateBrood();
    this.spawnFood();
    this.settleGranular();
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

  /** True if an egg, larva or pupa lies on the cell. */
  broodAt(x: number, y: number): boolean {
    return this.brood.at(x, y) >= 0;
  }

  private updateAnt(id: number, input: AntInput): void {
    const a = this.ants;
    const w = this.world;

    if (input.moveX || input.moveY) {
      a.aimX[id] = input.moveX;
      a.aimY[id] = input.moveY;
      if (input.moveX) a.facing[id] = input.moveX;
    }
    if (this.layCooldown[id] > 0) this.layCooldown[id]--;

    // Falling: ants with nothing to hold drop one cell per tick.
    if (!this.hasGrip(a.x[id], a.y[id])) {
      const ny = a.y[id] + 1;
      if (!w.solidAt(a.x[id], ny) && !a.occupied(a.x[id], ny, id)) a.y[id] = ny;
      this.resetDig(id);
      return;
    }

    if (a.cooldown[id] > 0) a.cooldown[id]--;
    else if (input.moveX || input.moveY) this.tryMove(id, input.moveX, input.moveY);

    if (input.lay !== null) this.tryLay(id, input.lay);
    if (input.eat && a.carrying[id] === Item.Food) {
      a.carrying[id] = Item.None;
      this.colony.food += FOOD_VALUE;
      this.stats.eaten++;
    }

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

  /** Simple placeholder behaviour for ants the player does not control. */
  private wander(id: number): AntInput {
    if (this.rng.next() < WANDER_TURN_CHANCE) {
      this.wanderX[id] = (this.rng.int(0, 2) - 1) as Axis;
      this.wanderY[id] = (this.rng.int(0, 2) - 1) as Axis;
    }
    return { ...IDLE, moveX: this.wanderX[id] as Axis, moveY: this.wanderY[id] as Axis };
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
      a.cooldown[id] = CASTES[a.caste[id] as Caste].stepTicks + (a.carrying[id] ? 1 : 0);
      this.resetDig(id);
      return;
    }
  }

  private tryLay(id: number, caste: Caste): void {
    const a = this.ants;
    const cost = CASTES[caste].eggCost;
    if (a.caste[id] !== Caste.Queen || this.layCooldown[id] > 0) return;
    if (this.colony.food < cost || this.broodAt(a.x[id], a.y[id])) return;
    if (this.brood.add(a.x[id], a.y[id], caste) < 0) return;
    this.colony.food -= cost;
    this.layCooldown[id] = LAY_COOLDOWN;
    this.stats.laid++;
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
    if (a.digProgress[id] < MATERIALS[m].digTicks) return;

    w.set(x, y, Material.Air);
    this.resetDig(id);
    this.wakeAround(x, y);
    if (m === Material.Food) {
      a.carrying[id] = Item.Food;
      this.foodOnMap--;
      return;
    }
    this.stats.dug++;
    if (this.digDisposal === DigDisposal.Carry) a.carrying[id] = Item.Soil;
    else if (this.digDisposal === DigDisposal.Surface) this.depositOnSurface(x);
  }

  /**
   * Puts a dug pellet on the ground surface near column x, away from any
   * shaft so the pile does not slide back into the hole.
   */
  private depositOnSurface(x: number): void {
    const w = this.world;
    const intact = (cx: number) => cx >= 0 && cx < w.width && this.topSolid(cx) <= w.surface[cx];
    for (let d = 3; d < 40; d++) {
      for (const cx of [x - d, x + d]) {
        if (!intact(cx) || !intact(cx - 1) || !intact(cx + 1)) continue;
        const y = this.topSolid(cx) - 1;
        if (y < 0 || this.ants.occupied(cx, y) || this.broodAt(cx, y)) continue;
        w.set(cx, y, Material.Loose);
        this.settling.add(w.index(cx, y));
        return;
      }
    }
    // Nowhere sensible to pile it: the soil is lost, like in Vanish mode.
  }

  /** Row of the highest solid cell in a column (the open-air surface). */
  topSolid(x: number): number {
    const w = this.world;
    let y = 0;
    while (y < w.height && !w.solidAt(x, y)) y++;
    return y;
  }

  private tryDrop(id: number, x: number, y: number): void {
    const w = this.world;
    if (!w.inBounds(x, y) || w.solidAt(x, y) || this.ants.occupied(x, y) || this.broodAt(x, y)) return;
    const item = this.ants.carrying[id];
    w.set(x, y, item === Item.Food ? Material.Food : Material.Loose);
    if (item === Item.Food) this.foodOnMap++;
    this.ants.carrying[id] = Item.None;
    this.stats.dropped++;
    this.settling.add(w.index(x, y));
  }

  private resetDig(id: number): void {
    this.ants.digTarget[id] = -1;
    this.ants.digProgress[id] = 0;
  }

  /** Eggs grow into larvae, then pupae, then hatch as adults of their caste. */
  private updateBrood(): void {
    const b = this.brood;
    const w = this.world;
    for (let i = b.count - 1; i >= 0; i--) {
      // Brood left with nothing under it rolls down.
      const below = b.y[i] + 1;
      if (!w.solidAt(b.x[i], below) && !this.broodAt(b.x[i], below)) b.y[i] = below;

      b.age[i]++;
      const stage = b.stage[i] as Stage;
      if (b.age[i] < STAGE_TICKS[stage]) continue;
      if (stage !== Stage.Pupa) {
        b.stage[i] = stage + 1;
        b.age[i] = 0;
        continue;
      }
      if (this.ants.count >= this.ants.capacity) continue;
      const id = this.ants.spawn(b.x[i], b.y[i], b.caste[i] as Caste);
      this.wanderX[id] = 0;
      this.wanderY[id] = 0;
      b.remove(i);
      this.stats.hatched++;
    }
  }

  /** Seeds and crumbs turn up at random spots on the surface. */
  private spawnFood(): void {
    if (this.foodOnMap >= MAX_FOOD_ON_MAP || this.rng.next() >= FOOD_SPAWN_CHANCE) return;
    const w = this.world;
    const x = this.rng.int(0, w.width - 1);
    const y = this.topSolid(x) - 1;
    if (y < 0 || this.ants.occupied(x, y) || this.broodAt(x, y)) return;
    w.set(x, y, Material.Food);
    this.foodOnMap++;
    this.settling.add(w.index(x, y));
  }

  /** Granular cells next to an opened cell may now be able to fall. */
  private wakeAround(x: number, y: number): void {
    const w = this.world;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (MATERIALS[w.get(x + dx, y + dy)].granular) this.settling.add(w.index(x + dx, y + dy));
      }
    }
  }

  /** Sand rules for loose soil and food: fall straight down, else slide diagonally. */
  private settleGranular(): void {
    if (this.settling.size === 0) return;
    const w = this.world;
    const active = [...this.settling].sort((p, q) => q - p); // bottom rows first
    this.settling.clear();
    const leftFirst = this.tick % 2 === 0;
    const free = (cx: number, cy: number) =>
      w.inBounds(cx, cy) && !w.solidAt(cx, cy) && !this.ants.occupied(cx, cy) && !this.broodAt(cx, cy);
    for (const i of active) {
      const m = w.cells[i] as Material;
      if (!MATERIALS[m].granular) continue;
      const x = i % w.width;
      const y = Math.floor(i / w.width);
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
      w.set(to[0], to[1], m);
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
      h ^= (v >> 8) & 0xff;
      h = Math.imul(h, 0x01000193);
    };
    for (const c of this.world.cells) mix(c);
    const a = this.ants;
    for (let i = 0; i < a.count; i++) {
      for (const v of [a.caste[i], a.x[i], a.y[i], a.carrying[i], a.digProgress[i], a.cooldown[i]]) mix(v);
    }
    const b = this.brood;
    for (let i = 0; i < b.count; i++) for (const v of [b.x[i], b.y[i], b.caste[i], b.stage[i], b.age[i]]) mix(v);
    mix(this.colony.food);
    mix(this.tick);
    return h >>> 0;
  }
}
