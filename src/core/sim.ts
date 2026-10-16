import { UNREACHABLE, thinkAnt } from './ai';
import { Ants, CASTES, Caste, ENERGY_MAX, Item, Task } from './ants';
import { Brood, STAGE_TICKS, Stage } from './brood';
import { ENEMIES, Enemies, EnemyKind } from './enemies';
import type { AntInput } from './input';
import { MATERIALS, Material, isDiggable } from './materials';
import { generateNestPlan, rasterizePlan, type PlanNode } from './nestplan';
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
export const FOOD_SPAWN_CHANCE = 1 / 45;
/** Most food lying around at once, per 100 columns of map. */
export const MAX_FOOD_ON_MAP = 16;
/** Reserve gained when an ant eats one piece of food or brings it home. */
export const FOOD_VALUE = 3;
/** Reserve a founding queen starts with, from her own body fat. */
export const STARTING_FOOD = 8;
export const LAY_COOLDOWN = 30;
export const BITE_TICKS = 10;
/** Chance per tick that a spider shows up, once the colony has a few ants. */
export const ENEMY_SPAWN_CHANCE = 1 / 3000;
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
/** Ticks a larva stays fed after a nurse feeds it. */
export const LARVA_MEAL = 150;
/** A hungry ant with an empty reserve loses 1 hp this often. */
const STARVE_TICKS = 300;
/** Nuptial flights: every 3 minutes, for 30 seconds, once the colony has enough workers. */
export const FLIGHT_PERIOD = 30 * 180;
export const FLIGHT_WINDOW = 30 * 30;
export const FLIGHT_MIN_WORKERS = 8;
/** Winged queens and males must be this old (ticks) before they fly. */
export const ALATE_MATURE = 30 * 60;
/** Dead ants are carried at least this far from the nest heart. */
export const MIDDEN_DISTANCE = 22;
/** Workers younger than this mostly nurse; older than ADULT_AGE mostly forage. */
export const YOUNG_AGE = 30 * 120;
export const ADULT_AGE = 30 * 300;

/** One in-game day lasts three minutes; seasons change every few days. */
export const DAY_TICKS = 30 * 180;
export const SEASON_DAYS = 4;
/** The first day starts in the morning. */
const DAY_START = 0.1;

export enum Season {
  Spring = 0,
  Summer = 1,
  Autumn = 2,
  Winter = 3,
}

/** Food turns up more in summer, hardly at all in winter. */
const SEASON_FOOD: Record<Season, number> = {
  [Season.Spring]: 1,
  [Season.Summer]: 1.6,
  [Season.Autumn]: 0.8,
  [Season.Winter]: 0.15,
};
/** Chance per tick that rain starts. */
const SEASON_RAIN: Record<Season, number> = {
  [Season.Spring]: 1 / 7000,
  [Season.Summer]: 1 / 12000,
  [Season.Autumn]: 1 / 5000,
  [Season.Winter]: 1 / 9000,
};
/** Share of the soil the colony's diggers carry out to the mound. */
const CARRY_OUT_SHARE = 0.35;
/** A new chamber is planned for every few ants. */
const ANTS_PER_ROOM = 5;

