import { Material } from './materials';
import { Rng } from './rng';
import type { World } from './world';

/**
 * One point of the nest plan. A room is a flat, wide chamber; a joint is a
 * bend in a shaft. Every node hangs off its parent by a tunnel, and parents
 * always come before their children, so any prefix of the plan is one
 * connected nest.
 */
export interface PlanNode {
  x: number;
  y: number;
  /** Half width and half height of a room; 0 for a shaft joint. */
  rx: number;
  ry: number;
  parent: number;
  room: boolean;
}

/** Half width of shafts and tunnels: two cells wide. */
export const TUNNEL_RADIUS = 1;

/**
 * Lays out a whole nest the way real ones look when cast in plaster
 * (Tschinkel's casts of harvester and fire ant nests): a main shaft that
 * winds downwards from the entrance, flat horizontal chambers opening off its
 * sides, wide near the surface and smaller deeper down, and side shafts that
 * branch off some chambers with chambers of their own. Rock is dug around,
 * never through, so seams are crossed only where they have gaps.
 */
export function generateNestPlan(world: World, entranceX: number, seed: number): PlanNode[] {
  const rng = new Rng(seed ^ 0x51ed27);
  const surface = world.surface[entranceX];
  const below = world.height - surface;
  const scale = Math.min(1, Math.max(0.45, below / 200));
  const bottom = world.height - 6;
  const nodes: PlanNode[] = [];

  const rockOnSegment = (ax: number, ay: number, bx: number, by: number): boolean => {
    const len = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let k = 0; k <= len; k++) {
      const x = ax + ((bx - ax) * k) / len;
      const y = ay + ((by - ay) * k) / len;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (world.get(Math.round(x + dx), Math.round(y + dy)) === Material.Rock) return true;
        }
      }
    }
    return false;
  };
  const rockInRoom = (cx: number, cy: number, rx: number, ry: number): boolean => {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) {
      for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
        if (inRoom(x, y, cx, cy, rx + 1, ry + 1) && world.get(x, y) === Material.Rock) return true;
      }
    }
    return false;
  };
  const roomFree = (cx: number, cy: number, rx: number, ry: number): boolean => {
    if (cx - rx < 3 || cx + rx > world.width - 4 || cy + ry > bottom) return false;
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++) if (cy - ry <= world.surface[x] + 4 * scale) return false;
    for (const n of nodes) {
      if (!n.room) continue;
      if (Math.abs(n.x - cx) < n.rx + rx + 3 && Math.abs(n.y - cy) < n.ry + ry + 3) return false;
    }
    return !rockInRoom(cx, cy, rx, ry);
  };

  /** Adds a room beside a shaft joint, on whichever side fits. */
  const addRoom = (joint: number, depthFraction: number, preferSide: number): number => {
    const j = nodes[joint];
    const size = 1 - 0.45 * depthFraction;
    for (const side of [preferSide, -preferSide]) {
      for (const shrink of [1, 0.75, 0.55]) {
        const rx = Math.max(3, Math.round((6 + rng.int(0, 4)) * scale * size * shrink));
        const ry = Math.max(1.5, rx * 0.5);
        const cx = Math.round(j.x + side * (rx + 1));
        const cy = j.y + Math.round(rng.next() * 2 - 1);
        if (!roomFree(cx, cy, rx, ry) || rockOnSegment(j.x, j.y, cx, cy)) continue;
        nodes.push({ x: cx, y: cy, rx, ry, parent: joint, room: true });
        return nodes.length - 1;
      }
    }
    return -1;
  };

  /** Digs a shaft down from a node, adding rooms off its sides as it goes. */
  const shaft = (from: number, slope: number, maxLength: number, depth: number): void => {
    let prev = from;
    let x = nodes[from].x;
    let y = nodes[from].y;
    let drift = slope;
    let nextRoom = Math.round((6 + rng.int(0, 4)) * scale);
    let side = rng.next() < 0.5 ? 1 : -1;
    for (let travelled = 0; travelled < maxLength; ) {
      const step = Math.max(3, Math.round(5 * scale));
      drift = Math.max(-1.2, Math.min(1.2, drift * 0.7 + (rng.next() - 0.5) * 0.9 + slope * 0.3));
      let placed = false;
      // Try the planned bend first, then sidestep to find a way around rock.
      for (const shift of [0, 1, -1, 2, -2, 3, -3, 5, -5, 7, -7, 10, -10, 14, -14, 18, -18, 24, -24]) {
        const nx = Math.round(x + drift * step) + shift;
        const ny = y + step;
        if (ny > bottom || nx < 4 || nx > world.width - 5) break;
        if (rockOnSegment(x, y, nx, ny)) continue;
        nodes.push({ x: nx, y: ny, rx: 0, ry: 0, parent: prev, room: false });
        prev = nodes.length - 1;
        travelled += Math.hypot(nx - x, ny - y);
        x = nx;
        y = ny;
        placed = true;
        break;
      }
      // No way down: try a short level gallery to either side, as ants do along a hard layer.
      if (!placed) {
        for (const k of [1, -1, 2, -2, 3, -3]) {
          const nx = x + k * step;
          if (nx < 4 || nx > world.width - 5 || y + 1 > bottom || rockOnSegment(x, y, nx, y + 1)) continue;
          nodes.push({ x: nx, y: y + 1, rx: 0, ry: 0, parent: prev, room: false });
          prev = nodes.length - 1;
          travelled += Math.abs(nx - x);
          x = nx;
          y += 1;
          placed = true;
          break;
        }
      }
      if (!placed) return;
      if (travelled >= nextRoom) {
        const fraction = (y - surface) / below;
        const room = addRoom(prev, fraction, side);
        if (room >= 0) {
          side = rng.next() < 0.75 ? -side : side;
          // Some rooms lead on to a side shaft with rooms of its own.
          if (depth < 2 && nodes.length > 6 && rng.next() < 0.3) {
            const r = nodes[room];
            const end = nodes.push({ x: Math.round(r.x + Math.sign(r.x - x) * r.rx * 0.7), y: r.y, rx: 0, ry: 0, parent: room, room: false }) - 1;
            shaft(end, Math.sign(r.x - x) * 0.8, maxLength * 0.45, depth + 1);
          }
        }
        nextRoom = travelled + Math.round((10 + rng.int(0, 7)) * scale * (1 + fraction));
      }
    }
  };

  nodes.push({ x: entranceX, y: surface, rx: 0, ry: 0, parent: -1, room: false });
  shaft(0, 0, (bottom - surface) * 1.5, 0);
  // A small plan (the main shaft hit rock early): branch new shafts off existing rooms.
  for (let tries = 0; tries < 12 && nodes.filter((n) => n.room).length < 24; tries++) {
    const rooms = nodes.map((n, i) => (n.room ? i : -1)).filter((i) => i >= 0);
    if (!rooms.length) break;
    const from = rooms[rng.int(0, rooms.length - 1)];
    const r = nodes[from];
    const dir = rng.next() < 0.5 ? -1 : 1;
    const end = nodes.push({ x: Math.round(r.x + dir * r.rx * 0.7), y: r.y, rx: 0, ry: 0, parent: from, room: false }) - 1;
    shaft(end, dir * 0.9, (bottom - r.y) * 0.8, 1);
  }

  // Dig order: shallower parts first, but never a node before its parent.
  const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].y - nodes[b].y || a - b);
  const placed = new Set<number>();
  const sorted: number[] = [];
  const visit = (i: number) => {
    if (placed.has(i)) return;
    if (nodes[i].parent >= 0) visit(nodes[i].parent);
    placed.add(i);
    sorted.push(i);
  };
  for (const i of order) visit(i);
  const remap = new Map(sorted.map((old, k) => [old, k]));
  return sorted.map((old) => {
    const n = nodes[old];
    return { ...n, parent: n.parent >= 0 ? remap.get(n.parent)! : -1 };
  });
}

