import { describe, expect, it } from 'vitest';
import { CASTES, Caste, IDLE, Material, Simulation } from '../src/core';

const opts = { seed: 42, width: 120, height: 80 };

function run(sim: Simulation, ticks: number) {
  for (let i = 0; i < ticks; i++) sim.step(IDLE);
}

/** First solid row of a column. */
function ground(sim: Simulation, x: number): number {
  let y = 0;
  while (!sim.world.solidAt(x, y)) y++;
  return y;
}

/** Carves a box of the given material with an open (air) inside. */
function box(sim: Simulation, x0: number, y0: number, w: number, h: number, wall: Material) {
  for (let y = y0 - 1; y <= y0 + h; y++) {
    for (let x = x0 - 1; x <= x0 + w; x++) {
      const inside = x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
      sim.world.set(x, y, inside ? Material.Air : wall);
    }
  }
}

describe('water', () => {
  it('falls, then spreads into a flat pool at the bottom of a basin', () => {
    const sim = new Simulation(opts);
    box(sim, 20, 40, 12, 10, Material.Rock);
    sim.pourWater(26, 41, 2);
    const poured = sim.water.count;
    expect(poured).toBeGreaterThan(5);
    run(sim, 200);
    expect(sim.water.count).toBe(poured);
    // Every cell of the pool sits on rock or other water, filling the floor row first.
    let floor = 0;
    for (let x = 20; x < 32; x++) {
      if (sim.world.get(x, 49) === Material.Water) floor++;
      for (let y = 40; y < 50; y++) {
        if (sim.world.get(x, y) === Material.Water) expect(sim.world.solidAt(x, y + 1) || sim.world.get(x, y + 1) === Material.Water).toBe(true);
      }
    }
    expect(floor).toBe(Math.min(12, poured));
  });

  it('soaks slowly into sand', () => {
    const sim = new Simulation(opts);
    box(sim, 20, 40, 12, 6, Material.Sand);
    sim.pourWater(26, 41, 1.6);
    const poured = sim.water.count;
    run(sim, 3000);
    expect(sim.water.count).toBeLessThan(poured);
  });

  it('lets sand sink through it', () => {
    const sim = new Simulation(opts);
    box(sim, 20, 40, 1, 8, Material.Rock);
    for (let y = 44; y < 48; y++) sim.pourWater(20, y, 0);
    sim.world.set(20, 40, Material.Loose);
    (sim as unknown as { settling: Set<number> }).settling.add(sim.world.index(20, 40));
    run(sim, 30);
    expect(sim.world.get(20, 47)).toBe(Material.Loose);
    // The water was pushed up above it, apart from what the loose soil drank.
    expect(sim.water.count).toBeGreaterThanOrEqual(3);
    expect(sim.world.get(20, 46)).toBe(Material.Water);
  });

  it('drowns an ant that cannot reach the air, and floats one up that can', () => {
    const sim = new Simulation(opts);
    box(sim, 20, 40, 1, 6, Material.Rock);
    for (let y = 40; y < 46; y++) sim.pourWater(20, y, 0);
    const trapped = sim.spawnAnt(20, 45, Caste.Worker);
    box(sim, 40, 40, 1, 8, Material.Rock);
    for (let y = 44; y < 48; y++) sim.pourWater(40, y, 0);
    const swimmer = sim.spawnAnt(40, 47, Caste.Worker);
    run(sim, 45 * 12);
    expect(sim.ants.alive[trapped]).toBe(0);
    expect(sim.stats.drowned).toBe(1);
    expect(sim.ants.alive[swimmer]).toBe(1);
  });
});

describe('the hand', () => {
  it('drops an ant from high up to its death, and a short drop does no harm', () => {
    const sim = new Simulation(opts);
    // A wide, deep pit: the ant falls down the middle, far from the walls.
    const x = 15;
    box(sim, x - 4, 10, 9, 60, Material.Rock);
    const high = sim.spawnAnt(x, 69, Caste.Worker);
    expect(sim.grab(x, 69)).toBe('ant');
    sim.moveHeld(x, 12);
    expect(sim.ants.y[high]).toBe(12);
    sim.dropHeld();
    run(sim, 60);
    expect(sim.ants.alive[high]).toBe(0);
    expect(sim.stats.fell).toBe(1);

    const low = sim.spawnAnt(x + 40, ground(sim, x + 40) - 1, Caste.Worker);
    sim.grab(sim.ants.x[low], sim.ants.y[low]);
    sim.moveHeld(sim.ants.x[low], sim.ants.y[low] - 3);
    sim.dropHeld();
    run(sim, 20);
    expect(sim.ants.alive[low]).toBe(1);
    expect(sim.ants.hp[low]).toBe(CASTES[Caste.Worker].maxHp);
  });

  it('picks up a block of ground, carries it and lets it fall back down', () => {
    const sim = new Simulation(opts);
    const x = 15;
    const top = ground(sim, x);
    const m = sim.world.get(x, top);
    expect(sim.grab(x, top)).toBe('block');
    sim.moveHeld(x + 3, top - 15);
    expect(sim.world.get(x + 3, top - 15)).toBe(m);
    expect(sim.world.get(x, top)).toBe(Material.Air);
    sim.dropHeld();
    run(sim, 40);
    expect(sim.world.get(x + 3, top - 15)).toBe(Material.Air);
    expect(sim.world.get(x + 3, ground(sim, x + 3))).toBe(m);
  });

  it('leaves bedrock where it is', () => {
    const sim = new Simulation(opts);
    expect(sim.grab(10, opts.height - 1)).toBe(null);
  });
});
