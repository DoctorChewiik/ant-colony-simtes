import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { CASTES, Caste, ENEMIES, EnemyKind, GUIDE_LIFE, Item, MATERIALS, Stage, TICK_RATE, hash2, type Simulation } from '../core';
import { ANT_H, ANT_W, CASTE_LOOKS, SPIDER_H, SPIDER_W, makeAntFrames, makeGyneFrames, makeSpiderFrames } from './antSprite';

const PELLET_COLORS: Record<Item, number> = {
  [Item.None]: 0,
  [Item.Soil]: 0x8c6440,
  [Item.Food]: 0xd6aa48,
  [Item.Corpse]: 0x2e1d15,
  [Item.Brood]: 0xf4f0e2,
};
import { cellColor } from './palette';
import { Scenery } from './scenery';

const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
/** A worker is drawn this many cells long. */
const ANT_LENGTH = 1.5;
/** Redraw the scent overlay every few frames; it changes slowly. */
const SCENT_EVERY = 6;

/** A creature drawn gliding at constant speed from its last cell to its current one. */
interface Glide {
  pos: { x: number; y: number };
  from: { x: number; y: number };
  cell: { x: number; y: number };
  moveStart: number;
  moveTime: number;
  gen: number;
}

interface AntView extends Glide {
  sprite: Sprite;
  pellet: Graphics;
  carried: Item;
  /** Fixed spot inside the cell, so ants sharing a cell spread out into a swarm. */
  offset: { x: number; y: number };
  phase: number;
}

interface EnemyView extends Glide {
  sprite: Sprite;
}

/** Draws the simulation as a side-view pixel ant farm. Reads the sim, never changes it. */
export class Renderer {
  readonly camera = new Container();
  zoom = 4;
  showScents = false;
  /** Follow the queen (when the player controls her) or let the camera roam free. */
  follow = false;
  /** An ant the camera keeps in view and rings, or -1. */
  watch = -1;
  private scenery: Scenery;
  private pantry = new Graphics();
  private worldCanvas: HTMLCanvasElement;
  private worldCtx: CanvasRenderingContext2D;
  private worldImage: ImageData;
  private worldTexture: Texture;
  private scentCanvas: HTMLCanvasElement;
  private scentCtx: CanvasRenderingContext2D;
  private scentImage: ImageData;
  private scentTexture: Texture;
  private scentSprite: Sprite;
  private antFrames: Record<Caste, Texture[]>;
  private gyneFrames: Texture[];
  private spiderFrames: Texture[];
  private antLayer = new Container();
  private enemyLayer = new Container();
  private antViews: AntView[] = [];
  private enemyViews: EnemyView[] = [];
  private brood = new Graphics();
  private bars = new Graphics();
  private cursor = new Graphics();
  private camPos = { x: 0, y: 0 };
  /** Milliseconds since the renderer started, for move animations. */
  private time = 0;
  private frame = 0;

