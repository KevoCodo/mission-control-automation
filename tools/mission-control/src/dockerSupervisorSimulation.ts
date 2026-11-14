/**
 * Inert supervisor fixture state machine.
 * No Docker, OS process, timers, network, persistence, or trusted permission APIs.
 * Caller events are claims, NOT proof of a real container or verified cleanup.
 */
export type SimulatedWorkerPhase =
  | 'BLOCKED' | 'SIMULATED_ACTIVE' | 'CLEANUP_REQUIRED' | 'CLOSED_CLAIMED' | 'QUARANTINED';
export type SimulatedWorkerEvent =
  | { type: 'FIXTURE_STARTED'; nowMs: number }
  | { type: 'HEARTBEAT'; nowMs: number }
  | { type: 'STOP_REQUESTED'; nowMs: number }
  | { type: 'FIXTURE_EXITED'; nowMs: number }
  | { type: 'CLEANUP_CLAIMED'; nowMs: number; containerAbsent: boolean; descendantsAbsent: boolean; mountsAbsent: boolean }
  | { type: 'CLEANUP_FAILED'; nowMs: number };
export interface SimulatedSupervisorState {
  version: 1;
  phase: SimulatedWorkerPhase;
  startedMs: number | null;
  lastObservedMs: number | null;
  deadlineMs: number | null;
  stopLatched: boolean;
  cleanupRequired: boolean;
  reason: string;
  /** Always false: these fixture events are not independent security evidence. */
  executionAuthorized: false;
  independentlyVerified: false;
}
export type SimulatedSupervisorDecision =
  | { action: 'DENY'; reason: string }
  | { action: 'REQUEST_CLEANUP'; reason: string }
  | { action: 'NO_ACTION'; reason: string };

export const MAX_FIXTURE_RUNTIME_MS = 300_000;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER - MAX_FIXTURE_RUNTIME_MS;
const validTime = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_TIMESTAMP;
const noGo = (reason: string): SimulatedSupervisorDecision => ({ action: 'DENY', reason });
const cleanup = (reason: string): SimulatedSupervisorDecision => ({ action: 'REQUEST_CLEANUP', reason });
const idle = (reason: string): SimulatedSupervisorDecision => ({ action: 'NO_ACTION', reason });

export function initialSimulatedSupervisor(): SimulatedSupervisorState {
  return {
    version: 1, phase: 'BLOCKED', startedMs: null, lastObservedMs: null,
    deadlineMs: null, stopLatched: false, cleanupRequired: false,
    reason: 'NO_GATE_A_AUTHORIZATION',
    executionAuthorized: false, independentlyVerified: false
  };
}

/**
 * Model how a future trusted host supervisor should respond to observations.
 * Even FIXTURE_STARTED represents synthetic input only; this never enables launch.
 */
export function advanceSimulatedSupervisor(
  state: SimulatedSupervisorState, event: SimulatedWorkerEvent
): { state: SimulatedSupervisorState; decision: SimulatedSupervisorDecision } {
  if (!validTime(event?.nowMs) ||
      (state.lastObservedMs !== null && event.nowMs < state.lastObservedMs)) {
    const next: SimulatedSupervisorState = {
      ...state, phase: 'QUARANTINED', stopLatched: true, cleanupRequired: true,
      reason: 'UNTRUSTED_OR_NONMONOTONIC_CLOCK'
    };
    return { state: next, decision: cleanup(next.reason) };
  }
  const observed = { ...state, lastObservedMs: event.nowMs };
  if (state.phase === 'QUARANTINED')
    return { state: { ...observed, stopLatched: true, cleanupRequired: true }, decision: cleanup('QUARANTINED') };
  if (event.type === 'STOP_REQUESTED') {
    const next: SimulatedSupervisorState = {
      ...observed, stopLatched: true,
      phase: state.phase === 'CLOSED_CLAIMED' ? 'CLOSED_CLAIMED' : 'CLEANUP_REQUIRED',
      cleanupRequired: state.phase !== 'CLOSED_CLAIMED', reason: 'STOP_REQUESTED'
    };
    return { state: next, decision: next.cleanupRequired ? cleanup(next.reason) : noGo('STOP_LATCHED') };
  }
  if (state.stopLatched && event.type === 'FIXTURE_STARTED')
    return { state: observed, decision: noGo('STOP_LATCHED') };
  if (state.phase === 'BLOCKED') {
    // Even a fixture start claim does not bypass Gate A.
    if (event.type === 'FIXTURE_STARTED')
      return { state: observed, decision: noGo('NO_GATE_A_AUTHORIZATION') };
    return { state: observed, decision: noGo('NO_GATE_A_AUTHORIZATION') };
  }
  if (state.phase === 'CLOSED_CLAIMED')
    return { state: observed, decision: noGo('FIXTURE_ALREADY_CLOSED') };
  if (event.type === 'CLEANUP_FAILED') {
    const next: SimulatedSupervisorState = {
      ...observed, phase: 'QUARANTINED', stopLatched: true,
      cleanupRequired: true, reason: 'CLEANUP_FAILURE'
    };
    return { state: next, decision: cleanup(next.reason) };
  }
  if (event.type === 'CLEANUP_CLAIMED' && state.phase === 'CLEANUP_REQUIRED') {
    const complete = event.containerAbsent === true &&
      event.descendantsAbsent === true && event.mountsAbsent === true;
    if (!complete) {
      const next: SimulatedSupervisorState = {
        ...observed, phase: 'QUARANTINED', stopLatched: true,
        cleanupRequired: true, reason: 'INCOMPLETE_CLEANUP_CLAIM'
      };
      return { state: next, decision: cleanup(next.reason) };
    }
    return {
      state: { ...observed, phase: 'CLOSED_CLAIMED', cleanupRequired: false,
        stopLatched: true, reason: 'CLAIMED_CLEANUP_NOT_VERIFIED' },
      decision: noGo('CLEANUP_CLAIM_IS_NOT_INDEPENDENT_EVIDENCE')
    };
  }
  if (state.phase === 'CLEANUP_REQUIRED')
    return { state: observed, decision: cleanup('CLEANUP_STILL_REQUIRED') };
  if (state.phase === 'SIMULATED_ACTIVE') {
    if (state.deadlineMs === null || event.nowMs >= state.deadlineMs) {
      const next: SimulatedSupervisorState = {
        ...observed, phase: 'CLEANUP_REQUIRED', stopLatched: true,
        cleanupRequired: true, reason: 'RUNTIME_EXPIRED'
      };
      return { state: next, decision: cleanup(next.reason) };
    }
    if (event.type === 'FIXTURE_EXITED') {
      const next: SimulatedSupervisorState = {
        ...observed, phase: 'CLEANUP_REQUIRED', cleanupRequired: true,
        reason: 'FIXTURE_EXITED'
      };
      return { state: next, decision: cleanup(next.reason) };
    }
    return { state: observed, decision: idle('SIMULATED_ONLY') };
  }
  return { state: observed, decision: noGo('UNSUPPORTED_EVENT') };
}

/** Synthetic state to test timeout/cleanup paths. No controller may use this as launch permission. */
export function simulatedAlreadyActiveFixture(startedMs: number): SimulatedSupervisorState {
  if (!validTime(startedMs)) return initialSimulatedSupervisor();
  return {
    ...initialSimulatedSupervisor(), phase: 'SIMULATED_ACTIVE',
    startedMs, lastObservedMs: startedMs, deadlineMs: startedMs + MAX_FIXTURE_RUNTIME_MS,
    reason: 'SYNTHETIC_ACTIVE_ONLY'
  };
}
