export enum EnemyKind {
  Spider = 0,
}

export interface EnemyInfo {
  name: string;
  maxHp: number;
  bite: number;
  biteTicks: number;
  stepTicks: number;
  /** Distance at which it notices an ant to hunt. */
  sight: number;
  /** Pieces of food its body leaves when it dies. */
  food: number;
}

export const ENEMIES: Record<EnemyKind, EnemyInfo> = {
  [EnemyKind.Spider]: { name: 'araignée', maxHp: 40, bite: 3, biteTicks: 14, stepTicks: 3, sight: 18, food: 3 },
};

/** Predators, stored in flat arrays like the ants. */
export class Enemies {
  count = 0;
  readonly alive: Uint8Array;
  readonly gen: Uint32Array;
  readonly kind: Uint8Array;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly hp: Int16Array;
  readonly facing: Int8Array;
  readonly cooldown: Uint8Array;
  readonly biteCooldown: Uint8Array;
  readonly wanderX: Int8Array;
  readonly wanderY: Int8Array;
  readonly steps: Uint32Array;

  constructor(readonly capacity: number) {
    this.alive = new Uint8Array(capacity);
    this.gen = new Uint32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.hp = new Int16Array(capacity);
    this.facing = new Int8Array(capacity);
    this.cooldown = new Uint8Array(capacity);
    this.biteCooldown = new Uint8Array(capacity);
    this.wanderX = new Int8Array(capacity);
    this.wanderY = new Int8Array(capacity);
    this.steps = new Uint32Array(capacity);
  }

  get living(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.alive[i];
    return n;
  }

  spawn(x: number, y: number, kind: EnemyKind): number {
    let id = 0;
    while (id < this.count && this.alive[id]) id++;
    if (id >= this.capacity) return -1;
    if (id === this.count) this.count++;
    this.alive[id] = 1;
    this.gen[id]++;
    this.kind[id] = kind;
    this.x[id] = x;
    this.y[id] = y;
    this.hp[id] = ENEMIES[kind].maxHp;
    this.facing[id] = 1;
    this.cooldown[id] = 0;
    this.biteCooldown[id] = 0;
    this.wanderX[id] = 0;
    this.wanderY[id] = 0;
    this.steps[id] = 0;
    return id;
  }
}
