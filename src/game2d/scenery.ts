import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Rng, Season, type Simulation } from '../core';

type Rgb = [number, number, number];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
const hex = (c: Rgb) => (c[0] << 16) | (c[1] << 8) | c[2];
const css = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Sky colours, top and horizon, through the day. */
const SKY: Array<{ t: number; top: Rgb; low: Rgb }> = [
  { t: 0.0, top: [86, 74, 128], low: [242, 176, 122] },
  { t: 0.08, top: [104, 166, 222], low: [206, 230, 240] },
  { t: 0.6, top: [104, 166, 222], low: [206, 230, 240] },
  { t: 0.7, top: [92, 70, 130], low: [242, 150, 104] },
  { t: 0.78, top: [16, 20, 46], low: [44, 48, 86] },
  { t: 0.93, top: [16, 20, 46], low: [44, 48, 86] },
  { t: 1.0, top: [86, 74, 128], low: [242, 176, 122] },
];

function skyAt(t: number): { top: Rgb; low: Rgb } {
  for (let i = 1; i < SKY.length; i++) {
    if (t <= SKY[i].t) {
      const a = SKY[i - 1];
      const b = SKY[i];
      const k = (t - a.t) / (b.t - a.t);
      return { top: mix(a.top, b.top, k), low: mix(a.low, b.low, k) };
    }
  }
  return SKY[0];
}

/** Leaf colours by season: summer greens, autumn golds and reds, bare in winter. */
const LEAVES: Record<Season, Rgb[]> = {
  [Season.Spring]: [
    [98, 178, 84],
    [128, 196, 98],
    [72, 150, 66],
  ],
  [Season.Summer]: [
    [70, 150, 62],
    [96, 172, 74],
    [52, 124, 52],
  ],
  [Season.Autumn]: [
    [214, 142, 54],
    [196, 92, 48],
    [226, 186, 74],
  ],
  [Season.Winter]: [],
};

const TRUNK: Rgb = [104, 74, 54];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): Texture {
  const t = Texture.from(c);
  t.source.scaleMode = 'nearest';
  return t;
}

/** Pixel disc, so canopies keep a crisp stepped edge. */
function disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(r * r - y * y));
    ctx.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1);
  }
}

/**
 * One row of trees as a pixel-art strip, one pixel per world cell. `haze`
 * fades distant rows into the sky colour.
 */
function drawTrees(
  width: number,
  height: number,
  rng: Rng,
  season: Season,
  count: number,
  size: number,
  haze: number,
): HTMLCanvasElement {
  const [c, ctx] = canvas(width, height);
  const hazeColor: Rgb = [186, 206, 214];
  const leaves = LEAVES[season].map((l) => mix(l, hazeColor, haze));
  const trunk = mix(TRUNK, hazeColor, haze);
  for (let i = 0; i < count; i++) {
    const x = rng.int(0, width - 1);
    const tall = Math.round((height * 0.45 + rng.next() * height * 0.5) * size);
    const top = height - tall;
    const tw = tall > height * 0.6 ? 2 : 1;
    ctx.fillStyle = css(trunk);
    ctx.fillRect(x, top + 4, tw, tall);
    if (!leaves.length) {
      // Winter: bare branches.
      for (let b = 0; b < 4; b++) {
        const by = top + 6 + rng.int(0, Math.floor(tall / 2));
        const dir = rng.next() < 0.5 ? -1 : 1;
        for (let k = 0; k < 5; k++) ctx.fillRect(x + dir * k, by - k, 1, 1);
      }
      continue;
    }
    const blobs = 3 + rng.int(0, 3);
    const r0 = Math.max(3, Math.round((5 + rng.next() * 6) * size));
    for (let k = 0; k < blobs; k++) {
      const bx = x + rng.int(-r0, r0);
      const by = top + rng.int(0, r0);
      const r = Math.max(2, r0 - rng.int(0, 3));
      disc(ctx, bx + 1, by + 1, r, css(leaves[2]));
      disc(ctx, bx, by, r, css(leaves[0]));
      disc(ctx, bx - Math.floor(r / 3), by - Math.floor(r / 3), Math.max(1, Math.floor(r / 2)), css(leaves[1]));
    }
  }
  return c;
}

