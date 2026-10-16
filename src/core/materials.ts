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
};

export function isSolid(m: Material): boolean {
  return MATERIALS[m].solid;
}

export function isDiggable(m: Material): boolean {
  return MATERIALS[m].digTicks > 0;
}
