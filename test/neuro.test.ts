import { describe, expect, it } from 'vitest';
import { Caste, CpgNetwork, IDLE, Item, Material, Simulation } from '../src/core';

const opts = { seed: 42, width: 160, height: 80 };

describe('neuro ant CPG', () => {
  it('settles into a tripod gait: the two tripods move half a cycle apart', () => {
    const cpg = new CpgNetwork();
    for (let t = 0; t < 600; t++) cpg.step(0.005, 1, 1);
    const diff = (a: number, b: number) => {
      const d = Math.abs(cpg.phases[a] - cpg.phases[b]) % (2 * Math.PI);
      return Math.min(d, 2 * Math.PI - d);
    };
    // Same tripod in phase, opposite tripods in anti-phase.
    expect(diff(0, 2)).toBeLessThan(0.2);
    expect(diff(0, 4)).toBeLessThan(0.2);
    expect(diff(0, 1)).toBeGreaterThan(Math.PI - 0.2);
    expect(diff(3, 4)).toBeGreaterThan(Math.PI - 0.2);
    expect(cpg.mags[0]).toBeGreaterThan(0.9);
  });

  it('stops stepping and keeps every foot planted with no descending drive', () => {
    const cpg = new CpgNetwork();
    for (let t = 0; t < 600; t++) cpg.step(0.005, 0, 0);
    for (let i = 0; i < 6; i++) expect(cpg.adhered(i)).toBe(true);
  });
});

describe('neuro controller in the game', () => {
  /** A worker on the open ground, the food some way off along the surface. */
  function setUp(foodDx: number) {
    const sim = new Simulation(opts);
    const x0 = sim.colony.nestX + 25;
    const y0 = sim.topSolid(x0) - 1;
    const id = sim.spawnAnt(x0, y0, Caste.Worker);
    sim.neuro.attach(sim, id);
    sim.ants.facing[id] = foodDx > 0 ? -1 : 1; // facing away: it has to turn round
    const fx = x0 + foodDx;
    sim.world.set(fx, sim.topSolid(fx) - 1, Material.Food);
    return { sim, id };
  }

  it('picks the first worker by itself', () => {
    const sim = new Simulation(opts);
    expect(sim.neuro.id).toBe(-1);
    const id = sim.spawnAnt(sim.colony.nestX + 3, sim.topSolid(sim.colony.nestX + 3) - 1, Caste.Worker);
    sim.step(IDLE);
    expect(sim.neuro.id).toBe(id);
  });

  it('smells food behind it, turns round, walks to it on its own legs and brings it home', () => {
    const { sim, id } = setUp(12);
    expect(sim.shelter()).toBe(false);
    let picked = -1;
    let delivered = -1;
    const food0 = sim.colony.food;
    for (let t = 0; t < 30 * 90 && delivered < 0; t++) {
      sim.step(IDLE);
      if (picked < 0 && sim.ants.carrying[id] === Item.Food) picked = t;
      if (picked >= 0 && sim.ants.carrying[id] === Item.None) delivered = t;
    }
    expect(picked).toBeGreaterThan(0);
    expect(picked).toBeLessThan(30 * 20);
    expect(delivered).toBeGreaterThan(picked);
    expect(sim.colony.food).toBeGreaterThan(food0);
  });

  it('takes one step per tripod touchdown, never more', () => {
    const { sim } = setUp(30);
    for (let t = 0; t < 30 * 5; t++) sim.step(IDLE);
    expect(sim.neuro.walked).toBeGreaterThan(10);
    expect(sim.neuro.walked).toBeLessThanOrEqual(sim.neuro.touchdowns);
  });
});
