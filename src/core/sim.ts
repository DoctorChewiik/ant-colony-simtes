import { UNREACHABLE, thinkAnt } from './ai';
import { Ants, CASTES, Caste, Item, Task } from './ants';
import { Brood, STAGE_TICKS, Stage } from './brood';
import { ENEMIES, Enemies, EnemyKind } from './enemies';
import type { AntInput } from './input';
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
  /** The player's ant carries the pellet and drops it by hand. */
  Carry = 2,
}

/** Chance per tick that a piece of food appears somewhere on the surface. */
export const FOOD_SPAWN_CHANCE = 1 / 90;
export const MAX_FOOD_ON_MAP = 40;
/** Reserve gained when an ant eats one piece of food or brings it home. */
export const FOOD_VALUE = 3;
/** Reserve a founding queen starts with, from her own body fat. */
export const STARTING_FOOD = 5;
export const LAY_COOLDOWN = 30;
export const BITE_TICKS = 10;
/** Chance per tick that a spider shows up, once the colony has a few ants. */
export const ENEMY_SPAWN_CHANCE = 1 / 1200;
/** Dug soil is piled at least this many columns from the hole, at most this high. */
const SPOIL_DISTANCE = 8;
const SPOIL_HEIGHT = 4;
/** Ticks the colony shows as under attack after the last bite. */
export const ALARM_TICKS = 150;
/** Ants can crowd up to this many on one cell, so groups swarm instead of queueing. */
export const MAX_ANTS_PER_CELL = 3;
const ALARM_RADIUS = 5;
const ALARM_DECAY = 0.85;
/** Distance fields and trail evaporation are refreshed on these intervals. */
const FIELD_INTERVAL = 15;
const TRAIL_INTERVAL = 8;
const TRAIL_DECAY = 0.985;
/** Workers rethink their job about every 20 seconds. */
export const RETASK_TICKS = 600;

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
  delivered: number;
  antsLost: number;
  enemiesKilled: number;
}

export interface Colony {
  food: number;
  /** Heart of the nest, where the queen last laid. Workers bring food here. */
  nestX: number;
  nestY: number;
  /** Where an ant was last attacked, and when. */
  alarmX: number;
  alarmY: number;
  alarmTick: number;
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * The shared simulation core. It knows nothing about rendering: the 2D and
 * voxel games both feed it inputs and draw what it holds. Same seed plus same
 * inputs always gives the same world.
 */
export class Simulation {
  readonly world: World;
  readonly ants = new Ants(1024);
  readonly brood = new Brood(1024);
  readonly enemies = new Enemies(32);
  readonly player: number;
  readonly stats: SimStats = {
    dug: 0,
    dropped: 0,
    laid: 0,
    hatched: 0,
    eaten: 0,
    delivered: 0,
    antsLost: 0,
    enemiesKilled: 0,
  };
  readonly colony: Colony;
  digDisposal = DigDisposal.Surface;
  tick = 0;
  foodOnMap = 0;
  /** True once the player's queen has died. */
  gameOver = false;
  readonly rng: Rng;
  /** Steps from each cell to the nest heart, through walkable cells. */
  readonly homeDist: Int16Array;
  /** Steps from each cell to the open surface. */
  readonly exitDist: Int16Array;
  /** Food trail pheromone, 0 to 1, laid by ants carrying food home. */
  readonly trail: Float32Array;
  /** Alarm pheromone, 0 to 1, released where ants meet an enemy; it calls others to fight. */
  readonly alarm: Float32Array;
  /** Number of ants on each cell. */
  private readonly antGrid: Uint8Array;
  /** Occupancy grids: slot id + 1 on the cell, 0 when empty. */
  private readonly enemyGrid: Int32Array;
  private readonly broodGrid: Int32Array;
  /** Loose soil and food cells that may still fall. */
  private settling = new Set<number>();
  private readonly layCooldown: Uint16Array;

