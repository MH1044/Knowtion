/**
 * @knowtion/simulator — deterministic multi-device sync simulation.
 *
 * There is no TigerBeetle-grade simulation framework for JavaScript, so this is ours.
 * It is the highest-value code in the repository per test written: a distributed bug you
 * cannot reproduce is one you cannot fix, and every failure here arrives with the seed
 * that produced it.
 */

export { runSimulation, InvariantViolation } from './simulator.js';
export type { SimulationOptions, SimulationResult } from './simulator.js';
export { SimulatedDevice } from './device.js';
export type { Action, DeviceOptions } from './device.js';
export { VirtualClock, choose, seededRandom } from './deterministic.js';
