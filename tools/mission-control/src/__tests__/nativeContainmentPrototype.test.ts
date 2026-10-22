import { describe, expect, it } from 'vitest';
import { advanceNativePrototype, assessNativeWorkerIsolation, parseDisposableHarnessResult, parseNativeObservation,
  type NativeEvent, type NativeStage } from '../nativeContainmentPrototype.js';

const base = () => ({ version: 1, source: 'LOCAL_NATIVE_CLAIM', receiptId: 'receipt-1',
  generation: 4, observedAt: '2026-10-18T00:00:00.000Z', processId: 100,
  jobOwned: true, containmentQueried: true, controllingHandleInherited: false,
  identity: 'UNAVAILABLE', restrictions: 'UNAVAILABLE',
  termination: 'UNVERIFIED', osError: null });
const run = (stage: NativeStage, event: NativeEvent, changes: Record<string, unknown> = {},
  gate = { active: false, generation: 4 }, used = new Set<string>()) =>
  advanceNativePrototype(stage, event, { ...base(), ...changes }, gate, used);
const isolation = () => ({
  host: { jobListAtCreation: true, restrictedToken: true, handleInspection: true,
    effectiveAcl: true, networkPolicy: true },
  observation: { ...base(), identity: 'VERIFIED', restrictions: 'APPLIED' },
  filesystem: { workspaceRoot: 'E:\\worker\\root', candidate: 'E:\\worker\\root',
    resolvedRoot: 'E:\\worker\\root', resolvedCandidate: 'E:\\worker\\root',
    volumeId: 'volume-123', rootFileId: 'file-12345', candidateFileId: 'file-12345',
    components: ['ORDINARY'] }
});

describe('Gate 2A native worker isolation claim boundary', () => {
  it('cannot authenticate even a complete set of caller claims', () => {
    expect(assessNativeWorkerIsolation(isolation())).toEqual({ locallyClaimedReady: true,
      independentlyAuthenticated: false, productionAuthorized: false, executable: false,
      reasons: ['INDEPENDENT_CONTAINMENT_EVIDENCE_MISSING'] });
  });
  it.each([
    ['unsupported creation-time Job list', (v: ReturnType<typeof isolation>) => { v.host.jobListAtCreation = false; }, 'HOST_JOBLISTATCREATION_UNAVAILABLE'],
    ['missing restricted token', (v: ReturnType<typeof isolation>) => { v.host.restrictedToken = false; }, 'HOST_RESTRICTEDTOKEN_UNAVAILABLE'],
    ['missing handle inspection', (v: ReturnType<typeof isolation>) => { v.host.handleInspection = false; }, 'HOST_HANDLEINSPECTION_UNAVAILABLE'],
    ['missing ACL enforcement', (v: ReturnType<typeof isolation>) => { v.host.effectiveAcl = false; }, 'HOST_EFFECTIVEACL_UNAVAILABLE'],
    ['missing network policy', (v: ReturnType<typeof isolation>) => { v.host.networkPolicy = false; }, 'HOST_NETWORKPOLICY_UNAVAILABLE'],
    ['missing Job membership', (v: ReturnType<typeof isolation>) => { v.observation.containmentQueried = false; }, 'JOB_CONTAINMENT_UNVERIFIED'],
    ['missing worker identity', (v: ReturnType<typeof isolation>) => { v.observation.identity = 'UNAVAILABLE'; }, 'WORKER_IDENTITY_UNVERIFIED'],
    ['missing restrictions', (v: ReturnType<typeof isolation>) => { v.observation.restrictions = 'UNAVAILABLE'; }, 'WORKER_RESTRICTIONS_UNVERIFIED'],
    ['unknown reparse status', (v: ReturnType<typeof isolation>) => { v.filesystem.components = ['UNKNOWN']; }, 'REPARSE_POINT_UNVERIFIED'],
    ['contradictory file IDs', (v: ReturnType<typeof isolation>) => { v.filesystem.candidateFileId = 'different-file-123'; }, 'FILE_IDENTITY_MISMATCH']
  ])('%s denies local readiness', (_name, mutate, reason) => {
    const v = isolation(); mutate(v);
    expect(assessNativeWorkerIsolation(v)).toMatchObject({ locallyClaimedReady: false,
      productionAuthorized: false, executable: false });
    expect(assessNativeWorkerIsolation(v).reasons).toContain(reason);
  });
  it('rejects malformed requests and missing containment evidence', () => {
    for (const v of [null, { ...isolation(), extra: true },
      { ...isolation(), host: { jobListAtCreation: true } }])
      expect(assessNativeWorkerIsolation(v).locallyClaimedReady).toBe(false);
    expect(assessNativeWorkerIsolation({ ...isolation(), observation: null }).reasons)
      .toContain('MALFORMED_NATIVE_OBSERVATION');
    expect(assessNativeWorkerIsolation({ ...isolation(), filesystem: null }).reasons)
      .toContain('MALFORMED_FILESYSTEM_IDENTITY');
  });
  it('rejects hostile component arrays without calling their methods or accessors', () => {
    let calls = 0;
    const forgedSome = Object.assign(['REPARSE'], { some: () => { calls++; return false; } });
    const forgedIncludes = Object.assign(['REPARSE'], { includes: () => { calls++; return false; } });
    const accessor = Object.defineProperty(['ORDINARY'], '0', {
      configurable: true, enumerable: true, get: () => { calls++; return 'ORDINARY'; }
    });
    const extra = Object.defineProperty(['ORDINARY'], 'extra', { value: true });
    const invalidPrototype = Object.setPrototypeOf(['ORDINARY'], null);
    const malformed = 'MALFORMED_FILESYSTEM_IDENTITY';
    for (const [components, expected] of [
      [forgedSome, malformed], [forgedIncludes, malformed], [accessor, malformed],
      [['ORDINARY', ,], malformed], [extra, malformed], [invalidPrototype, malformed],
      [[42], malformed], [['REPARSE'], 'REPARSE_POINT_PRESENT']
    ] as const) {
      const v = isolation();
      v.filesystem.components = components as never;
      const assessed = assessNativeWorkerIsolation(v);
      expect(assessed).toMatchObject({ locallyClaimedReady: false,
        independentlyAuthenticated: false, productionAuthorized: false, executable: false });
      expect(assessed.reasons).toContain(expected);
    }
    expect(calls).toBe(0);
  });
});

