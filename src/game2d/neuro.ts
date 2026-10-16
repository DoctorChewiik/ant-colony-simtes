import { Caste, Item, Material, Task, UNREACHABLE, type Simulation } from '../core';

/**
 * A neuromechanical view of one ant, after NeuroMechFly / flygym (EPFL):
 * a "brain" turns what the ant senses and does into two descending drives
 * (left and right side), and a central pattern generator (CPG) of six
 * coupled oscillators, one per leg, turns those drives into a tripod gait.
 * Each leg follows its oscillator's phase: swing (lifted, adhesion off)
 * then stance (foot planted, adhesion on). The feet of the stance legs
 * stay fixed on the ground while the body moves over them.
 *
 * Legs are numbered as in flygym: 0-2 left front/middle/hind, 3-5 right.
 */

const TAU = Math.PI * 2;
/** Tripod gait: legs 0, 2, 4 (LF, LH, RM) in phase, anti-phase to 1, 3, 5. As flygym's tripod phase biases. */
const PHASE_BIAS = [
  [0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0],
  [0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0],
].map((row) => row.map((v) => v * Math.PI));
const COUPLING = 10;
const CONVERGENCE = 20;
/** Steps per second at full drive (slowed down from a real ant's ~10 Hz so it can be watched). */
const STEP_FREQ = 3;
/** Part of each step cycle a leg spends in the air. */
const SWING = 0.4;
/** Moves per second of an ant walking at full speed in the game. */
const FULL_SPEED = 6;

const LEG_NAMES = ['AG', 'MG', 'PG', 'AD', 'MD', 'PD'];
const TASK_NAMES: Record<number, string> = {
  [Task.Idle]: 'repos',
  [Task.Forage]: 'fourrageuse',
  [Task.Dig]: 'terrassière',
  [Task.Nurse]: 'nourrice',
  [Task.Guard]: 'garde',
};
const CASTE_NAMES: Record<number, string> = {
  [Caste.Worker]: 'Ouvrière',
  [Caste.Soldier]: 'Soldat',
  [Caste.Queen]: 'Reine',
  [Caste.Male]: 'Mâle',
};

/** What the ant's body is clinging to, which sets how the body is drawn. */
type Surface = 'floor' | 'wall-left' | 'wall-right' | 'ceiling' | 'none' | 'water';

export interface Senses {
  food: number;
  trail: number;
  alarm: number;
  home: number;
  light: number;
  water: number;
}

export class CpgNetwork {
  readonly phases = new Float64Array(6);
  readonly mags = new Float64Array(6);
  readonly freqs = new Float64Array(6);
  readonly amps = new Float64Array(6);

  constructor() {
    for (let i = 0; i < 6; i++) this.phases[i] = (i % 2) * Math.PI + 0.3 * Math.sin(i * 7.1);
  }

  /** One Euler step: dθi = 2π fi + Σj rj wij sin(θj − θi − φij);  dri = a (Ri − ri). */
  step(dt: number, driveL: number, driveR: number): void {
    for (let i = 0; i < 6; i++) {
      const drive = i < 3 ? driveL : driveR;
      this.amps[i] = Math.min(1, Math.abs(drive));
      this.freqs[i] = STEP_FREQ * (drive < 0 ? -1 : 1) * (0.5 + 0.5 * this.amps[i]);
    }
    const d = new Float64Array(6);
    for (let i = 0; i < 6; i++) {
      let coupling = 0;
      // As in flygym, legs are coupled only to the legs of the other tripod.
      for (let j = 0; j < 6; j++) {
        if (!PHASE_BIAS[i][j]) continue;
        coupling += this.mags[j] * COUPLING * Math.sin(this.phases[j] - this.phases[i] - PHASE_BIAS[i][j]);
      }
      // A leg at rest does not cycle: frequency fades with the oscillator's amplitude.
      d[i] = TAU * this.freqs[i] * Math.min(1, this.mags[i] * 4) + coupling;
    }
    for (let i = 0; i < 6; i++) {
      this.phases[i] = (this.phases[i] + d[i] * dt + TAU) % TAU;
      this.mags[i] += CONVERGENCE * (this.amps[i] - this.mags[i]) * dt;
    }
  }

  /** True while the leg is on the ground (stance): its foot pad sticks. */
  adhered(i: number): boolean {
    return this.phases[i] / TAU >= SWING || this.mags[i] < 0.05;
  }
}

/** The ant the player chose to look inside, with its CPG and what its brain reads. */
export class NeuroAnt {
  readonly cpg = new CpgNetwork();
  id = -1;
  private gen = 0;
  private lastX = 0;
  private lastY = 0;
  private speed = 0;
  private turnUntil = 0;
  private lastFacing = 1;
  private facingSince = 0;
  private time = 0;
  /** Ground travelled, so the ground under the planted feet scrolls with them. */
  private groundShift = 0;
  driveL = 0;
  driveR = 0;
  surface: Surface = 'floor';
  senses: Senses = { food: 0, trail: 0, alarm: 0, home: 0, light: 0, water: 0 };