/** One room of the nest the workers are digging: an ellipse centred on (x, y). */
export interface Chamber {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

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
  /** Dead ants carried out to the refuse pile. */
  buried: number;
  larvaeFed: number;
  /** Times an ant ate from the reserve. */
  meals: number;
  /** Winged queens and males that left on a nuptial flight. */
  flown: number;
  diedOfAge: number;
  starved: number;
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
    buried: 0,
    larvaeFed: 0,
    meals: 0,
    flown: 0,
    diedOfAge: 0,
    starved: 0,
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
  /** Steps to where nurses keep the brood. */
  readonly nurseryDist: Int16Array;
  /** Steps to the nearest wall the diggers still have to dig, following the nest plan. */
  readonly digDist: Int16Array;
  /** Rooms of the nest plan dug so far or being dug: 0 is the queen's chamber, 1 the nursery. */
  chambers: Chamber[] = [];
  /** The whole nest this colony will dig as it grows; see nestplan.ts. */
  readonly plan: PlanNode[];
  /** How many plan nodes the colony is building now. */
  planActive = 0;
  /** 1 on every cell of the active part of the plan. */
  readonly planMask: Uint8Array;
  private planCells: number[] = [];
  /** Rain lasts until this tick. */
  rainUntil = 0;
  /** Where the nursery currently is; it moves away from danger during an attack. */
  nurseryX = 0;
  nurseryY = 0;
  /** Surface cell where the main tunnel comes out. */
  entranceX = 0;
  entranceY = 0;
  /** Planned cells still to dig. */
  planLeft = 0;
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
    this.nurseryDist = new Int16Array(cells);
    this.digDist = new Int16Array(cells);
    this.planMask = new Uint8Array(cells);
    this.layCooldown = new Uint16Array(this.ants.capacity);
    const sx = Math.floor(options.width / 2);
    const sy = this.world.surface[sx] - 1;
    this.colony = { food: STARTING_FOOD, nestX: sx, nestY: sy, alarmX: 0, alarmY: 0, alarmTick: -1e9 };
    // The player starts as a founding queen, alone, about to dig her first nest.
    this.player = this.spawnAnt(sx, sy, Caste.Queen);
    this.entranceX = sx;
    this.entranceY = sy;
    this.plan = generateNestPlan(this.world, sx, options.seed);
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
    if (!this.raining() && this.rng.next() < SEASON_RAIN[this.season()]) {
      this.rainUntil = this.tick + this.rng.int(900, 2700);
    }
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

  /** A diagonal step between two solid corners: too tight for a spider (ants are small enough). */
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

