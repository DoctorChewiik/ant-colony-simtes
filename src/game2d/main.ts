// Lets PixiJS run on pages with a strict Content Security Policy (no eval).
import 'pixi.js/unsafe-eval';
import { Application } from 'pixi.js';
import {
  Caste,
  DigDisposal,
  HUNGRY,
  Item,
  Season,
  Simulation,
  Stage,
  TICK_RATE,
  Task,
  thinkQueen,
} from '../core';
import { Controls } from './controls';
import { NeuroAnt } from './neuro';
import { Renderer } from './renderer';
import { isTouchDevice, mountTouchControls } from './touch';

const WORLD = { width: 400, height: 260 };
const TICK_MS = 1000 / TICK_RATE;
const MAX_STEPS_PER_FRAME = 20;
const SPEEDS = [1, 2, 4, 8];
/** Camera speed with the arrow keys, in screen pixels per second. */
const PAN_SPEED = 700;

const DISPOSAL_NAMES: Record<DigDisposal, string> = {
  [DigDisposal.Surface]: 'remonte à la surface',
  [DigDisposal.Vanish]: 'disparaît',
  [DigDisposal.Carry]: 'à porter soi-même',
};

const CARRIED_NAMES: Record<Item, string> = {
  [Item.None]: 'rien',
  [Item.Soil]: 'une boulette de terre',
  [Item.Food]: 'de la nourriture',
  [Item.Corpse]: 'une fourmi morte',
  [Item.Brood]: 'du couvain',
};

const SEASON_NAMES: Record<Season, string> = {
  [Season.Spring]: 'Printemps',
  [Season.Summer]: 'Été',
  [Season.Autumn]: 'Automne',
  [Season.Winter]: 'Hiver',
};

function phaseName(t: number): string {
  if (t < 0.06 || t > 0.94) return 'aube';
  if (t < 0.64) return 'jour';
  if (t < 0.74) return 'crépuscule';
  return 'nuit';
}

