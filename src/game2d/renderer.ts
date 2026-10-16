import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { Item, MATERIALS, type Simulation } from '../core';
import { ANT_H, ANT_W, makeAntFrames } from './antSprite';
import { cellColor } from './palette';

const MIN_ZOOM = 2;
const MAX_ZOOM = 32;

/** Draws the simulation as a side-view pixel ant farm. Reads the sim, never changes it. */
export class Renderer {
  readonly camera = new Container();
  zoom = 14;
  private worldCanvas: HTMLCanvasElement;
  private worldCtx: CanvasRenderingContext2D;
  private worldImage: ImageData;
  private worldTexture: Texture;
  private ant: Sprite;
  private antFrames: Texture[];
  private pellet = new Graphics();
  private cursor = new Graphics();
  private antPos = { x: 0, y: 0 };
  private camPos = { x: 0, y: 0 };

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
    this.ant = new Sprite(this.antFrames[0]);
    this.ant.anchor.set(0.5);
    this.ant.addChild(this.pellet);
    this.pellet.rect(ANT_W / 2 - 0.5, -ANT_H / 2 + 0.5, 3, 3).fill(0x8c6440);
    this.pellet.visible = false;

    this.camera.addChild(new Sprite(this.worldTexture), this.cursor, this.ant);
    app.stage.addChild(this.camera);

    const p = sim.player;
    this.antPos = { x: sim.ants.x[p] + 0.5, y: sim.ants.y[p] + 0.5 };
    this.camPos = { ...this.antPos };
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

    // Glide the ant between cells so cell-by-cell steps look smooth.
    const p = sim.player;
    const tx = ants.x[p] + 0.5;
    const ty = ants.y[p] + 0.5;
    const k = 1 - Math.exp(-dt / 50);
    this.antPos.x += (tx - this.antPos.x) * k;
    this.antPos.y += (ty - this.antPos.y) * k;
    if (Math.abs(tx - this.antPos.x) > 3 || Math.abs(ty - this.antPos.y) > 3) this.antPos = { x: tx, y: ty };
    this.orientAnt(p);
    this.ant.texture = this.antFrames[(ants.steps[p] >> 1) % this.antFrames.length];
    this.pellet.visible = ants.carrying[p] === Item.Soil;

    // Camera follows the ant.
    const kc = 1 - Math.exp(-dt / 160);
    this.camPos.x += (this.antPos.x - this.camPos.x) * kc;
    this.camPos.y += (this.antPos.y - this.camPos.y) * kc;
    this.camera.scale.set(this.zoom);
    this.camera.position.set(
      Math.round(this.app.screen.width / 2 - this.camPos.x * this.zoom),
      Math.round(this.app.screen.height / 2 - this.camPos.y * this.zoom),
    );

    this.drawCursor(aimed);
  }

  /** Legs toward whatever the ant is gripping: floor, ceiling or wall. */
  private orientAnt(id: number): void {
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

    this.ant.rotation = rotation;
    this.ant.scale.set(1 / (ANT_W / 2), flip / ANT_H);
    // Sit on the gripped surface rather than float in the middle of the cell.
    this.ant.position.set(this.antPos.x + support[0] * 0.1, this.antPos.y + support[1] * 0.1);
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
