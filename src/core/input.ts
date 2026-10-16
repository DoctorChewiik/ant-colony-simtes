import type { Caste } from './ants';

export type Axis = -1 | 0 | 1;

/** Everything a controller (player or AI) can ask one ant to do in one tick. */
export interface AntInput {
  moveX: Axis;
  moveY: Axis;
  /** Held: dig the aimed cell. */
  dig: boolean;
  /** Pressed this tick: drop what the ant carries into the aimed cell. */
  drop: boolean;
  /** Pressed this tick: eat the food the ant carries, adding it to the colony's reserve. */
  eat: boolean;
  /** Pressed this tick: a queen lays an egg of this caste where she stands. */
  lay: Caste | null;
  /** Optional cell to aim at (mouse); used when it is next to the ant. */
  target: { x: number; y: number } | null;
}

export const IDLE: AntInput = {
  moveX: 0,
  moveY: 0,
  dig: false,
  drop: false,
  eat: false,
  lay: null,
  target: null,
};