/** Bushes, grass blades and flowers standing on the real ground line. */
function drawUndergrowth(sim: Simulation, height: number, rng: Rng, season: Season): HTMLCanvasElement {
  const { world } = sim;
  const [c, ctx] = canvas(world.width, height);
  const leaves = LEAVES[season].length ? LEAVES[season] : ([[120, 110, 90], [140, 128, 104], [100, 92, 76]] as Rgb[]);
  for (let x = 0; x < world.width; x++) {
    const ground = world.surface[x];
    if (rng.next() < 0.05) {
      const r = rng.int(2, 4);
      disc(ctx, x + 1, ground - r + 1, r, css(leaves[2]));
      disc(ctx, x, ground - r, r, css(leaves[0]));
    }
    if (rng.next() < 0.5) {
      ctx.fillStyle = css(mix(leaves[1], [70, 140, 60], 0.5));
      ctx.fillRect(x, ground - rng.int(1, 2), 1, 2);
    }
    if (season !== Season.Winter && rng.next() < 0.04) {
      const stem = rng.int(3, 7);
      ctx.fillStyle = 'rgb(86,150,70)';
      ctx.fillRect(x, ground - stem, 1, stem);
      ctx.fillStyle = rng.next() < 0.6 ? '#f4f1e6' : '#f2d35a';
      ctx.fillRect(x - 1, ground - stem - 1, 3, 2);
    }
  }
  return c;
}

function drawCloud(rng: Rng): HTMLCanvasElement {
  const w = 34;
  const h = 14;
  const [c, ctx] = canvas(w, h);
  for (let k = 0; k < 5; k++) {
    const r = rng.int(3, 6);
    disc(ctx, 6 + k * 5 + rng.int(-1, 1), h - r - 1 + rng.int(-1, 0), r, k % 2 ? '#f4f1ea' : '#ffffff');
  }
  return c;
}

interface Drop {
  x: number;
  y: number;
  speed: number;
}

/**
 * Everything behind and above the ground: sky through the day, stars, drifting
 * clouds, rows of trees with parallax, undergrowth, and rain.
 */
export class Scenery {
  /** Screen-space layers drawn behind the camera. */
  readonly back = new Container();
  /** World-space layers inside the camera, behind the terrain. */
  readonly world = new Container();
  /** Screen-space layer in front of everything (rain). */
  readonly front = new Container();
  private skyCanvas: HTMLCanvasElement;
  private skyCtx: CanvasRenderingContext2D;
  private skyTexture: Texture;
  private sky: Sprite;
  private stars = new Graphics();
  private clouds: Array<{ sprite: Sprite; speed: number; x: number; y: number }> = [];
  private layers: Array<{ sprite: Sprite; factor: number; width: number }> = [];
  private undergrowth: Sprite | null = null;
  private rain = new Graphics();
  private drops: Drop[] = [];
  private season: Season | -1 = -1;
  private lastSky = -1;
  private starField: Array<[number, number, number]> = [];

  constructor(private sim: Simulation) {
    [this.skyCanvas, this.skyCtx] = canvas(1, 64);
    this.skyTexture = texture(this.skyCanvas);
    this.skyTexture.source.scaleMode = 'linear';
    this.sky = new Sprite(this.skyTexture);
    this.back.addChild(this.sky, this.stars);
    const rng = new Rng(sim.options.seed ^ 0xc10d);
    for (let i = 0; i < 7; i++) {
      const sprite = new Sprite(texture(drawCloud(rng)));
      this.back.addChild(sprite);
      this.clouds.push({ sprite, speed: 2 + rng.next() * 4, x: rng.next(), y: 0.05 + rng.next() * 0.25 });
    }
    for (let i = 0; i < 90; i++) this.starField.push([rng.next(), rng.next() * 0.6, rng.next()]);
    this.front.addChild(this.rain);
  }

  private buildTrees(season: Season): void {
    const { world } = this.sim;
    for (const l of this.layers) l.sprite.destroy({ texture: true });
    this.undergrowth?.destroy({ texture: true });
    this.layers = [];
    this.world.removeChildren();
    const base = Math.min(...world.surface) + 1;
    const rng = new Rng(this.sim.options.seed ^ 0x7ee5);
    const rows: Array<[number, number, number, number]> = [
      // parallax factor, tree count per 100 columns, size, haze
      [0.55, 9, 0.8, 0.55],
      [0.75, 7, 0.95, 0.28],
      [1, 3, 1.1, 0],
    ];
    for (const [factor, density, size, haze] of rows) {
      const width = Math.ceil(world.width * (2 - factor));
      const strip = drawTrees(width, base + 4, rng, season, Math.round((width / 100) * density), size, haze);
      const sprite = new Sprite(texture(strip));
      this.world.addChild(sprite);
      this.layers.push({ sprite, factor, width });
    }
    this.undergrowth = new Sprite(texture(drawUndergrowth(this.sim, base + 8, rng, season)));
    this.world.addChild(this.undergrowth);
  }

