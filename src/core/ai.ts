import { CASTES, Caste, HUNGRY, Item, Task } from './ants';
import { Stage } from './brood';
import { IDLE, type AntInput, type Axis } from './input';
import { Material, isDiggable } from './materials';
import { ALATE_MATURE, MIDDEN_DISTANCE, Season, type Simulation } from './sim';

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
/** Nurses keep the brood within this many steps of the nursery, and fetch any farther away. */
const NURSERY_SPREAD = 6;
const NURSERY_FETCH = 9;
/** Soldiers that patrol outside stay this close to the entrance. */
const PATROL_RANGE = 14;
/** Weakest alarm scent an ant will follow. */
const ALARM_SCENT = 0.05;
const FOOD_SMELL = 12;

function move(dx: number, dy: number): AntInput {
  return { ...IDLE, moveX: Math.sign(dx) as Axis, moveY: Math.sign(dy) as Axis };
}

function act(x: number, y: number): AntInput {
  return { ...IDLE, dig: true, target: { x, y } };
}

function drop(x: number, y: number): AntInput {
  return { ...IDLE, drop: true, target: { x, y } };
}

/** Standing on the open ground surface (not down the entrance hole). */
function onSurface(sim: Simulation, x: number, y: number): boolean {
  return sim.exitDist[sim.idx(x, y)] <= 1;
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Cells next to the ant it could step onto. */
function steps(sim: Simulation, x: number, y: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [dx, dy] of DIRS) {
    if (sim.canStand(x + dx, y + dy)) out.push([dx, dy]);
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

/** Walks along the surface in one direction, climbing over mounds and stones on the way. */
function headAway(sim: Simulation, id: number, dir: number): AntInput {
  const options = steps(sim, sim.ants.x[id], sim.ants.y[id]);
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  for (const [dx, dy] of options) {
    const score = dx * dir * 2 - dy + sim.rng.next() * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = [dx, dy];
    }
  }
  return best ? move(best[0], best[1]) : IDLE;
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
  // Blocked by traffic: mostly wait for the way to clear.
  if (best) return move(best[0], best[1]);
  return sim.rng.next() < 0.25 ? wander(sim, id) : IDLE;
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

/** Something solid an ant can actually get next to (not buried in soil). */
function reachable(sim: Simulation, x: number, y: number): boolean {
  for (const [dx, dy] of DIRS) {
    if (sim.world.inBounds(x + dx, y + dy) && sim.homeDist[sim.idx(x + dx, y + dy)] !== UNREACHABLE) return true;
  }
  return false;
}

function nearest(sim: Simulation, x: number, y: number, range: number, m: Material): [number, number] | null {
  const w = sim.world;
  let best: [number, number] | null = null;
  let bestDist = range + 1;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      if (w.get(x + dx, y + dy) !== m || !reachable(sim, x + dx, y + dy)) continue;
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
 * Decides what one AI ant does this tick: fight, answer an alarm, finish what
 * it carries, eat, then do the job of its caste and age. It returns the same
 * kind of input the player gives, so AI ants obey the same rules.
 */
export function thinkAnt(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  const caste = a.caste[id] as Caste;
  const carrying = a.carrying[id] as Item;
  const handsFree = carrying === Item.None || carrying === Item.Soil;
  const fighter = caste === Caste.Soldier || (caste === Caste.Worker && handsFree);

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

  // A starving ant eats first, even with a pellet or a body in its mandibles.
  if (a.energy[id] < HUNGRY / 3 && sim.colony.food > 0 && carrying !== Item.Food && carrying !== Item.Brood) {
    if (sim.homeDist[sim.idx(x, y)] <= 2) return { ...IDLE, eat: true };
    return follow(sim, id, sim.homeDist);
  }

  // Finish the errand in the mandibles first.
  switch (carrying) {
    case Item.Food:
      if (sim.homeDist[sim.idx(x, y)] <= 2) return { ...IDLE, eat: true };
      return follow(sim, id, sim.homeDist);
    case Item.Soil:
      return haulSoil(sim, id);
    case Item.Corpse:
      return carryToMidden(sim, id);
    case Item.Brood:
      return carryBrood(sim, id);
  }

  // Hungry: go home and eat from the colony's reserve.
  if (a.energy[id] < HUNGRY && sim.colony.food > 0) {
    if (sim.homeDist[sim.idx(x, y)] <= 2) return { ...IDLE, eat: true };
    return follow(sim, id, sim.homeDist);
  }

  if (sim.isAlate(id)) return alate(sim, id);
  if (caste === Caste.Soldier) return guard(sim, id);

  // Undertakers: a worker in the nest that finds a dead nestmate takes it out.
  if (a.task[id] !== Task.Forage) {
    const body = nearest(sim, x, y, 6, Material.Corpse);
    const { nestX, nestY } = sim.colony;
    if (body && Math.hypot(body[0] - nestX, body[1] - nestY) < MIDDEN_DISTANCE - 2) {
      if (chebyshev(x, y, body[0], body[1]) === 1) return act(body[0], body[1]);
      return toward(sim, id, body[0], body[1]);
    }
  }

  switch (a.task[id] as Task) {
    case Task.Forage:
      return forage(sim, id);
    case Task.Dig:
      return dig(sim, id);
    case Task.Nurse:
      return nurse(sim, id);
    default:
      return stayNear(sim, id, 5, 0.2);
  }
}

/**
 * Foragers search the surface, follow food trails left by nestmates, smell
 * food nearby and go back to where they last found some.
 */
function forage(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  // Night, rain or winter: foragers come home and wait.
  if (sim.shelter()) {
    if (sim.homeDist[sim.idx(x, y)] > 8) return follow(sim, id, sim.homeDist);
    return stayNear(sim, id, 8, 0.15);
  }
  // Underground: head out to the surface first; food is smelled out in the open.
  const out = onSurface(sim, x, y);
  const food = out ? nearest(sim, x, y, FOOD_SMELL, Material.Food) : null;
  if (food) {
    if (chebyshev(x, y, food[0], food[1]) === 1) return act(food[0], food[1]);
    return toward(sim, id, food[0], food[1]);
  }
  if (!out) return sim.rng.next() < 0.9 ? follow(sim, id, sim.exitDist) : wander(sim, id);

  // Go back to the last place food was found; give up once there and it is gone.
  if (a.memX[id] >= 0) {
    if (Math.abs(a.memX[id] - x) <= 2) {
      a.memX[id] = -1;
      a.memY[id] = -1;
    } else {
      return toward(sim, id, a.memX[id], sim.topSolid(a.memX[id]) - 1);
    }
  }

  // Search: climb food trails towards their source, keep a heading, drift away from home.
  const options = steps(sim, x, y);
  if (!options.length) return IDLE;
  const trailHere = sim.trail[sim.idx(x, y)];
  const homeHere = sim.homeDist[sim.idx(x, y)];
  let total = 0;
  const weights = options.map(([dx, dy]) => {
    const i = sim.idx(x + dx, y + dy);
    let w = 1 + 10 * sim.trail[i] + 80 * Math.max(0, sim.trail[i] - trailHere);
    if (dx === a.aimX[id] && dy === a.aimY[id]) w += 10;
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

/** Diggers follow the nest plan: they go to the nearest unfinished wall and dig it. */
function dig(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const w = sim.world;
  const x = a.x[id];
  const y = a.y[id];

  // Keep digging the cell already started.
  const t = a.digTarget[id];
  if (t >= 0) {
    const tx = t % w.width;
    const ty = (t - tx) / w.width;
    if (isDiggable(w.get(tx, ty))) return act(tx, ty);
  }

  const choices: Array<[number, number]> = [];
  for (const [dx, dy] of DIRS) {
    const m = w.get(x + dx, y + dy);
    // Food that rolled into a tunnel is cleared too, and taken home.
    if (!isDiggable(m) || m === Material.Corpse) continue;
    if (sim.inPlan(x + dx, y + dy)) choices.push([x + dx, y + dy]);
  }
  if (choices.length) {
    const [cx, cy] = choices[sim.rng.int(0, choices.length - 1)];
    return act(cx, cy);
  }
  const d = sim.digDist[sim.idx(x, y)];
  if (d === UNREACHABLE) {
    // Nothing left to dig, or no way there: rest in the nest.
    return stayNear(sim, id, 6, 0.3);
  }
  return sim.rng.next() < 0.9 ? follow(sim, id, sim.digDist) : wander(sim, id);
}

/** Each pellet goes up the tunnel and onto the mound beside the entrance. */
function haulSoil(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  if (!onSurface(sim, x, y)) return follow(sim, id, sim.exitDist);
  const away = Math.sign(x - sim.entranceX) || a.facing[id];
  // Every column near the mound is full: give up and leave the pellet where it is.
  const far = Math.abs(x - sim.entranceX) > 60;
  for (const dx of [away, -away, 0]) {
    const cx = x + dx;
    if (!far && !sim.spoilColumn(cx)) continue;
    const cy = sim.topSolid(cx) - 1;
    if (Math.abs(cy - y) <= 1 && (cx !== x || cy !== y) && sim.free(cx, cy)) return drop(cx, cy);
  }
  return headAway(sim, id, away);
}

/** Dead nestmates are carried out of the nest and left on a refuse pile well away from it. */
function carryToMidden(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  if (!onSurface(sim, x, y)) return follow(sim, id, sim.exitDist);
  const away = Math.sign(x - sim.colony.nestX) || a.facing[id];
  if (sim.middenSpot(x, y)) {
    for (const dx of [away, -away]) {
      const cy = sim.topSolid(x + dx) - 1;
      if (Math.abs(cy - y) <= 1 && sim.free(x + dx, cy)) return drop(x + dx, cy);
    }
  }
  return headAway(sim, id, away);
}

/** A nurse carries an egg, larva or pupa to the nursery and sets it on the floor. */
function carryBrood(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const w = sim.world;
  const x = a.x[id];
  const y = a.y[id];
  const field = sim.nurseryDist;
  const d = field[sim.idx(x, y)];
  if (d === UNREACHABLE) return follow(sim, id, sim.homeDist);
  if (d <= NURSERY_SPREAD) {
    for (const [dx, dy] of [[0, 0], ...DIRS] as Array<readonly [number, number]>) {
      const cx = x + dx;
      const cy = y + dy;
      if (!sim.walkable(cx, cy) || !w.solidAt(cx, cy + 1) || sim.broodAt(cx, cy)) continue;
      if (field[sim.idx(cx, cy)] > NURSERY_SPREAD) continue;
      return drop(cx, cy);
    }
    return wander(sim, id, (cx, cy) => field[sim.idx(cx, cy)] <= NURSERY_SPREAD + 2);
  }
  return follow(sim, id, field);
}

/** Goes to a cell near the nest, using whichever map leads closest to it. */
function approach(sim: Simulation, id: number, tx: number, ty: number): AntInput {
  const a = sim.ants;
  if (chebyshev(a.x[id], a.y[id], tx, ty) <= 4) return toward(sim, id, tx, ty);
  const i = sim.idx(tx, ty);
  const field = sim.nurseryDist[i] <= sim.homeDist[i] ? sim.nurseryDist : sim.homeDist;
  if (field[sim.idx(a.x[id], a.y[id])] <= field[i]) return toward(sim, id, tx, ty);
  return follow(sim, id, field);
}

/** Nurses feed hungry larvae, gather the brood into the nursery, and otherwise stay with it. */
function nurse(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const b = sim.brood;
  const x = a.x[id];
  const y = a.y[id];
  let hungry = -1;
  let stray = -1;
  let hungryDist = 1e9;
  let strayDist = 1e9;
  for (let i = 0; i < b.count; i++) {
    const bi = sim.idx(b.x[i], b.y[i]);
    if (sim.homeDist[bi] === UNREACHABLE && sim.nurseryDist[bi] === UNREACHABLE) continue;
    const d = chebyshev(x, y, b.x[i], b.y[i]);
    if (b.stage[i] === Stage.Larva && b.fed[i] === 0 && d < hungryDist) {
      hungryDist = d;
      hungry = i;
    }
    if (sim.nurseryDist[bi] > NURSERY_FETCH && d < strayDist) {
      strayDist = d;
      stray = i;
    }
  }
  const job = hungry >= 0 ? hungry : stray;
  if (job >= 0) {
    if (chebyshev(x, y, b.x[job], b.y[job]) <= 1) return act(b.x[job], b.y[job]);
    return approach(sim, id, b.x[job], b.y[job]);
  }
  // Nothing to do: stay among the brood, grooming it.
  const d = sim.nurseryDist[sim.idx(x, y)];
  if (d === UNREACHABLE) return stayNear(sim, id, 3, 0.3);
  if (d > 4) return follow(sim, id, sim.nurseryDist);
  if (sim.rng.next() >= 0.25) return IDLE;
  return wander(sim, id, (cx, cy) => sim.nurseryDist[sim.idx(cx, cy)] <= 4);
}

/**
 * Soldiers block the entrance from the inside; one in three patrols the
 * ground around it instead.
 */
function guard(sim: Simulation, id: number): AntInput {
  const a = sim.ants;
  const x = a.x[id];
  const y = a.y[id];
  const patrol = id % 3 === 0;
  if (!sim.outside(x, y)) {
    const d = sim.exitDist[sim.idx(x, y)];
    if (d === UNREACHABLE) return wander(sim, id);
    if (patrol || d > 2) return follow(sim, id, sim.exitDist);
    if (sim.rng.next() >= 0.15) return IDLE;
    return wander(sim, id, (cx, cy) => !sim.outside(cx, cy) && sim.exitDist[sim.idx(cx, cy)] <= 2);
  }
  if (!patrol) return follow(sim, id, sim.homeDist);
  if (Math.abs(x - sim.entranceX) > PATROL_RANGE) return toward(sim, id, sim.entranceX, sim.entranceY);
  return wander(sim, id, (cx) => Math.abs(cx - sim.entranceX) <= PATROL_RANGE);
}

/** Winged queens and males wait in the nest, then climb out together for the nuptial flight. */
function alate(sim: Simulation, id: number): AntInput {
  if (sim.flightActive() && sim.age(id) >= ALATE_MATURE) {
    return follow(sim, id, sim.exitDist);
  }
  return stayNear(sim, id, 6, 0.15);
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

/**
 * The queen when nobody controls her. A founding queen walks to the planned
 * entrance and digs her way down to the first chamber, then stays there and
 * lays: workers first, soldiers once the colony is established, and winged
 * queens and males when it is big, in spring and summer. She holds back
 * when food is short, when there is already plenty of brood, and in winter.
 */
export function thinkQueen(sim: Simulation): AntInput {
  const id = sim.player;
  const a = sim.ants;
  const w = sim.world;
  const x = a.x[id];
  const y = a.y[id];

  for (const [dx, dy] of DIRS) {
    if (sim.enemyAt(x + dx, y + dy) >= 0) return act(x + dx, y + dy);
  }

  const home = sim.chambers[0];
  const floor = home ? sim.chamberFloor(home) : -1;
  if (floor < 0) {
    // Founding: dig down the planned shaft, like a digger, preferring the way to her chamber.
    if (!home) return IDLE;
    const t = a.digTarget[id];
    if (t >= 0 && isDiggable(w.cells[t] as Material)) return act(t % w.width, Math.floor(t / w.width));
    let best: [number, number] | null = null;
    let bestDist = Infinity;
    for (const [dx, dy] of DIRS) {
      const cx = x + dx;
      const cy = y + dy;
      const m = w.get(cx, cy);
      if (!sim.inPlan(cx, cy) || !isDiggable(m) || m === Material.Food || m === Material.Corpse) continue;
      const dist = Math.hypot(home.x - cx, home.y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = [cx, cy];
      }
    }
    const here = Math.hypot(home.x - x, home.y - y);
    if (best && bestDist < here) return act(best[0], best[1]);
    // Walk on through what is already dug if that gets her closer.
    for (const [dx, dy] of steps(sim, x, y)) {
      if (sim.inPlan(x + dx, y + dy) && Math.hypot(home.x - x - dx, home.y - y - dy) < here - 0.5) return move(dx, dy);
    }
    if (best) return act(best[0], best[1]);
    if (sim.digDist[sim.idx(x, y)] !== UNREACHABLE) return follow(sim, id, sim.digDist);
    return toward(sim, id, home.x, home.y);
  }

  // In the queen's chamber.
  const d = sim.homeDist[sim.idx(x, y)];
  if (d > 3 && d !== UNREACHABLE) return follow(sim, id, sim.homeDist);
  if (sim.broodAt(x, y)) return wander(sim, id, (cx, cy) => sim.homeDist[sim.idx(cx, cy)] <= 3);
  const caste = chooseEgg(sim);
  if (caste === null) return sim.rng.next() < 0.02 ? wander(sim, id, (cx, cy) => sim.homeDist[sim.idx(cx, cy)] <= 3) : IDLE;
  return { ...IDLE, lay: caste };
}

function chooseEgg(sim: Simulation): Caste | null {
  if (sim.season() === Season.Winter) return null;
  const a = sim.ants;
  let workers = 0;
  let soldiers = 0;
  for (let i = 0; i < a.count; i++) {
    if (!a.alive[i]) continue;
    if (a.caste[i] === Caste.Worker) workers++;
    else if (a.caste[i] === Caste.Soldier) soldiers++;
  }
  // Enough brood for the nurses to raise, and food left over for the adults.
  if (sim.brood.count >= Math.max(5, workers * 0.6)) return null;
  const keep = Math.max(2, Math.floor(workers / 2));
  let caste = Caste.Worker;
  const r = sim.rng.next();
  const breeding = workers >= 30 && (sim.season() === Season.Spring || sim.season() === Season.Summer);
  if (breeding && r < 0.1) caste = r < 0.04 ? Caste.Queen : Caste.Male;
  else if (workers >= 10 && soldiers < workers / 6 && r < 0.3) caste = Caste.Soldier;
  return sim.colony.food >= CASTES[caste].eggCost + keep ? caste : null;
}
