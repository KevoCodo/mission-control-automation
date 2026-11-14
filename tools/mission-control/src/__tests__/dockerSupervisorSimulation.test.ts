import { describe, expect, it } from 'vitest';
import { advanceSimulatedSupervisor, initialSimulatedSupervisor,
  simulatedAlreadyActiveFixture } from '../dockerSupervisorSimulation.js';

describe('inert Docker supervisor simulation', () => {
  it('cannot launch even a fixture before independent Gate A authorization', () => {
    const r = advanceSimulatedSupervisor(initialSimulatedSupervisor(),
      { type: 'FIXTURE_STARTED', nowMs: 1000 });
    expect(r.decision).toEqual({ action: 'DENY', reason: 'NO_GATE_A_AUTHORIZATION' });
    expect(r.state.executionAuthorized).toBe(false);
    expect(r.state.phase).toBe('BLOCKED');
  });
  it('marks 300 seconds as cleanup required but never calls Docker', () => {
    const s = simulatedAlreadyActiveFixture(1000);
    expect(advanceSimulatedSupervisor(s, { type: 'HEARTBEAT', nowMs: 300999 })
      .decision.action).toBe('NO_ACTION');
    const expired = advanceSimulatedSupervisor(s, { type: 'HEARTBEAT', nowMs: 301000 });
    expect(expired.state).toMatchObject({
      phase: 'CLEANUP_REQUIRED', stopLatched: true,
      cleanupRequired: true, executionAuthorized: false
    });
    expect(expired.decision).toEqual({ action: 'REQUEST_CLEANUP', reason: 'RUNTIME_EXPIRED' });
    expect(advanceSimulatedSupervisor(expired.state,
      { type: 'FIXTURE_STARTED', nowMs: 301001 }).decision.action).toBe('DENY');
  });
  it('latches STOP and rejects restart', () => {
    const stopped = advanceSimulatedSupervisor(simulatedAlreadyActiveFixture(5),
      { type: 'STOP_REQUESTED', nowMs: 6 });
    expect(stopped.state.stopLatched).toBe(true);
    expect(stopped.decision.action).toBe('REQUEST_CLEANUP');
    expect(advanceSimulatedSupervisor(stopped.state,
      { type: 'FIXTURE_STARTED', nowMs: 7 }).decision.action).toBe('DENY');
  });
  it('requires all cleanup claims and still treats them as unverified', () => {
    const pending = advanceSimulatedSupervisor(simulatedAlreadyActiveFixture(10),
      { type: 'FIXTURE_EXITED', nowMs: 20 });
    const closed = advanceSimulatedSupervisor(pending.state, {
      type: 'CLEANUP_CLAIMED', nowMs: 21,
      containerAbsent: true, descendantsAbsent: true, mountsAbsent: true
    });
    expect(closed.state.phase).toBe('CLOSED_CLAIMED');
    expect(closed.state.independentlyVerified).toBe(false);
    expect(closed.state.executionAuthorized).toBe(false);
    expect(closed.decision.action).toBe('DENY');
  });
  it('quarantines incomplete cleanup or failed cleanup', () => {
    const pending = advanceSimulatedSupervisor(simulatedAlreadyActiveFixture(10),
      { type: 'FIXTURE_EXITED', nowMs: 20 });
    const incomplete = advanceSimulatedSupervisor(pending.state, {
      type: 'CLEANUP_CLAIMED', nowMs: 21,
      containerAbsent: true, descendantsAbsent: false, mountsAbsent: true
    });
    expect(incomplete.state.phase).toBe('QUARANTINED');
    expect(incomplete.decision.action).toBe('REQUEST_CLEANUP');
    const failed = advanceSimulatedSupervisor(pending.state,
      { type: 'CLEANUP_FAILED', nowMs: 21 });
    expect(failed.state.phase).toBe('QUARANTINED');
    expect(failed.state.stopLatched).toBe(true);
  });
  it('rejects backwards or invalid clocks by quarantining', () => {
    const s = simulatedAlreadyActiveFixture(100);
    for (const nowMs of [99, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
      const r = advanceSimulatedSupervisor(s, { type: 'HEARTBEAT', nowMs });
      expect(r.state.phase).toBe('QUARANTINED');
      expect(r.decision.action).toBe('REQUEST_CLEANUP');
    }
  });
  it('does not interact with other user containers or host state', () => {
    const s = initialSimulatedSupervisor();
    expect(s).not.toHaveProperty('containerName');
    expect(s).not.toHaveProperty('dockerClient');
    expect(s).not.toHaveProperty('hostPath');
    expect(s.executionAuthorized).toBe(false);
  });
});
