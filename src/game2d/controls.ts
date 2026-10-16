import type { AntInput, Axis } from '../core';

/**
 * Keyboard and mouse state, turned into one AntInput per simulation tick.
 * Keys use physical codes, so WASD is also ZQSD on an AZERTY keyboard.
 */
export class Controls {
  private keys = new Set<string>();
  private dropQueued = false;
  mouseDown = false;
  mouse: { x: number; y: number } | null = null;
  onKey: (code: string) => void = () => {};
  onZoom: (factor: number) => void = () => {};

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat && (e.code === 'Space' || e.code === 'KeyE')) this.dropQueued = true;
      if (!e.repeat) this.onKey(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    target.addEventListener('pointermove', (e) => (this.mouse = { x: e.clientX, y: e.clientY }));
    target.addEventListener('pointerleave', () => (this.mouse = null));
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.mouse = { x: e.clientX, y: e.clientY };
      this.mouseDown = true;
      this.dropQueued = true;
    });
    window.addEventListener('pointerup', () => (this.mouseDown = false));
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.onZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false },
    );
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private axis(neg: string[], pos: string[]): Axis {
    const n = neg.some((k) => this.keys.has(k));
    const p = pos.some((k) => this.keys.has(k));
    return n === p ? 0 : n ? -1 : 1;
  }

  /** Builds this tick's input. `mouseCell` is the world cell under the pointer. */
  sample(mouseCell: { x: number; y: number } | null): AntInput {
    const input: AntInput = {
      moveX: this.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']),
      moveY: this.axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
      dig: this.keys.has('Space') || this.mouseDown,
      drop: this.dropQueued,
      target: mouseCell,
    };
    this.dropQueued = false;
    return input;
  }
}