  constructor(readonly options: SimOptions) {
    this.world = generateWorld(options);
    this.rng = new Rng(options.seed ^ 0x9e3779b9);
    const cells = this.world.width * this.world.height;
    this.antGrid = new Uint8Array(cells);
    this.enemyGrid = new Int32Array(cells);
    this.broodGrid = new Int32Array(cells);
    this.homeDist = new Int16Array(cells);
    this.exitDist = new Int16Array(cells);
    this.trail = new Float32Array(cells);
    this.alarm = new Float32Array(cells);
    this.layCooldown = new Uint16Array(this.ants.capacity);
    const sx = Math.floor(options.width / 2);
    const sy = this.world.surface[sx] - 1;
    this.colony = { food: STARTING_FOOD, nestX: sx, nestY: sy, alarmX: 0, alarmY: 0, alarmTick: -1e9 };
    // The player starts as a founding queen, alone, about to dig her first nest.
    this.player = this.spawnAnt(sx, sy, Caste.Queen);
    this.updateFields();
  }

  step(playerInput: AntInput): void {
    if (!this.gameOver) this.updateAnt(this.player, playerInput);
    for (let id = 0; id < this.ants.count; id++) {
      if (id !== this.player && this.ants.alive[id]) this.updateAnt(id, thinkAnt(this, id));
    }
    this.updateEnemies();
    this.updateBrood();
    this.spawnFood();
    this.spawnEnemies();
    if (this.tick % TRAIL_INTERVAL === 0) {
      const t = this.trail;
      for (let i = 0; i < t.length; i++) if (t[i] > 0) t[i] = t[i] < 0.01 ? 0 : t[i] * TRAIL_DECAY;
      const al = this.alarm;
      for (let i = 0; i < al.length; i++) if (al[i] > 0) al[i] = al[i] < 0.02 ? 0 : al[i] * ALARM_DECAY;
    }
    this.settleGranular();
    this.tick++;
    if (this.tick % FIELD_INTERVAL === 0) this.updateFields();
  }

  // ---- Queries -------------------------------------------------------------

  idx(x: number, y: number): number {
    return y * this.world.width + x;
  }

  /** How many ants stand on a cell. */
  antsAt(x: number, y: number): number {
    return this.world.inBounds(x, y) ? this.antGrid[this.idx(x, y)] : 0;
  }

  enemyAt(x: number, y: number): number {
    return this.world.inBounds(x, y) ? this.enemyGrid[this.idx(x, y)] - 1 : -1;
  }

  /** True if an egg, larva or pupa lies on the cell. */
  broodAt(x: number, y: number): boolean {
    return this.world.inBounds(x, y) && this.broodGrid[this.idx(x, y)] > 0;
  }

  hasGrip(x: number, y: number): boolean {
    const w = this.world;
    for (const [dx, dy] of DIRS) if (w.solidAt(x + dx, y + dy)) return true;
    return false;
  }

  /** Open cell something can cling to, ignoring who stands there. */
  walkable(x: number, y: number): boolean {
    return this.world.inBounds(x, y) && !this.world.solidAt(x, y) && this.hasGrip(x, y);
  }

  /** Can an ant step here: walkable, not crowded, no enemy on it. */
  canStand(x: number, y: number): boolean {
    return this.walkable(x, y) && this.antsAt(x, y) < MAX_ANTS_PER_CELL && this.enemyAt(x, y) < 0;
  }

  /** Releases alarm pheromone around a point; nearby ants smell it and come to fight. */
  raiseAlarm(x: number, y: number, strength: number): void {
    const w = this.world;
    for (let dy = -ALARM_RADIUS; dy <= ALARM_RADIUS; dy++) {
      for (let dx = -ALARM_RADIUS; dx <= ALARM_RADIUS; dx++) {
        if (!w.inBounds(x + dx, y + dy)) continue;
        const v = strength * (1 - Math.hypot(dx, dy) / (ALARM_RADIUS + 1));
        const i = this.idx(x + dx, y + dy);
        if (v > this.alarm[i]) this.alarm[i] = v;
      }
    }
  }

