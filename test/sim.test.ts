import { describe, expect, it } from 'vitest';
import {
  CASTES,
  Caste,
  DigDisposal,
  FOOD_VALUE,
  IDLE,
  Item,
  Material,
  EnemyKind,
  MAX_ANTS_PER_CELL,
  STAGE_TICKS,
  Task,
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

describe('colony life', () => {
  /** A founded colony: the queen has dug a short shaft and the nest heart is at its bottom. */
  function colony(seed = 42) {
    const sim = new Simulation({ ...opts, seed, width: 160 });
    sim.digDisposal = DigDisposal.Vanish;
    for (let i = 0; i < 4; i++) {
      sim.step(input({ moveY: 1 }));
      run(sim, input({ dig: true }), 25);
      run(sim, input({ moveY: 1 }), 4);
    }
    sim.colony.food = 50;
    sim.step(input({ lay: Caste.Worker }));
    return sim;
  }

  function addAnts(sim: Simulation, n: number, caste: Caste, task?: Task) {
    const { nestX, nestY } = sim.colony;
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = sim.spawnAnt(nestX, nestY, caste);
      if (task !== undefined) sim.ants.task[id] = task;
      ids.push(id);
    }
    return ids;
  }

  it('lets a few ants share a cell so groups swarm', () => {
    const sim = colony();
    const { nestX, nestY } = sim.colony;
    addAnts(sim, MAX_ANTS_PER_CELL - 1, Caste.Worker, Task.Nurse);
    expect(sim.antsAt(nestX, nestY)).toBe(MAX_ANTS_PER_CELL);
    expect(sim.canStand(nestX, nestY)).toBe(false);
  });

  it('foragers find food on the surface and bring it home', () => {
    const sim = colony();
    addAnts(sim, 8, Caste.Worker, Task.Forage);
    const { nestX } = sim.colony;
    for (const dx of [-14, -10, 9, 13]) {
      const x = nestX + dx;
      sim.world.set(x, sim.topSolid(x) - 1, Material.Food);
      sim.foodOnMap++;
    }
    const before = sim.colony.food;
    run(sim, IDLE, 3000);
    expect(sim.stats.delivered).toBeGreaterThan(0);
    expect(sim.colony.food).toBeGreaterThan(before);
  });

  it('diggers dig the planned chambers and nothing else', () => {
    const sim = colony();
    const openBefore = sim.world.cells.map((c) => (c === Material.Air ? 1 : 0));
    const dugBefore = sim.stats.dug;
    addAnts(sim, 6, Caste.Worker, Task.Dig);
    run(sim, IDLE, 2400);
    expect(sim.stats.dug - dugBefore).toBeGreaterThan(15);
    for (let y = 0; y < sim.world.height; y++) {
      for (let x = 0; x < sim.world.width; x++) {
        if (sim.world.get(x, y) !== Material.Air || y <= sim.world.surface[x]) continue;
        if (openBefore[sim.world.index(x, y)]) continue;
        expect(sim.inPlan(x, y)).toBe(true);
      }
    }
  });

  it('diggers carry the soil out and pile it in a mound beside the entrance', () => {
    const sim = colony();
    sim.digDisposal = DigDisposal.Surface;
    const heightBefore = [...sim.world.surface].map((_, x) => sim.topSolid(x));
    addAnts(sim, 6, Caste.Worker, Task.Dig);
    run(sim, IDLE, 3000);
    let raised = 0;
    for (let x = 0; x < sim.world.width; x++) {
      for (let y = sim.topSolid(x); y < heightBefore[x]; y++) {
        if (sim.world.get(x, y) !== Material.Loose) continue;
        raised++;
        expect(Math.abs(x - sim.entranceX)).toBeLessThan(30);
      }
    }
    expect(raised).toBeGreaterThan(0);
    // The entrance stays open.
    expect(sim.exitDist[sim.idx(sim.colony.nestX, sim.colony.nestY)]).toBeLessThan(1000);
  });

  it('nurses feed the larvae, which only grow when fed', () => {
    const sim = colony();
    run(sim, IDLE, STAGE_TICKS[Stage.Egg] + 5);
    expect(sim.brood.stage[0]).toBe(Stage.Larva);
    // With a worker around, nobody feeding means the larva stops growing.
    const lazy = addAnts(sim, 1, Caste.Worker, Task.Forage)[0];
    sim.ants.x[lazy] = 5;
    const age = sim.brood.age[0];
    sim.brood.fed[0] = 0;
    for (let t = 0; t < 30; t++) {
      sim.brood.fed[0] = 0;
      sim.step(IDLE);
    }
    expect(sim.brood.age[0]).toBe(age);
    addAnts(sim, 3, Caste.Worker, Task.Nurse);
    run(sim, IDLE, 600);
    expect(sim.stats.larvaeFed).toBeGreaterThan(0);
  });

  it('nurses carry the brood into the nursery', () => {
    const sim = colony();
    addAnts(sim, 8, Caste.Worker, Task.Dig);
    run(sim, IDLE, 4000);
    expect(Math.hypot(sim.nurseryX - sim.colony.nestX, sim.nurseryY - sim.colony.nestY)).toBeGreaterThan(3);
    // The queen lays at the nest heart; nurses take the eggs to the nursery.
    for (let i = 1; i < sim.ants.count; i++) sim.ants.task[i] = Task.Nurse;
    sim.step(input({ lay: Caste.Worker }));
    expect(sim.brood.count).toBeGreaterThan(0);
    run(sim, IDLE, 600);
    expect(sim.brood.count).toBeGreaterThan(0);
    for (let i = 0; i < sim.brood.count; i++) {
      expect(sim.nurseryDist[sim.idx(sim.brood.x[i], sim.brood.y[i])]).toBeLessThanOrEqual(9);
    }
  });

  it('dead ants are carried out of the nest to a refuse pile', () => {
    const sim = colony();
    const { nestX, nestY } = sim.colony;
    addAnts(sim, 4, Caste.Worker, Task.Nurse);
    sim.world.set(nestX + 1, nestY, Material.Corpse);
    run(sim, IDLE, 3000);
    // The body was carried out and left far from the nest (spiders may have killed others since).
    expect(sim.stats.buried).toBeGreaterThanOrEqual(1);
  });

  it('hungry ants eat from the reserve, and starve when it is empty', () => {
    const sim = colony();
    const [ant] = addAnts(sim, 1, Caste.Worker, Task.Nurse);
    sim.ants.energy[ant] = 10;
    const food = sim.colony.food;
    run(sim, IDLE, 40);
    expect(sim.stats.meals).toBe(1);
    expect(sim.colony.food).toBe(food - 1);
    sim.ants.energy[ant] = 0;
    // Keep the store empty, even if a forager brings something home.
    for (let t = 0; t < 300 * 11; t++) {
      sim.colony.food = 0;
      sim.step(IDLE);
    }
    expect(sim.ants.alive[ant]).toBe(0);
    expect(sim.stats.starved).toBe(1);
  });

  it('young workers mostly nurse and old ones mostly forage', () => {
    const sim = colony();
    sim.colony.food = 1000;
    const count = (age: number, task: Task) =>
      Array.from({ length: 400 }, () => sim.pickTask(Caste.Worker, age)).filter((t) => t === task).length;
    expect(count(0, Task.Nurse)).toBeGreaterThan(count(0, Task.Forage));
    expect(count(30 * 600, Task.Forage)).toBeGreaterThan(count(30 * 600, Task.Nurse));
  });

  it('winged queens and males leave on a nuptial flight', () => {
    const sim = colony();
    addAnts(sim, 9, Caste.Worker, Task.Nurse);
    const alates = addAnts(sim, 2, Caste.Male).concat(addAnts(sim, 1, Caste.Queen));
    sim.colony.food = 1000;
    for (let t = 0; t < 30 * 200 && !sim.flightActive(); t++) sim.step(IDLE);
    expect(sim.flightActive()).toBe(true);
    for (let t = 0; t < 900; t++) sim.step(IDLE);
    for (const id of alates) expect(sim.ants.alive[id]).toBe(0);
    expect(sim.stats.flown).toBe(3);
  });

  it('ants raise the alarm and gang up to kill a spider', () => {
    const sim = colony();
    addAnts(sim, 3, Caste.Soldier);
    addAnts(sim, 6, Caste.Worker, Task.Nurse);
    const { nestX } = sim.colony;
    const sx = nestX + 6;
    const spider = sim.spawnEnemy(sx, sim.topSolid(sx) - 1, EnemyKind.Spider);
    expect(spider).toBeGreaterThanOrEqual(0);
    let alarmed = false;
    for (let t = 0; t < 1500 && sim.enemies.alive[spider]; t++) {
      sim.step(IDLE);
      if (sim.alarm.some((v) => v > 0.5)) alarmed = true;
    }
    expect(alarmed).toBe(true);
    expect(sim.enemies.alive[spider]).toBe(0);
    expect(sim.stats.enemiesKilled).toBe(1);
    // The spider's body became food.
    expect(sim.foodOnMap).toBeGreaterThan(0);
  });

  it('a spider kills a lone ant and its slot is reused', () => {
    const sim = colony();
    const x = 10;
    const y = sim.topSolid(x) - 1;
    const victim = sim.spawnAnt(x, y, Caste.Worker);
    sim.ants.task[victim] = Task.Idle;
    sim.spawnEnemy(x + 1, sim.topSolid(x + 1) - 1, EnemyKind.Spider);
    const gen = sim.ants.gen[victim];
    for (let t = 0; t < 600 && sim.ants.alive[victim]; t++) sim.step(IDLE);
    expect(sim.ants.alive[victim]).toBe(0);
    expect(sim.stats.antsLost).toBe(1);
    const again = sim.spawnAnt(sim.colony.nestX, sim.colony.nestY, Caste.Worker);
    expect(again).toBe(victim);
    expect(sim.ants.gen[again]).toBe(gen + 1);
  });

  it('a whole colony stays deterministic', () => {
    const a = colony(5);
    const b = colony(5);
    for (const sim of [a, b]) {
      addAnts(sim, 5, Caste.Worker);
      addAnts(sim, 2, Caste.Soldier);
      sim.spawnEnemy(30, sim.topSolid(30) - 1, EnemyKind.Spider);
      run(sim, IDLE, 1500);
    }
    expect(a.hash()).toBe(b.hash());
  });
});
