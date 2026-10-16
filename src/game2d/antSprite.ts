import { Texture } from 'pixi.js';
import { Caste } from '../core';

/** Pixel size of the ant sprite. A worker spans 2 cells wide and 1 cell tall. */
export const ANT_W = 10;
export const ANT_H = 6;

// Facing right, legs down. g = gaster, t = thorax, h = head, a = antenna, l = leg, m = mandible, w = wing.
const BODY = ['.......aa.', '.ggg.tthha', 'gggggtthhm', '.ggg.tt.h.'];
const LEGS = ['..l.l.l...', '.l.l.l....'];
const WINGS = '..wwww....';

interface CasteLook {
  colors: Record<string, string>;
  /** Visual size relative to a worker. */
  scale: number;
  wings: boolean;
}

export const CASTE_LOOKS: Record<Caste, CasteLook> = {
  [Caste.Worker]: {
    colors: { g: '#2a1810', t: '#3a2216', h: '#33200f', a: '#4a2e1c', l: '#24150d', m: '#5a3820' },
    scale: 1,
    wings: false,
  },
  [Caste.Soldier]: {
    colors: { g: '#3a1a10', t: '#5a2614', h: '#7a3018', a: '#5a3820', l: '#2a140c', m: '#9a4a24' },
    scale: 1.3,
    wings: false,
  },
  [Caste.Queen]: {
    colors: { g: '#2a160c', t: '#4a2a18', h: '#3a2010', a: '#5a3820', l: '#24150d', m: '#6a4428' },
    scale: 1.55,
    wings: false,
  },
  [Caste.Male]: {
    colors: { g: '#141414', t: '#1e1e1e', h: '#1a1a1a', a: '#333333', l: '#101010', m: '#2a2a2a', w: '#c8d6e0' },
    scale: 1.1,
    wings: true,
  },
};

function frameTexture(rows: string[], colors: Record<string, string>): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = ANT_W;
  canvas.height = ANT_H;
  const ctx = canvas.getContext('2d')!;
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = colors[ch];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.globalAlpha = ch === 'w' ? 0.75 : 1;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

/** Two walking frames per caste. */
export function makeAntFrames(): Record<Caste, Texture[]> {
  const out = {} as Record<Caste, Texture[]>;
  for (const caste of [Caste.Worker, Caste.Soldier, Caste.Queen, Caste.Male]) {
    const look = CASTE_LOOKS[caste];
    out[caste] = LEGS.map((legs) => frameTexture([look.wings ? WINGS : '..........', ...BODY, legs], look.colors));
  }
  return out;
}
