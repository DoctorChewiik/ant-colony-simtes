import { Caste, Item, Material, NEURO, UNREACHABLE, type CpgNetwork, type NeuroBrain, type NeuroGoal, type Simulation } from '../core';

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
const SWING = NEURO.swing;

const LEG_NAMES = ['AG', 'MG', 'PG', 'AD', 'MD', 'PD'];
const CASTE_NAMES: Record<number, string> = {
  [Caste.Worker]: 'Ouvrière',
  [Caste.Soldier]: 'Soldat',
  [Caste.Queen]: 'Reine',
  [Caste.Male]: 'Mâle',
};
const GOALS: Record<NeuroGoal, string> = {
  food: 'remonte l\'odeur de nourriture',
  home: 'suit l\'odeur du nid',
  air: 'remonte vers l\'air libre',
  explore: 'explore et cherche une odeur',
  rest: 'se repose au nid',
  reflex: 'agit par réflexe',
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

/**
 * The panel view of the neuromechanical ant. The controller itself (CPG,
 * antennae, brain) runs in the simulation, in core/neuro.ts; this only draws it.
 */
export class NeuroAnt {
  private time = 0;
  /** Ground travelled, so the ground under the planted feet scrolls with them. */
  private groundShift = 0;
  private brain: NeuroBrain | null = null;
  surface: Surface = 'floor';
  senses: Senses = { food: 0, trail: 0, alarm: 0, home: 0, light: 0, water: 0 };

  get id(): number {
    return this.brain?.id ?? -1;
  }

  private get cpg(): CpgNetwork {
    return this.brain!.cpg;
  }

  /** Moves the controller onto another ant (the player's queen keeps her own controls). */
  select(sim: Simulation, id: number): void {
    this.brain = sim.neuro;
    if (id >= 0 && id !== sim.player && id !== sim.neuro.id) {
      sim.neuro.auto = false;
      sim.neuro.attach(sim, id);
    }
  }

  /** The controller has a living host. */
  valid(sim: Simulation): boolean {
    this.brain = sim.neuro;
    return sim.neuro.valid(sim);
  }

  update(sim: Simulation, dtMs: number): void {
    if (!this.valid(sim) || dtMs <= 0) return;
    const dt = Math.min(0.05, dtMs / 1000);
    this.time += dt;
    const x = sim.ants.x[this.id];
    const y = sim.ants.y[this.id];
    this.surface = this.findSurface(sim, x, y);
    this.senses = this.sense(sim, x, y);
    // Stance feet move back at the stride speed; the ground moves with them.
    const b = this.brain!;
    if (b.driveL > 0 && b.driveR > 0) {
      const stride = (26 * (this.cpg.mags[0] + this.cpg.mags[3])) / 2;
      const freq = NEURO.stepFrequency * (0.5 + 0.5 * Math.min(1, b.driveL));
      this.groundShift += (stride * freq * dt) / (1 - SWING);
    }
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
    // The brain makes it a forager whatever job the colony had given it.
    const job = caste === Caste.Worker ? ' · fourrageuse neuro' : '';
    let doing = 'se repose';
    if (sim.held === id) doing = 'est tenue par ta main';
    else if (this.surface === 'water') doing = 'nage vers l\'air';
    else if (this.surface === 'none') doing = 'tombe, les pattes écartées';
    else if (a.digTarget[id] >= 0) doing = 'creuse avec ses mandibules';
    else if (a.carrying[id] === Item.Food) doing = 'rapporte de la nourriture en suivant l\'odeur du nid';
    else if (a.carrying[id] === Item.Soil) doing = 'porte une boulette de terre';
    else if (a.carrying[id] === Item.Brood) doing = 'porte du couvain';
    else if (a.carrying[id] === Item.Corpse) doing = 'emporte une fourmi morte';
    else doing = GOALS[this.brain!.goal];
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
      ['Ordre G', this.brain!.driveL],
      ['Ordre D', this.brain!.driveR],
      ['Antenne G', this.brain!.smellL],
      ['Antenne D', this.brain!.smellR],
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
      ctx.fillStyle = k < 2 ? (v < 0 ? '#d0453a' : '#8ace00') : k < 4 ? '#7fc2e6' : '#e8b04a';
      ctx.fillRect(bx, ry + 2, bw * Math.min(1, Math.abs(v)), 8);
    });
  }
}
