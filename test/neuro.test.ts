import { describe, expect, it } from 'vitest';
import { CpgNetwork } from '../src/game2d/neuro';

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
