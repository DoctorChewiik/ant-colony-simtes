export type Axis = -1 | 0 | 1;

/** Everything a controller (player or AI) can ask one ant to do in one tick. */
export interface AntInput {
  moveX: Axis;
  moveY: Axis;
  /** Held: dig the aimed cell. */
  dig: boolean;
  /** Pressed this tick: drop what the ant carries into the aimed cell. */
  drop: boolean;
  /** Optional cell to aim at (mouse); used when it is next to the ant. */
  target: { x: number; y: number } | null;
}

export const IDLE: AntInput = { moveX: 0, moveY: 0, dig: false, drop: false, target: null };
