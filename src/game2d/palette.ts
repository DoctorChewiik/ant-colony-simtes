import { Material, hash2, type World } from '../core';

type Rgba = [number, number, number, number];
type Rgb = [number, number, number];

/** Base shades per material; each cell picks one by a hash so the ground looks grainy. */
const SHADES: Record<Material, Rgb[]> = {
  [Material.Water]: [
    [58, 120, 196],
    [62, 126, 202],
    [55, 116, 190],
  ],
  [Material.Air]: [
    [124, 88, 60],
    [118, 84, 57],
    [128, 92, 62],
  ],
  [Material.Grass]: [
    [92, 156, 62],
    [78, 140, 54],
    [104, 168, 70],
  ],
  [Material.Soil]: [
    [156, 122, 86],
    [146, 114, 80],
    [164, 130, 92],
    [150, 118, 84],
  ],
  [Material.Sand]: [
    [214, 184, 138],
    [208, 178, 132],
    [222, 194, 148],
    [210, 180, 134],
    [218, 188, 142],
  ],
  [Material.Clay]: [
    [200, 150, 108],
    [192, 142, 102],
    [206, 158, 114],
  ],
  [Material.Stone]: [
    [170, 162, 150],
    [162, 154, 142],
    [176, 168, 156],
  ],
  [Material.Rock]: [
    [128, 128, 134],
    [120, 120, 126],
    [136, 136, 142],
  ],
  [Material.Loose]: [
    [104, 76, 52],
    [96, 70, 48],
    [112, 82, 56],
  ],
  [Material.Food]: [
    [222, 178, 76],
    [204, 158, 62],
    [236, 196, 96],
  ],
  [Material.Corpse]: [
    [52, 34, 26],
    [44, 28, 22],
  ],
};

/** Grains that stand out from the sand: a few pale and dark specks. */
const SPECKLED = new Set([Material.Sand, Material.Soil, Material.Stone, Material.Clay]);

/**
 * RGBA colour of one cell. Open sky is transparent so the scenery behind
 * shows through; dug tunnels are a warm brown; rocks get a dark rim and a
 * light top edge so pebbles read as stones.
 */
export function cellColor(world: World, x: number, y: number): Rgba {
  const m = world.get(x, y);
  const surface = world.surface[x];
  if (m === Material.Air && y < surface) return [0, 0, 0, 0];
  const h = hash2(x, y);
  const shades = SHADES[m];
  let [r, g, b] = shades[h % shades.length];

  if (SPECKLED.has(m)) {
    const speck = (h >> 8) & 63;
    if (speck === 0 || speck === 1) [r, g, b] = [r * 0.62, g * 0.6, b * 0.58];
    else if (speck < 5) [r, g, b] = [r * 1.08, g * 1.08, b * 1.1];
  }
  if (m === Material.Rock) {
    const edge = (dx: number, dy: number) => world.get(x + dx, y + dy) !== Material.Rock;
    if (edge(0, -1)) [r, g, b] = [158, 158, 164];
    else if (edge(-1, 0) || edge(1, 0) || edge(0, 1)) [r, g, b] = [88, 88, 94];
  }
  if (m === Material.Water) {
    // A bright line where the water meets the air.
    if (world.get(x, y - 1) !== Material.Water) [r, g, b] = [128, 186, 236];
    // Over the open sky the scenery shows through a little.
    if (y < surface) return [Math.round(r), Math.round(g), Math.round(b), 215];
  }
  if (m === Material.Air) {
    // Tunnel walls are a touch darker than the middle of a chamber.
    let walls = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      if (world.solidAt(x + dx, y + dy)) walls++;
    }
    const k = 1 - walls * 0.06;
    [r, g, b] = [r * k, g * k, b * k];
  }

  const depth = Math.max(0, y - surface) / Math.max(1, world.height - surface);
  const light = 1 - Math.min(0.25, depth * 0.3);
  return [Math.round(r * light), Math.round(g * light), Math.round(b * light), 255];
}
