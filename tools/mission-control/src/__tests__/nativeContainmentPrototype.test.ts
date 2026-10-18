import { describe, expect, it } from 'vitest';
import { advanceNativePrototype, type NativeEvent, type NativeStage } from '../nativeContainmentPrototype.js';

const base = () => ({ version: 1, source: 'LOCAL_NATIVE_CLAIM', receiptId: 'receipt-1',
  generation: 4, observedAt: '2026-10-18T00:00:00.000Z', processId: 100,
  jobOwned: true, containmentQueried: true, controllingHandleInherited: false,
  identity: 'UNAVAILABLE', restrictions: 'UNAVAILABLE',
  termination: 'UNVERIFIED', osError: null });
const run = (stage: NativeStage, event: NativeEvent, changes: Record<string, unknown> = {},
  gate = { active: false, generation: 4 }, used = new Set<string>()) =>
  advanceNativePrototype(stage, event, { ...base(), ...changes }, gate, used);

describe('disposable native containment claim model', () => {
  it('orders local setup, start, exit, and termination claims without authorizing', () => {
    const cases: Array<[NativeStage, NativeEvent, NativeStage, Record<string, unknown>]> = [
      ['CREATED', 'JOB_ASSIGNED', 'CONTAINED', {}],
      ['CONTAINED', 'STARTED', 'RUNNING', {}],
      ['RUNNING', 'PROCESS_EXITED', 'EXITED', { termination: 'OBSERVED' }],
      ['EXITED', 'REQUEST_TERMINATION', 'TERMINATION_REQUESTED', {}],
      ['TERMINATION_REQUESTED', 'TERMINATION_OBSERVED', 'TERMINATED', { termination: 'OBSERVED' }]
    ];
    for (const [from, event, to, changes] of cases) {
      const value = run(from, event, changes);
      expect(value).toMatchObject({ stage: to, authenticity: 'UNVERIFIED',
        retryAllowed: false, productionAuthorized: false, executable: false });
    }
  });
  it.each([
    ['setup failure', 'CREATED', 'SETUP_FAILED', {}, 'CONTAINMENT_UNCERTAIN'],
    ['invalid PID', 'CREATED', 'JOB_ASSIGNED', { processId: 0 }, 'CONTAINMENT_UNCERTAIN'],
    ['invalid job handle claim', 'CREATED', 'JOB_ASSIGNED', { jobOwned: false }, 'CONTAINMENT_UNCERTAIN'],
    ['duplicate ownership', 'CONTAINED', 'JOB_ASSIGNED', {}, 'CONTAINMENT_UNCERTAIN'],
    ['supervisor exit', 'RUNNING', 'EVIDENCE_MISSING', {}, 'CONTAINMENT_UNCERTAIN'],
    ['missing termination', 'TERMINATION_REQUESTED', 'TERMINATION_OBSERVED', {}, 'CONTAINMENT_UNCERTAIN'],
    ['missing containment query', 'CREATED', 'JOB_ASSIGNED', { containmentQueried: false }, 'CONTAINMENT_UNCERTAIN'],
    ['inherited controlling handle', 'CREATED', 'JOB_ASSIGNED', { controllingHandleInherited: true }, 'CONTAINMENT_UNCERTAIN'],
    ['unsupported nested job', 'CREATED', 'JOB_ASSIGNED', { osError: { api: 'AssignProcessToJobObject', code: 5 } }, 'CONTAINMENT_UNCERTAIN'],
    ['restricted token failure', 'CREATED', 'SETUP_FAILED', { osError: { api: 'CreateRestrictedToken', code: 5 } }, 'CONTAINMENT_UNCERTAIN'],
    ['parent child order', 'CREATED', 'STARTED', {}, 'CONTAINMENT_UNCERTAIN'],
    ['failure cleanup', 'CREATED', 'SETUP_FAILED', { jobOwned: false }, 'CONTAINMENT_UNCERTAIN'],
    ['invalid format', 'CREATED', 'JOB_ASSIGNED', { version: 2 }, 'CONTAINMENT_UNCERTAIN'],
    ['unsupported runtime', 'CREATED', 'SETUP_FAILED', { osError: { api: 'CreateJobObjectW', code: 50 } }, 'CONTAINMENT_UNCERTAIN'],
  ] as const)('%s fails closed', (_name, stage, event, changes, expected) => {
    expect(run(stage, event, changes).stage).toBe(expected);
  });
  it('blocks STOP before launch and during setup', () => {
    for (const [stage, event] of [['CREATED', 'JOB_ASSIGNED'], ['CONTAINED', 'STARTED']] as const)
      expect(run(stage, event, {}, { active: true, generation: 4 }).reason).toBe('STOP_ACTIVE');
  });
  it('rejects stale generation, replayed receipt, and forged native receipt', () => {
    expect(run('CREATED', 'JOB_ASSIGNED', {}, { active: false, generation: 5 }).reason).toBe('STALE_GENERATION');
    expect(run('CREATED', 'JOB_ASSIGNED', {}, { active: false, generation: 4 }, new Set(['receipt-1'])).reason)
      .toBe('REPLAYED_RECEIPT');
    expect(run('CREATED', 'JOB_ASSIGNED', { source: 'AUTHENTICATED_NATIVE_RECEIPT' }).reason)
      .toBe('INVALID_NATIVE_RESULT');
  });
  it('cannot grant authority even from claimed containment and identity', () => {
    const value = run('CREATED', 'JOB_ASSIGNED', { identity: 'VERIFIED', restrictions: 'APPLIED' });
    expect(value).toMatchObject({ authenticity: 'UNVERIFIED', productionAuthorized: false, executable: false });
  });
  it.each([
    ['null gate', null, new Set<string>(), 'INVALID_GATE'],
    ['undefined gate', undefined, new Set<string>(), 'INVALID_GATE'],
    ['missing active', { generation: 4 }, new Set<string>(), 'INVALID_GATE'],
    ['nonboolean active', { active: 'false', generation: 4 }, new Set<string>(), 'INVALID_GATE'],
    ['invalid generation', { active: false, generation: 0 }, new Set<string>(), 'INVALID_GATE'],
    ['missing receipts', { active: false, generation: 4 }, undefined, 'INVALID_RECEIPT_TRACKER'],
    ['invalid receipts', { active: false, generation: 4 }, ['receipt-1'], 'INVALID_RECEIPT_TRACKER'],
    ['invalid receipt entry', { active: false, generation: 4 }, new Set<unknown>([42]), 'INVALID_RECEIPT_TRACKER'],
    ['null receipts', { active: false, generation: 4 }, null, 'INVALID_RECEIPT_TRACKER']
  ] as const)('%s returns uncertainty', (_name, gate, receipts, reason) => {
    expect(advanceNativePrototype('CREATED', 'JOB_ASSIGNED', base(), gate, receipts))
      .toMatchObject({ stage: 'CONTAINMENT_UNCERTAIN', reason, authenticity: 'UNVERIFIED',
        productionAuthorized: false, executable: false });
  });
  it('rejects unsupported stage and event before interpreting claims', () => {
    expect(advanceNativePrototype('ROOT' as NativeStage, 'JOB_ASSIGNED', base(),
      { active: false, generation: 4 }, new Set()).reason).toBe('INVALID_STAGE');
    expect(advanceNativePrototype('CREATED', 'LAUNCH' as NativeEvent, base(),
      { active: false, generation: 4 }, new Set()).reason).toBe('INVALID_EVENT');
    expect(advanceNativePrototype(undefined, 'JOB_ASSIGNED', base(),
      { active: false, generation: 4 }, new Set()).reason).toBe('INVALID_STAGE');
    expect(advanceNativePrototype('CREATED', null, base(),
      { active: false, generation: 4 }, new Set()).reason).toBe('INVALID_EVENT');
  });
  it.each([null, undefined, [], { ...base(), unexpected: true }])
    ('rejects missing, sparse, or unexpected observations', observation => {
      expect(advanceNativePrototype('CREATED', 'JOB_ASSIGNED', observation,
        { active: false, generation: 4 }, new Set()).reason).toBe('INVALID_NATIVE_RESULT');
    });
  it.each([
    { api: 'CreateJobObjectW', code: 5, extra: true },
    { api: 'CreateJobObjectW' },
    { api: 'CreateJobObjectW', code: -1 },
    Object.defineProperty({ code: 5 }, 'api', { enumerable: true, get: () => 'CreateJobObjectW' })
  ])('rejects malformed or unexpected nested OS error fields', osError => {
    expect(run('CREATED', 'JOB_ASSIGNED', { osError }).reason).toBe('INVALID_NATIVE_RESULT');
  });
  it('rejects accessor observations without running their getters', () => {
    let reads = 0;
    const observation = Object.defineProperty(base(), 'jobOwned', {
      enumerable: true, get: () => { reads++; return true; }
    });
    expect(advanceNativePrototype('CREATED', 'JOB_ASSIGNED', observation,
      { active: false, generation: 4 }, new Set()).reason).toBe('INVALID_NATIVE_RESULT');
    expect(reads).toBe(0);
  });
  it('rejects throwing proxies and malformed gate accessors without throwing', () => {
    const hostile = new Proxy(base(), { getPrototypeOf: () => { throw new Error('hostile'); } });
    expect(advanceNativePrototype('CREATED', 'JOB_ASSIGNED', hostile,
      { active: false, generation: 4 }, new Set()).stage).toBe('CONTAINMENT_UNCERTAIN');
    const gate = Object.defineProperty({ generation: 4 }, 'active', { enumerable: true, get: () => false });
    expect(advanceNativePrototype('CREATED', 'JOB_ASSIGNED', base(), gate, new Set()).reason).toBe('INVALID_GATE');
  });
  it.each([
    ['CREATED', 'JOB_ASSIGNED'], ['CONTAINED', 'STARTED']
  ] as const)('STOP active at %s / %s stays denied', (stage, event) => {
    expect(run(stage, event, {}, { active: true, generation: 4 }))
      .toMatchObject({ stage: 'CONTAINMENT_UNCERTAIN', reason: 'STOP_ACTIVE',
        productionAuthorized: false, executable: false });
  });
  it('rejects a forged authenticated source even with claimed success', () => {
    expect(run('CREATED', 'JOB_ASSIGNED', { source: 'AUTHENTICATED_NATIVE_RECEIPT',
      identity: 'VERIFIED', restrictions: 'APPLIED' }))
      .toMatchObject({ stage: 'CONTAINMENT_UNCERTAIN', reason: 'INVALID_NATIVE_RESULT',
        authenticity: 'UNVERIFIED', productionAuthorized: false, executable: false });
  });
});
