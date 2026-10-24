import { describe, expect, it } from 'vitest';
import { assessProcessObservation, type ProcessObservationRecord } from '../processObservationEvidence.js';

const digest = 'a'.repeat(64);
const parent = { pid: 10, creationId: 'parent-1' };
const harness = { pid: 20, creationId: 'harness-1' };
const child = { pid: 30, creationId: 'child-1' };

function fixture(): ProcessObservationRecord {
  return {
    version: 1,
    session: { sessionId: 'session-1', collectorId: 'collector-1', providerId: 'provider-1',
      providerConfigurationSha256: digest, rawTraceSha256: digest, provenance: 'UNAUTHENTICATED',
      coverage: 'CLAIMED_COMPLETE', lifecycle: 'COMPLETED', interruptionCount: 0 },
    window: { startedAtMs: 100, launchAtMs: 110, harnessExitAtMs: 150, endedAtMs: 160,
      firstSequence: 1, lastSequence: 2 },
    harness: { process: harness, parent },
    events: [
      { sequence: 1, timestampMs: 120, rawEventId: 'raw-1', type: 'PROCESS_START', process: harness, parent },
      { sequence: 2, timestampMs: 140, rawEventId: 'raw-2', type: 'PROCESS_END', process: harness, parent },
    ],
    loss: { eventsLost: 0, logBuffersLost: 0, realTimeBuffersLost: 0 },
    cleanup: { observedAtMs: 170, complete: true, outstanding: [] },
  };
}

function withChild(): ProcessObservationRecord {
  const trace = fixture();
  trace.events.splice(1, 0,
    { sequence: 2, timestampMs: 125, rawEventId: 'raw-2', type: 'PROCESS_START', process: child, parent: harness },
    { sequence: 3, timestampMs: 126, rawEventId: 'raw-3', type: 'PROCESS_END', process: child, parent: harness });
  trace.events[3].sequence = 4;
  trace.events[3].rawEventId = 'raw-4';
  trace.window.lastSequence = 4;
  return trace;
}

