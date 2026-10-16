import { Material, isSolid } from './materials';

/**
 * The world is always a 3D grid of cells. The 2D game uses depth 1; the voxel
 * game will use the same class with a real depth.
 */
export class World {
  readonly cells: Uint8Array;
  /** Height of the original ground surface per column, used for sky vs tunnel. */
  readonly surface: Int32Array;
  /** Cell indices changed since the renderer last drained them. */
  private changed: number[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly depth = 1,
  ) {
    this.cells = new Uint8Array(width * height * depth);
    this.surface = new Int32Array(width);
  }

  index(x: number, y: number, z = 0): number {
    return (z * this.height + y) * this.width + x;
  }

  inBounds(x: number, y: number, z = 0): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.height && z < this.depth;
  }

  /** Out-of-bounds reads as rock so nothing can leave the map. */
  get(x: number, y: number, z = 0): Material {
    if (!this.inBounds(x, y, z)) return Material.Rock;
    return this.cells[this.index(x, y, z)] as Material;
  }

  set(x: number, y: number, m: Material, z = 0): void {
    if (!this.inBounds(x, y, z)) return;
    const i = this.index(x, y, z);
    if (this.cells[i] === m) return;
    this.cells[i] = m;
    this.changed.push(i);
  }

  solidAt(x: number, y: number, z = 0): boolean {
    return isSolid(this.get(x, y, z));
  }

  /** Returns and clears the list of changed cell indices. */
  drainChanges(): number[] {
    const out = this.changed;
    this.changed = [];
    return out;
  }
}
