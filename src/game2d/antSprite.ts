import { Texture } from 'pixi.js';

/** Pixel size of the ant sprite. The ant spans 2 cells wide and 1 cell tall. */
export const ANT_W = 10;
export const ANT_H = 5;

// Facing right, legs down. g = gaster, t = thorax, h = head, a = antenna, l = leg, m = mandible.
const FRAMES = [
  ['.......aa.', '.ggg.tthha', 'gggggtthhm', '.ggg.tt.h.', '..l.l.l...'],
  ['.......aa.', '.ggg.tthha', 'gggggtthhm', '.ggg.tt.h.', '.l.l.l....'],
];

const COLORS: Record<string, string> = {
  g: '#2a1810',
  t: '#3a2216',
  h: '#33200f',
  a: '#4a2e1c',
  l: '#24150d',
  m: '#5a3820',
};

function frameTexture(rows: string[]): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = ANT_W;
  canvas.height = ANT_H;
  const ctx = canvas.getContext('2d')!;
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = COLORS[ch];
      if (!color) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

export function makeAntFrames(): Texture[] {
  return FRAMES.map(frameTexture);
}
