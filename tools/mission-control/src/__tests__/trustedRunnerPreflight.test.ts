import { describe, expect, it } from 'vitest';
import { fingerprintDispatchPayload } from '../dispatch.js';
import { RUNNER_CONTROLS, assessTrustedRunnerPreflight } from '../trustedRunnerPreflight.js';
import { assessWindowsFilesystemIdentity } from '../windowsFilesystemPreflight.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const root = 'E:\\AI-Development\\isolated\\worker-23';
const repository = { owner: 'KevoCodo', name: 'ai-delivery-lab' };
function fixture() {
  const envelope = { protocolVersion: 1, dispatchId: '123e4567-e89b-42d3-a456-426614174000',
    operationKey: 'fixture/23', repository, issueNumber: 23, targetId: 'target-23', branch: 'issue-23',
    worktreeId: 'worktree-23', agentRole: 'BUILDER', generation: 3, actionScope: 'ASSIGNMENT',
    payloadDigest: fingerprintDispatchPayload({ fixture: true }), digestAlgorithm: 'SHA-256-CANONICAL-JSON',
    grantId: 'grant-23', issuedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-10-17T13:00:00.000Z',
    fencingEpoch: 7, correlationId: 'corr-23' };
  return {
    envelope,
    identity: { version: 1, workerExecutionId: 'worker-23', dispatchId: envelope.dispatchId,
      repository, issueNumber: 23, agentRole: 'BUILDER', targetId: 'target-23', generation: 3,
      branch: 'issue-23', worktreeId: 'worktree-23', workspaceRoot: root, expectedBaseCommit: 'a'.repeat(40),
      grantId: 'grant-23', fencingEpoch: 7, correlationId: 'corr-23', issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt },
    capabilities: { role: 'BUILDER', workspaces: [{ root, operations: ['READ', 'WRITE'] }],
      executable: { absolutePath: 'C:\\Tools\\codex.exe', sha256: 'b'.repeat(64) },
      network: { mode: 'DENY', destinations: [] }, environmentAllowlist: ['S2A_FIXTURE_MARKER'],
      github: { mode: 'NONE' }, limits: { cpuMillis: 1000, memoryBytes: 1024, maxProcesses: 1,
        runtimeMillis: 1000, outputBytes: 1024 } },
    fence: { stop: { active: false, durableEpoch: 7, generation: 3, barrierReceiptId: 'barrier-7',
      durableEvidenceRef: 'durable-7' }, grant: { grantId: 'grant-23', expiresAt: envelope.expiresAt,
      revoked: false }, dispatchGeneration: 3 },
    filesystem: { workspaceRoot: root, candidate: root, resolvedRoot: root, resolvedCandidate: root,
      volumeId: 'volume-123', rootFileId: 'file-12345', candidateFileId: 'file-12345',
      components: ['ORDINARY'] },
    provider: { version: 1, origin: 'FIXTURE', evidenceRef: 'fixture-provider' },
    claims: RUNNER_CONTROLS.map((control, i) => ({ control, status: 'READY',
      workerExecutionId: 'worker-23', dispatchId: envelope.dispatchId, repository, generation: 3,
      fencingEpoch: 7, evidenceRef: `claim-${i}` }))
  };
}
const reasons = (v: unknown) => assessTrustedRunnerPreflight(v, now).reasons;

