import { Caste, Item, Task } from './ants';
import { IDLE, type AntInput, type Axis } from './input';
import { Material, isDiggable } from './materials';
import type { Simulation } from './sim';

/** Value of a distance field cell nothing can reach. */
export const UNREACHABLE = 32767;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** How far each caste notices an enemy and goes for it. */
const ENEMY_SIGHT: Record<Caste, number> = {
  [Caste.Worker]: 6,
  [Caste.Soldier]: 20,
  [Caste.Queen]: 0,
  [Caste.Male]: 0,
};
/** Weakest alarm scent an ant will follow. */
const ALARM_SCENT = 0.05;
const FOOD_SMELL = 8;

function move(dx: number, dy: number): AntInput {
  return { ...IDLE, moveX: Math.sign(dx) as Axis, moveY: Math.sign(dy) as Axis };
}

function act(x: number, y: number): AntInput {
  return { ...IDLE, dig: true, target: { x, y } };
}

/** Cells next to the ant it could step onto. */
function steps(sim: Simulation, x: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [dx, dy] of DIRS) {
    if (sim.canStand(x + dx, y + dy) && !sim.squeezes(x, y, x + dx, y + dy)) out.push([dx, dy]);
  }
  return out;
}

/** Picks a step, keeping the current heading most of the time so paths look purposeful. */
function wander(sim: Simulation, id: number, keep = (_dx: number, _dy: number) => true): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  const options = steps(sim, x, y).filter(([dx, dy]) => keep(x + dx, y + dy));
  if (!options.length) return IDLE;
  const ahead = options.find(([dx, dy]) => dx === a.aimX[id] && dy === a.aimY[id]);
  if (ahead && sim.rng.next() < 0.8) return move(ahead[0], ahead[1]);
  const [dx, dy] = options[sim.rng.int(0, options.length - 1)];
  return move(dx, dy);
}

/** Steps downhill on a distance field (towards the nest, or out to the surface). */
function follow(sim: Simulation, id: number, field: Int16Array): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  let best: [number, number] | null = null;
  let bestValue = field[sim.idx(x, y)];
  for (const [dx, dy] of steps(sim, x, y)) {
    const v = field[sim.idx(x + dx, y + dy)];
    if (v < bestValue || (v === bestValue && best && sim.rng.next() < 0.5)) {
      bestValue = v;
      best = [dx, dy];
    }
  }
  return best ? move(best[0], best[1]) : wander(sim, id);
}

/** Steps to the neighbour closest to a point. */
function toward(sim: Simulation, id: number, tx: number, ty: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  let best: [number, number] | null = null;
  let bestDist = Math.hypot(tx - x, ty - y);
  for (const [dx, dy] of steps(sim, x, y)) {
    const d = Math.hypot(tx - x - dx, ty - y - dy);
    if (d < bestDist) {
      bestDist = d;
      best = [dx, dy];
    }
  }
  return best ? move(best[0], best[1]) : wander(sim, id);
}

function nearestEnemy(sim: Simulation, x: number, y: number, range: number): number {
  const e = sim.enemies;
  let best = -1;
  let bestDist = range + 1;
  for (let i = 0; i < e.count; i++) {
    if (!e.alive[i]) continue;
    const d = Math.max(Math.abs(e.x[i] - x), Math.abs(e.y[i] - y));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function nearestFood(sim: Simulation, x: number, y: number, range: number): [number, number] | null {
  const w = sim.world;
  let best: [number, number] | null = null;
  let bestDist = range + 1;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      if (w.get(x + dx, y + dy) !== Material.Food) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (d < bestDist) {
        bestDist = d;
        best = [x + dx, y + dy];
      }
    }
  }
  return best;
}

/**
 * Decides what one AI ant does this tick: fight, answer an alarm, then its job.
 * It returns the same kind of input the player gives, so AI ants obey the same rules.
 */