/** Chambers have a domed roof and a flatter floor. */
export function inRoom(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / (y > cy ? ry * 0.6 : ry);
  return dx * dx + dy * dy <= 1;
}

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by). */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len = vx * vx + vy * vy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
}

/** Marks every cell of the first `count` nodes (their rooms and tunnels) in `mask`. */
export function rasterizePlan(world: World, nodes: PlanNode[], count: number, mask: Uint8Array): number[] {
  mask.fill(0);
  const cells: number[] = [];
  const mark = (x: number, y: number) => {
    if (!world.inBounds(x, y) || y >= world.height - 3) return;
    const i = world.index(x, y);
    if (mask[i]) return;
    mask[i] = 1;
    cells.push(i);
  };
  for (let k = 0; k < Math.min(count, nodes.length); k++) {
    const n = nodes[k];
    if (n.room) {
      for (let y = Math.floor(n.y - n.ry); y <= Math.ceil(n.y + n.ry); y++) {
        for (let x = Math.floor(n.x - n.rx); x <= Math.ceil(n.x + n.rx); x++) {
          if (inRoom(x, y, n.x, n.y, n.rx, n.ry)) mark(x, y);
        }
      }
    }
    if (n.parent < 0) continue;
    const p = nodes[n.parent];
    const r = TUNNEL_RADIUS;
    for (let y = Math.floor(Math.min(p.y, n.y) - 1); y <= Math.ceil(Math.max(p.y, n.y) + 1); y++) {
      for (let x = Math.floor(Math.min(p.x, n.x) - 1); x <= Math.ceil(Math.max(p.x, n.x) + 1); x++) {
        if (segmentDistance(x, y, p.x + 0.5, p.y, n.x + 0.5, n.y) <= r) mark(x, y);
      }
    }
  }
  return cells;
}
