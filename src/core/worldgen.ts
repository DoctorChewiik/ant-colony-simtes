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

/** Side view of a patch of ground: sky, grass, soil, a clay band, rocks, bedrock. */
export function generateWorld({ width, height, seed }: WorldGenOptions): World {
  const rng = new Rng(seed);
  const world = new World(width, height);
  const hills = valueNoise(rng, width, 24);
  const bumps = valueNoise(rng, width, 6);
  const clayTop = valueNoise(rng, width, 32);

  const baseSurface = Math.floor(height * 0.28);
  for (let x = 0; x < width; x++) {
    const s = baseSurface + Math.round((hills[x] - 0.5) * 10 + (bumps[x] - 0.5) * 3);
    world.surface[x] = s;
    const clayStart = s + Math.floor(height * 0.3) + Math.round(clayTop[x] * 8);
    const clayEnd = clayStart + 10 + Math.round(clayTop[x] * 6);
    for (let y = 0; y < height; y++) {
      let m: Material;
      if (y < s) m = Material.Air;
      else if (y === s) m = Material.Grass;
      else if (y >= height - 3) m = Material.Rock;
      else if (y >= clayStart && y < clayEnd) m = Material.Clay;
      else m = Material.Soil;
      world.cells[world.index(x, y)] = m;
    }
  }

  // Scattered rocks below the topsoil; ants have to dig around them.
  const rockCount = Math.floor((width * height) / 1400);
  for (let r = 0; r < rockCount; r++) {
    const cx = rng.int(0, width - 1);
    const cy = rng.int(baseSurface + 8, height - 4);
    const radius = rng.int(2, 5);
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (!world.inBounds(x, y) || y <= world.surface[x] + 2) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d <= radius * radius - rng.int(0, radius)) world.cells[world.index(x, y)] = Material.Rock;
      }
    }
  }

  world.drainChanges();
  return world;
}