describe('S2B-1 trusted runner claim preflight', () => {
  it('never promotes complete fixture or caller-supplied trusted labels to production authority', () => {
    const v = fixture();
    expect(assessTrustedRunnerPreflight(v, now)).toMatchObject({ structurallyValid: true,
      locallyClaimedReady: false, independentlyAuthenticated: false, productionAuthorized: false,
      executable: false });
    v.provider.origin = 'TRUSTED_COMPONENT';
    const claim = assessTrustedRunnerPreflight({ ...v, verifierEvidenceRef: 'verifier-1',
      atomicGateEvidenceRef: 'gate-1', sandboxReady: true }, now);
    expect(claim).toMatchObject({ structurallyValid: false, productionAuthorized: false });
    const spoofed = assessTrustedRunnerPreflight({ ...v, verifierEvidenceRef: 'verifier-1',
      atomicGateEvidenceRef: 'gate-1' }, now);
    expect(spoofed).toMatchObject({ structurallyValid: true, locallyClaimedReady: true,
      independentlyAuthenticated: false, productionAuthorized: false, executable: false });
  });
  it.each([
    ['trusted provider missing', (x: ReturnType<typeof fixture>) => { (x as { provider: unknown }).provider = null; }, 'TRUSTED_PROVIDER_MISSING'],
    ['unsupported version', (x: ReturnType<typeof fixture>) => { x.provider.version = 2; }, 'UNSUPPORTED_PROVIDER_VERSION'],
    ['missing executable hash', (x: ReturnType<typeof fixture>) => { x.capabilities.executable.sha256 = ''; }, 'MALFORMED_OR_CONFLICTING_WORKER_CONTRACT'],
    ['wrong worker', (x: ReturnType<typeof fixture>) => { x.claims[0].workerExecutionId = 'other'; }, 'WRONG_WORKER_IDENTITY'],
    ['wrong dispatch', (x: ReturnType<typeof fixture>) => { x.claims[0].dispatchId = 'other'; }, 'WRONG_DISPATCH_BINDING'],
    ['wrong repository', (x: ReturnType<typeof fixture>) => { x.claims[0].repository = { owner: 'other', name: 'repo' }; }, 'WRONG_REPOSITORY'],
    ['stale generation', (x: ReturnType<typeof fixture>) => { x.claims[0].generation = 2; }, 'STALE_GENERATION'],
    ['stale epoch', (x: ReturnType<typeof fixture>) => { x.claims[0].fencingEpoch = 6; }, 'STALE_FENCING_EPOCH'],
    ['STOP active', (x: ReturnType<typeof fixture>) => { x.fence.stop.active = true; }, 'STOP_ACTIVE_OR_UNKNOWN'],
    ['STOP evidence absent', (x: ReturnType<typeof fixture>) => { x.fence.stop.barrierReceiptId = ''; }, 'MISSING_BARRIER_EVIDENCE'],
    ['missing process containment', (x: ReturnType<typeof fixture>) => { x.claims = x.claims.filter(c => c.control !== 'PROCESS_TREE'); }, 'CONTROL_MISSING_PROCESS_TREE'],
    ['missing network restriction', (x: ReturnType<typeof fixture>) => { x.claims = x.claims.filter(c => c.control !== 'NETWORK'); }, 'CONTROL_MISSING_NETWORK'],
    ['missing credential isolation', (x: ReturnType<typeof fixture>) => { x.claims = x.claims.filter(c => c.control !== 'CREDENTIALS'); }, 'CONTROL_MISSING_CREDENTIALS'],
    ['missing resource limits', (x: ReturnType<typeof fixture>) => { x.claims = x.claims.filter(c => c.control !== 'RESOURCE_LIMITS'); }, 'CONTROL_MISSING_RESOURCE_LIMITS'],
    ['missing barrier', (x: ReturnType<typeof fixture>) => { x.claims = x.claims.filter(c => c.control !== 'STOP_BARRIER'); }, 'MISSING_LAUNCH_SYNCHRONIZATION_BARRIER'],
    ['missing durable state', (x: ReturnType<typeof fixture>) => { x.claims = x.claims.filter(c => c.control !== 'DURABLE_STATE'); }, 'MISSING_DURABLE_EXECUTION_STATE'],
    ['invalid containment', (x: ReturnType<typeof fixture>) => { x.filesystem.candidate = 'F:\\other\\worker'; }, 'OUTSIDE_WORKSPACE'],
    ['reparse ambiguity', (x: ReturnType<typeof fixture>) => { x.filesystem.components = ['UNKNOWN']; }, 'REPARSE_POINT_UNVERIFIED'],
    ['unverifiable identity', (x: ReturnType<typeof fixture>) => { x.filesystem.volumeId = ''; }, 'MALFORMED_FILESYSTEM_IDENTITY'],
    ['duplicate evidence', (x: ReturnType<typeof fixture>) => { x.claims.push({ ...x.claims[0] }); }, 'DUPLICATE_OR_CONTRADICTORY_EVIDENCE']
  ])('%s fails closed', (_name, mutate, expected) => {
    const v = fixture(); mutate(v); expect(reasons(v)).toContain(expected);
    expect(assessTrustedRunnerPreflight(v, now).productionAuthorized).toBe(false);
  });
  it('rejects malformed nested objects and sparse arrays', () => {
    const v = fixture();
    for (const bad of [null, [], { ...v, claims: [v.claims[0], ,] },
      { ...v, claims: [{ ...v.claims[0], repository: null }] },
      { ...v, filesystem: { ...v.filesystem, components: ['ORDINARY', ,] } },
      { ...v, fence: { ...v.fence, stop: [] } }])
      expect(assessTrustedRunnerPreflight(bad, now).productionAuthorized).toBe(false);
    expect(reasons({ ...v, claims: [v.claims[0], ,] })).toContain('MALFORMED_INPUT');
    expect(reasons({ ...v, claims: [{ ...v.claims[0], repository: null }] })).toContain('MALFORMED_CONTROL_EVIDENCE');
    expect(assessWindowsFilesystemIdentity({ ...v.filesystem, components: ['ORDINARY', ,] }))
      .toContain('MALFORMED_FILESYSTEM_IDENTITY');
  });
  it('rejects unsafe Windows forms and cannot authenticate claimed handle identity', () => {
    const v = fixture().filesystem;
    for (const candidate of ['\\\\server\\share\\x', '\\\\?\\E:\\x', `${root}\\..\\other`,
      `${root}\\file:stream`, `${root}\\CON`, `${root}\\link.`, `${root}\\x/y`])
      expect(assessWindowsFilesystemIdentity({ ...v, candidate }).length).toBeGreaterThan(0);
    expect(assessWindowsFilesystemIdentity(v)).toEqual([]);
  });
  it('checks claimed file IDs when root and candidate resolve to one location', () => {
    const v = fixture().filesystem;
    expect(assessWindowsFilesystemIdentity(v)).toEqual([]);
    expect(assessWindowsFilesystemIdentity({ ...v, candidateFileId: 'different-file-123' }))
      .toContain('FILE_IDENTITY_MISMATCH');
    const child = `${root}\\child`;
    expect(assessWindowsFilesystemIdentity({ ...v, candidate: child, resolvedCandidate: child,
      candidateFileId: 'different-file-123', components: ['ORDINARY', 'ORDINARY'] })).toEqual([]);
  });
});
