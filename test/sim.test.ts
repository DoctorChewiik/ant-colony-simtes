import { describe, expect, it } from 'vitest';
import { IDLE, Item, Material, Simulation, type AntInput } from '../src/core';

const opts = { seed: 42, width: 120, height: 80 };

function input(partial: Partial<AntInput>): AntInput {
  return { ...IDLE, ...partial };
}

function run(sim: Simulation, inp: AntInput, ticks: number) {
  for (let i = 0; i < ticks; i++) sim.step(inp);
}

describe('world generation', () => {
  it('is deterministic for a seed', () => {
    expect(new Simulation(opts).hash()).toBe(new Simulation(opts).hash());
    expect(new Simulation(opts).hash()).not.toBe(new Simulation({ ...opts, seed: 7 }).hash());
  });

  it('puts grass on the surface and bedrock at the bottom', () => {
    const { world } = new Simulation(opts);
    for (let x = 0; x < world.width; x++) {
      expect(world.get(x, world.surface[x])).toBe(Material.Grass);
      expect(world.get(x, world.surface[x] - 1)).toBe(Material.Air);
      expect(world.get(x, world.height - 1)).toBe(Material.Rock);
    }
  });
});

describe('the player ant', () => {
  it('spawns standing on the surface', () => {
    const sim = new Simulation(opts);
    const { ants, world } = sim;
    expect(world.solidAt(ants.x[0], ants.y[0])).toBe(false);
    expect(sim.hasGrip(ants.x[0], ants.y[0])).toBe(true);
  });

  it('walks along the ground', () => {
    const sim = new Simulation(opts);
    const x0 = sim.ants.x[0];
    run(sim, input({ moveX: 1 }), 30);
    expect(sim.ants.x[0]).toBeGreaterThan(x0 + 5);
    expect(sim.hasGrip(sim.ants.x[0], sim.ants.y[0])).toBe(true);
  });

  it('digs down, picks up the soil and drops it again', () => {
    const sim = new Simulation(opts);
    const { ants, world } = sim;
    const x = ants.x[0];
    const below = ants.y[0] + 1;
    expect(world.get(x, below)).toBe(Material.Grass);

    sim.step(input({ moveY: 1 })); // aim down; blocked by ground so the ant stays put
    run(sim, input({ dig: true }), 20);
    expect(world.get(x, below)).toBe(Material.Air);
    expect(ants.carrying[0]).toBe(Item.Soil);
    expect(sim.stats.dug).toBe(1);

    // Put the pellet back into the hole.
    sim.step(input({ drop: true, target: { x, y: below } }));
    expect(ants.carrying[0]).toBe(Item.None);
    expect(sim.stats.dropped).toBe(1);
    run(sim, IDLE, 40);
    // The loose pellet settled somewhere solid, never inside the ant.
    let loose = 0;
    for (const c of world.cells) if (c === Material.Loose) loose++;
    expect(loose).toBe(1);
  });

  it('cannot dig rock', () => {
    const sim = new Simulation(opts);
    const { ants, world } = sim;
    world.set(ants.x[0] + 1, ants.y[0], Material.Rock);
    run(sim, input({ dig: true, target: { x: ants.x[0] + 1, y: ants.y[0] } }), 100);
    expect(world.get(ants.x[0] + 1, ants.y[0])).toBe(Material.Rock);
    expect(ants.carrying[0]).toBe(Item.None);
  });

  it('falls when nothing is left to hold', () => {
    const sim = new Simulation(opts);
    const { ants, world } = sim;
    const x = ants.x[0];
    const y = ants.y[0];
    for (let dy = -1; dy <= 6; dy++) for (let dx = -1; dx <= 1; dx++) world.set(x + dx, y + dy, Material.Air);
    run(sim, IDLE, 10);
    expect(ants.y[0]).toBe(y + 6);
  });
});

describe('loose soil', () => {
  it('falls and piles up like sand', () => {
    const sim = new Simulation(opts);
    const { world } = sim;
    const x = 10;
    for (let y = 0; y < 30; y++) world.set(x, y, Material.Air);
    world.set(x, 2, Material.Loose);
    // Wake it through a drop-equivalent: dig a neighbour above it.
    (sim as unknown as { settling: Set<number> }).settling.add(world.index(x, 2));
    run(sim, IDLE, 60);
    let y = 0;
    while (world.get(x, y) !== Material.Loose && y < world.height) y++;
    expect(world.solidAt(x, y + 1)).toBe(true);
    expect(y).toBeGreaterThan(2);
  });
});

describe('determinism', () => {
  it('same inputs give the same state', () => {
    const script = (sim: Simulation) => {
      run(sim, input({ moveX: -1 }), 15);
      sim.step(input({ moveY: 1 }));
      run(sim, input({ dig: true }), 15);
      sim.step(input({ moveX: 1 }));
      sim.step(input({ drop: true }));
      run(sim, input({ moveX: 1, dig: true }), 40);
    };
    const a = new Simulation(opts);
    const b = new Simulation(opts);
    script(a);
    script(b);
    expect(a.hash()).toBe(b.hash());
  });
});
