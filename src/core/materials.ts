/** Every cell in the world holds one material. Values are stored in a Uint8Array. */
export enum Material {
  Air = 0,
  Grass = 1,
  Soil = 2,
  Clay = 3,
  Rock = 4,
  /** Soil an ant has dug and dropped. It falls and piles up like sand. */
  Loose = 5,
  /** A seed or crumb lying in the world; ants pick it up and eat it. */
  Food = 6,
  /** A dead ant. Workers carry it out of the nest to the refuse pile. */
  Corpse = 7,
  /** Pale sandy soil, the bulk of the ground. */
  Sand = 8,
  /** Dense grey subsoil deep down, slow to dig. */
  Stone = 9,
}

export interface MaterialInfo {
  name: string;
  solid: boolean;
  /** Ticks of digging needed to remove one cell; 0 means it cannot be dug. */
  digTicks: number;
  /** Falls and slides like sand when unsupported. */
  granular: boolean;
}

export const MATERIALS: Record<Material, MaterialInfo> = {
  [Material.Air]: { name: 'air', solid: false, digTicks: 0, granular: false },
  [Material.Grass]: { name: 'grass', solid: true, digTicks: 8, granular: false },
  [Material.Soil]: { name: 'soil', solid: true, digTicks: 10, granular: false },
  [Material.Clay]: { name: 'clay', solid: true, digTicks: 24, granular: false },
  [Material.Rock]: { name: 'rock', solid: true, digTicks: 0, granular: false },
  [Material.Loose]: { name: 'loose soil', solid: true, digTicks: 3, granular: true },
  [Material.Food]: { name: 'food', solid: true, digTicks: 2, granular: true },
  [Material.Corpse]: { name: 'dead ant', solid: true, digTicks: 2, granular: true },
  [Material.Sand]: { name: 'sand', solid: true, digTicks: 8, granular: false },
  [Material.Stone]: { name: 'stone', solid: true, digTicks: 40, granular: false },
};

export function isSolid(m: Material): boolean {
  return MATERIALS[m].solid;
}

export function isDiggable(m: Material): boolean {
  return MATERIALS[m].digTicks > 0;
}