export function thinkAnt(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  const caste = a.caste[id] as Caste;
  const fighter = caste === Caste.Soldier || (caste === Caste.Worker && a.carrying[id] !== Item.Food);

  // Bite an enemy within reach.
  if (fighter) {
    for (const [dx, dy] of DIRS) {
      if (sim.enemyAt(x + dx, y + dy) >= 0) {
        sim.raiseAlarm(x, y, 1);
        return act(x + dx, y + dy);
      }
    }
  }

  // Seen an enemy: call the others with alarm scent and charge.
  if (fighter && ENEMY_SIGHT[caste] > 0) {
    const enemy = nearestEnemy(sim, x, y, ENEMY_SIGHT[caste]);
    if (enemy >= 0) {
      sim.raiseAlarm(x, y, 0.8);
      return toward(sim, id, sim.enemies.x[enemy], sim.enemies.y[enemy]);
    }
  }

  // Smell of alarm: climb it to where the fight is. Nurses stay with the brood unless it is strong.
  const here = sim.alarm[sim.idx(x, y)];
  const answers = caste === Caste.Soldier || (fighter && (a.task[id] !== Task.Nurse || here > 0.4));
  if (answers && here > ALARM_SCENT) {
    let best: [number, number] | null = null;
    let bestValue = here;
    for (const [dx, dy] of steps(sim, x, y)) {
      const v = sim.alarm[sim.idx(x + dx, y + dy)];
      if (v > bestValue) {
        bestValue = v;
        best = [dx, dy];
      }
    }
    if (best) return move(best[0], best[1]);
  }

  // Food in the mandibles goes home first, whatever the job.
  if (a.carrying[id] === Item.Food) {
    if (sim.homeDist[sim.idx(x, y)] <= 2) return { ...IDLE, eat: true };
    return follow(sim, id, sim.homeDist);
  }

  switch (a.task[id] as Task) {
    case Task.Forage:
      return forage(sim, id);
    case Task.Dig:
      return dig(sim, id);
    case Task.Guard:
      return stayNear(sim, id, 10, 0.5);
    case Task.Nurse:
      return stayNear(sim, id, 3, 0.3);
    default:
      return stayNear(sim, id, 5, 0.2);
  }
}

function forage(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  const food = nearestFood(sim, x, y, FOOD_SMELL);
  if (food) {
    if (Math.max(Math.abs(food[0] - x), Math.abs(food[1] - y)) === 1) return act(food[0], food[1]);
    return toward(sim, id, food[0], food[1]);
  }
  // Underground: head out to the surface.
  if (!sim.outside(x, y) && sim.rng.next() < 0.85) return follow(sim, id, sim.exitDist);

  // On the surface: drift along food trails and away from home, with a steady heading.
  const options = steps(sim, x, y);
  if (!options.length) return IDLE;
  const homeHere = sim.homeDist[sim.idx(x, y)];
  let total = 0;
  const weights = options.map(([dx, dy]) => {
    const i = sim.idx(x + dx, y + dy);
    let w = 1 + 25 * sim.trail[i];
    if (dx === a.aimX[id] && dy === a.aimY[id]) w += 4;
    if (sim.homeDist[i] > homeHere) w += 1;
    total += w;
    return w;
  });
  let r = sim.rng.next() * total;
  for (let k = 0; k < options.length; k++) {
    r -= weights[k];
    if (r <= 0) return move(options[k][0], options[k][1]);
  }
  return move(options[0][0], options[0][1]);
}

function dig(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const w = sim.world;
  const x = a.x[id];
  const y = a.y[id];
  const { nestX, nestY } = sim.colony;
  const radius = sim.nestRadius();

  // Keep digging the cell already started.
  const t = a.digTarget[id];
  if (t >= 0) {
    const tx = t % w.width;
    const ty = (t - tx) / w.width;
    if (isDiggable(w.get(tx, ty))) return act(tx, ty);
  }
  if (sim.stats.dug >= sim.digBudget()) return stayNear(sim, id, 3, 0.3);
  if (sim.homeDist[sim.idx(x, y)] === UNREACHABLE) return wander(sim, id);
  if (Math.hypot(x - nestX, y - nestY) > radius) return follow(sim, id, sim.homeDist);

  // Dig into a wall of the nest, mostly sideways and down, never breaking the surface open.
  if (sim.rng.next() < 0.25) {
    const choices: Array<[number, number]> = [];
    for (const [dx, dy] of DIRS) {
      const cx = x + dx;
      const cy = y + dy;
      const m = w.get(cx, cy);
      if (!isDiggable(m) || m === Material.Food) continue;
      const entrance = Math.hypot(cx - nestX, cy - nestY) <= 1.5;
      if (!entrance && cy <= w.surface[cx] + 1) continue;
      if (Math.hypot(cx - nestX, cy - nestY) > radius) continue;
      choices.push([cx, cy]);
      if (dy >= 0) choices.push([cx, cy]);
    }
    if (choices.length) {
      const [cx, cy] = choices[sim.rng.int(0, choices.length - 1)];
      return act(cx, cy);
    }
  }
  return wander(sim, id, (cx, cy) => Math.hypot(cx - nestX, cy - nestY) <= radius);
}

/** Stays within `range` steps of the nest heart, moving about some of the time. */
function stayNear(sim: Simulation, id: number, range: number, activity: number): AntInput {
  const home = sim.homeDist;
  const here = home[sim.idx(sim.ants.x[id], sim.ants.y[id])];
  if (here === UNREACHABLE) return wander(sim, id);
  if (here > range) return follow(sim, id, home);
  if (sim.rng.next() >= activity) return IDLE;
  return wander(sim, id, (cx, cy) => home[sim.idx(cx, cy)] <= range);
}
