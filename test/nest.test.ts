import { describe, expect, it } from 'vitest';
import { DAY_TICKS, Material, SEASON_DAYS, Season, Simulation, generateNestPlan, thinkQueen } from '../src/core';

const opts = { seed: 1234, width: 400, height: 260 };

describe('procedural nest', () => {
  it('lays out a connected nest of rooms that avoids rock', () => {
    const sim = new Simulation(opts);
    const plan = generateNestPlan(sim.world, sim.entranceX, 1234);
    const rooms = plan.filter((n) => n.room);
    expect(rooms.length).toBeGreaterThanOrEqual(8);
    plan.forEach((n, i) => {
      if (i > 0) expect(n.parent).toBeLessThan(i);
      expect(sim.world.get(Math.round(n.x), Math.round(n.y))).not.toBe(Material.Rock);
    });
    // Rooms near the surface are wider than the deepest ones.
    const byDepth = [...rooms].sort((a, b) => a.y - b.y);
    const top = byDepth.slice(0, 3).reduce((s, r) => s + r.rx, 0);
    const deep = byDepth.slice(-3).reduce((s, r) => s + r.rx, 0);
    expect(top).toBeGreaterThanOrEqual(deep);
  });

  it('the queen alone digs her first chamber and lays eggs there', () => {
    const sim = new Simulation(opts);
    for (let t = 0; t < 30 * 60 * 3 && sim.brood.count === 0; t++) sim.step(thinkQueen(sim));
    expect(sim.chamberFloor(sim.chambers[0])).toBeGreaterThanOrEqual(0);
    expect(sim.brood.count).toBeGreaterThan(0);
  });
});

describe('time and weather', () => {
  it('cycles through day and night and the four seasons', () => {
    const sim = new Simulation(opts);
    expect(sim.isNight()).toBe(false);
    expect(sim.season()).toBe(Season.Spring);
    let night = false;
    for (let t = 0; t < DAY_TICKS; t++) {
      sim.step(thinkQueen(sim));
      night ||= sim.isNight();
    }
    expect(night).toBe(true);
    expect(sim.day()).toBe(2);
    (sim as unknown as { tick: number }).tick += DAY_TICKS * SEASON_DAYS * 3;
    expect(sim.season()).toBe(Season.Winter);
  });
});