  /** A diagonal step may not squeeze between two solid corners. */
  squeezes(x: number, y: number, nx: number, ny: number): boolean {
    return nx !== x && ny !== y && this.world.solidAt(nx, y) && this.world.solidAt(x, ny);
  }

  /** The cell an ant will dig into, bite or drop onto. */
  aimedCell(id: number, input: AntInput): { x: number; y: number } {
    const a = this.ants;
    const t = input.target;
    if (t && Math.max(Math.abs(t.x - a.x[id]), Math.abs(t.y - a.y[id])) === 1) return t;
    return { x: a.x[id] + a.aimX[id], y: a.y[id] + a.aimY[id] };
  }

  /** Row of the highest solid cell in a column (the open-air surface). */
  topSolid(x: number): number {
    const w = this.world;
    let y = 0;
    while (y < w.height && !w.solidAt(x, y)) y++;
    return y;
  }

  /** Open sky above this cell. */
  outside(x: number, y: number): boolean {
    return y < this.topSolid(x);
  }

  alarmActive(): boolean {
    return this.tick - this.colony.alarmTick < ALARM_TICKS;
  }

  /** How far the nest may grow from its heart, by colony size. */
  nestRadius(): number {
    return 4 + 2 * Math.sqrt(this.ants.living);
  }

  /** Cells the colony may dig in total, by colony size. */
  digBudget(): number {
    return 60 + 30 * this.ants.living;
  }

  // ---- Ants ------------------------------------------------------------------

  spawnAnt(x: number, y: number, caste: Caste): number {
    const id = this.ants.spawn(x, y, caste);
    if (id < 0) return -1;
    this.antGrid[this.idx(x, y)]++;
    this.layCooldown[id] = 0;
    this.ants.task[id] = this.pickTask(caste);
    return id;
  }

  /** Job for a new or rethinking ant, weighted by what the colony needs. */
  pickTask(caste: Caste): Task {
    if (caste === Caste.Soldier) return Task.Guard;
    if (caste !== Caste.Worker) return Task.Idle;
    const hungry = this.colony.food < 6;
    const canDig = this.stats.dug < this.digBudget();
    const r = this.rng.next();
    const forage = hungry ? 0.65 : 0.45;
    const dig = canDig ? (hungry ? 0.25 : 0.4) : 0;
    if (r < forage) return Task.Forage;
    if (r < forage + dig) return Task.Dig;
    return Task.Nurse;
  }

  private moveAnt(id: number, nx: number, ny: number): void {
    const a = this.ants;
    this.antGrid[this.idx(a.x[id], a.y[id])]--;
    a.x[id] = nx;
    a.y[id] = ny;
    this.antGrid[this.idx(nx, ny)]++;
  }

  private killAnt(id: number): void {
    const a = this.ants;
    if (!a.alive[id]) return;
    a.alive[id] = 0;
    this.antGrid[this.idx(a.x[id], a.y[id])]--;
    // Whatever it carried falls where it died.
    if (a.carrying[id] === Item.Food) this.placeNear(a.x[id], a.y[id], Material.Food, 1);
    a.carrying[id] = Item.None;
    this.stats.antsLost++;
    if (id === this.player) this.gameOver = true;
  }