describe('disposable native containment claim model', () => {
  it('parses exact disposable harness text without granting authority', () => {
    expect(parseDisposableHarnessResult(
      'result=LOCAL_DISPOSABLE_OBSERVATION pid=123 exit=0 job_member=1 termination_requested=0\r\n', '', 0))
      .toMatchObject({ kind: 'LOCAL_CLAIM', processId: 123, authenticity: 'UNVERIFIED',
        productionAuthorized: false, executable: false });
    expect(parseDisposableHarnessResult('', 'result=FAIL_CLOSED step=IsProcessInJob win32=5\n', 1))
      .toMatchObject({ kind: 'FAIL_CLOSED', osError: { api: 'IsProcessInJob', code: 5 },
        productionAuthorized: false });
    for (const [stdout, stderr, code] of [
      ['result=LOCAL_DISPOSABLE_OBSERVATION pid=123 exit=0 job_member=1 termination_requested=0', '', 1],
      ['result=LOCAL_DISPOSABLE_OBSERVATION pid=123 exit=0 job_member=0 termination_requested=0', '', 0],
      ['result=LOCAL_DISPOSABLE_OBSERVATION pid=123 exit=0 job_member=1 termination_requested=0', 'warning', 0],
      ['', 'cleanup_error=CloseHandle win32=6\nresult=FAIL_CLOSED step=EXIT_UNVERIFIED win32=1460', 1]
    ] as const) expect(parseDisposableHarnessResult(stdout, stderr, code).kind).toBe('MALFORMED');
  });
  it('parses only exact local observation records', () => {
    expect(parseNativeObservation(base())).toEqual(base());
    expect(parseNativeObservation({ ...base(), osError: { api: 'CloseHandle', code: 6 } }))
      .toMatchObject({ osError: { api: 'CloseHandle', code: 6 } });
    expect(parseNativeObservation({ ...base(), termination: 'OBSERVED', extra: true })).toBeNull();
    expect(parseNativeObservation({ ...base(), observedAt: 'not-a-time' })).toBeNull();
  });
  it('never accepts native errors or absent process observation as success', () => {
    expect(run('CONTAINED', 'STARTED', { osError: { api: 'ResumeThread', code: 5 } }).reason)
      .toBe('NATIVE_ERROR');
    expect(run('EXITED', 'REQUEST_TERMINATION', { osError: { api: 'CloseHandle', code: 6 } }).reason)
      .toBe('NATIVE_ERROR');
    expect(run('RUNNING', 'PROCESS_EXITED', { processId: null, termination: 'OBSERVED' }).stage)
      .toBe('CONTAINMENT_UNCERTAIN');
    expect(run('TERMINATION_REQUESTED', 'TERMINATION_OBSERVED',
      { processId: null, termination: 'OBSERVED' }).stage).toBe('CONTAINMENT_UNCERTAIN');
  });
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
