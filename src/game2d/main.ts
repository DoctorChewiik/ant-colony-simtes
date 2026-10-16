// Lets PixiJS run on pages with a strict Content Security Policy (no eval).
import 'pixi.js/unsafe-eval';
import { Application } from 'pixi.js';
import { Caste, DigDisposal, Item, Simulation, Stage, TICK_RATE, Task } from '../core';
import { Controls } from './controls';
import { Renderer } from './renderer';
import { isTouchDevice, mountTouchControls } from './touch';

const WORLD = { width: 320, height: 200 };
const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;

const DISPOSAL_NAMES: Record<DigDisposal, string> = {
  [DigDisposal.Surface]: 'remonte à la surface',
  [DigDisposal.Vanish]: 'disparaît',
  [DigDisposal.Carry]: 'à porter soi-même',
};

const CARRIED_NAMES: Record<Item, string> = {
  [Item.None]: 'rien',
  [Item.Soil]: 'une boulette de terre',
  [Item.Food]: 'de la nourriture',
};

async function start() {
  const host = document.getElementById('game')!;
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#1a120c',
    antialias: false,
    roundPixels: true,
    // Sharp pixels on high-density phone screens, capped to stay fast.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  host.appendChild(app.canvas);

  const controls = new Controls(app.canvas);
  const status = document.getElementById('status')!;
  const help = document.getElementById('help')!;
  const pausedLabel = document.getElementById('paused')!;

  let seed = Number(new URLSearchParams(location.search).get('seed')) || Math.floor(Math.random() * 1e9);
  let sim = new Simulation({ seed, ...WORLD });
  let renderer = new Renderer(app, sim);
  let paused = false;
  let acc = 0;

  const newWorld = () => {
    app.stage.removeChildren();
    seed = Math.floor(Math.random() * 1e9);
    const disposal = sim.digDisposal;
    sim = new Simulation({ seed, ...WORLD });
    sim.digDisposal = disposal;
    const zoom = renderer.zoom;
    renderer = new Renderer(app, sim);
    renderer.zoom = zoom;
  };

  const togglePause = () => {
    paused = !paused;
    pausedLabel.hidden = !paused;
  };
  const toggleDisposal = () => (sim.digDisposal = (sim.digDisposal + 1) % 3);
  const toggleHelp = () => (help.hidden = !help.hidden);
  const toggleScents = () => (renderer.showScents = !renderer.showScents);

  controls.onZoom = (f) => renderer.zoomBy(f);
  controls.onKey = (code) => {
    if (code === 'KeyP' || code === 'Escape') togglePause();
    else if (code === 'KeyN') newWorld();
    else if (code === 'KeyT') toggleDisposal();
    else if (code === 'KeyH') toggleHelp();
    else if (code === 'KeyV') toggleScents();
  };

  if (isTouchDevice()) {
    document.body.classList.add('touch');
    help.hidden = true;
    mountTouchControls(document.getElementById('hud')!, controls, {
      toggleDisposal,
      togglePause,
      toggleHelp,
      toggleScents,
      zoom: (f) => renderer.zoomBy(f),
    });
  }
  let lastStatus = '';

  // `?debug` exposes the simulation in the browser console, for testing scenes by hand.
  if (new URLSearchParams(location.search).has('debug')) {
    (window as unknown as { fourmiliere: unknown }).fourmiliere = { get sim() { return sim; } };
  }

  const mouseCell = () => (controls.mouse ? renderer.screenToCell(controls.mouse.x, controls.mouse.y) : null);

  app.ticker.add((ticker) => {
    if (!paused) {
      acc += ticker.deltaMS;
      let steps = 0;
      while (acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
        sim.step(controls.sample(mouseCell()));
        acc -= TICK_MS;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    }

    // Highlight the cell the ant would dig or drop into.
    const p = sim.player;
    const hover = mouseCell();
    const near =
      hover && Math.max(Math.abs(hover.x - sim.ants.x[p]), Math.abs(hover.y - sim.ants.y[p])) === 1;
    const aimed = near ? hover : { x: sim.ants.x[p] + sim.ants.aimX[p], y: sim.ants.y[p] + sim.ants.aimY[p] };
    renderer.render(ticker.deltaMS, aimed);

    const depth = Math.max(0, sim.ants.y[p] - sim.world.surface[sim.ants.x[p]]);
    const castes = [0, 0, 0, 0];
    const tasks = [0, 0, 0, 0, 0];
    for (let i = 0; i < sim.ants.count; i++) {
      if (!sim.ants.alive[i] || i === p) continue;
      castes[sim.ants.caste[i]]++;
      tasks[sim.ants.task[i]]++;
    }
    const stages = [0, 0, 0];
    for (let i = 0; i < sim.brood.count; i++) stages[sim.brood.stage[i]]++;
    const spiders = sim.enemies.living;
    const text = [
      sim.gameOver
        ? '<b class="alert">La reine est morte. Appuie sur N pour une nouvelle colonie.</b>'
        : sim.alarmActive()
          ? `<b class="alert">Alerte ! La colonie se défend${spiders ? ` (${spiders} araignée${spiders > 1 ? 's' : ''})` : ''}</b>`
          : spiders
            ? `${spiders} araignée${spiders > 1 ? 's' : ''} dans les environs`
            : '',
      `<b>Réserve de nourriture : ${sim.colony.food}</b> · Porte : ${CARRIED_NAMES[sim.ants.carrying[p] as Item]}`,
      `Colonie : ${castes[Caste.Worker]} ouvrières · ${castes[Caste.Soldier]} soldats · ` +
        `${castes[Caste.Queen]} reines · ${castes[Caste.Male]} mâles`,
      `Au travail : ${tasks[Task.Forage]} fourragent · ${tasks[Task.Dig]} creusent · ` +
        `${tasks[Task.Nurse]} soignent · ${tasks[Task.Guard]} gardent`,
      `Couvain : ${stages[Stage.Egg]} œufs · ${stages[Stage.Larva]} larves · ${stages[Stage.Pupa]} nymphes`,
      `Terre creusée : ${DISPOSAL_NAMES[sim.digDisposal]} · Profondeur : ${depth} · Graine : ${seed}`,
    ]
      .filter(Boolean)
      .join('<br>');
    // Only touch the page when the numbers change; rewriting it every frame costs smoothness.
    if (text !== lastStatus) {
      status.innerHTML = text;
      lastStatus = text;
    }
  });
}

start();