type Tool = 'none' | 'hand' | 'water' | 'neuro';
const TOOL_ICONS: Record<Tool, string> = { none: '', hand: ' ✋', water: ' 💧', neuro: ' 🧠' };
const BRUSHES = [
  { label: 'Petit', radius: 0.6 },
  { label: 'Moyen', radius: 1.6 },
  { label: 'Gros', radius: 3.2 },
];

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function makeButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tool';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

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
  const when = document.getElementById('when')!;
  const headline = document.getElementById('headline')!;
  const alerts = document.getElementById('alerts')!;
  const details = document.getElementById('details')!;
  const help = document.getElementById('help')!;
  const pausedLabel = document.getElementById('paused')!;
  const toolbar = document.getElementById('toolbar')!;
  const toolsPanel = document.getElementById('tools')!;
  const neuroPanel = document.getElementById('neuro')!;
  const neuroTitle = document.getElementById('neuro-title')!;
  const neuroDoing = document.getElementById('neuro-doing')!;
  const neuroCanvas = document.getElementById('neuro-canvas') as HTMLCanvasElement;
  const neuroCtx = neuroCanvas.getContext('2d')!;
  const neuro = new NeuroAnt();

  let seed = Number(new URLSearchParams(location.search).get('seed')) || Math.floor(Math.random() * 1e9);
  let sim = new Simulation({ seed, ...WORLD });
  let renderer = new Renderer(app, sim);
  let paused = false;
  let speed = 0;
  let controlling = false;
  let acc = 0;
  let tool: Tool = 'none';
  let brush = 1;
  let pourAcc = 0;
  let wasPainting = false;

  const setControlling = (on: boolean) => {
    controlling = on && !sim.gameOver;
    controls.spectator = !controlling;
    renderer.follow = controlling;
    document.body.classList.toggle('controlling', controlling);
    queenButton.classList.toggle('on', controlling);
  };

  const newWorld = () => {
    app.stage.removeChildren();
    sim.dropHeld();
    watchAnt(-1);
    seed = Math.floor(Math.random() * 1e9);
    const disposal = sim.digDisposal;
    sim = new Simulation({ seed, ...WORLD });
    sim.digDisposal = disposal;
    renderer = new Renderer(app, sim);
    setControlling(false);
  };

  const togglePause = () => {
    paused = !paused;
    pausedLabel.hidden = !paused;
    pauseButton.classList.toggle('on', paused);
  };
  const cycleSpeed = () => {
    speed = (speed + 1) % SPEEDS.length;
    speedButton.textContent = `×${SPEEDS[speed]}`;
  };
  const toggleDisposal = () => (sim.digDisposal = (sim.digDisposal + 1) % 3);
  const toggleHelp = () => (help.hidden = !help.hidden);
  const toggleDetails = () => (details.hidden = !details.hidden);
  const toggleScents = () => {
    renderer.showScents = !renderer.showScents;
    scentButton.classList.toggle('on', renderer.showScents);
  };

  /** Opens the neuro panel on an ant (or closes it with -1) and keeps the camera on it. */
  const watchAnt = (id: number) => {
    neuro.select(sim, id);
    renderer.watch = id;
    neuroPanel.hidden = id < 0;
  };
  document.getElementById('neuro-close')!.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    watchAnt(-1);
  });
  const nearestAnt = (x: number, y: number, reach = 4): number => {
    const a = sim.ants;
    let best = -1;
    let bestD = reach + 0.5;
    for (let i = 0; i < a.count; i++) {
      if (!a.alive[i]) continue;
      const d = Math.hypot(a.x[i] - x, a.y[i] - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const brushButtons: HTMLButtonElement[] = [];
  const setTool = (t: Tool) => {
    sim.dropHeld();
    tool = t;
    controls.toolActive = t !== 'none';
    menuButton.textContent = '☰' + TOOL_ICONS[t];
    menuButton.classList.toggle('on', t !== 'none');
    for (const [k, b] of toolButtons) b.classList.toggle('on', k === t);
    app.canvas.style.cursor = t === 'hand' ? 'grab' : t === 'water' || t === 'neuro' ? 'crosshair' : '';
  };
  const setBrush = (k: number) => {
    brush = k;
    brushButtons.forEach((b, i) => b.classList.toggle('on', i === k));
  };
  const toggleMenu = () => (toolsPanel.hidden = !toolsPanel.hidden);
  const pickTool = (t: Tool) => {
    setTool(tool === t ? 'none' : t);
    // Close the menu so the whole screen is free to pour or grab.
    toolsPanel.hidden = true;
  };
  const toolList = document.getElementById('tool-list')!;
  for (const [t, label, title] of [
    ['hand', '✋ Main', 'Attraper et lâcher les fourmis et les blocs'],
    ['water', '💧 Eau', "Verser de l'eau"],
    ['neuro', '🧠 Neuro', 'Voir les pattes et le cerveau d\'une fourmi'],
    ['none', 'Aucun', 'Déplacer la vue'],
  ] as [Tool, string, string][]) {
    const b = makeButton(label, title, () => pickTool(t));
    toolButtons.set(t, b);
    toolList.append(b);
  }
  const sizeList = document.getElementById('size-list')!;
  BRUSHES.forEach((br, k) => {
    const b = makeButton(br.label, `Taille du jet d'eau : ${br.label.toLowerCase()}`, () => setBrush(k));
    brushButtons.push(b);
    sizeList.append(b);
  });
  document.getElementById('tool-actions')!.append(makeButton("Vider l'eau", "Retirer toute l'eau", () => sim.water.clear()));

  const menuButton = makeButton('☰', 'Outils : main, eau', toggleMenu);
  const pauseButton = makeButton('II', 'Pause', togglePause);
  const speedButton = makeButton('×1', 'Vitesse du temps', cycleSpeed);
  const queenButton = makeButton('Reine', 'Prendre la reine en main', () => setControlling(!controlling));
  const scentButton = makeButton('Odeurs', 'Voir les phéromones', toggleScents);
  toolbar.append(
    menuButton,
    pauseButton,
    speedButton,
    queenButton,
    scentButton,
    makeButton('Infos', 'Détails de la colonie', toggleDetails),
    makeButton('+', 'Zoomer', () => renderer.zoomBy(1.25)),
    makeButton('−', 'Dézoomer', () => renderer.zoomBy(0.8)),
    makeButton('?', 'Aide', toggleHelp),
  );

  controls.onZoom = (f, x, y) => renderer.zoomBy(f, x, y);
  controls.onPan = (dx, dy) => renderer.pan(dx, dy);
  controls.onKey = (code) => {
    if (code === 'KeyP' || code === 'Escape') togglePause();
    else if (code === 'KeyN') newWorld();
    else if (code === 'KeyT') toggleDisposal();
    else if (code === 'KeyH') toggleHelp();
    else if (code === 'KeyV') toggleScents();
    else if (code === 'KeyI') toggleDetails();
    else if (code === 'KeyX') cycleSpeed();
    else if (code === 'KeyC') setControlling(!controlling);
    else if (code === 'KeyR') renderer.resetView();
    else if (code === 'KeyB') toggleMenu();
  };

  setBrush(brush);

  if (isTouchDevice()) {
    document.body.classList.add('touch');
    mountTouchControls(document.getElementById('hud')!, controls, { toggleDisposal });
  }
  let lastHud = '';

  // `?debug` exposes the simulation in the browser console, for testing scenes by hand.
  if (new URLSearchParams(location.search).has('debug')) {
    (window as unknown as { fourmiliere: unknown }).fourmiliere = {
      get sim() {
        return sim;
      },
      get renderer() {
        return renderer;
      },
      /** Runs the colony forward by `ticks` without drawing. */
      advance(ticks: number) {
        for (let t = 0; t < ticks; t++) sim.step(thinkQueen(sim));
      },
    };
  }

  const mouseCell = () => (controls.mouse ? renderer.screenToCell(controls.mouse.x, controls.mouse.y) : null);

  app.ticker.add((ticker) => {
    if (!paused) {
      acc += ticker.deltaMS * SPEEDS[speed];
      let steps = 0;
      while (acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
        const input = controls.sample(mouseCell());
        sim.step(controlling ? input : thinkQueen(sim));
        acc -= TICK_MS;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;
    }
    if (controlling && sim.gameOver) setControlling(false);

    // Tools from the menu act on the cell under the pointer.
    const cell = controls.painting ? mouseCell() : null;
    const tap = controls.toolTap ? renderer.screenToCell(controls.toolTap.x, controls.toolTap.y) : null;
    controls.toolTap = null;
    if (tool === 'water' && tap && !cell) sim.pourWater(tap.x, tap.y, BRUSHES[brush].radius);
    if (tool === 'water' && cell) {
      pourAcc += ticker.deltaMS;
      for (; pourAcc >= TICK_MS; pourAcc -= TICK_MS) sim.pourWater(cell.x, cell.y, BRUSHES[brush].radius);
    }
    if (tool === 'hand') {
      if (cell && !wasPainting) sim.grab(cell.x, cell.y);
      else if (cell) sim.moveHeld(cell.x, cell.y);
      else if (!controls.painting && wasPainting) sim.dropHeld();
      app.canvas.style.cursor = controls.painting && (sim.held >= 0 || sim.heldCell >= 0) ? 'grabbing' : 'grab';
    }
    if (tool === 'neuro' && tap) {
      const id = nearestAnt(tap.x, tap.y);
      if (id >= 0) watchAnt(id);
    }
    wasPainting = controls.painting;

    // The ant under the neuro lens: CPG and brain step with the game clock.
    if (!neuroPanel.hidden) {
      if (!neuro.valid(sim)) watchAnt(-1);
      else {
        neuro.update(sim, paused ? 0 : ticker.deltaMS * SPEEDS[speed]);
        const w = neuroCanvas.clientWidth;
        const h = neuroCanvas.clientHeight;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (neuroCanvas.width !== Math.round(w * dpr)) {
          neuroCanvas.width = Math.round(w * dpr);
          neuroCanvas.height = Math.round(h * dpr);
        }
        neuroCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        neuro.draw(neuroCtx, w, h, sim);
        const words = neuro.describe(sim);
        neuroTitle.textContent = `🧠 ${words.title}`;
        neuroDoing.textContent = `Elle ${words.doing}.`;
      }
    }

    if (!controlling) {
      const d = controls.direction();
      if (d.x || d.y) renderer.pan((-d.x * PAN_SPEED * ticker.deltaMS) / 1000, (-d.y * PAN_SPEED * ticker.deltaMS) / 1000);
    }

    // Highlight the cell the queen would dig or drop into.
    const p = sim.player;
    let aimed: { x: number; y: number } | null = null;
    if (controlling) {
      const hover = mouseCell();
      const near = hover && Math.max(Math.abs(hover.x - sim.ants.x[p]), Math.abs(hover.y - sim.ants.y[p])) === 1;
      aimed = near ? hover : { x: sim.ants.x[p] + sim.ants.aimX[p], y: sim.ants.y[p] + sim.ants.aimY[p] };
    }
    renderer.render(ticker.deltaMS, aimed);
    updateHud();
  });

  function specialistLine(): string {
    const sp = sim.specialists();
    return `Spécialistes : ${sp.forage} fourrageuses · ${sp.dig} terrassières · ${sp.nurse} nourrices · ${sp.generalist} polyvalentes`;
  }

  function updateHud() {
    const a = sim.ants;
    const p = sim.player;
    const castes = [0, 0, 0, 0];
    const tasks = [0, 0, 0, 0, 0];
    const stages = [0, 0, 0];
    let hungry = 0;
    let living = 0;
    for (let i = 0; i < a.count; i++) {
      if (!a.alive[i]) continue;
      living++;
      if (i === p) continue;
      castes[a.caste[i]]++;
      if (a.caste[i] === Caste.Worker) tasks[a.task[i]]++;
      if (a.energy[i] < HUNGRY) hungry++;
      if (a.carrying[i] === Item.Brood) stages[a.broodStage[i]]++;
    }
    for (let i = 0; i < sim.brood.count; i++) stages[sim.brood.stage[i]]++;
    const brood = stages[0] + stages[1] + stages[2];
    const alates = castes[Caste.Queen] + castes[Caste.Male];
    const spiders = sim.enemies.living;
    const s = sim.stats;

    const whenText = `Jour ${sim.day()} · ${SEASON_NAMES[sim.season()]} · ${phaseName(sim.timeOfDay())}${sim.raining() ? ' · pluie' : ''}`;
    const headText = `${plural(living, 'fourmi', 'fourmis')} · ${brood} couvain · ${Math.round(sim.nestProgress() * 100)} % nid`;
    const founding = sim.chambers[0] && sim.chamberFloor(sim.chambers[0]) < 0 && living === 1;
    const alertText = [
      sim.gameOver
        ? '<b class="alert">La reine est morte. N pour une nouvelle colonie.</b>'
        : sim.alarmActive()
          ? `<b class="alert">Alerte ! La colonie se défend${spiders ? ` (${plural(spiders, 'araignée', 'araignées')})` : ''}</b>`
          : '',
      founding ? 'La reine creuse sa première chambre.' : '',
      sim.flightActive() && alates ? '<b>Vol nuptial : les reines et les mâles ailés s\'envolent</b>' : '',
      sim.colony.food === 0 && hungry ? `<b class="alert">Réserve vide : ${hungry} fourmis ont faim</b>` : '',
      sim.season() === Season.Winter ? 'Hiver : la colonie hiberne, la reine ne pond plus.' : '',
      controlling ? `Tu diriges la reine · elle porte ${CARRIED_NAMES[a.carrying[p] as Item]}` : '',
    ]
      .filter(Boolean)
      .join('<br>');
    const detailText = details.hidden
      ? ''
      : [
          `<b>Réserve de nourriture : ${sim.colony.food}</b>`,
          `${castes[Caste.Worker]} ouvrières · ${castes[Caste.Soldier]} soldats · ${castes[Caste.Queen]} reines ailées · ${castes[Caste.Male]} mâles`,
          `Ouvrières : ${tasks[Task.Nurse]} nourrices · ${tasks[Task.Dig]} terrassières · ${tasks[Task.Forage]} fourrageuses`,
          specialistLine(),
          `Couvain : ${stages[Stage.Egg]} œufs · ${stages[Stage.Larva]} larves · ${stages[Stage.Pupa]} nymphes`,
          `Nid : ${sim.chambers.filter((c) => sim.chamberFloor(c) >= 0).length}/${sim.chambers.length} chambres · ${sim.plan.filter((n) => n.room).length} prévues au total`,
          `Morts : ${s.antsLost} (${s.buried} au cimetière, ${s.starved} de faim, ${s.diedOfAge} de vieillesse, ${s.drowned} noyées, ${s.fell} de chute) · Envolés : ${s.flown}`,
          `Araignées tuées : ${s.enemiesKilled} · Nourriture rapportée : ${s.delivered}`,
          `Eau : ${sim.water.count} cases`,
          `Terre creusée : ${DISPOSAL_NAMES[sim.digDisposal]} · Graine : ${seed}`,
        ].join('<br>');
    // Only touch the page when the text changes; rewriting it every frame costs smoothness.
    const all = whenText + headText + alertText + detailText;
    if (all !== lastHud) {
      lastHud = all;
      when.textContent = whenText;
      headline.textContent = headText;
      alerts.innerHTML = alertText;
      alerts.hidden = !alertText;
      details.innerHTML = detailText;
    }
  }
}

start();
