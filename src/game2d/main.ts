// Lets PixiJS run on pages with a strict Content Security Policy (no eval).
import 'pixi.js/unsafe-eval';
import { Application } from 'pixi.js';
import { Item, Simulation, TICK_RATE } from '../core';
import { Controls } from './controls';
import { Renderer } from './renderer';

const WORLD = { width: 320, height: 200 };
const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 5;

async function start() {
  const host = document.getElementById('game')!;
  const app = new Application();
  await app.init({ resizeTo: window, background: '#1a120c', antialias: false, roundPixels: true });
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
    sim = new Simulation({ seed, ...WORLD });
    const zoom = renderer.zoom;
    renderer = new Renderer(app, sim);
    renderer.zoom = zoom;
  };

  controls.onZoom = (f) => renderer.zoomBy(f);
  controls.onKey = (code) => {
    if (code === 'KeyP' || code === 'Escape') {
      paused = !paused;
      pausedLabel.hidden = !paused;
    } else if (code === 'KeyN') newWorld();
    else if (code === 'KeyH') help.hidden = !help.hidden;
  };

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
    status.textContent =
      `Porte : ${sim.ants.carrying[p] === Item.Soil ? 'une boulette de terre' : 'rien'}` +
      ` · Profondeur : ${depth}` +
      ` · Creusé : ${sim.stats.dug}` +
      ` · Graine : ${seed}`;
  });
}

start();
