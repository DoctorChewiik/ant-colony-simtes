/** What an ant holds in its mandibles. */
export enum Item {
  None = 0,
  Soil = 1,
  Food = 2,
}

/** What an ant is born as. */
export enum Caste {
  Worker = 0,
  Soldier = 1,
  Queen = 2,
  Male = 3,
}

/** The job an AI ant is doing. */
export enum Task {
  Idle = 0,
  Forage = 1,
  Dig = 2,
  Nurse = 3,
  Guard = 4,
}

export interface CasteInfo {
  name: string;
  /** Food the queen spends to lay one egg of this caste. */
  eggCost: number;
  /** Ticks between steps when walking. */
  stepTicks: number;
  maxHp: number;
  /** Damage per bite. */
  bite: number;
}

export const CASTES: Record<Caste, CasteInfo> = {
  [Caste.Worker]: { name: 'ouvrière', eggCost: 1, stepTicks: 2, maxHp: 10, bite: 1 },
  [Caste.Soldier]: { name: 'soldat', eggCost: 2, stepTicks: 3, maxHp: 30, bite: 4 },
  [Caste.Queen]: { name: 'reine', eggCost: 4, stepTicks: 3, maxHp: 40, bite: 2 },
  [Caste.Male]: { name: 'mâle', eggCost: 2, stepTicks: 2, maxHp: 6, bite: 0 },
};

/**
 * All ants live in flat typed arrays (one slot per ant) instead of one object
 * per ant, so the simulation can scale to thousands of them. Dead ants free
 * their slot; `gen` changes each time a slot is reused.
 */
export class Ants {
  /** Highest slot ever used, plus one. Loop to this and skip dead slots. */
  count = 0;
  readonly alive: Uint8Array;
  readonly gen: Uint32Array;
  readonly caste: Uint8Array;
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** +1 facing right, -1 facing left. */
  readonly facing: Int8Array;
  /** Direction the ant last tried to move or aim in; used for digging and dropping. */
  readonly aimX: Int8Array;
  readonly aimY: Int8Array;
  readonly carrying: Uint8Array;
  /** Cell index being dug, or -1. */
  readonly digTarget: Int32Array;
  readonly digProgress: Uint16Array;
  /** Ticks until the ant may take its next step. */
  readonly cooldown: Uint8Array;
  readonly biteCooldown: Uint8Array;
  readonly hp: Int16Array;
  readonly task: Uint8Array;
  /** Steps since the ant picked up food, for laying a fading trail. */
  readonly trip: Uint16Array;
  /** Steps taken, for the walk animation. */
  readonly steps: Uint32Array;

  constructor(readonly capacity: number) {
    this.alive = new Uint8Array(capacity);
    this.gen = new Uint32Array(capacity);
    this.caste = new Uint8Array(capacity);
    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.facing = new Int8Array(capacity);
    this.aimX = new Int8Array(capacity);
    this.aimY = new Int8Array(capacity);
    this.carrying = new Uint8Array(capacity);
    this.digTarget = new Int32Array(capacity);
    this.digProgress = new Uint16Array(capacity);
    this.cooldown = new Uint8Array(capacity);
    this.biteCooldown = new Uint8Array(capacity);
    this.hp = new Int16Array(capacity);
    this.task = new Uint8Array(capacity);
    this.trip = new Uint16Array(capacity);
    this.steps = new Uint32Array(capacity);
  }

  /** Number of living ants. */
  get living(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.alive[i];
    return n;
  }

  /** Puts a new ant in the first free slot. Returns -1 when full. */
  spawn(x: number, y: number, caste = Caste.Worker): number {
    let id = 0;
    while (id < this.count && this.alive[id]) id++;
    if (id >= this.capacity) return -1;
    if (id === this.count) this.count++;
    this.alive[id] = 1;
    this.gen[id]++;
    this.caste[id] = caste;
    this.x[id] = x;
    this.y[id] = y;
    this.facing[id] = 1;
    this.aimX[id] = 1;
    this.aimY[id] = 0;
    this.carrying[id] = Item.None;
    this.digTarget[id] = -1;
    this.digProgress[id] = 0;
    this.cooldown[id] = 0;
    this.biteCooldown[id] = 0;
    this.hp[id] = CASTES[caste].maxHp;
    this.task[id] = Task.Idle;
    this.trip[id] = 0;
    this.steps[id] = 0;
    return id;
  }
}