  select(sim: Simulation, id: number): void {
    this.id = id;
    this.gen = id >= 0 ? sim.ants.gen[id] : 0;
    if (id >= 0) {
      this.lastX = sim.ants.x[id];
      this.lastY = sim.ants.y[id];
      this.lastFacing = sim.ants.facing[id] || 1;
    }
  }

  /** Still the same living ant? */
  valid(sim: Simulation): boolean {
    return this.id >= 0 && sim.ants.alive[this.id] === 1 && sim.ants.gen[this.id] === this.gen;
  }

  update(sim: Simulation, dtMs: number): void {
    if (!this.valid(sim)) return;
    if (dtMs <= 0) return;
    const dt = Math.min(0.05, dtMs / 1000);
    this.time += dt;
    const a = sim.ants;
    const id = this.id;
    const x = a.x[id];
    const y = a.y[id];
    const moved = Math.hypot(x - this.lastX, y - this.lastY);
    this.lastX = x;
    this.lastY = y;
    // Smoothed walking speed, in moves per second of game time.
    this.speed += ((moved > 0 ? moved / dt : 0) - this.speed) * Math.min(1, dt * 4);
    this.surface = this.findSurface(sim, x, y);
    this.senses = this.sense(sim, x, y);

    // Brain → descending drives. Walking forwards drives both sides alike;
    // turning round drives the sides in opposite directions for a moment.
    const facing = a.facing[id] || 1;
    // A real about-turn, not a jostle back and forth in a crowd.
    if (facing !== this.lastFacing) {
      if (this.time - this.facingSince > 0.8) this.turnUntil = this.time + 0.3;
      this.facingSince = this.time;
    }
    this.lastFacing = facing;
    const drive = this.surface === 'none' ? 0 : Math.min(1.2, this.speed / FULL_SPEED);
    if (this.time < this.turnUntil) {
      this.driveL = 0.8;
      this.driveR = -0.8;
    } else {
      this.driveL = drive;
      this.driveR = drive;
    }
    this.cpg.step(dt, this.driveL, this.driveR);
    // Stance feet move back at the stride speed; the ground moves with them.
    const stride = 26 * (this.cpg.mags[0] + this.cpg.mags[3]) / 2;
    const freq = STEP_FREQ * (0.5 + 0.5 * Math.min(1, Math.abs(this.driveL)));
    if (this.time >= this.turnUntil) this.groundShift += (stride * freq * dt) / (1 - SWING);
  }

  private findSurface(sim: Simulation, x: number, y: number): Surface {
    const w = sim.world;
    if (w.get(x, y) === Material.Water) return 'water';
    if (w.solidAt(x, y + 1) || w.solidAt(x - 1, y + 1) || w.solidAt(x + 1, y + 1)) return 'floor';
    if (w.solidAt(x - 1, y)) return 'wall-left';
    if (w.solidAt(x + 1, y)) return 'wall-right';
    if (w.solidAt(x, y - 1) || w.solidAt(x - 1, y - 1) || w.solidAt(x + 1, y - 1)) return 'ceiling';
    return 'none';
  }

