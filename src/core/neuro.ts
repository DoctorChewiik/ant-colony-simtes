import { nearestEnemy, thinkAnt, steps, UNREACHABLE } from './ai';
import { Caste, HUNGRY, Item } from './ants';
import { IDLE, type AntInput, type Axis } from './input';
import { Material } from './materials';
import { TICK_RATE, type Simulation } from './sim';

/**
 * The neuromechanical ant controller, ported from ant_nmf_env.py (itself after
 * NeuroMechFly / flygym, EPFL) so it runs in the game with no Python:
 *
 *   antennae ──► brain (chemotaxis) ──► descending drives [left, right]
 *                                              │
 *   world ◄── one cell per foot touchdown ◄── CPG: six coupled oscillators
 *
 * The ant hosting it walks only when its legs do: each time a tripod puts its
 * feet down, the body moves one cell. Its brain compares the smell picked up
 * by the upper and lower antenna (in the cross-section, the ant's left and
 * right) and turns towards the stronger side, or turns round when the smell
 * is behind it. Legs are numbered as in flygym: 0-2 left front/middle/hind, 3-5 right.
 */

const TAU = Math.PI * 2;
/** Tripod gait: legs 0, 2, 4 in phase, anti-phase to 1, 3, 5. As flygym's tripod phase biases. */
const PHASE_BIAS = [
  [0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0],
].map((row) => row.map((v) => v * Math.PI));

/** Settings shared with AntConfig in ant_nmf_env.py. */
export const NEURO = {
  /** Steps per second at full drive. Real ants walk at 8-25 Hz; slowed down so the gait can be watched. */
  stepFrequency: 4,
  /** Part of each step cycle a leg spends in the air. */
  swing: 0.4,
  coupling: 10,
  convergence: 20,
  baseDrive: 1,
  /** How hard a difference between the antennae turns the ant, at birth (then learned). */
  turnGain: 1,
  /** Places a brain can remember finding food at. */
  memorySlots: 6,
  /** Cells from the head to the antenna tips. */
  antennaReach: 2,
  /** How far from the ant the guide pheromone can be smelled. */
  guideRange: 6,
  /** How far food can be smelled, in cells of open path. */
  smellRange: 20,
  /** Distance over which a smell fades to a third. */
  smellSpread: 6,
};

export class CpgNetwork {
  readonly phases = new Float64Array(6);
  readonly mags = new Float64Array(6);
  readonly freqs = new Float64Array(6);
  readonly amps = new Float64Array(6);
  private readonly d = new Float64Array(6);

  constructor() {
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < 6; i++) {
      this.phases[i] = (i % 2) * Math.PI + 0.3 * Math.sin(i * 7.1);
      this.mags[i] = 0;
    }
  }

  /** One Euler step: dθi = 2π fi + Σj rj wij sin(θj − θi − φij);  dri = a (Ri − ri). */
  step(dt: number, driveL: number, driveR: number): void {
    for (let i = 0; i < 6; i++) {
      const drive = i < 3 ? driveL : driveR;
      this.amps[i] = Math.min(1, Math.abs(drive));
      this.freqs[i] = NEURO.stepFrequency * (drive < 0 ? -1 : 1) * (0.5 + 0.5 * this.amps[i]);
    }
    for (let i = 0; i < 6; i++) {
      let coupling = 0;
      // As in flygym, legs are coupled only to the legs of the other tripod.
      for (let j = 0; j < 6; j++) {
        if (!PHASE_BIAS[i][j]) continue;
        coupling += this.mags[j] * NEURO.coupling * Math.sin(this.phases[j] - this.phases[i] - PHASE_BIAS[i][j]);
      }
      // A leg at rest does not cycle: frequency fades with the oscillator's amplitude.
      this.d[i] = TAU * this.freqs[i] * Math.min(1, this.mags[i] * 4) + coupling;
    }
    for (let i = 0; i < 6; i++) {
      this.phases[i] = (((this.phases[i] + this.d[i] * dt) % TAU) + TAU) % TAU;
      this.mags[i] += NEURO.convergence * (this.amps[i] - this.mags[i]) * dt;
    }
  }

  /** True while the leg is on the ground (stance): its foot pad sticks. */
  adhered(i: number): boolean {
    return this.phases[i] / TAU >= NEURO.swing || this.mags[i] < 0.05;
  }
}

