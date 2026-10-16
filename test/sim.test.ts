import { describe, expect, it } from 'vitest';
import {
  CASTES,
  Caste,
  DigDisposal,
  FOOD_VALUE,
  IDLE,
  Item,
  Material,
  STAGE_TICKS,
  STARTING_FOOD,
  Simulation,
  Stage,
  type AntInput,
} from '../src/core';

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
    sim.digDisposal = DigDisposal.Carry;
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

  it('starts as a founding queen', () => {
    const sim = new Simulation(opts);
    expect(sim.ants.caste[sim.player]).toBe(Caste.Queen);
    expect(sim.colony.food).toBe(STARTING_FOOD);
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

describe('dug soil', () => {
  function digBelow(sim: Simulation) {
    sim.step(input({ moveY: 1 }));
    run(sim, input({ dig: true }), 20);
  }

  it('is piled on the surface away from the hole by default', () => {
    const sim = new Simulation(opts);
    const { ants, world } = sim;
    const x = ants.x[0];
    const y = ants.y[0] + 1;
    digBelow(sim);
    expect(world.get(x, y)).toBe(Material.Air);
    expect(ants.carrying[0]).toBe(Item.None);
    run(sim, IDLE, 30);
    let piles = 0;
    for (let cx = 0; cx < world.width; cx++) {
      if (world.get(cx, sim.topSolid(cx)) === Material.Loose) {
        piles++;
        expect(Math.abs(cx - x)).toBeGreaterThanOrEqual(2);
      }
    }
    expect(piles).toBe(1);
  });

  it('can simply vanish', () => {
    const sim = new Simulation(opts);
    sim.digDisposal = DigDisposal.Vanish;
    digBelow(sim);
    expect(sim.ants.carrying[0]).toBe(Item.None);
    expect([...sim.world.cells].filter((c) => c === Material.Loose)).toHaveLength(0);
    expect(sim.stats.dug).toBe(1);
  });
});

describe('eggs and castes', () => {
  const hatchTicks = STAGE_TICKS[Stage.Egg] + STAGE_TICKS[Stage.Larva] + STAGE_TICKS[Stage.Pupa] + 5;

  it('the queen lays an egg that hatches into the chosen caste', () => {
    const sim = new Simulation(opts);
    sim.step(input({ lay: Caste.Soldier }));
    expect(sim.brood.count).toBe(1);
    expect(sim.colony.food).toBe(STARTING_FOOD - CASTES[Caste.Soldier].eggCost);
    run(sim, IDLE, STAGE_TICKS[Stage.Egg] + 1);
    expect(sim.brood.stage[0]).toBe(Stage.Larva);
    run(sim, IDLE, hatchTicks);
    expect(sim.brood.count).toBe(0);
    expect(sim.ants.count).toBe(2);
    expect(sim.ants.caste[1]).toBe(Caste.Soldier);
    expect(sim.stats.hatched).toBe(1);
  });

  it('every caste can be laid', () => {
    const sim = new Simulation(opts);
    sim.colony.food = 100;
    for (const caste of [Caste.Worker, Caste.Soldier, Caste.Queen, Caste.Male]) {
      sim.step(input({ moveX: 1 }));
      run(sim, IDLE, 40);
      sim.step(input({ lay: caste }));
    }
    run(sim, IDLE, hatchTicks + 40);
    const castes = [...sim.ants.caste.slice(1, sim.ants.count)].sort();
    expect(castes).toEqual([Caste.Worker, Caste.Soldier, Caste.Queen, Caste.Male].sort());
  });

  it('needs enough food to lay', () => {
    const sim = new Simulation(opts);
    sim.colony.food = 1;
    sim.step(input({ lay: Caste.Queen }));
    expect(sim.brood.count).toBe(0);
    expect(sim.colony.food).toBe(1);
  });
});

describe('food', () => {
  it('turns up at random on the surface over time', () => {
    const sim = new Simulation(opts);
    run(sim, IDLE, 1800);
    expect(sim.foodOnMap).toBeGreaterThan(5);
    const count = [...sim.world.cells].filter((c) => c === Material.Food).length;
    expect(count).toBe(sim.foodOnMap);
  });

  it('can be picked up and eaten to refill the reserve', () => {
    const sim = new Simulation(opts);
    const { ants, world } = sim;
    const fx = ants.x[0] + 1;
    const fy = ants.y[0];
    world.set(fx, fy, Material.Food);
    sim.foodOnMap++;
    run(sim, input({ dig: true, target: { x: fx, y: fy } }), 5);
    expect(ants.carrying[0]).toBe(Item.Food);
    sim.step(input({ eat: true }));
    expect(ants.carrying[0]).toBe(Item.None);
    expect(sim.colony.food).toBe(STARTING_FOOD + FOOD_VALUE);
  });
});