  /** Open sky above this cell, at or above ground level (a dug shaft is not outside). */
  outside(x: number, y: number): boolean {
    return y < this.topSolid(x) && y < this.world.surface[x] + 1;
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

  /** Ticks since the ant hatched. */
  age(id: number): number {
    return this.tick - this.ants.born[id];
  }

  /** Winged queens and males: they live in the nest until their nuptial flight. */
  isAlate(id: number): boolean {
    const c = this.ants.caste[id];
    return id !== this.player && (c === Caste.Queen || c === Caste.Male);
  }

  /** True while winged ants of a big enough colony leave on their nuptial flight. */
  flightActive(): boolean {
    if (this.tick % FLIGHT_PERIOD >= FLIGHT_WINDOW || this.tick < FLIGHT_PERIOD) return false;
    let workers = 0;
    const a = this.ants;
    for (let i = 0; i < a.count; i++) if (a.alive[i] && a.caste[i] === Caste.Worker) workers++;
    return workers >= FLIGHT_MIN_WORKERS;
  }

  /** Is this cell part of the nest the workers are building? */
  inPlan(x: number, y: number): boolean {
    return this.world.inBounds(x, y) && this.planMask[this.idx(x, y)] === 1;
  }

  /** Fraction of the day, 0 at dawn; dusk falls at 0.7. */
  timeOfDay(): number {
    return (this.tick / DAY_TICKS + DAY_START) % 1;
  }

  /** Day number, from 1. */
  day(): number {
    return Math.floor(this.tick / DAY_TICKS + DAY_START) + 1;
  }

  season(): Season {
    return (Math.floor((this.day() - 1) / SEASON_DAYS) % 4) as Season;
  }

  /** Sunlight from 0 (night) to 1 (day). */
  daylight(): number {
    const t = this.timeOfDay();
    if (t < 0.06) return 0.575 + 0.425 * (t / 0.06);
    if (t < 0.64) return 1;
    if (t < 0.74) return 1 - 0.85 * ((t - 0.64) / 0.1);
    if (t > 0.94) return 0.15 + 0.425 * ((t - 0.94) / 0.06);
    return 0.15;
  }

  isNight(): boolean {
    return this.daylight() < 0.4;
  }

  raining(): boolean {
    return this.tick < this.rainUntil;
  }

  /** Foragers stay in the nest at night, in the rain and through the winter. */
  shelter(): boolean {
    return this.isNight() || this.raining() || this.season() === Season.Winter;
  }

  /** Lowest open cell in the middle of a chamber, or -1 while it is still undug. */
  chamberFloor(c: Chamber): number {
    const w = this.world;
    const x = Math.round(c.x);
    let y = Math.round(c.y);
    if (w.solidAt(x, y)) return -1;
    while (y < c.y + c.ry + 2 && !w.solidAt(x, y + 1)) y++;
    return this.walkable(x, y) ? this.idx(x, y) : -1;
  }

  /** Planned cells dug so far, as a fraction of the active plan. */
  nestProgress(): number {
    if (!this.planCells.length) return 1;
    let open = 0;
    for (const i of this.planCells) if (!this.world.solidAt(i % this.world.width, Math.floor(i / this.world.width))) open++;
    return open / this.planCells.length;
  }

  /** Can a pellet of dug soil go on top of this column, building the mound beside the entrance? */
  spoilColumn(cx: number): boolean {
    const w = this.world;
    if (cx < 1 || cx >= w.width - 1 || Math.abs(cx - this.entranceX) < SPOIL_DISTANCE) return false;
    for (let x = cx - 1; x <= cx + 1; x++) if (this.topSolid(x) > w.surface[x]) return false;
    return w.surface[cx] - this.topSolid(cx) < SPOIL_HEIGHT;
  }

  /** Far enough from the nest to leave a dead ant. */
  middenSpot(x: number, y: number): boolean {
    return this.outside(x, y) && Math.hypot(x - this.colony.nestX, y - this.colony.nestY) >= MIDDEN_DISTANCE;
  }

  // ---- Ants ------------------------------------------------------------------

  spawnAnt(x: number, y: number, caste: Caste): number {
    const id = this.ants.spawn(x, y, caste);
    if (id < 0) return -1;
    this.antGrid[this.idx(x, y)]++;
    this.layCooldown[id] = 0;
    this.ants.born[id] = this.tick;
    this.ants.task[id] = this.pickTask(caste, 0);
    return id;
  }

  /**
   * Job for a new or rethinking ant. Like real workers, young ones look after
   * the brood, middle-aged ones dig, and old ones go out to forage; what the
   * colony lacks (food, brood care, room) shifts the odds.
   */
  pickTask(caste: Caste, age: number): Task {
    if (caste === Caste.Soldier) return Task.Guard;
    if (caste !== Caste.Worker) return Task.Idle;
    let nurse: number;
    let dig: number;
    let forage: number;
    if (age < YOUNG_AGE) [nurse, dig, forage] = [0.65, 0.25, 0.1];
    else if (age < ADULT_AGE) [nurse, dig, forage] = [0.15, 0.45, 0.4];
    else [nurse, dig, forage] = [0.05, 0.15, 0.8];
    const workers = Math.max(1, this.ants.living);
    if (this.colony.food < 2 + workers / 2) forage *= 2.5;
    if (this.brood.count === 0) nurse *= 0.15;
    if (this.planLeft === 0) dig *= 0.1;
    const r = this.rng.next() * (nurse + dig + forage);
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

  private killAnt(id: number, leaveBody = true): void {
    const a = this.ants;
    if (!a.alive[id]) return;
    a.alive[id] = 0;
    const x = a.x[id];
    const y = a.y[id];
    this.antGrid[this.idx(x, y)]--;
    // Whatever it carried falls where it died.
    const carried = a.carrying[id] as Item;
    if (carried === Item.Brood && !this.broodAt(x, y)) {
      const b = this.brood.add(x, y, a.broodCaste[id], a.broodStage[id], a.broodAge[id]);
      if (b >= 0) this.broodGrid[this.idx(x, y)] = b + 1;
    }
    if (carried === Item.Food) this.placeNear(x, y, Material.Food, 1);
    if (carried === Item.Corpse) this.placeNear(x, y, Material.Corpse, 1);
    a.carrying[id] = Item.None;
    if (leaveBody) {
      this.placeNear(x, y, Material.Corpse, 1);
      this.stats.antsLost++;
    }
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
    if (a.flying[id]) {
      this.fly(id);
      return;
    }
    if (id !== this.player) {
      if (this.tick % RETASK_TICKS === id % RETASK_TICKS && a.caste[id] === Caste.Worker) {
        a.task[id] = this.pickTask(Caste.Worker, this.age(id));
      }
      // Hunger and old age.
      // In winter the colony huddles and burns little energy.
      const winter = this.season() === Season.Winter;
      if (a.energy[id] > 0) {
        if (!winter || this.tick % 4 === 0) a.energy[id]--;
      }
      else if (this.tick % STARVE_TICKS === 0 && --a.hp[id] <= 0) {
        this.stats.starved++;
        this.killAnt(id);
        return;
      }
      // Lifespans vary by a few minutes either way, so a generation does not die all at once.
      const spread = 0.75 + 0.5 * (((id * 2654435761 + a.gen[id] * 40503) >>> 0) % 1000) / 1000;
      if (this.age(id) > CASTES[a.caste[id] as Caste].lifespan * spread) {
        this.stats.diedOfAge++;
        this.killAnt(id);
        return;
      }
      // Winged ants take off from the open surface during a nuptial flight.
      if (this.isAlate(id) && this.flightActive() && this.age(id) >= ALATE_MATURE && this.outside(a.x[id], a.y[id])) {
        a.flying[id] = 1;
        return;
      }
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
      else {
        this.stats.delivered++;
        this.recruit(id);
      }
    } else if (input.eat && id !== this.player && a.carrying[id] !== Item.Food && this.colony.food > 0) {
      // A hungry worker eats from the colony's reserve.
      if (this.homeDist[this.idx(a.x[id], a.y[id])] <= 3) {
        this.colony.food--;
        a.energy[id] = ENERGY_MAX;
        this.stats.meals++;
      }
    }

    // Nurses pick up, feed and set down the brood.
    const t = input.target;
    if (
      t &&
      a.caste[id] === Caste.Worker &&
      id !== this.player &&
      Math.max(Math.abs(t.x - a.x[id]), Math.abs(t.y - a.y[id])) <= 1
    ) {
      if (input.drop && a.carrying[id] === Item.Brood) {
        this.setBroodDown(id, t.x, t.y);
        return;
      }
      if (input.dig && a.carrying[id] === Item.None && this.broodAt(t.x, t.y)) {
        this.tendBrood(id, t.x, t.y);
        return;
      }
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
      if (!this.canStand(nx, ny)) continue;
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
      a.memX[id] = x;
      a.memY[id] = y;
      this.foodOnMap--;
      return;
    }
    if (m === Material.Corpse) {
      a.carrying[id] = Item.Corpse;
      return;
    }
    this.stats.dug++;
    if (id !== this.player) {
      // The colony's diggers carry pellets out to build a mound by the entrance; the rest
      // is pressed into the walls, as real ants do with much of what they dig.
      if (this.digDisposal !== DigDisposal.Vanish && this.rng.next() < CARRY_OUT_SHARE) a.carrying[id] = Item.Soil;
      return;
    }
    if (this.digDisposal === DigDisposal.Carry) a.carrying[id] = Item.Soil;
    else if (this.digDisposal === DigDisposal.Surface) this.depositOnSurface(x);
  }

  /** Feeds a hungry larva, or picks up the egg, larva or pupa to carry it. */
  private tendBrood(id: number, x: number, y: number): void {
    const b = this.brood;
    const i = this.broodGrid[this.idx(x, y)] - 1;
    if (i < 0) return;
    if (b.stage[i] === Stage.Larva && b.fed[i] === 0) {
      b.fed[i] = LARVA_MEAL;
      this.stats.larvaeFed++;
      return;
    }
    const a = this.ants;
    a.carrying[id] = Item.Brood;
    a.broodCaste[id] = b.caste[i];
    a.broodStage[id] = b.stage[i];
    a.broodAge[id] = Math.min(65535, b.age[i]);
    this.removeBrood(i);
  }

  private setBroodDown(id: number, x: number, y: number): void {
    const a = this.ants;
    if (!this.world.inBounds(x, y) || this.world.solidAt(x, y) || this.broodAt(x, y)) return;
    if (this.enemyAt(x, y) >= 0) return;
    const b = this.brood.add(x, y, a.broodCaste[id], a.broodStage[id], a.broodAge[id]);
    if (b < 0) return;
    this.broodGrid[this.idx(x, y)] = b + 1;
    a.carrying[id] = Item.None;
  }

  /** A forager back with food brings a nestmate along to forage where it found it. */
  private recruit(id: number): void {
    const a = this.ants;
    if (a.memX[id] < 0) return;
    for (let i = 0; i < a.count; i++) {
      if (!a.alive[i] || i === id || i === this.player || a.caste[i] !== Caste.Worker) continue;
      if (a.task[i] === Task.Forage || a.carrying[i] !== Item.None) continue;
      if (Math.max(Math.abs(a.x[i] - a.x[id]), Math.abs(a.y[i] - a.y[id])) > 3) continue;
      if (this.age(i) < YOUNG_AGE / 2) continue;
      a.task[i] = Task.Forage;
      a.memX[i] = a.memX[id];
      a.memY[i] = a.memY[id];
      return;
    }
  }

  /** A winged ant flies up and away, drifting with the wind, and leaves the map. */
  private fly(id: number): void {
    const a = this.ants;
    if (this.tick % 2) return;
    const x = a.x[id];
    const y = a.y[id];
    const drift = this.rng.next() < 0.5 ? a.facing[id] : 0;
    const nx = x + drift;
    const ny = y - 1;
    if (ny < 0 || nx < 0 || nx >= this.world.width) {
      this.stats.flown++;
      this.killAnt(id, false);
      return;
    }
    if (!this.world.solidAt(nx, ny)) {
      this.moveAnt(id, nx, ny);
      a.steps[id]++;
    } else if (!this.world.solidAt(x, ny)) {
      this.moveAnt(id, x, ny);
      a.steps[id]++;
    }
  }

  /**
   * Puts a dug pellet on the ground surface well away from column x, in low
   * piles, so the soil never slides back and buries the nest entrance.
   */
  private depositOnSurface(x: number): void {
    const w = this.world;
    const intact = (cx: number) => cx >= 0 && cx < w.width && this.topSolid(cx) <= w.surface[cx];
    // Away from both the hole and the nest entrance, so nothing slides back in.
    const from = Math.abs(x - this.entranceX) < SPOIL_DISTANCE * 2 ? this.entranceX : x;
    for (let d = SPOIL_DISTANCE; d < 120; d++) {
      for (const cx of [from - d, from + d]) {
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
    if (item === Item.Brood) {
      this.setBroodDown(id, x, y);
      return;
    }
    if (item === Item.Corpse && this.middenSpot(x, y)) this.stats.buried++;
    w.set(x, y, item === Item.Food ? Material.Food : item === Item.Corpse ? Material.Corpse : Material.Loose);
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

      const stage = b.stage[i] as Stage;
      // Larvae only grow while fed. A founding queen alone feeds her first brood from her own body.
      if (stage === Stage.Larva) {
        if (b.fed[i] > 0) b.fed[i]--;
        else if (this.hasWorkers()) continue;
      }
      b.age[i]++;
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

  private hasWorkers(): boolean {
    const a = this.ants;
    for (let i = 0; i < a.count; i++) if (a.alive[i] && a.caste[i] === Caste.Worker) return true;
    return false;
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
    if (living < 12) return;
    const max = Math.min(5, Math.floor(living / 15));
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
  /**
   * Seeds and dead insects turn up at random spots on the surface, a few
   * pieces together, so a forager that finds some can bring nestmates back.
   */
  private spawnFood(): void {
    const chance = FOOD_SPAWN_CHANCE * SEASON_FOOD[this.season()] * (this.raining() ? 0.3 : 1);
    if (this.foodOnMap >= (MAX_FOOD_ON_MAP * this.world.width) / 100 || this.rng.next() >= chance * 0.3) return;
    const w = this.world;
    const x = this.rng.int(2, w.width - 3);
    const pieces = this.rng.int(2, 6);
    for (let k = 0; k < pieces; k++) {
      const cx = x + this.rng.int(-2, 2);
      const y = this.topSolid(cx) - 1;
      if (y < 0 || !this.free(cx, y)) continue;
      w.set(cx, y, Material.Food);
      this.foodOnMap++;
      this.settling.add(w.index(cx, y));
    }
  }

  /** Breadth-first step counts to the nest heart and to the open surface, and the dig plan. */
  private updateFields(): void {
    const w = this.world;
    this.activatePlan();
    // The heart of the nest is the queen's chamber once it is dug; before that, wherever the queen is.
    const heart = this.chambers.length ? this.chamberFloor(this.chambers[0]) : -1;
    if (heart >= 0) {
      this.colony.nestX = heart % w.width;
      this.colony.nestY = (heart - this.colony.nestX) / w.width;
    } else if (this.ants.alive[this.player]) {
      this.colony.nestX = this.ants.x[this.player];
      this.colony.nestY = this.ants.y[this.player];
    }
    const home: number[] = [];
    const nest = this.nearestWalkable(this.colony.nestX, this.colony.nestY);
    if (nest >= 0) home.push(nest);
    this.bfs(this.homeDist, home);
    const exits: number[] = [];
    for (let x = 0; x < w.width; x++) {
      const top = Math.min(this.topSolid(x), w.surface[x]);
      if (top > 0 && this.walkable(x, top - 1)) exits.push(this.idx(x, top - 1));
    }
    this.bfs(this.exitDist, exits);
    this.planFrontier();
    this.findNursery();
  }

  /** The colony plans one more chamber for every few ants. */
  private activatePlan(): void {
    const rooms = 2 + Math.floor(this.ants.living / ANTS_PER_ROOM);
    let count = 0;
    let seen = 0;
    while (count < this.plan.length) {
      if (this.plan[count].room && ++seen > rooms) break;
      count++;
    }
    if (count === this.planActive) return;
    this.planActive = count;
    this.planCells = rasterizePlan(this.world, this.plan, count, this.planMask);
    this.chambers = this.plan.slice(0, count).filter((n) => n.room);
  }

  /** Diggers follow `digDist` to the nearest planned cell they can reach. */
  private planFrontier(): void {
    const w = this.world;
    const sources: number[] = [];
    let left = 0;
    for (const i of this.planCells) {
      const m = w.cells[i] as Material;
      if (!isDiggable(m) || m === Material.Corpse) continue;
      const x = i % w.width;
      const y = (i - x) / w.width;
      let reachable = false;
      for (const [dx, dy] of DIRS) {
        if (!w.inBounds(x + dx, y + dy)) continue;
        const j = this.idx(x + dx, y + dy);
        if (this.homeDist[j] !== UNREACHABLE) {
          reachable = true;
          sources.push(j);
        }
      }
      if (reachable) left++;
    }
    this.planLeft = left;
    this.bfs(this.digDist, sources);
  }

  /** The nursery is the second chamber once dug; during an attack the brood goes to the room farthest from the fight. */
  private findNursery(): void {
    const { nestX, nestY, alarmX, alarmY } = this.colony;
    const open: number[] = [];
    for (const c of this.chambers) {
      const f = this.chamberFloor(c);
      if (f >= 0 && this.homeDist[f] !== UNREACHABLE) open.push(f);
    }
    let cell = open.length > 1 ? open[1] : this.nearestWalkable(nestX, nestY);
    const threat = this.alarmActive() && Math.hypot(alarmX - nestX, alarmY - nestY) < this.nestRadius() + 12;
    if (threat && open.length > 1) {
      let far = -1;
      for (const f of open) {
        const fx = f % this.world.width;
        const d = Math.hypot(fx - alarmX, (f - fx) / this.world.width - alarmY);
        if (d > far) {
          far = d;
          cell = f;
        }
      }
    }
    if (cell < 0) {
      this.nurseryDist.fill(UNREACHABLE);
      return;
    }
    this.nurseryX = cell % this.world.width;
    this.nurseryY = (cell - this.nurseryX) / this.world.width;
    this.bfs(this.nurseryDist, [cell]);
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
        if (!this.walkable(nx, ny)) continue;
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
      for (const v of [a.alive[i], a.caste[i], a.x[i], a.y[i], a.carrying[i], a.hp[i], a.task[i], a.energy[i]]) mix(v);
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