  private hurtAnt(id: number, damage: number): void {
    const a = this.ants;
    a.hp[id] -= damage;
    this.colony.alarmX = a.x[id];
    this.colony.alarmY = a.y[id];
    this.colony.alarmTick = this.tick;
    this.raiseAlarm(a.x[id], a.y[id], 1);
    if (a.hp[id] <= 0) this.killAnt(id);
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
    if (a.biteCooldown[id] > 0) a.biteCooldown[id]--;
    if (id !== this.player && this.tick % RETASK_TICKS === id % RETASK_TICKS && a.caste[id] === Caste.Worker) {
      a.task[id] = this.pickTask(Caste.Worker);
    }

    // Falling: ants with nothing to hold drop one cell per tick.
    if (!this.hasGrip(a.x[id], a.y[id])) {
      const nx = a.x[id];
      const ny = a.y[id] + 1;
      if (!w.solidAt(nx, ny) && this.antsAt(nx, ny) < MAX_ANTS_PER_CELL && this.enemyAt(nx, ny) < 0) {
        this.moveAnt(id, nx, ny);
      }
      this.resetDig(id);
      return;
    }

    if (a.cooldown[id] > 0) a.cooldown[id]--;
    else if (input.moveX || input.moveY) this.tryMove(id, input.moveX, input.moveY);

    if (input.lay !== null) this.tryLay(id, input.lay);
    if (input.eat && a.carrying[id] === Item.Food) {
      a.carrying[id] = Item.None;
      this.colony.food += FOOD_VALUE;
      if (id === this.player) this.stats.eaten++;
      else this.stats.delivered++;
    }

    const aim = this.aimedCell(id, input);
    const enemy = this.enemyAt(aim.x, aim.y);
    if (input.dig && enemy >= 0) {
      this.bite(id, enemy);
      this.resetDig(id);
    } else if (a.carrying[id] !== Item.None) {
      this.resetDig(id);
      if (input.drop) this.tryDrop(id, aim.x, aim.y);
    } else if (input.dig) {
      this.digStep(id, aim.x, aim.y);
    } else {
      this.resetDig(id);
    }
  }

  private bite(id: number, enemy: number): void {
    const a = this.ants;
    const damage = CASTES[a.caste[id] as Caste].bite;
    if (a.biteCooldown[id] > 0 || damage <= 0) return;
    a.biteCooldown[id] = BITE_TICKS;
    const e = this.enemies;
    e.hp[enemy] -= damage;
    if (e.hp[enemy] <= 0) this.killEnemy(enemy);
  }

  private tryMove(id: number, mx: number, my: number): void {
    const a = this.ants;
    const x = a.x[id];
    const y = a.y[id];
    // Straight ahead, then step up over a bump, then follow the ground down.
    const options: Array<[number, number]> = [[x + mx, y + my]];
    if (mx && !my) options.push([x + mx, y - 1], [x + mx, y + 1]);
    for (const [nx, ny] of options) {
      if (!this.canStand(nx, ny) || this.squeezes(x, y, nx, ny)) continue;
      this.moveAnt(id, nx, ny);
      a.steps[id]++;
      a.cooldown[id] = CASTES[a.caste[id] as Caste].stepTicks + (a.carrying[id] ? 1 : 0);
      if (a.carrying[id] === Item.Food) {
        // Lay a food trail home, strongest near the food.
        const i = this.idx(nx, ny);
        this.trail[i] = Math.max(this.trail[i], 1 - a.trip[id] / 300);
        if (a.trip[id] < 65535) a.trip[id]++;
      }
      this.resetDig(id);
      return;
    }
  }

  private tryLay(id: number, caste: Caste): void {
    const a = this.ants;
    const cost = CASTES[caste].eggCost;
    if (a.caste[id] !== Caste.Queen || this.layCooldown[id] > 0) return;
    if (this.colony.food < cost || this.broodAt(a.x[id], a.y[id])) return;
    const b = this.brood.add(a.x[id], a.y[id], caste);
    if (b < 0) return;
    this.broodGrid[this.idx(a.x[id], a.y[id])] = b + 1;
    this.colony.food -= cost;
    this.layCooldown[id] = LAY_COOLDOWN;
    this.stats.laid++;
    // Where the queen lays is the heart of the nest.
    this.colony.nestX = a.x[id];
    this.colony.nestY = a.y[id];
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
      a.trip[id] = 0;
      this.foodOnMap--;
      return;
    }
    this.stats.dug++;
    // Only the player carries soil by hand; the colony's diggers haul it out themselves.
    const disposal =
      id !== this.player && this.digDisposal === DigDisposal.Carry ? DigDisposal.Surface : this.digDisposal;
    if (disposal === DigDisposal.Carry) a.carrying[id] = Item.Soil;
    else if (disposal === DigDisposal.Surface) this.depositOnSurface(x);
  }