describe('portable process observation evidence', () => {
  it('keeps a valid but unauthenticated trace and missing child event unverified', () => {
    expect(assessProcessObservation(fixture())).toMatchObject({ status: 'UNVERIFIED', locallyConsistent: true,
      childObserved: false, noChild: 'UNVERIFIED', executionAuthorized: false });
  });
  it('detects a short-lived child without granting authorization', () => {
    expect(assessProcessObservation(withChild())).toMatchObject({ status: 'UNVERIFIED', childObserved: true,
      noChild: 'UNVERIFIED', executionAuthorized: false });
  });
  it('rejects a harness with its parent PID even when the creation labels differ', () => {
    const trace = fixture();
    trace.harness.process = { pid: parent.pid, creationId: 'different-label' };
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['SELF_PARENTED_HARNESS']) });
  });
  it('rejects a harness sharing its parent creation identity despite a different PID', () => {
    const trace = fixture();
    trace.harness.process = { pid: 20, creationId: parent.creationId };
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['SELF_PARENTED_HARNESS']) });
  });
  it('reserves the existing harness parent identity against a start event', () => {
    const trace = fixture();
    trace.events.splice(1, 0, { sequence: 2, timestampMs: 125, rawEventId: 'raw-root-start',
      type: 'PROCESS_START', process: parent, parent: harness });
    trace.events[2].sequence = 3;
    trace.window.lastSequence = 3;
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['RESERVED_PARENT_IDENTITY']) });
  });
  it('rejects unproved reuse of the parent PID with a changed creation identity', () => {
    const trace = fixture();
    trace.events.splice(1, 0, { sequence: 2, timestampMs: 125, rawEventId: 'raw-root-pid-reuse',
      type: 'PROCESS_START', process: { pid: parent.pid, creationId: 'new-label' }, parent: harness });
    trace.events[2].sequence = 3;
    trace.window.lastSequence = 3;
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['UNRESOLVED_PARENT_PID_REUSE']) });
  });
  it('rejects reuse of the reserved parent creation identity under a different PID', () => {
    const trace = fixture();
    trace.events.splice(1, 0, { sequence: 2, timestampMs: 125, rawEventId: 'raw-root-id-reuse',
      type: 'PROCESS_START', process: { pid: 31, creationId: parent.creationId }, parent: harness });
    trace.events[2].sequence = 3;
    trace.window.lastSequence = 3;
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['RESERVED_PARENT_CREATION_ID', 'CREATION_ID_ALIAS']) });
  });
  it('rejects an event that substitutes a new creation identity for the parent PID', () => {
    const trace = fixture();
    trace.events[0].parent = { pid: parent.pid, creationId: 'new-label' };
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['UNRESOLVED_PARENT_PID_REUSE']) });
  });
  it('rejects an ancestry cycle in a process start', () => {
    const trace = withChild();
    trace.events[1].parent = child;
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['ANCESTRY_CYCLE']) });
  });
  it('rejects complete child events aliasing the harness creation ID under another PID', () => {
    const trace = withChild();
    trace.events[1].process = { pid: child.pid, creationId: harness.creationId };
    trace.events[2].process = { pid: child.pid, creationId: harness.creationId };
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['CREATION_ID_ALIAS']) });
  });
  it('rejects complete second-child events aliasing the first child creation ID', () => {
    const trace = withChild();
    trace.events.splice(3, 0,
      { sequence: 4, timestampMs: 130, rawEventId: 'raw-second-start', type: 'PROCESS_START',
        process: { pid: 31, creationId: child.creationId }, parent: harness },
      { sequence: 5, timestampMs: 131, rawEventId: 'raw-second-end', type: 'PROCESS_END',
        process: { pid: 31, creationId: child.creationId }, parent: harness });
    trace.events[5].sequence = 6;
    trace.window.lastSequence = 6;
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['CREATION_ID_ALIAS']) });
  });
  it('rejects a parent reference that aliases a known creation ID under another PID', () => {
    const trace = withChild();
    trace.events[1].parent = { pid: 99, creationId: harness.creationId };
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', locallyConsistent: false,
      reasons: expect.arrayContaining(['CREATION_ID_ALIAS']) });
  });
  it('accepts repeated references to one PID and creation ID as locally consistent', () => {
    const trace = withChild();
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'UNVERIFIED', locallyConsistent: true,
      childObserved: true, noChild: 'UNVERIFIED', independentlyAuthenticated: false, executionAuthorized: false });
  });
  it.each([
    ['parent PID mismatch', (t: ProcessObservationRecord) => { t.events[1].parent = { pid: 99, creationId: 'other' }; }],
    ['duplicate process start', (t: ProcessObservationRecord) => { t.events[2].type = 'PROCESS_START'; }],
    ['missing process exit', (t: ProcessObservationRecord) => { t.events.splice(2, 1); t.events[2].sequence = 3; t.window.lastSequence = 3; }],
    ['event sequence gap', (t: ProcessObservationRecord) => { t.events[1].sequence = 9; }],
    ['clock contradiction', (t: ProcessObservationRecord) => { t.events[1].timestampMs = 119; }],
    ['nonzero loss counters', (t: ProcessObservationRecord) => { t.loss.eventsLost = 1; }],
    ['missing loss counters', (t: ProcessObservationRecord) => { t.loss.eventsLost = null; }],
    ['interrupted observer', (t: ProcessObservationRecord) => { t.session.lifecycle = 'INTERRUPTED'; t.session.interruptionCount = 1; }],
    ['incomplete prelaunch window', (t: ProcessObservationRecord) => { t.window.startedAtMs = 110; }],
    ['incomplete postexit window', (t: ProcessObservationRecord) => { t.window.endedAtMs = 150; }],
    ['unknown coverage', (t: ProcessObservationRecord) => { t.session.coverage = 'UNKNOWN'; }],
    ['incomplete cleanup', (t: ProcessObservationRecord) => { t.cleanup.outstanding = [child]; }],
  ] as const)('rejects %s', (_name, mutate) => {
    const trace = withChild();
    mutate(trace);
    expect(assessProcessObservation(trace)).toMatchObject({ status: 'REJECTED', noChild: 'UNVERIFIED', executionAuthorized: false });
  });
  it('distinguishes sequential PID reuse from conflicting live identities', () => {
    const reused = withChild();
    reused.events.splice(3, 0,
      { sequence: 4, timestampMs: 130, rawEventId: 'raw-reuse-start', type: 'PROCESS_START',
        process: { pid: 30, creationId: 'child-2' }, parent: harness },
      { sequence: 5, timestampMs: 131, rawEventId: 'raw-reuse-end', type: 'PROCESS_END',
        process: { pid: 30, creationId: 'child-2' }, parent: harness });
    reused.events[5].sequence = 6;
    reused.window.lastSequence = 6;
    expect(assessProcessObservation(reused).status).toBe('UNVERIFIED');
    const overlap = withChild();
    overlap.events.splice(2, 0, { sequence: 3, timestampMs: 125, rawEventId: 'raw-overlap',
      type: 'PROCESS_START', process: { pid: 30, creationId: 'child-2' }, parent: harness });
    overlap.events[3].sequence = 4;
    overlap.events[3].rawEventId = 'raw-3';
    overlap.events[4].sequence = 5;
    overlap.events[4].rawEventId = 'raw-4';
    overlap.window.lastSequence = 5;
    expect(assessProcessObservation(overlap).status).toBe('REJECTED');
  });
  it('rejects a forged positive provenance field', () => {
    const trace = fixture() as unknown as Record<string, unknown>;
    trace.authenticated = true;
    expect(assessProcessObservation(trace).status).toBe('MALFORMED');
  });
  it('rejects malformed nested records and foreign prototypes', () => {
    const trace = fixture();
    (trace.events[0] as unknown as Record<string, unknown>).extra = true;
    expect(assessProcessObservation(trace).status).toBe('MALFORMED');
    const foreign = fixture();
    Object.setPrototypeOf(foreign.session, { inherited: true });
    expect(assessProcessObservation(foreign).status).toBe('MALFORMED');
  });
  it('rejects hostile arrays, symbols, accessors, and proxies without running a getter', () => {
    const sparse = fixture();
    delete sparse.events[0];
    expect(assessProcessObservation(sparse).status).toBe('MALFORMED');
    const extra = fixture();
    (extra.events as unknown as Record<string, unknown>).other = 1;
    expect(assessProcessObservation(extra).status).toBe('MALFORMED');
    const arrayAccessor = fixture();
    let arrayGetterCalled = false;
    Object.defineProperty(arrayAccessor.events, '0', { enumerable: true, get() { arrayGetterCalled = true; throw new Error('must not run'); } });
    expect(assessProcessObservation(arrayAccessor).status).toBe('MALFORMED');
    expect(arrayGetterCalled).toBe(false);
    const accessor = fixture();
    let called = false;
    Object.defineProperty(accessor.session, 'sessionId', { enumerable: true, get() { called = true; return 'bad'; } });
    expect(assessProcessObservation(accessor).status).toBe('MALFORMED');
    expect(called).toBe(false);
    const symbol = fixture();
    Object.defineProperty(symbol.events, Symbol('hidden'), { value: true });
    expect(assessProcessObservation(symbol).status).toBe('MALFORMED');
    expect(assessProcessObservation(new Proxy(fixture(), { getPrototypeOf() { throw new Error('trap'); } })).status).toBe('MALFORMED');
  });
});
