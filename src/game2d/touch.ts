import { Caste, type Axis } from '../core';
import type { Controls } from './controls';

/** Fraction of the joystick radius the thumb must travel before it counts as a direction. */
const DEAD_ZONE = 0.35;

export interface TouchActions {
  toggleDisposal: () => void;
}

function button(label: string, className: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `touch-btn ${className}`;
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  return b;
}

/** Calls `fn` on a tap without letting the tap reach the game behind the button. */
function onTap(el: HTMLElement, fn: () => void): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  });
}

/** On-screen joystick and action buttons for phones and tablets, shown while the player controls the queen. */
export function mountTouchControls(root: HTMLElement, controls: Controls, actions: TouchActions): void {
  const ui = document.createElement('div');
  ui.id = 'touch';
  root.appendChild(ui);

  // Joystick: drag anywhere inside the pad to walk and aim in 8 directions.
  const pad = document.createElement('div');
  pad.className = 'joystick';
  const knob = document.createElement('div');
  knob.className = 'knob';
  pad.appendChild(knob);
  ui.appendChild(pad);
  let padPointer = -1;
  const moveKnob = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + radius)) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
    const axis = (v: number): Axis => (v > DEAD_ZONE ? 1 : v < -DEAD_ZONE ? -1 : 0);
    controls.touchAxis = { x: axis(dx), y: axis(dy) };
  };
  const releasePad = () => {
    padPointer = -1;
    knob.style.transform = '';
    controls.touchAxis = { x: 0, y: 0 };
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    padPointer = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    moveKnob(e);
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId === padPointer) moveKnob(e);
  });
  pad.addEventListener('pointerup', releasePad);
  pad.addEventListener('pointercancel', releasePad);

  // Action buttons on the right.
  const actionsBox = document.createElement('div');
  actionsBox.className = 'actions';
  ui.appendChild(actionsBox);

  const dig = button('Creuser', 'big', 'Creuser ou ramasser (maintenir)');
  dig.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dig.setPointerCapture(e.pointerId);
    controls.touchDig = true;
    dig.classList.add('held');
  });
  const stopDig = () => {
    controls.touchDig = false;
    dig.classList.remove('held');
  };
  dig.addEventListener('pointerup', stopDig);
  dig.addEventListener('pointercancel', stopDig);

  const drop = button('Déposer', '', 'Déposer ce que la fourmi porte');
  onTap(drop, () => controls.queueDrop());
  const eat = button('Manger', '', 'Manger la nourriture portée');
  onTap(eat, () => controls.queueEat());
  const lay = button('Pondre', '', 'Pondre un œuf');
  const soil = button('Terre', '', 'Changer ce que devient la terre creusée');
  onTap(soil, actions.toggleDisposal);
  actionsBox.append(lay, eat, drop, soil, dig);

  // Egg menu: one button per caste, with its food cost.
  const layMenu = document.createElement('div');
  layMenu.className = 'lay-menu';
  layMenu.hidden = true;
  const castes: Array<[Caste, string]> = [
    [Caste.Worker, 'Ouvrière · 1'],
    [Caste.Soldier, 'Soldat · 2'],
    [Caste.Queen, 'Reine · 4'],
    [Caste.Male, 'Mâle · 2'],
  ];
  for (const [caste, label] of castes) {
    const b = button(label, '', `Pondre un œuf : ${label}`);
    onTap(b, () => {
      controls.queueLay(caste);
      layMenu.hidden = true;
    });
    layMenu.appendChild(b);
  }
  ui.appendChild(layMenu);
  onTap(lay, () => (layMenu.hidden = !layMenu.hidden));
}

/** True on phones and tablets, where there is no keyboard or mouse. */
export function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}
