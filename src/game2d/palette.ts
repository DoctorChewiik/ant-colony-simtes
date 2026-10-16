import { Material, hash2, type World } from '../core';

type Rgb = [number, number, number];

const SHADES: Record<Material, Rgb[]> = {
  [Material.Air]: [[43, 29, 20]],
  [Material.Grass]: [
    [79, 138, 58],
    [92, 156, 66],
    [63, 116, 48],
  ],
  [Material.Soil]: [
    [122, 82, 52],
    [110, 74, 47],
    [132, 90, 57],
    [116, 78, 50],
  ],
  [Material.Clay]: [
    [154, 106, 74],
    [160, 112, 78],
    [145, 98, 68],
  ],
  [Material.Rock]: [
    [109, 106, 102],
    [94, 91, 88],
    [122, 118, 114],
  ],
  [Material.Loose]: [
    [140, 100, 64],
    [150, 107, 69],
    [131, 93, 60],
  ],
  [Material.Food]: [
    [214, 170, 72],
    [196, 150, 60],
    [230, 190, 90],
  ],
};

const SKY_TOP: Rgb = [120, 178, 222];
const SKY_LOW: Rgb = [207, 232, 242];

/** RGB colour of one cell: material shade, per-cell variation, darker with depth. */
export function cellColor(world: World, x: number, y: number): Rgb {
  const m = world.get(x, y);
  const surface = world.surface[x];
  if (m === Material.Air && y < surface) {
    const t = y / Math.max(1, surface);
    return [
      Math.round(SKY_TOP[0] + (SKY_LOW[0] - SKY_TOP[0]) * t),
      Math.round(SKY_TOP[1] + (SKY_LOW[1] - SKY_TOP[1]) * t),
      Math.round(SKY_TOP[2] + (SKY_LOW[2] - SKY_TOP[2]) * t),
    ];
  }
  const shades = SHADES[m];
  const base = shades[hash2(x, y) % shades.length];
  const depth = Math.max(0, y - surface) / (world.height - surface);
  const light = 1 - Math.min(0.6, depth * 0.75);
  return [Math.round(base[0] * light), Math.round(base[1] * light), Math.round(base[2] * light)];
}