/** What the brain is steering by. */
export type NeuroGoal = 'guide' | 'food' | 'memory' | 'home' | 'air' | 'explore' | 'rest' | 'reflex';

/** The brain and legs of the one ant that runs the neuromechanical controller. */
export class NeuroBrain {
  readonly cpg = new CpgNetwork();
  /** The host ant, or -1. */
  id = -1;
  private gen = 0;
  /** Pick a new host by itself when the last one dies (off once the player chooses one). */
  auto = true;
  driveL = 0;
  driveR = 0;
  /** Smell at the upper ("left") and lower ("right") antenna, and under the body, 0 to 1. */
  smellL = 0;
  smellR = 0;
  smellHere = 0;
  goal: NeuroGoal = 'rest';
  /** Feet put down since the host was chosen, and cells walked. */
  touchdowns = 0;
  walked = 0;
  /**
   * What the brain learns, and keeps when it moves to another ant:
   *  - where it found food (spatial memory, as foragers learn their feeding
   *    sites), each place weighted by how often it paid off;
   *  - how hard to turn on a smell difference (the antennal gain), tuned trip
   *    after trip by trial and error: a change that made the last trip to food
   *    straighter is kept, one that made it worse is undone.
   */
  memory: Array<{ x: number; y: number; weight: number }> = [];
  turnGain = NEURO.turnGain;
  private gainStep = 0.5;
  /** Trips to food completed, and how straight they were on average (1 = a beeline). */
  trips = 0;
  efficiency = 0;
  private tripFrom: { x: number; y: number; walked: number } | null = null;
  private stanceA = true;
  private stanceB = true;
  private pendingStep = false;
  private pivotTicks = 0;
  private scent: Float32Array | null = null;
  private scentX = 0;
  private scentY = 0;
  private scentTick = -1;

  attach(sim: Simulation, id: number): void {
    this.id = id;
    this.gen = id >= 0 ? sim.ants.gen[id] : 0;
    this.cpg.reset();
    this.touchdowns = 0;
    this.walked = 0;
    this.pendingStep = false;
    this.pivotTicks = 0;
    this.scentTick = -1;
  }

  valid(sim: Simulation): boolean {
    return this.id >= 0 && sim.ants.alive[this.id] === 1 && sim.ants.gen[this.id] === this.gen;
  }

  /** Keeps a host: the oldest living worker that is not the player's. */
  ensure(sim: Simulation): void {
    if (this.valid(sim) || !this.auto) {
      if (!this.valid(sim) && this.id >= 0) this.id = -1;
      return;
    }
    this.id = -1;
    const a = sim.ants;
    for (let i = 0; i < a.count; i++) {
      if (a.alive[i] && a.caste[i] === Caste.Worker && i !== sim.player) {
        this.attach(sim, i);
        return;
      }
    }
  }