  constructor(
    private app: Application,
    private sim: Simulation,
  ) {
    const { world } = sim;
    this.worldCanvas = document.createElement('canvas');
    this.worldCanvas.width = world.width;
    this.worldCanvas.height = world.height;
    this.worldCtx = this.worldCanvas.getContext('2d')!;
    this.worldImage = this.worldCtx.createImageData(world.width, world.height);
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) this.paintCell(x, y);
    }
    this.worldCtx.putImageData(this.worldImage, 0, 0);
    this.worldTexture = Texture.from(this.worldCanvas);
    this.worldTexture.source.scaleMode = 'nearest';

    this.scentCanvas = document.createElement('canvas');
    this.scentCanvas.width = world.width;
    this.scentCanvas.height = world.height;
    this.scentCtx = this.scentCanvas.getContext('2d')!;
    this.scentImage = this.scentCtx.createImageData(world.width, world.height);
    this.scentTexture = Texture.from(this.scentCanvas);
    this.scentTexture.source.scaleMode = 'nearest';
    this.scentSprite = new Sprite(this.scentTexture);
    this.scentSprite.visible = false;

    this.antFrames = makeAntFrames();
    this.gyneFrames = makeGyneFrames();
    this.spiderFrames = makeSpiderFrames();

    this.scenery = new Scenery(sim);
    this.camera.addChild(
      this.scenery.world,
      new Sprite(this.worldTexture),
      this.pantry,
      this.scentSprite,
      this.brood,
      this.cursor,
      this.enemyLayer,
      this.antLayer,
      this.bars,
    );
    app.stage.addChild(this.scenery.back, this.camera, this.scenery.front);
    this.resetView();
  }

  /** Frames the nest entrance and the ground below it, like a cut-away ant farm. */
  resetView(): void {
    const { screen } = this.app;
    this.zoom = Math.max(this.minZoom(), 2, Math.min(8, Math.min(screen.width / 170, screen.height / 110)));
    this.camPos = {
      x: this.sim.entranceX + 0.5,
      y: this.sim.world.surface[this.sim.entranceX] + screen.height / this.zoom / 2 - 34,
    };
  }

  zoomBy(factor: number, sx = this.app.screen.width / 2, sy = this.app.screen.height / 2): void {
    // Keep the cell under the pointer where it is.
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom(), this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.camPos.x += before.x - after.x;
    this.camPos.y += before.y - after.y;
    this.clampCamera();
  }

  /** Moves the camera by a drag of (dx, dy) screen pixels. */
  pan(dx: number, dy: number): void {
    this.camPos.x -= dx / this.zoom;
    this.camPos.y -= dy / this.zoom;
    this.clampCamera();
  }

  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.app.screen.width / 2) / this.zoom + this.camPos.x,
      y: (sy - this.app.screen.height / 2) / this.zoom + this.camPos.y,
    };
  }

  /** Never zoom out past the point where the world stops filling a tall phone screen. */
  private minZoom(): number {
    const { world } = this.sim;
    const span = world.height + 4 - (Math.min(...world.surface) - 70);
    return Math.max(MIN_ZOOM, this.app.screen.height / span);
  }

  private clampCamera(): void {
    if (this.zoom < this.minZoom()) this.zoom = this.minZoom();
    const { world } = this.sim;
    const halfW = this.app.screen.width / this.zoom / 2;
    const halfH = this.app.screen.height / this.zoom / 2;
    const top = Math.min(...world.surface) - 70;
    this.camPos.x = halfW * 2 >= world.width ? world.width / 2 : Math.max(halfW, Math.min(world.width - halfW, this.camPos.x));
    this.camPos.y = Math.max(top + halfH, Math.min(world.height - halfH + 4, this.camPos.y));
  }

  /** Screen pixel to world cell. */
  screenToCell(sx: number, sy: number): { x: number; y: number } {
    const p = this.camera.toLocal({ x: sx, y: sy });
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  private paintCell(x: number, y: number): void {
    if (!this.sim.world.inBounds(x, y)) return;
    const [r, g, b, a] = cellColor(this.sim.world, x, y);
    const i = (y * this.sim.world.width + x) * 4;
    const d = this.worldImage.data;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }

  render(dt: number, aimed: { x: number; y: number } | null): void {
    const { sim } = this;
    const { world, ants, enemies } = sim;
    this.time += dt;
    this.frame++;

    const changes = world.drainChanges();
    if (changes.length) {
      // Neighbours too: wall shading and rock rims depend on them.
      for (const i of changes) {
        const cx = i % world.width;
        const cy = Math.floor(i / world.width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.paintCell(cx + dx, cy + dy);
      }
      this.worldCtx.putImageData(this.worldImage, 0, 0);
      this.worldTexture.source.update();
    }
    // The guide pheromone shows even with the other scents hidden.
    const guide = sim.guideActive();
    this.scentSprite.visible = this.showScents || guide;
    if ((this.showScents || guide) && this.frame % SCENT_EVERY === 0) this.paintScents();

    this.bars.clear();
    while (this.antViews.length < ants.count) this.addAntView(this.antViews.length);
    for (let id = 0; id < ants.count; id++) this.updateAntView(id);
    while (this.enemyViews.length < enemies.count) this.addEnemyView();
    for (let id = 0; id < enemies.count; id++) this.updateEnemyView(id);
    this.drawBrood();

    // The camera follows the queen when the player controls her; otherwise it stays where it was put.
    const target = this.follow ? sim.player : this.watch;
    if (target >= 0 && ants.alive[target] && this.antViews[target]) {
      const player = this.antViews[target].pos;
      const kc = 1 - Math.exp(-dt / 120);
      this.camPos.x += (player.x - this.camPos.x) * kc;
      this.camPos.y += (player.y - this.camPos.y) * kc;
    }
    this.clampCamera();
    this.drawPantry();
    this.scenery.update(dt, this.camPos.x, this.camPos.y, this.zoom, this.app.screen.width, this.app.screen.height);
    this.camera.scale.set(this.zoom);
    this.camera.position.set(
      Math.round(this.app.screen.width / 2 - this.camPos.x * this.zoom),
      Math.round(this.app.screen.height / 2 - this.camPos.y * this.zoom),
    );

    this.drawCursor(aimed);
  }

  /** Food trails in green, alarm scent in red, the guide pheromone in violet. */
  private paintScents(): void {
    const { trail, alarm, guideTick, tick } = this.sim;
    const d = this.scentImage.data;
    const all = this.showScents;
    for (let i = 0; i < trail.length; i++) {
      const t = all ? trail[i] : 0;
      const a = all ? alarm[i] : 0;
      const o = i * 4;
      const age = tick - guideTick[i];
      if (age >= 0 && age < GUIDE_LIFE * 4) {
        // Guide pheromone in violet, brightest where it was drawn last.
        const g = Math.exp(-age / GUIDE_LIFE);
        d[o] = 190;
        d[o + 1] = 90;
        d[o + 2] = 255;
        d[o + 3] = Math.round(60 + 160 * g);
        continue;
      }
      if (t < 0.02 && a < 0.02) {
        d[o + 3] = 0;
        continue;
      }
      d[o] = Math.round(80 + 175 * a);
      d[o + 1] = Math.round(220 * t * (1 - a));
      d[o + 2] = 60;
      d[o + 3] = Math.round(Math.min(1, Math.max(t, a)) * 170);
    }
    this.scentCtx.putImageData(this.scentImage, 0, 0);
    this.scentTexture.source.update();
  }

  /** Starts or continues a constant-speed glide towards the creature's cell. */
  private glide(view: Glide, x: number, y: number, gen: number, stepMs: number): void {
    if (view.gen !== gen) {
      // A new creature in a reused slot: appear in place.
      view.gen = gen;
      view.cell = { x, y };
      view.pos = { x: x + 0.5, y: y + 0.5 };
      view.from = { ...view.pos };
      view.moveTime = 1;
    } else if (x !== view.cell.x || y !== view.cell.y) {
      const jump = Math.abs(x - view.cell.x) + Math.abs(y - view.cell.y) > 3;
      view.from = jump ? { x: x + 0.5, y: y + 0.5 } : { ...view.pos };
      view.cell = { x, y };
      view.moveStart = this.time;
      view.moveTime = stepMs;
    }
    const t = Math.min(1, (this.time - view.moveStart) / view.moveTime);
    view.pos.x = view.from.x + (view.cell.x + 0.5 - view.from.x) * t;
    view.pos.y = view.from.y + (view.cell.y + 0.5 - view.from.y) * t;
  }

  private addAntView(id: number): void {
    const sprite = new Sprite(this.antFrames[Caste.Worker][0]);
    sprite.anchor.set(0.5);
    const pellet = new Graphics();
    sprite.addChild(pellet);
    // The player's ant is drawn on top of the others.
    if (id === this.sim.player) this.antLayer.addChild(sprite);
    else this.antLayer.addChildAt(sprite, 0);
    const h = hash2(id, 7);
    this.antViews.push({
      sprite,
      pellet,
      carried: Item.None,
      pos: { x: 0, y: 0 },
      from: { x: 0, y: 0 },
      cell: { x: 0, y: 0 },
      moveStart: 0,
      moveTime: 1,
      gen: -1,
      offset: id === this.sim.player ? { x: 0, y: 0 } : { x: ((h & 255) / 255 - 0.5) * 0.6, y: (((h >> 8) & 255) / 255 - 0.5) * 0.3 },
      phase: ((h >> 16) & 255) / 40,
    });
  }

  private updateAntView(id: number): void {
    const { ants } = this.sim;
    const view = this.antViews[id];
    view.sprite.visible = ants.alive[id] === 1;
    if (!ants.alive[id]) return;
    const caste = ants.caste[id] as Caste;
    const ticks = CASTES[caste].stepTicks + (ants.carrying[id] ? 1 : 0);
    this.glide(view, ants.x[id], ants.y[id], ants.gen[id], ((ticks + 1) * 1000) / TICK_RATE);

    // Young queens still have their wings; the player's founding queen has shed hers.
    const frames = caste === Caste.Queen && id !== this.sim.player ? this.gyneFrames : this.antFrames[caste];
    view.sprite.texture = frames[(ants.steps[id] >> 1) % frames.length];
    this.orientAnt(id, view, CASTE_LOOKS[caste].scale);

    // Swarming: crowded ants jostle around their spot instead of sitting still.
    if (id !== this.sim.player) {
      const crowd = this.sim.antsAt(ants.x[id], ants.y[id]) > 1 ? 1 : 0.4;
      const t = this.time / 1000 + view.phase;
      view.sprite.x += view.offset.x + Math.sin(t * 9) * 0.06 * crowd;
      view.sprite.y += view.offset.y * crowd + Math.cos(t * 7) * 0.04 * crowd;
      view.sprite.rotation += Math.sin(t * 5) * 0.15 * crowd;
    }

    const carried = ants.carrying[id] as Item;
    if (carried !== view.carried) {
      view.carried = carried;
      view.pellet.clear();
      if (carried !== Item.None) {
        const color = PELLET_COLORS[carried];
        if (carried === Item.Brood || carried === Item.Corpse) {
          view.pellet.ellipse(ANT_W / 2 + 0.5, -ANT_H / 2 + 3, 2.2, 1.4).fill(color);
        } else {
          view.pellet.rect(ANT_W / 2 - 0.5, -ANT_H / 2 + 1.5, 3, 3).fill(color);
        }
      }
    }

    const max = CASTES[caste].maxHp;
    if (ants.hp[id] < max) this.drawBar(view.sprite.x, view.sprite.y - 0.8, ants.hp[id] / max, 1);
  }

  private addEnemyView(): void {
    const sprite = new Sprite(this.spiderFrames[0]);
    sprite.anchor.set(0.5, 0.7);
    this.enemyLayer.addChild(sprite);
    this.enemyViews.push({
      sprite,
      pos: { x: 0, y: 0 },
      from: { x: 0, y: 0 },
      cell: { x: 0, y: 0 },
      moveStart: 0,
      moveTime: 1,
      gen: -1,
    });
  }

  private updateEnemyView(id: number): void {
    const e = this.sim.enemies;
    const view = this.enemyViews[id];
    view.sprite.visible = e.alive[id] === 1;
    if (!e.alive[id]) return;
    const info = ENEMIES[e.kind[id] as EnemyKind];
    this.glide(view, e.x[id], e.y[id], e.gen[id], ((info.stepTicks + 1) * 1000) / TICK_RATE);
    view.sprite.texture = this.spiderFrames[(e.steps[id] >> 1) % this.spiderFrames.length];
    view.sprite.scale.set((e.facing[id] * 3) / SPIDER_W, 1.5 / SPIDER_H);
    view.sprite.position.set(view.pos.x, view.pos.y + 0.5);
    this.drawBar(view.pos.x, view.pos.y - 1.1, e.hp[id] / info.maxHp, 2);
  }

  private drawBar(cx: number, y: number, fraction: number, width: number): void {
    const f = Math.max(0, Math.min(1, fraction));
    this.bars.rect(cx - width / 2, y, width, 0.16).fill({ color: 0x000000, alpha: 0.6 });
    this.bars.rect(cx - width / 2, y, width * f, 0.16).fill(f > 0.5 ? 0x6bbf59 : f > 0.25 ? 0xe8b04a : 0xd0453a);
  }

  /** Legs toward whatever the ant is gripping: floor, ceiling or wall. */
  private orientAnt(id: number, view: AntView, scale: number): void {
    const { world, ants } = this.sim;
    const x = ants.x[id];
    const y = ants.y[id];
    let support: [number, number] = [0, 1];
    if (world.solidAt(x, y + 1)) support = [0, 1];
    else if (world.solidAt(x, y - 1)) support = [0, -1];
    else if (world.solidAt(x + 1, y)) support = [1, 0];
    else if (world.solidAt(x - 1, y)) support = [-1, 0];

    let forward: [number, number];
    if (support[0] === 0) forward = [ants.facing[id], 0];
    else forward = [0, ants.aimY[id] !== 0 ? ants.aimY[id] : -1];

    const rotation = Math.atan2(forward[1], forward[0]);
    const legsX = Math.round(-Math.sin(rotation));
    const legsY = Math.round(Math.cos(rotation));
    const flip = legsX === support[0] && legsY === support[1] ? 1 : -1;

    const s = view.sprite;
    s.rotation = rotation;
    s.scale.set((scale * ANT_LENGTH) / ANT_W, (flip * scale * ANT_LENGTH * 0.6) / ANT_H);
    // Sit on the gripped surface rather than float in the middle of the cell.
    const lift = 0.1 - (scale - 1) * 0.5;
    s.position.set(view.pos.x + support[0] * lift, view.pos.y + support[1] * lift);
  }

  /** The colony's food reserve, shown as a heap of seeds on the floor of the queen's chamber. */
  private drawPantry(): void {
    const g = this.pantry;
    if (this.frame % 15 !== 1) return;
    g.clear();
    const { sim } = this;
    const room = sim.chambers[2] ?? sim.chambers[0];
    if (!room) return;
    const floor = sim.chamberFloor(room);
    if (floor < 0) return;
    const fx = floor % sim.world.width;
    const fy = (floor - fx) / sim.world.width;
    const seeds = Math.min(80, sim.colony.food);
    for (let k = 0; k < seeds; k++) {
      const row = Math.floor(Math.sqrt(k));
      const col = k - row * row;
      const x = fx + (col - row) * 0.35 + ((k * 7) % 3) * 0.05;
      const y = fy + 0.85 - (Math.sqrt(seeds) - row) * 0.2;
      g.ellipse(x + 0.5, y, 0.22, 0.14).fill(k % 3 ? 0xd9ad52 : 0xc2913c);
    }
  }

  private drawBrood(): void {
    const b = this.sim.brood;
    const g = this.brood;
    g.clear();
    for (let i = 0; i < b.count; i++) {
      const cx = b.x[i] + 0.5;
      const bottom = b.y[i] + 1;
      const stage = b.stage[i] as Stage;
      // A bigger caste has a bigger egg, larva and cocoon.
      const size = b.caste[i] === Caste.Queen ? 1.3 : b.caste[i] === Caste.Soldier ? 1.15 : 1;
      if (stage === Stage.Egg) {
        g.ellipse(cx, bottom - 0.22 * size, 0.2 * size, 0.2 * size).fill(0xf4f0e2);
      } else if (stage === Stage.Larva) {
        g.ellipse(cx, bottom - 0.25 * size, 0.38 * size, 0.24 * size).fill(0xeee6cc);
        g.circle(cx + 0.28 * size, bottom - 0.3 * size, 0.06).fill(0x8a6a40);
      } else {
        g.ellipse(cx, bottom - 0.28 * size, 0.42 * size, 0.27 * size).fill(0xd9c08a);
        g.ellipse(cx, bottom - 0.28 * size, 0.42 * size, 0.27 * size).stroke({ width: 0.05, color: 0xa88850 });
      }
    }
  }

  private drawCursor(aimed: { x: number; y: number } | null): void {
    const g = this.cursor;
    g.clear();
    if (this.watch >= 0 && this.sim.ants.alive[this.watch] && this.antViews[this.watch]) {
      const p = this.antViews[this.watch].pos;
      g.circle(p.x, p.y, 2.2).stroke({ width: 0.25, color: 0xe8b04a, alpha: 0.95 });
    }
    if (!aimed || this.sim.gameOver) return;
    const { ants, world } = this.sim;
    const p = this.sim.player;
    const m = world.get(aimed.x, aimed.y);
    const carrying = ants.carrying[p] !== Item.None;
    const enemy = this.sim.enemyAt(aimed.x, aimed.y) >= 0;
    const usable = enemy || (carrying ? !world.solidAt(aimed.x, aimed.y) : MATERIALS[m].digTicks > 0);
    const color = enemy ? 0xe8b04a : usable ? 0xf3e9dc : 0xd0453a;
    g.rect(aimed.x + 0.05, aimed.y + 0.05, 0.9, 0.9).stroke({ width: 0.1, color, alpha: 0.9 });
    const digTicks = MATERIALS[m].digTicks;
    if (!carrying && digTicks > 0 && ants.digTarget[p] === world.index(aimed.x, aimed.y)) {
      const progress = ants.digProgress[p] / digTicks;
      g.rect(aimed.x, aimed.y + 1 - progress, 1, progress).fill({ color: 0x000000, alpha: 0.45 });
    }
  }
}
