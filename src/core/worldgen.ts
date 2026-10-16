import { Material } from './materials';
import { Rng } from './rng';
import { World } from './world';

export interface WorldGenOptions {
  width: number;
  height: number;
  seed: number;
}

/** 1D value noise: random points every `step` columns, smoothly interpolated. */
function valueNoise(rng: Rng, length: number, step: number): Float32Array {
  const points = Math.ceil(length / step) + 2;
  const knots = Array.from({ length: points }, () => rng.next());
  const out = new Float32Array(length);
  for (let x = 0; x < length; x++) {
    const i = Math.floor(x / step);
    const t = (x % step) / step;
    const s = t * t * (3 - 2 * t);
    out[x] = knots[i] * (1 - s) + knots[i + 1] * s;
  }
  return out;
}

/**
 * Side view of a patch of ground, in layers like a real soil profile: grass,
 * dark topsoil, pale sand, a clay band, more sand, dense stone, bedrock. Thin
 * seams of rock with gaps cross it, and pebbles are scattered through it.
 */
export function generateWorld({ width, height, seed }: WorldGenOptions): World {
  const rng = new Rng(seed);
  const world = new World(width, height);
  const hills = valueNoise(rng, width, 40);
  const bumps = valueNoise(rng, width, 7);
  const n1 = valueNoise(rng, width, 30);
  const n2 = valueNoise(rng, width, 26);
  const n3 = valueNoise(rng, width, 34);

  const baseSurface = Math.floor(height * 0.23);
  const below = height - baseSurface;
  for (let x = 0; x < width; x++) {
    const s = baseSurface + Math.round((hills[x] - 0.5) * 4 + (bumps[x] - 0.5) * 1.5);
    world.surface[x] = s;
    const topsoilEnd = s + 4 + Math.round(n1[x] * 4);
    const clayStart = baseSurface + Math.floor(below * 0.42) + Math.round(n2[x] * 6);
    const clayEnd = clayStart + Math.max(3, Math.floor(below * 0.1)) + Math.round(n1[x] * 4);
    const stoneStart = baseSurface + Math.floor(below * 0.78) + Math.round(n3[x] * 5);
    for (let y = 0; y < height; y++) {
      let m: Material;
      if (y < s) m = Material.Air;
      else if (y === s) m = Material.Grass;
      else if (y >= height - 3) m = Material.Rock;
      else if (y < topsoilEnd) m = Material.Soil;
      else if (y >= stoneStart) m = Material.Stone;
      else if (y >= clayStart && y < clayEnd) m = Material.Clay;
      else m = Material.Sand;
      world.cells[world.index(x, y)] = m;
    }
  }

  // Rock seams: thin wavy layers with gaps the ants can squeeze through.
  for (const depth of [0.36, 0.62]) {
    let y = baseSurface + Math.floor(below * depth);
    let x = 0;
    while (x < width) {
      const run = rng.int(18, 60);
      for (let k = 0; k < run && x < width; k++, x++) {
        if (rng.next() < 0.12) y += rng.int(-1, 1);
        if (world.inBounds(x, y) && y > world.surface[x] + 6) world.cells[world.index(x, y)] = Material.Rock;
      }
      x += rng.int(3, 7);
    }
  }

  // Pebbles, wider than tall.
  const pebbles = Math.floor((width * height) / 700);
  for (let r = 0; r < pebbles; r++) {
    const cx = rng.int(0, width - 1);
    const cy = rng.int(baseSurface + 3, height - 4);
    const rx = rng.int(1, 4);
    const ry = Math.max(1, rx - rng.int(0, 2));
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (!world.inBounds(x, y) || y <= world.surface[x] + 2) continue;
        const d = ((x - cx) / (rx + 0.5)) ** 2 + ((y - cy) / (ry + 0.5)) ** 2;
        if (d <= 1) world.cells[world.index(x, y)] = Material.Rock;
      }
    }
  }

  world.drainChanges();
  return world;
}
