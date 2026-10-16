import { Caste, type AntInput, type Axis } from '../core';

const LAY_KEYS: Record<string, Caste> = {
  Digit1: Caste.Worker,
  Digit2: Caste.Soldier,
  Digit3: Caste.Queen,
  Digit4: Caste.Male,
  Numpad1: Caste.Worker,
  Numpad2: Caste.Soldier,
  Numpad3: Caste.Queen,
  Numpad4: Caste.Male,
};

/**
 * Keyboard and mouse state, turned into one AntInput per simulation tick.
 * Keys use physical codes, so WASD is also ZQSD on an AZERTY keyboard.
 */
export class Controls {
  private keys = new Set<string>();
  private dropQueued = false;
  private eatQueued = false;
  private layQueued: Caste | null = null;
  mouseDown = false;
  /** On-screen joystick and buttons (phones and tablets). */
  touchAxis: { x: Axis; y: Axis } = { x: 0, y: 0 };
  touchDig = false;
  mouse: { x: number; y: number } | null = null;
  onKey: (code: string) => void = () => {};
  /** Zoom by `factor` around a screen point. */
  onZoom: (factor: number, x?: number, y?: number) => void = () => {};
  /** Drag to move the camera, in spectator mode. */
  onPan: (dx: number, dy: number) => void = () => {};
  /** True while the colony plays itself: the pointer moves the camera instead of digging. */
  spectator = true;
  private dragFrom: { x: number; y: number } | null = null;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat && e.code === 'KeyE') this.dropQueued = true;
      if (!e.repeat && e.code === 'KeyF') this.eatQueued = true;
      if (!e.repeat && e.code in LAY_KEYS) this.layQueued = LAY_KEYS[e.code];
      if (!e.repeat) this.onKey(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    // Two fingers on the game pinch-zoom; one finger or the mouse aims and digs.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const spread = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    target.addEventListener('pointermove', (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const d = spread();
        const [a, b] = [...touches.values()];
        if (pinch > 0) this.onZoom(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
        return;
      }
      if (this.spectator && this.dragFrom) {
        this.onPan(e.clientX - this.dragFrom.x, e.clientY - this.dragFrom.y);
        this.dragFrom = { x: e.clientX, y: e.clientY };
      }
      this.mouse = { x: e.clientX, y: e.clientY };
    });
    target.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.mouse = null;
    });
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.pointerType !== 'mouse') touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size >= 2) {
        this.mouseDown = false;
        this.dragFrom = null;
        pinch = spread();
        return;
      }
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.spectator) {
        this.dragFrom = { x: e.clientX, y: e.clientY };
        return;
      }
      this.mouseDown = true;
      this.dropQueued = true;
    });
    const release = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      this.dragFrom = null;
      if (touches.size < 2) pinch = 0;
      this.mouseDown = false;
      if (e.pointerType !== 'mouse') this.mouse = null;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
      },
      { passive: false },
    );
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  queueDrop(): void {
    this.dropQueued = true;
  }

  queueEat(): void {
    this.eatQueued = true;
  }

  queueLay(caste: Caste): void {
    this.layQueued = caste;
  }

  private axis(neg: string[], pos: string[]): Axis {
    const n = neg.some((k) => this.keys.has(k));
    const p = pos.some((k) => this.keys.has(k));
    return n === p ? 0 : n ? -1 : 1;
  }

  /** Arrow keys and WASD/ZQSD, plus the on-screen joystick, as a direction. */
  direction(): { x: Axis; y: Axis } {
    return {
      x: this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) || this.touchAxis.x,
      y: this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']) || this.touchAxis.y,
    };
  }

  /** Builds this tick's input. `mouseCell` is the world cell under the pointer. */
  sample(mouseCell: { x: number; y: number } | null): AntInput {
    const input: AntInput = {
      moveX: this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']) || this.touchAxis.x,
      moveY: this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']) || this.touchAxis.y,
      dig: this.keys.has('Space') || this.mouseDown || this.touchDig,
      drop: this.dropQueued,
      eat: this.eatQueued,
      lay: this.layQueued,
      target: mouseCell,
    };
    this.dropQueued = false;
    this.eatQueued = false;
    this.layQueued = null;
    return input;
  }
}
