import { Caste } from './ants';

/** Life stages before an ant becomes an adult. */
export enum Stage {
  Egg = 0,
  Larva = 1,
  Pupa = 2,
}

/** Ticks spent in each stage (30 ticks per second); real ants take weeks. */
export const STAGE_TICKS: Record<Stage, number> = {
  [Stage.Egg]: 300,
  [Stage.Larva]: 450,
  [Stage.Pupa]: 300,
};

/** Eggs, larvae and pupae, stored like the ants in flat arrays. */
export class Brood {
  count = 0;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly caste: Uint8Array;
  readonly stage: Uint8Array;
  readonly age: Uint32Array;

  constructor(readonly capacity: number) {
    this.x = new Int32Array(capacity);
    this.y = new Int32Array(capacity);
    this.caste = new Uint8Array(capacity);
    this.stage = new Uint8Array(capacity);
    this.age = new Uint32Array(capacity);
  }

  add(x: number, y: number, caste: Caste): number {
    if (this.count >= this.capacity) return -1;
    const id = this.count++;
    this.x[id] = x;
    this.y[id] = y;
    this.caste[id] = caste;
    this.stage[id] = Stage.Egg;
    this.age[id] = 0;
    return id;
  }

  /** Removes one entry by moving the last one into its slot. */
  remove(id: number): void {
    const last = --this.count;
    if (id === last) return;
    this.x[id] = this.x[last];
    this.y[id] = this.y[last];
    this.caste[id] = this.caste[last];
    this.stage[id] = this.stage[last];
    this.age[id] = this.age[last];
  }

  at(x: number, y: number): number {
    for (let i = 0; i < this.count; i++) if (this.x[i] === x && this.y[i] === y) return i;
    return -1;
  }
}