  /**
   * Puts a dug pellet on the ground surface well away from column x, in low
   * piles, so the soil never slides back and buries the nest entrance.
   */
  private depositOnSurface(x: number): void {
    const w = this.world;
    const intact = (cx: number) => cx >= 0 && cx < w.width && this.topSolid(cx) <= w.surface[cx];
    for (let d = SPOIL_DISTANCE; d < 120; d++) {
      for (const cx of [x - d, x + d]) {
        if (!intact(cx) || !intact(cx - 1) || !intact(cx + 1)) continue;
        const y = this.topSolid(cx) - 1;
        if (y < 0 || w.surface[cx] - 1 - y >= SPOIL_HEIGHT || !this.free(cx, y)) continue;
        w.set(cx, y, Material.Loose);
        this.settling.add(w.index(cx, y));
        return;
      }
    }
    // Nowhere sensible to pile it: the soil is lost, like in Vanish mode.
  }

  private tryDrop(id: number, x: number, y: number): void {
    const w = this.world;
    if (!w.inBounds(x, y) || !this.free(x, y)) return;
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

  // ---- Brood ---------------------------------------------------------------

  /** Eggs grow into larvae, then pupae, then hatch as adults of their caste. */
  private updateBrood(): void {
    const b = this.brood;
    const w = this.world;
    for (let i = b.count - 1; i >= 0; i--) {
      // Brood left with nothing under it rolls down.
      const below = b.y[i] + 1;
      if (!w.solidAt(b.x[i], below) && !this.broodAt(b.x[i], below)) {
        this.broodGrid[this.idx(b.x[i], b.y[i])] = 0;
        b.y[i] = below;
        this.broodGrid[this.idx(b.x[i], b.y[i])] = i + 1;
      }

      b.age[i]++;
      const stage = b.stage[i] as Stage;
      if (b.age[i] < STAGE_TICKS[stage]) continue;
      if (stage !== Stage.Pupa) {
        b.stage[i] = stage + 1;
        b.age[i] = 0;
        continue;
      }
      if (this.antsAt(b.x[i], b.y[i]) >= MAX_ANTS_PER_CELL || this.enemyAt(b.x[i], b.y[i]) >= 0) continue;
      if (this.spawnAnt(b.x[i], b.y[i], b.caste[i] as Caste) < 0) continue;
      this.removeBrood(i);
      this.stats.hatched++;
    }
  }

  private removeBrood(i: number): void {
    const b = this.brood;
    this.broodGrid[this.idx(b.x[i], b.y[i])] = 0;
    const last = b.count - 1;
    b.remove(i);
    // The last entry moved into slot i.
    if (i !== last) this.broodGrid[this.idx(b.x[i], b.y[i])] = i + 1;
  }

  // ---- Enemies ---------------------------------------------------------------

  spawnEnemy(x: number, y: number, kind: EnemyKind): number {
    if (!this.world.inBounds(x, y) || this.world.solidAt(x, y) || !this.free(x, y)) return -1;
    const id = this.enemies.spawn(x, y, kind);
    if (id >= 0) this.enemyGrid[this.idx(x, y)] = id + 1;
    return id;
  }

  /** Spiders turn up at random, far from the nest, more often as the colony grows. */
  private spawnEnemies(): void {
    const living = this.ants.living;
    if (living < 3) return;
    const max = Math.min(6, 1 + Math.floor(living / 8));
    if (this.enemies.living >= max || this.rng.next() >= ENEMY_SPAWN_CHANCE) return;
    const w = this.world;
    for (let tries = 0; tries < 10; tries++) {
      const x = this.rng.int(0, w.width - 1);
      if (Math.abs(x - this.colony.nestX) < 40) continue;
      if (this.spawnEnemy(x, this.topSolid(x) - 1, EnemyKind.Spider) >= 0) return;
    }
  }

  private moveEnemy(id: number, nx: number, ny: number): void {
    const e = this.enemies;
    this.enemyGrid[this.idx(e.x[id], e.y[id])] = 0;
    e.x[id] = nx;
    e.y[id] = ny;
    this.enemyGrid[this.idx(nx, ny)] = id + 1;
  }

  private killEnemy(id: number): void {
    const e = this.enemies;
    if (!e.alive[id]) return;
    e.alive[id] = 0;
    this.enemyGrid[this.idx(e.x[id], e.y[id])] = 0;
    this.stats.enemiesKilled++;
    // The body becomes food for the colony.
    this.placeNear(e.x[id], e.y[id], Material.Food, ENEMIES[e.kind[id] as EnemyKind].food);
  }

  /** Spiders hunt the nearest ant they can see, bite it, or wander. */
  private updateEnemies(): void {
    const e = this.enemies;
    const a = this.ants;
    const w = this.world;
    for (let id = 0; id < e.count; id++) {
      if (!e.alive[id]) continue;
      const info = ENEMIES[e.kind[id] as EnemyKind];
      if (e.biteCooldown[id] > 0) e.biteCooldown[id]--;
      const x = e.x[id];
      const y = e.y[id];

      if (!this.hasGrip(x, y)) {
        if (!w.solidAt(x, y + 1) && this.free(x, y + 1)) this.moveEnemy(id, x, y + 1);
        continue;
      }

      let prey = -1;
      let best = info.sight + 1;
      for (let i = 0; i < a.count; i++) {
        if (!a.alive[i]) continue;
        const d = Math.max(Math.abs(a.x[i] - x), Math.abs(a.y[i] - y));
        if (d < best) {
          best = d;
          prey = i;
        }
      }

      if (prey >= 0 && best === 1) {
        if (e.biteCooldown[id] === 0) {
          e.biteCooldown[id] = info.biteTicks;
          this.hurtAnt(prey, info.bite);
        }
        continue;
      }

      if (e.cooldown[id] > 0) {
        e.cooldown[id]--;
        continue;
      }
      let mx: number;
      let my: number;
      if (prey >= 0) {
        mx = Math.sign(a.x[prey] - x);
        my = Math.sign(a.y[prey] - y);
      } else {
        if (this.rng.next() < 0.04) {
          e.wanderX[id] = this.rng.int(-1, 1);
          e.wanderY[id] = this.rng.int(-1, 1);
        }
        mx = e.wanderX[id];
        my = e.wanderY[id];
      }
      if (!mx && !my) continue;
      const options: Array<[number, number]> = [[x + mx, y + my]];
      if (mx) options.push([x + mx, y - 1], [x + mx, y + 1], [x + mx, y]);
      if (my) options.push([x, y + my]);
      for (const [nx, ny] of options) {
        if (!this.walkable(nx, ny) || !this.free(nx, ny) || this.squeezes(x, y, nx, ny)) continue;
        this.moveEnemy(id, nx, ny);
        if (mx) e.facing[id] = mx;
        e.steps[id]++;
        e.cooldown[id] = info.stepTicks;
        break;
      }
    }
  }

  // ---- World -----------------------------------------------------------------

  /** No creature, egg or solid cell here. */
  free(x: number, y: number): boolean {
    return (
      this.world.inBounds(x, y) &&
      !this.world.solidAt(x, y) &&
      this.antsAt(x, y) === 0 &&
      this.enemyAt(x, y) < 0 &&
      !this.broodAt(x, y)
    );
  }

  /** Drops up to `n` cells of a granular material in free cells around a point. */
  private placeNear(x: number, y: number, m: Material, n: number): void {
    let placed = 0;
    for (let r = 0; r <= 2 && placed < n; r++) {
      for (let dy = -r; dy <= r && placed < n; dy++) {
        for (let dx = -r; dx <= r && placed < n; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = x + dx;
          const cy = y + dy;
          if (r > 0 && !this.free(cx, cy)) continue;
          if (r === 0 && (this.world.solidAt(cx, cy) || this.broodAt(cx, cy))) continue;
          this.world.set(cx, cy, m);
          if (m === Material.Food) this.foodOnMap++;
          this.settling.add(this.world.index(cx, cy));
          placed++;
        }
      }
    }
  }

  /** Seeds and crumbs turn up at random spots on the surface. */
  private spawnFood(): void {
    if (this.foodOnMap >= MAX_FOOD_ON_MAP || this.rng.next() >= FOOD_SPAWN_CHANCE) return;
    const w = this.world;
    const x = this.rng.int(0, w.width - 1);
    const y = this.topSolid(x) - 1;
    if (y < 0 || !this.free(x, y)) return;
    w.set(x, y, Material.Food);
    this.foodOnMap++;
    this.settling.add(w.index(x, y));
  }

  /** Breadth-first step counts to the nest heart and to the open surface. */
  private updateFields(): void {
    const w = this.world;
    const home: number[] = [];
    const nest = this.nearestWalkable(this.colony.nestX, this.colony.nestY);
    if (nest >= 0) home.push(nest);
    this.bfs(this.homeDist, home);
    const exits: number[] = [];
    for (let x = 0; x < w.width; x++) {
      const top = this.topSolid(x);
      if (top > 0 && this.walkable(x, top - 1)) exits.push(this.idx(x, top - 1));
    }
    this.bfs(this.exitDist, exits);
  }

  private nearestWalkable(x: number, y: number): number {
    for (let r = 0; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (this.walkable(x + dx, y + dy)) return this.idx(x + dx, y + dy);
        }
      }
    }
    return -1;
  }

  private bfs(field: Int16Array, sources: number[]): void {
    const w = this.world;
    field.fill(UNREACHABLE);
    const queue = new Int32Array(field.length);
    let head = 0;
    let tail = 0;
    for (const s of sources) {
      field[s] = 0;
      queue[tail++] = s;
    }
    while (head < tail) {
      const i = queue[head++];
      const x = i % w.width;
      const y = (i - x) / w.width;
      const d = field[i] + 1;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.walkable(nx, ny) || this.squeezes(x, y, nx, ny)) continue;
        const j = this.idx(nx, ny);
        if (field[j] <= d) continue;
        field[j] = d;
        queue[tail++] = j;
      }
    }
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
    for (const i of active) {
      const m = w.cells[i] as Material;
      if (!MATERIALS[m].granular) continue;
      const x = i % w.width;
      const y = Math.floor(i / w.width);
      let to: [number, number] | null = null;
      if (this.free(x, y + 1)) to = [x, y + 1];
      else {
        const sides = leftFirst ? [-1, 1] : [1, -1];
        for (const s of sides) {
          if (this.free(x + s, y) && this.free(x + s, y + 1)) {
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
      for (const v of [a.alive[i], a.caste[i], a.x[i], a.y[i], a.carrying[i], a.hp[i], a.task[i]]) mix(v);
    }
    const b = this.brood;
    for (let i = 0; i < b.count; i++) for (const v of [b.x[i], b.y[i], b.caste[i], b.stage[i], b.age[i]]) mix(v);
    const e = this.enemies;
    for (let i = 0; i < e.count; i++) for (const v of [e.alive[i], e.x[i], e.y[i], e.hp[i]]) mix(v);
    mix(this.colony.food);
    mix(this.tick);
    return h >>> 0;
  }
}

