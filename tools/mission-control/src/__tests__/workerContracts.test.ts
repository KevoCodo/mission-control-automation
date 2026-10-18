import { describe, expect, it } from 'vitest';
import { fingerprintDispatchPayload } from '../dispatch.js';
import { assessFilesystemAccess, assessWindowsPath, parseWorkerCapabilities } from '../workerIsolation.js';
import { parseWorkerIdentity } from '../workerIdentity.js';
import { assessWorkerFence, assessWorkerStartClaim, assessWorkerTransition, classifyWorkerRecovery } from '../workerLifecycle.js';
import { assessReceipt, assessReceiptHistory } from '../executionProtocol.js';
import { verifyCurrentPermission } from '../authorization.js';
import { planSupervisedAdmission } from '../supervisedAdmission.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const root = 'E:\\AI-Development\\isolated\\worker-23';
const envelope = { protocolVersion: 1, dispatchId: '123e4567-e89b-42d3-a456-426614174000',
  operationKey: 'fixture/23', repository: { owner: 'KevoCodo', name: 'ai-delivery-lab' },
  issueNumber: 23, targetId: 'target-23', branch: 'issue-23', worktreeId: 'worktree-23',
  agentRole: 'BUILDER', generation: 3, actionScope: 'ASSIGNMENT',
  payloadDigest: fingerprintDispatchPayload({ fixture: true }), digestAlgorithm: 'SHA-256-CANONICAL-JSON',
  grantId: 'grant-23', issuedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-10-17T13:00:00.000Z',
  fencingEpoch: 7, correlationId: 'corr-23' };
const identity = { version: 1, workerExecutionId: 'worker-23', dispatchId: envelope.dispatchId,
  repository: envelope.repository, issueNumber: 23, agentRole: 'BUILDER', targetId: 'target-23',
  generation: 3, branch: 'issue-23', worktreeId: 'worktree-23', workspaceRoot: root,
  expectedBaseCommit: 'a'.repeat(40), grantId: 'grant-23', fencingEpoch: 7,
  correlationId: 'corr-23', issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt };
const fence = { stop: { active: false, durableEpoch: 7, generation: 3,
  barrierReceiptId: 'barrier-7', durableEvidenceRef: 'durable-7' },
  grant: { grantId: 'grant-23', expiresAt: envelope.expiresAt, revoked: false }, dispatchGeneration: 3 };
const capability = { role: 'BUILDER', workspaces: [{ root, operations: ['READ', 'WRITE'] }],
  executable: { absolutePath: 'C:\\Tools\\codex.exe', sha256: 'b'.repeat(64) },
  network: { mode: 'DENY', destinations: [] }, environmentAllowlist: ['S2A_FIXTURE_MARKER'], github: { mode: 'NONE' },
  limits: { cpuMillis: 1000, memoryBytes: 1024, maxProcesses: 1, runtimeMillis: 1000, outputBytes: 1024 } };