  /** Call every frame with the camera's centre (in cells), zoom and the screen size. */
  update(dt: number, camX: number, camY: number, zoom: number, screenW: number, screenH: number): void {
    const sim = this.sim;
    const season = sim.season();
    if (season !== this.season) {
      this.season = season;
      this.buildTrees(season);
    }
    const t = sim.timeOfDay();
    const night = 1 - sim.daylight();
    const rain = sim.raining() ? 1 : 0;

    // Sky gradient, redrawn when the colours change.
    const key = Math.round(t * 400) + rain * 1000;
    if (key !== this.lastSky) {
      this.lastSky = key;
      let { top, low } = skyAt(t);
      if (rain) {
        top = mix(top, [96, 100, 112], 0.6);
        low = mix(low, [140, 144, 152], 0.6);
      }
      const g = this.skyCtx.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0, css(top));
      g.addColorStop(1, css(low));
      this.skyCtx.fillStyle = g;
      this.skyCtx.fillRect(0, 0, 1, 64);
      this.skyTexture.source.update();
    }
    // The sky ends at the horizon line on screen.
    const horizon = Math.max(0, (Math.min(...sim.world.surface) - camY) * zoom + screenH / 2);
    // Paint the sky down past the lowest ground, so no gap shows behind dips in the surface.
    const skyBottom = Math.max(0, (Math.max(...sim.world.surface) + 2 - camY) * zoom + screenH / 2);
    this.sky.width = screenW;
    this.sky.height = Math.max(1, skyBottom);

    this.stars.clear();
    if (night > 0.3 && !rain) {
      for (const [sx, sy, tw] of this.starField) {
        const y = sy * horizon;
        this.stars.rect(sx * screenW, y, 2, 2).fill({ color: 0xffffff, alpha: (night - 0.3) * (0.6 + 0.4 * tw) });
      }
    }

    const cloudTint = hex(mix([255, 255, 255], [70, 76, 104], night * 0.85));
    for (const c of this.clouds) {
      c.x = (c.x + (c.speed * dt) / 1000 / screenW) % 1.2;
      const s = Math.max(2, zoom * 0.9);
      c.sprite.scale.set(s);
      c.sprite.position.set((c.x - 0.1) * (screenW + 40 * s) - camX * zoom * 0.05, c.y * horizon);
      c.sprite.tint = rain ? 0x9aa0aa : cloudTint;
      c.sprite.alpha = rain ? 0.95 : 0.9;
    }

    // Tree rows slide slower than the ground when the camera pans: depth.
    const W = sim.world.width;
    const shade = hex(mix([255, 255, 255], [60, 70, 110], night * 0.8));
    for (const l of this.layers) {
      l.sprite.x = (camX - W / 2) * (1 - l.factor) - (l.width - W) / 2;
      l.sprite.tint = rain ? hex(mix([255, 255, 255], [150, 156, 170], 0.5)) : shade;
    }
    if (this.undergrowth) this.undergrowth.tint = shade;

    this.updateRain(dt, rain === 1, camX, camY, zoom, screenW, screenH);
  }

  private updateRain(dt: number, raining: boolean, camX: number, camY: number, zoom: number, w: number, h: number): void {
    const g = this.rain;
    g.clear();
    if (!raining) {
      this.drops.length = 0;
      return;
    }
    while (this.drops.length < 160) this.drops.push({ x: Math.random() * w, y: Math.random() * h, speed: 0.6 + Math.random() * 0.5 });
    const ground = (sx: number) => {
      const cx = Math.floor((sx - w / 2) / zoom + camX);
      const surface = this.sim.world.surface[Math.max(0, Math.min(this.sim.world.width - 1, cx))];
      return (surface - camY) * zoom + h / 2;
    };
    for (const d of this.drops) {
      d.y += d.speed * dt;
      d.x -= d.speed * dt * 0.15;
      if (d.y > ground(d.x) || d.x < -10) {
        d.y = -Math.random() * 40;
        d.x = Math.random() * (w + 60);
      }
      g.moveTo(d.x, d.y).lineTo(d.x + 2, d.y - 10);
    }
    g.stroke({ width: 1, color: 0xcfe0f0, alpha: 0.55 });
  }
}