  /** One tick of the controller for the host ant: senses, brain, CPG, then at most one step. */
  think(sim: Simulation, id: number): AntInput {
    const a = sim.ants;
    const x = a.x[id];
    const y = a.y[id];
    const dt = 1 / TICK_RATE;
    const carrying = a.carrying[id] as Item;

    // Reflexes the brain does not override: breathing, biting an attacker,
    // eating when starving, and errands it was already on when chosen.
    const reflex =
      sim.deepWater(x, y) ||
      nearestEnemy(sim, x, y, 6) >= 0 ||
      sim.alarm[sim.idx(x, y)] > 0.05 ||
      (a.energy[id] < HUNGRY / 3 && carrying !== Item.Food) ||
      carrying === Item.Soil ||
      carrying === Item.Corpse ||
      carrying === Item.Brood ||
      sim.held === id;
    if (reflex) {
      this.goal = 'reflex';
      const input = thinkAnt(sim, id);
      const walking = input.moveX !== 0 || input.moveY !== 0;
      this.driveL = this.driveR = walking ? NEURO.baseDrive : 0;
      this.cpg.step(dt, this.driveL, this.driveR);
      this.trackFeet();
      return input;
    }

    // Food in reach of the mandibles: bite it off and carry it.
    if (carrying === Item.None) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (sim.world.get(x + dx, y + dy) === Material.Food) {
            if (this.goal !== 'food' || this.tripFrom) this.learn(x + dx, y + dy);
            this.goal = 'food';
            this.driveL = this.driveR = 0;
            this.cpg.step(dt, 0, 0);
            this.trackFeet();
            return { ...IDLE, dig: true, target: { x: x + dx, y: y + dy } };
          }
        }
      }
    }
    // Back at the nest with food: hand it over.
    if (carrying === Item.Food && sim.homeDist[sim.idx(x, y)] <= 2) {
      this.goal = 'home';
      return { ...IDLE, eat: true };
    }
    if (carrying === Item.None && a.energy[id] < HUNGRY && sim.colony.food > 0 && sim.homeDist[sim.idx(x, y)] <= 2) {
      this.goal = 'home';
      return { ...IDLE, eat: true };
    }

    // --- Antennae: what each one smells ------------------------------------
    const smell = this.chooseSmell(sim, id);
    const f = a.facing[id] || 1;
    const options = steps(sim, x, y);
    let up = 0;
    let down = 0;
    for (let r = 1; r <= NEURO.antennaReach; r++) {
      for (let k = 0; k <= 2; k++) {
        if (sim.canStand(x + f * r, y - k)) up = Math.max(up, smell(x + f * r, y - k));
        if (sim.canStand(x + f * r, y + k)) down = Math.max(down, smell(x + f * r, y + k));
      }
    }
    // Straight up or down a shaft, the antennae reach along it.
    if (sim.canStand(x, y - 1)) up = Math.max(up, smell(x, y - 1));
    if (sim.canStand(x, y + 1)) down = Math.max(down, smell(x, y + 1));
    this.smellL = up;
    this.smellR = down;
    this.smellHere = smell(x, y);

    // --- Brain: descending drives ------------------------------------------
    const ahead = options.filter(([dx]) => dx === f || dx === 0);
    const behindStronger = this.goal !== 'explore' && Math.max(up, down) < this.smellHere - 1e-4;
    // At the freshest end of a guide trail: stop there and wait.
    const atGuideEnd = this.goal === 'guide' && freshestNearby(sim, x, y);
    if (this.pivotTicks > 0) this.pivotTicks--;
    else if (this.goal === 'rest' || atGuideEnd) {
      this.driveL = this.driveR = 0;
    } else if (!ahead.length || behindStronger || (this.goal === 'explore' && sim.rng.next() < 0.004)) {
      // The smell is behind (or the way is shut): pivot on the spot, the two
      // sides stepping in opposite directions, then face the other way.
      this.pivotTicks = Math.round(TICK_RATE * 0.4);
      this.driveL = 0.8;
      this.driveR = -0.8;
      a.facing[id] = -f as -1 | 1;
    } else {
      const total = up + down;
      // Lost the scent: keep walking with a gentle zigzag, as in the Python demo.
      const asym = total < 1e-4 ? 0.3 * Math.sin(this.walked * 0.7) : (up - down) / total;
      const turn = this.turnGain * asym;
      this.driveL = Math.max(-1.2, NEURO.baseDrive - Math.max(0, turn));
      this.driveR = Math.max(-1.2, NEURO.baseDrive - Math.max(0, -turn));
    }

    // --- CPG and legs -------------------------------------------------------
    this.cpg.step(dt, this.driveL, this.driveR);
    this.trackFeet();
    if (this.driveL === 0 && this.driveR === 0) this.pendingStep = false;
    if (this.pivotTicks > 0 || !this.pendingStep) return IDLE;
    this.pendingStep = false;

    // A tripod just landed: the body moves one cell, nose up or down as the
    // drives say (the weaker side is the side the ant turns towards).
    const turn = this.driveR - this.driveL; // > 0: towards the upper antenna
    let best: readonly [number, number] | null = null;
    let bestScore = -Infinity;
    for (const [dx, dy] of ahead) {
      let score = (dx === f ? 1 : 0.4) - dy * turn + smell(x + dx, y + dy) * 2;
      // On a wall the legs climb unless the smell says otherwise.
      if (dx === 0 && Math.abs(turn) < 0.05) score -= dy * 0.2;
      score += sim.rng.next() * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = [dx, dy];
      }
    }
    if (!best) return IDLE;
    this.walked++;
    return { ...IDLE, moveX: best[0] as Axis, moveY: best[1] as Axis };
  }

  /** Food found at (fx, fy): remember the place and grade the trip that led there. */
  private learn(fx: number, fy: number): void {
    const near = this.memory.find((m) => Math.abs(m.x - fx) <= 5 && Math.abs(m.y - fy) <= 5);
    if (near) {
      near.weight += 1;
      near.x = fx;
      near.y = fy;
    } else {
      this.memory.push({ x: fx, y: fy, weight: 1 });
      this.memory.sort((p, q) => q.weight - p.weight);
      this.memory.length = Math.min(this.memory.length, NEURO.memorySlots);
    }
    const trip = this.tripFrom;
    this.tripFrom = null;
    if (!trip) return;
    const taken = this.walked - trip.walked;
    const direct = Math.max(Math.abs(fx - trip.x), Math.abs(fy - trip.y)) - 1;
    if (direct < 3 || taken < 1) return;
    const eff = Math.min(1, direct / taken);
    // Trial and error on the antennal gain: worse than usual, step back the other way, smaller.
    if (this.trips > 0 && eff < this.efficiency) this.gainStep *= -0.6;
    if (Math.abs(this.gainStep) < 0.1) this.gainStep = 0.1 * Math.sign(this.gainStep || 1);
    this.efficiency = this.trips > 0 ? this.efficiency * 0.7 + eff * 0.3 : eff;
    this.trips++;
    this.turnGain = Math.min(8, Math.max(0.3, this.turnGain + this.gainStep));
  }

  /** The most promising place remembered; one found empty is trusted less, then forgotten. */
  private recall(x: number, y: number): { x: number; y: number } | null {
    let best: { x: number; y: number; weight: number } | null = null;
    let bestScore = 0;
    for (const m of this.memory) {
      const d = Math.max(Math.abs(m.x - x), Math.abs(m.y - y));
      if (d <= 2) {
        // Here, and nothing to smell: the food is gone.
        m.weight *= 0.4;
        continue;
      }
      const score = m.weight / (1 + d / 60);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    this.memory = this.memory.filter((m) => m.weight >= 0.3);
    return best;
  }

  /** Counts feet put down; each tripod touchdown lets the body take one step. */
  private trackFeet(): void {
    const a = this.cpg.adhered(0) && this.cpg.mags[0] > 0.05;
    const b = this.cpg.adhered(3) && this.cpg.mags[3] > 0.05;
    if ((a && !this.stanceA) || (b && !this.stanceB)) {
      this.touchdowns++;
      this.pendingStep = true;
    }
    this.stanceA = a;
    this.stanceB = b;
  }

  /** Picks what to smell for: food, the nest, fresh air, or a pheromone trail. */
  private chooseSmell(sim: Simulation, id: number): (x: number, y: number) => number {
    const a = sim.ants;
    const x = a.x[id];
    const y = a.y[id];
    const nest = (cx: number, cy: number) => {
      const d = sim.homeDist[sim.idx(cx, cy)];
      return d === UNREACHABLE ? 0 : Math.exp(-d / 40);
    };
    // The player's guide pheromone comes first: the ant follows it to its freshest end.
    if (sim.guideActive() && guideSmell(sim, x, y) > 0.02) {
      this.goal = 'guide';
      return (cx, cy) => guideSmell(sim, cx, cy);
    }
    if (a.carrying[id] === Item.Food || (a.energy[id] < HUNGRY && sim.colony.food > 0)) {
      this.goal = 'home';
      return nest;
    }
    if (sim.shelter()) {
      this.goal = sim.homeDist[sim.idx(x, y)] > 8 ? 'home' : 'rest';
      return nest;
    }
    if (this.foodScent(sim, x, y)) {
      // A new trip towards food starts: remember where from, to judge it on arrival.
      if (this.goal !== 'food' || !this.tripFrom) this.tripFrom = { x, y, walked: this.walked };
      this.goal = 'food';
      return (cx, cy) => this.scentAt(cx, cy) + 0.3 * Math.min(1, sim.trail[sim.idx(cx, cy)]);
    }
    if (!sim.outside(x, y)) {
      this.goal = 'air';
      return (cx, cy) => {
        const d = sim.exitDist[sim.idx(cx, cy)];
        return d === UNREACHABLE ? 0 : Math.exp(-d / 40);
      };
    }
    // Nothing to smell: head for the best place remembered, by the sense of
    // direction alone (ants keep track of where they are by path integration).
    const place = this.recall(x, y);
    if (place) {
      this.goal = 'memory';
      return (cx, cy) => Math.exp(-Math.max(Math.abs(cx - place.x), Math.abs(cy - place.y)) / 30);
    }
    this.goal = 'explore';
    return (cx, cy) => Math.min(1, sim.trail[sim.idx(cx, cy)]);
  }

  /**
   * Food smell around the ant: spreads from each food cell along open paths
   * (not through soil), fading with distance. Recomputed every few ticks.
   */
  private foodScent(sim: Simulation, x: number, y: number): boolean {
    if (this.scent && sim.tick - this.scentTick < 6 && Math.abs(x - this.scentX) < 4 && Math.abs(y - this.scentY) < 4) {
      return this.scentFound;
    }
    const R = NEURO.smellRange;
    const S = 2 * R + 1;
    const dist = (this.scent ??= new Float32Array(S * S));
    dist.fill(Infinity);
    this.scentX = x;
    this.scentY = y;
    this.scentTick = sim.tick;
    const queue: number[] = [];
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const cx = x - R + i;
        const cy = y - R + j;
        if (sim.world.get(cx, cy) !== Material.Food) continue;
        // The smell starts in the open cells around the food.
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ni = i + dx;
            const nj = j + dy;
            if (ni < 0 || nj < 0 || ni >= S || nj >= S || !sim.walkable(cx + dx, cy + dy)) continue;
            if (dist[nj * S + ni] > 0) {
              dist[nj * S + ni] = 0;
              queue.push(nj * S + ni);
            }
          }
        }
      }
    }
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      const i = c % S;
      const j = (c - i) / S;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = i + dx;
          const nj = j + dy;
          if (ni < 0 || nj < 0 || ni >= S || nj >= S) continue;
          const n = nj * S + ni;
          if (dist[n] <= dist[c] + 1 || !sim.walkable(x - R + ni, y - R + nj)) continue;
          dist[n] = dist[c] + 1;
          queue.push(n);
        }
      }
    }
    this.scentFound = Number.isFinite(dist[R * S + R]);
    return this.scentFound;
  }

  private scentFound = false;

  private scentAt(cx: number, cy: number): number {
    const R = NEURO.smellRange;
    const i = cx - this.scentX + R;
    const j = cy - this.scentY + R;
    const S = 2 * R + 1;
    if (!this.scent || i < 0 || j < 0 || i >= S || j >= S) return 0;
    const d = this.scent[j * S + i];
    return Number.isFinite(d) ? Math.exp(-d / NEURO.smellSpread) : 0;
  }
}

/** The guide pheromone as the antennae pick it up: strongest on the trail, fading a few cells off it. */
function guideSmell(sim: Simulation, x: number, y: number): number {
  const R = NEURO.guideRange;
  let best = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const v = sim.guideAt(x + dx, y + dy);
      if (v <= best) continue;
      best = Math.max(best, v * Math.exp(-Math.max(Math.abs(dx), Math.abs(dy)) / 2));
    }
  }
  return best;
}

/** On the guide trail, with no fresher mark within two cells: the end of the trail. */
function freshestNearby(sim: Simulation, x: number, y: number): boolean {
  const here = sim.guideAt(x, y);
  if (here <= 0) return false;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) if (sim.guideAt(x + dx, y + dy) > here + 1e-6) return false;
  }
  return true;
}
