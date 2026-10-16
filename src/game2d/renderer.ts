import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { CASTES, Caste, Item, MATERIALS, Stage, TICK_RATE, type Simulation } from '../core';
import { ANT_H, ANT_W, CASTE_LOOKS, makeAntFrames } from './antSprite';
import { cellColor } from './palette';

const MIN_ZOOM = 2;
const MAX_ZOOM = 32;

interface AntView {
  sprite: Sprite;
  pellet: Graphics;
  /** Where the ant is drawn, gliding from `from` to its current cell. */
  pos: { x: number; y: number };
  from: { x: number; y: number };
  cell: { x: number; y: number };
  moveStart: number;
  moveTime: number;
  carried: Item;
}

/** Draws the simulation as a side-view pixel ant farm. Reads the sim, never changes it. */
export class Renderer {
  readonly camera = new Container();
  zoom = 14;
  private worldCanvas: HTMLCanvasElement;
  private worldCtx: CanvasRenderingContext2D;
  private worldImage: ImageData;
  private worldTexture: Texture;
  private antFrames: Record<Caste, Texture[]>;
  private antLayer = new Container();
  private antViews: AntView[] = [];
  private brood = new Graphics();
  private cursor = new Graphics();
  private camPos = { x: 0, y: 0 };
  /** Milliseconds since the renderer started, for move animations. */
  private time = 0;

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
    this.antFrames = makeAntFrames();

    this.camera.addChild(new Sprite(this.worldTexture), this.brood, this.cursor, this.antLayer);
    app.stage.addChild(this.camera);

    const p = sim.player;
    this.camPos = { x: sim.ants.x[p] + 0.5, y: sim.ants.y[p] + 0.5 };
  }

  zoomBy(factor: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
  }

  /** Screen pixel to world cell. */
  screenToCell(sx: number, sy: number): { x: number; y: number } {
    const p = this.camera.toLocal({ x: sx, y: sy });
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  private paintCell(x: number, y: number): void {
    const [r, g, b] = cellColor(this.sim.world, x, y);
    const i = (y * this.sim.world.width + x) * 4;
    const d = this.worldImage.data;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }

  render(dt: number, aimed: { x: number; y: number } | null): void {
    const { sim } = this;
    const { world, ants } = sim;

    const changes = world.drainChanges();
    if (changes.length) {
      for (const i of changes) this.paintCell(i % world.width, Math.floor(i / world.width));
      this.worldCtx.putImageData(this.worldImage, 0, 0);
      this.worldTexture.source.update();
    }

    this.time += dt;
    while (this.antViews.length < ants.count) this.addAntView(this.antViews.length);
    for (let id = 0; id < ants.count; id++) this.updateAntView(id);
    this.drawBrood();

    // Camera follows the player's ant.
    const player = this.antViews[sim.player].pos;
    const kc = 1 - Math.exp(-dt / 120);
    this.camPos.x += (player.x - this.camPos.x) * kc;
    this.camPos.y += (player.y - this.camPos.y) * kc;
    this.camera.scale.set(this.zoom);
    this.camera.position.set(
      Math.round(this.app.screen.width / 2 - this.camPos.x * this.zoom),
      Math.round(this.app.screen.height / 2 - this.camPos.y * this.zoom),
    );

    this.drawCursor(aimed);
  }

  private addAntView(id: number): void {
    const { ants } = this.sim;
    const sprite = new Sprite(this.antFrames[ants.caste[id] as Caste][0]);
    sprite.anchor.set(0.5);
    const pellet = new Graphics();
    sprite.addChild(pellet);
    // The player's ant is drawn on top of the others.
    if (id === this.sim.player) this.antLayer.addChild(sprite);
    else this.antLayer.addChildAt(sprite, 0);
    const at = { x: ants.x[id] + 0.5, y: ants.y[id] + 0.5 };
    this.antViews.push({
      sprite,
      pellet,
      pos: { ...at },
      from: { ...at },
      cell: { x: ants.x[id], y: ants.y[id] },
      moveStart: this.time,
      moveTime: 1,
      carried: Item.None,
    });
  }

  private updateAntView(id: number): void {
    const { ants } = this.sim;
    const view = this.antViews[id];
    const caste = ants.caste[id] as Caste;

    // Glide at constant speed from the last cell to the new one, timed to the
    // ant's step rate, so a walking ant moves continuously instead of hopping.
    if (ants.x[id] !== view.cell.x || ants.y[id] !== view.cell.y) {
      const jump = Math.abs(ants.x[id] - view.cell.x) + Math.abs(ants.y[id] - view.cell.y) > 3;
      view.from = jump ? { x: ants.x[id] + 0.5, y: ants.y[id] + 0.5 } : { ...view.pos };
      view.cell = { x: ants.x[id], y: ants.y[id] };
      view.moveStart = this.time;
      const ticks = CASTES[caste].stepTicks + (ants.carrying[id] ? 1 : 0);
      view.moveTime = ((ticks + 1) * 1000) / TICK_RATE;
    }
    const t = Math.min(1, (this.time - view.moveStart) / view.moveTime);
    view.pos.x = view.from.x + (view.cell.x + 0.5 - view.from.x) * t;
    view.pos.y = view.from.y + (view.cell.y + 0.5 - view.from.y) * t;

    const frames = this.antFrames[caste];
    view.sprite.texture = frames[(ants.steps[id] >> 1) % frames.length];
    this.orientAnt(id, view, CASTE_LOOKS[caste].scale);

    const carried = ants.carrying[id] as Item;
    if (carried !== view.carried) {
      view.carried = carried;
      view.pellet.clear();
      if (carried !== Item.None) {
        view.pellet
          .rect(ANT_W / 2 - 0.5, -ANT_H / 2 + 1.5, 3, 3)
          .fill(carried === Item.Food ? 0xd6aa48 : 0x8c6440);
      }
    }
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
    s.scale.set(scale / (ANT_W / 2), (flip * scale) / ANT_H);
    // Sit on the gripped surface rather than float in the middle of the cell.
    const lift = 0.1 - (scale - 1) * 0.5;
    s.position.set(view.pos.x + support[0] * lift, view.pos.y + support[1] * lift);
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
    if (!aimed) return;
    const { ants, world } = this.sim;
    const p = this.sim.player;
    const m = world.get(aimed.x, aimed.y);
    const carrying = ants.carrying[p] !== Item.None;
    const usable = carrying ? !world.solidAt(aimed.x, aimed.y) : MATERIALS[m].digTicks > 0;
    const color = usable ? 0xf3e9dc : 0xd0453a;
    g.rect(aimed.x + 0.05, aimed.y + 0.05, 0.9, 0.9).stroke({ width: 0.1, color, alpha: 0.9 });
    const digTicks = MATERIALS[m].digTicks;
    if (!carrying && digTicks > 0 && ants.digTarget[p] === world.index(aimed.x, aimed.y)) {
      const progress = ants.digProgress[p] / digTicks;
      g.rect(aimed.x, aimed.y + 1 - progress, 1, progress).fill({ color: 0x000000, alpha: 0.45 });
    }
  }
}