describe('S2A non-executable worker contracts', () => {
  it('binds a strict versioned identity to every B3B envelope field and expiry', () => {
    expect(parseWorkerIdentity(identity, envelope, now)).toEqual(identity);
    for (const variant of [
      { ...identity, version: 2 }, { ...identity, dispatchId: '123e4567-e89b-42d3-a456-426614174001' },
      { ...identity, repository: { owner: 'other', name: 'ai-delivery-lab' } },
      { ...identity, generation: 4 }, { ...identity, grantId: 'other' },
      { ...identity, workspaceRoot: 'E:\\AI-Development\\isolated\\worker-23\\..\\other' },
      { ...identity, extra: true }, ...Object.keys(identity).map((key) =>
        Object.fromEntries(Object.entries(identity).filter(([name]) => name !== key)))
    ]) expect(() => parseWorkerIdentity(variant, envelope, now)).toThrow();
    expect(() => parseWorkerIdentity(identity, { ...envelope, protocolVersion: 2 }, now)).toThrow();
    expect(() => parseWorkerIdentity(identity, envelope, new Date(envelope.expiresAt))).toThrow();
  });
  it('defaults STOP and barrier gaps to denial; stale starts cannot cross a newer epoch', () => {
    expect(assessWorkerFence(identity, envelope, fence, now)).toMatchObject({ contractEligible: true, authoritative: false, executable: false });
    for (const [change, reason] of [
      [{ stop: { ...fence.stop, active: true } }, 'STOP_ACTIVE_OR_UNKNOWN'],
      [{ stop: { ...fence.stop, barrierReceiptId: '' } }, 'MISSING_BARRIER_EVIDENCE'],
      [{ stop: { ...fence.stop, durableEpoch: 8 } }, 'STALE_EPOCH'],
      [{ stop: { ...fence.stop, generation: 4 } }, 'STALE_GENERATION'],
      [{ dispatchGeneration: 4 }, 'DISPATCH_GENERATION_MISMATCH'],
      [{ grant: { ...fence.grant, grantId: 'other' } }, 'GRANT_MISMATCH'],
      [{ grant: { ...fence.grant, revoked: true } }, 'GRANT_REVOKED_OR_UNKNOWN']
    ] as const) expect(assessWorkerFence(identity, envelope, { ...fence, ...change }, now).reasons).toContain(reason);
    expect(assessWorkerFence(identity, envelope, { ...fence, stop: undefined } as never, now).contractEligible).toBe(false);
  });
  it('requires ordered, bound evidence and never treats a completion label or exit as authority', () => {
    const goodFence = assessWorkerFence(identity, envelope, fence, now);
    const ev = (kind: string, event: string) => ({ kind, event, evidenceRef: 'evidence-1',
      dispatchId: identity.dispatchId, workerExecutionId: identity.workerExecutionId });
    expect(assessWorkerTransition('PLANNED', 'RUNNING', identity, ev('AUTHENTICATED_PROVIDER', 'PROCESS_STARTED') as never, goodFence).reasons)
      .toContain('INVALID_TRANSITION');
    expect(assessWorkerTransition('STARTING', 'RUNNING', identity, ev('LOCAL_OBSERVATION', 'PROCESS_STARTED') as never, goodFence).reasons)
      .toContain('MISSING_OR_CONFLICTING_EVIDENCE');
    expect(assessWorkerTransition('RESULT_PENDING', 'COMPLETED', identity, undefined, goodFence).contractEligible).toBe(false);
    expect(assessWorkerTransition('RESULT_PENDING', 'COMPLETED', identity,
      ev('AUTHENTICATED_PROVIDER', 'RESULT_AND_CONTAINMENT_VERIFIED') as never, goodFence))
      .toMatchObject({ contractEligible: true, authoritative: false, executable: false });
    expect(assessWorkerTransition('RUNNING', 'RESULT_PENDING', identity,
      ev('EXTERNAL_PROCESS', 'PROCESS_EXITED') as never, goodFence).authoritative).toBe(false);
  });
  it('quarantines lost acknowledgments, restart gaps, exits, and duplicate starts', () => {
    const base = { intentRecorded: true, launchAttempted: true, acknowledgment: true,
      observedRunning: false, exited: false, terminated: false, descendantsContained: false,
      providerRestarted: false, staleGeneration: false, lifecycleEvidenceComplete: true };
    expect(classifyWorkerRecovery({ ...base, launchAttempted: false, acknowledgment: false }).classification).toBe('NEVER_ATTEMPTED');
    expect(classifyWorkerRecovery({ ...base, acknowledgment: false }).classification).toBe('ACKNOWLEDGMENT_LOST');
    expect(classifyWorkerRecovery({ ...base, observedRunning: true }).classification).toBe('OBSERVED_RUNNING');
    expect(classifyWorkerRecovery({ ...base, exited: true }).classification).toBe('EXIT_WITHOUT_CONTAINMENT');
    expect(classifyWorkerRecovery({ ...base, terminated: true }).classification).toBe('TERMINATED_DESCENDANTS_UNKNOWN');
    expect(classifyWorkerRecovery({ ...base, providerRestarted: true }).classification).toBe('PROVIDER_RESTART');
    expect(classifyWorkerRecovery({ ...base, staleGeneration: true }).classification).toBe('STALE_GENERATION');
    expect(classifyWorkerRecovery({ ...base, lifecycleEvidenceComplete: false }).classification).toBe('MISSING_EVIDENCE');
    expect(classifyWorkerRecovery({ ...base, providerRestarted: true })).toMatchObject({ retryEligible: false, retired: false });
    expect(assessWorkerTransition('STARTING', 'STARTING', identity, undefined,
      assessWorkerFence(identity, envelope, fence, now)).reasons).toContain('INVALID_TRANSITION');
    expect(assessWorkerStartClaim(identity, [{ ...identity }],
      assessWorkerFence(identity, envelope, fence, now)).reasons).toContain('DUPLICATE_WORKER_START');
  });
  it('quarantines contradictory recovery observations before never-attempted classification', () => {
    const base = { intentRecorded: true, launchAttempted: false, acknowledgment: false,
      observedRunning: false, exited: false, terminated: false, descendantsContained: false,
      providerRestarted: false, staleGeneration: false, lifecycleEvidenceComplete: true };
    for (const change of [
      { intentRecorded: false, launchAttempted: true }, { acknowledgment: true },
      { observedRunning: true }, { exited: true }, { terminated: true },
      { descendantsContained: true }
    ]) expect(classifyWorkerRecovery({ ...base, ...change })).toEqual({
      classification: 'CONFLICTING_EVIDENCE', retryEligible: false, retired: false
    });
  });
  it('returns conservative assessments for malformed public inputs', () => {
    const goodFence = assessWorkerFence(identity, envelope, fence, now);
    for (const bad of [null, undefined, [], { ...identity, workspaceRoot: null }])
      expect(assessWorkerFence(bad, envelope, fence, now).contractEligible).toBe(false);
    for (const bad of [null, undefined, [], { ...fence, grant: [] }, { ...fence, stop: [] }])
      expect(assessWorkerFence(identity, envelope, bad as never, now).contractEligible).toBe(false);
    expect(assessWorkerFence(identity, envelope, fence, undefined as never).contractEligible).toBe(false);
    for (const bad of [null, undefined, [], {}]) {
      expect(assessWorkerTransition('STARTING', 'RUNNING', bad as never, undefined, goodFence).contractEligible).toBe(false);
      expect(assessWorkerStartClaim(bad as never, [], goodFence).contractEligible).toBe(false);
      expect(assessFilesystemAccess(bad as never, root, 'READ')).toContain('MALFORMED_SCOPE');
      expect(classifyWorkerRecovery(bad as never)).toEqual({ classification: 'MISSING_EVIDENCE',
        retryEligible: false, retired: false });
    }
    for (const bad of [null, undefined, [null], [{}], [{ dispatchId: 'x' }], new Array(1)])
      expect(assessWorkerStartClaim(identity, bad as never, goodFence).contractEligible).toBe(false);
    expect(assessWorkerTransition('STARTING', 'RUNNING', identity, null as never, goodFence).contractEligible).toBe(false);
    expect(assessWorkerTransition('STARTING', 'RUNNING', identity, undefined, null as never).contractEligible).toBe(false);
    expect(assessFilesystemAccess({ root, operations: null } as never, root, 'READ')).toContain('MALFORMED_SCOPE');
    expect(assessFilesystemAccess({ root, operations: ['READ', ,] } as never, root, 'READ'))
      .toContain('MALFORMED_SCOPE');
  });
  it('rejects path escapes, ambiguous formats, and role/capability escalation', () => {
    expect(assessWindowsPath(root, `${root}\\src\\file.ts`)).toEqual([]);
    for (const path of [`${root}\\..\\other`, '\\\\server\\share\\file', '\\\\?\\E:\\file',
      'E:\\', `${root}\\file:stream`, `${root.toLowerCase()}\\file`, `${root}/file`,
      'F:\\other\\file', `${root}2\\file`]) expect(assessWindowsPath(root, path).length).toBeGreaterThan(0);
    expect(assessFilesystemAccess(capability.workspaces[0] as never, `${root}\\src`, 'WRITE'))
      .toContain('REPARSE_POINT_UNVERIFIED');
    expect(parseWorkerCapabilities(capability)).toEqual(capability);
    for (const invalid of [
      { ...capability, executable: { absolutePath: '*', sha256: 'b'.repeat(64) } },
      { ...capability, network: { mode: 'ALLOWLIST', destinations: ['*'] } },
      { ...capability, limits: { ...capability.limits, runtimeMillis: 0 } },
      { ...capability, role: 'REVIEWER' }, { ...capability, role: 'TESTER' },
      { ...capability, github: { mode: 'WRITE' } },
      { ...capability, environmentAllowlist: ['S2A_FIXTURE_MARKER', ,] },
      ...['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND',
        'HOME', 'USERPROFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'COMSPEC', 'AWS_ACCESS_KEY_ID', 'CI']
        .map((name) => ({ ...capability, environmentAllowlist: [name] })),
      { ...capability, environmentAllowlist: ['S2A_FIXTURE_MARKER', 'S2A_FIXTURE_MARKER'] }
    ]) expect(() => parseWorkerCapabilities(invalid)).toThrow();
  });
  it('preserves B3A/B3B and S1 denial boundaries in pure fixtures', () => {
    expect(assessReceipt(envelope, undefined, now).authoritative).toBe(false);
    expect(assessReceiptHistory(envelope, [], now, { result: 'NOT_FOUND', complete: true,
      excludesDelayedDelivery: true })).toMatchObject({ claimedOutcome: 'UNCERTAIN', authoritative: false });
    expect(verifyCurrentPermission({ action: 'ASSIGNMENT', actorId: 'builder-1', repository: envelope.repository,
      target: { kind: 'issue', number: 23 }, issueNumber: 23 } as never).executable).toBe(false);
    expect(planSupervisedAdmission({}).executable).toBe(false);
  });
});