  /** What the antennae and eyes pick up, each from 0 to 1. */
  private sense(sim: Simulation, x: number, y: number): Senses {
    const w = sim.world;
    let nearest = 99;
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        if (w.get(x + dx, y + dy) === Material.Food) nearest = Math.min(nearest, Math.max(Math.abs(dx), Math.abs(dy)));
      }
    }
    const i = sim.idx(x, y);
    const home = sim.homeDist[i];
    return {
      food: nearest > 10 ? 0 : 1 - nearest / 11,
      trail: Math.min(1, sim.trail[i]),
      alarm: Math.min(1, sim.alarm[i]),
      home: home === UNREACHABLE ? 0 : Math.max(0, 1 - home / 80),
      light: sim.outside(x, y) ? sim.daylight() : 0,
      water: w.get(x, y) === Material.Water ? 1 : 0,
    };
  }

  /** Words for what the ant is up to. */
  describe(sim: Simulation): { title: string; doing: string } {
    const a = sim.ants;
    const id = this.id;
    const caste = a.caste[id] as Caste;
    const job = caste === Caste.Worker ? ` · ${TASK_NAMES[a.task[id]] ?? ''}` : '';
    let doing = 'se repose';
    if (sim.held === id) doing = 'est tenue par ta main';
    else if (this.surface === 'water') doing = 'nage vers l\'air';
    else if (this.surface === 'none') doing = 'tombe, les pattes écartées';
    else if (a.digTarget[id] >= 0) doing = 'creuse avec ses mandibules';
    else if (a.carrying[id] === Item.Food) doing = 'rapporte de la nourriture';
    else if (a.carrying[id] === Item.Soil) doing = 'porte une boulette de terre';
    else if (a.carrying[id] === Item.Brood) doing = 'porte du couvain';
    else if (a.carrying[id] === Item.Corpse) doing = 'emporte une fourmi morte';
    else if (this.speed > 0.5) doing = this.surface === 'ceiling' ? 'marche au plafond' : this.surface.startsWith('wall') ? 'grimpe le long de la paroi' : 'marche';
    return { title: `${CASTE_NAMES[caste]}${job} n°${id}`, doing };
  }

  /** Draws the ant in side view, its legs, the CPG phases and the brain's readings. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number, sim: Simulation): void {
    ctx.clearRect(0, 0, width, height);
    if (!this.valid(sim)) {
      ctx.fillStyle = '#f3e9dc';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillText('Touche une fourmi avec l\'outil 🧠 pour voir son cerveau.', 10, 24);
      return;
    }
    const viewW = Math.min(width * 0.56, 300);
    this.drawBody(ctx, viewW, height, sim);
    const dial = Math.min(64, height * 0.3);
    this.drawCpg(ctx, viewW + 10, 4, dial);
    this.drawReadings(ctx, viewW + 10, dial + 14, height, width - viewW - 12);
  }

  private drawBody(ctx: CanvasRenderingContext2D, w: number, h: number, sim: Simulation): void {
    const a = sim.ants;
    const caste = a.caste[this.id] as Caste;
    const big = caste === Caste.Queen ? 1.25 : caste === Caste.Soldier ? 1.15 : 1;
    const facing = a.facing[this.id] || 1;
    // A pale lit backdrop so the dark ant reads clearly.
    ctx.fillStyle = this.surface === 'water' ? '#3d6f9e' : '#d9c39a';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h - 16, 6);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h - 16);
    ctx.clip();
    const cx = w / 2;
    const cy = (h - 16) * 0.5;
    const zoom = Math.min(w / 210, (h - 16) / 150);
    const rotation = { floor: 0, 'wall-left': Math.PI / 2, 'wall-right': -Math.PI / 2, ceiling: Math.PI, none: 0, water: 0 }[this.surface];

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom);
    ctx.rotate(rotation);
    const groundY = 34;
    // The surface the feet grip, scrolling under the planted feet.
    if (this.surface !== 'none' && this.surface !== 'water') {
      ctx.fillStyle = '#7a5a3c';
      ctx.fillRect(-w, groundY, w * 2, 40);
      ctx.fillStyle = '#5e4430';
      const shift = ((this.groundShift * facing) % 18 + 18) % 18;
      for (let gx = -w; gx < w; gx += 18) ctx.fillRect(gx - shift, groundY + 6, 6, 3);
    }
    if (this.surface === 'water') {
      ctx.fillStyle = 'rgba(70, 140, 220, 0.5)';
      ctx.fillRect(-w, -40, w * 2, 120);
    }
    ctx.scale(facing * big, big);

    const color = caste === Caste.Soldier ? '#5a2416' : caste === Caste.Queen ? '#3b1d10' : '#2a1a12';
    const hipY = 6;
    // Legs: far side (right legs when facing right) behind the body, near side in front.
    const near = facing > 0 ? [0, 1, 2] : [3, 4, 5];
    const far = facing > 0 ? [3, 4, 5] : [0, 1, 2];
    for (const i of far) this.drawLeg(ctx, i, hipY, groundY, '#4a3428', 0.7);
    // Gaster, petiole, thorax, head.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(-36, -2, 26, 17, -0.15, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-8, 2, 6, 5, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(14, 0, 18, 9, 0.1, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(42, -6, 12, 10, 0, 0, TAU);
    ctx.fill();
    // Mandibles and antennae, the antennae twitching more when they pick up a smell.
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(52, -2);
    ctx.lineTo(60, 2);
    ctx.stroke();
    const twitch = Math.sin(this.time * (6 + 14 * Math.max(this.senses.food, this.senses.trail))) * 4;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(46, -14);
    ctx.lineTo(54, -30);
    ctx.lineTo(70, -28 + twitch);
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(44, -14);
    ctx.lineTo(50, -31);
    ctx.lineTo(64, -33 - twitch);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const i of near) this.drawLeg(ctx, i, hipY, groundY, '#2e2018', 1);
    ctx.restore();
    ctx.restore();

    ctx.fillStyle = '#f3e9dc';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('● patte en appui  ○ en l\'air', 4, h - 3);
  }

  /** One leg by two-segment inverse kinematics, the foot following its oscillator. */
  private drawLeg(ctx: CanvasRenderingContext2D, i: number, hipY: number, groundY: number, color: string, alpha: number): void {
    const k = i % 3; // 0 front, 1 middle, 2 hind
    const hipX = [24, 14, 4][k];
    const footRest = [58, 16, -40][k];
    const phase = this.cpg.phases[i] / TAU;
    const mag = this.cpg.mags[i];
    const stride = 26 * mag;
    let fx: number;
    let fy: number;
    if (this.surface === 'none') {
      // Falling: legs splayed out, reaching for something to hold.
      fx = footRest * 1.15;
      fy = groundY - 10 + Math.sin(this.time * 9 + i) * 4;
    } else if (this.surface === 'water') {
      fx = footRest + Math.sin(this.time * 10 + i * 2) * 12;
      fy = groundY - 6 + Math.cos(this.time * 10 + i * 2) * 6;
    } else if (phase < SWING) {
      const u = phase / SWING;
      fx = footRest - stride / 2 + stride * u;
      fy = groundY - Math.sin(Math.PI * u) * 12 * Math.min(1, mag * 2);
    } else {
      const u = (phase - SWING) / (1 - SWING);
      fx = footRest + stride / 2 - stride * u;
      fy = groundY;
    }
    // Femur and tibia lengths; the knee bends upwards like an insect's.
    const L1 = k === 2 ? 34 : 28;
    const L2 = k === 2 ? 40 : 32;
    const dx = fx - hipX;
    const dy = fy - hipY;
    const d = Math.min(L1 + L2 - 0.01, Math.hypot(dx, dy));
    const base = Math.atan2(dy, dx);
    const bend = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
    const knee = base - Math.sign(dx || 1) * bend;
    const kx = hipX + L1 * Math.cos(knee);
    const ky = hipY + L1 * Math.sin(knee);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kx, ky);
    ctx.lineTo(fx, fy);
    ctx.stroke();
    // Foot pad: filled while adhesion is on.
    const stuck = this.surface !== 'none' && this.surface !== 'water' && this.cpg.adhered(i);
    ctx.beginPath();
    ctx.arc(fx, fy, 3, 0, TAU);
    if (stuck) {
      ctx.fillStyle = i % 2 === 0 ? '#e8b04a' : '#7fc2e6';
      ctx.fill();
    } else {
      ctx.strokeStyle = '#f3e9dc';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** The six oscillators as hands on a dial: the two tripods point opposite ways. */
  private drawCpg(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
    const r = size / 2;
    const cx = x + r;
    const cy = y + r;
    ctx.strokeStyle = 'rgba(243, 233, 220, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    // The swing part of the cycle.
    ctx.strokeStyle = 'rgba(243, 233, 220, 0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + SWING * TAU);
    ctx.stroke();
    ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i < 6; i++) {
      const ang = this.cpg.phases[i] - Math.PI / 2;
      const rr = r * (0.35 + 0.6 * Math.min(1, this.cpg.mags[i]));
      ctx.fillStyle = i % 2 === 0 ? '#e8b04a' : '#7fc2e6';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 3.5, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = '#f3e9dc';
    ctx.fillText('CPG', x + size + 6, y + 12);
    ctx.fillStyle = '#e8b04a';
    ctx.fillText(`A ${LEG_NAMES[0]} ${LEG_NAMES[2]} ${LEG_NAMES[4]}`, x + size + 6, y + 26);
    ctx.fillStyle = '#7fc2e6';
    ctx.fillText(`B ${LEG_NAMES[3]} ${LEG_NAMES[5]} ${LEG_NAMES[1]}`, x + size + 6, y + 40);
  }

  private drawReadings(ctx: CanvasRenderingContext2D, x: number, top: number, h: number, w: number): void {
    const s = this.senses;
    const rows: Array<[string, number]> = [
      ['Ordre G', this.driveL],
      ['Ordre D', this.driveR],
      ['Nourrit.', s.food],
      ['Piste', s.trail],
      ['Alarme', s.alarm],
      ['Nid', s.home],
      ['Lumière', s.light],
      ['Eau', s.water],
    ];
    const rowH = Math.min(15, (h - top) / rows.length);
    ctx.font = '10px ui-monospace, monospace';
    rows.forEach(([label, v], k) => {
      const ry = top + k * rowH;
      ctx.fillStyle = '#f3e9dc';
      ctx.fillText(label, x, ry + 9);
      const bx = x + 60;
      const bw = Math.max(20, w - 62);
      ctx.fillStyle = 'rgba(243, 233, 220, 0.15)';
      ctx.fillRect(bx, ry + 2, bw, 8);
      ctx.fillStyle = k < 2 ? (v < 0 ? '#d0453a' : '#8ace00') : '#e8b04a';
      ctx.fillRect(bx, ry + 2, bw * Math.min(1, Math.abs(v)), 8);
    });
  }
}
