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

export interface CasteInfo {
  name: string;
  /** Food the queen spends to lay one egg of this caste. */
  eggCost: number;
  /** Ticks between steps when walking. */
  stepTicks: number;
}

export const CASTES: Record<Caste, CasteInfo> = {
  [Caste.Worker]: { name: 'ouvrière', eggCost: 1, stepTicks: 2 },
  [Caste.Soldier]: { name: 'soldat', eggCost: 2, stepTicks: 3 },
  [Caste.Queen]: { name: 'reine', eggCost: 4, stepTicks: 3 },
  [Caste.Male]: { name: 'mâle', eggCost: 2, stepTicks: 2 },
};

/**
 * All ants live in flat typed arrays (one slot per ant) instead of one object
 * per ant, so the simulation can scale to thousands of them.
 */
export class Ants {
  count = 0;
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
  /** Steps taken, for the walk animation. */
  readonly steps: Uint32Array;

  constructor(readonly capacity: number) {
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
    this.steps = new Uint32Array(capacity);
  }

  spawn(x: number, y: number, caste = Caste.Worker): number {
    if (this.count >= this.capacity) throw new Error('ant capacity reached');
    const id = this.count++;
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
    this.steps[id] = 0;
    return id;
  }

  /** True if some ant other than `except` stands on the cell. */
  occupied(x: number, y: number, except = -1): boolean {
    for (let i = 0; i < this.count; i++) {
      if (i !== except && this.x[i] === x && this.y[i] === y) return true;
    }
    return false;
  }
}
