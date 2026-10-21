import { describe, expect, it } from 'vitest';
import { assessBuilderAdmission, builderDispatchPayload, parseBuilderExecutionRequest, parseBuilderGrantBinding } from '../builderTrustedExecution.js';
import { fingerprintDispatchPayload } from '../dispatch.js';
import { verifyCurrentPermission } from '../authorization.js';
import type { AuthorizationRecord, DispatchRecord } from '../types.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const repository = { owner: 'KevoCodo', name: 'operis' };
const root = 'E:\\Isolated\\operis-builder-4';
const envelope = { protocolVersion: 1, dispatchId: '123e4567-e89b-42d3-a456-426614174000',
  operationKey: 'operis/4/builder', repository, issueNumber: 4, targetId: 'issue-4',
  branch: 'builder/issue-4', worktreeId: 'operis-4', agentRole: 'BUILDER', generation: 1,
  actionScope: 'ASSIGNMENT', payloadDigest: fingerprintDispatchPayload({ fixture: 'plan' }),
  digestAlgorithm: 'SHA-256-CANONICAL-JSON', grantId: 'grant-4',
  issuedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-10-17T13:00:00.000Z',
  fencingEpoch: 7, correlationId: 'corr-4' };
const identity = { version: 1, workerExecutionId: 'worker-4', dispatchId: envelope.dispatchId,
  repository, issueNumber: 4, agentRole: 'BUILDER', targetId: envelope.targetId,
  generation: 1, branch: envelope.branch, worktreeId: envelope.worktreeId, workspaceRoot: root,
  expectedBaseCommit: 'a'.repeat(40), grantId: envelope.grantId, fencingEpoch: 7,
  correlationId: envelope.correlationId, issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt };
const capabilities = { role: 'BUILDER', workspaces: [{ root, operations: ['READ', 'WRITE'] }],
  executable: { absolutePath: 'C:\\Trusted\\codex.exe', sha256: 'b'.repeat(64) },
  network: { mode: 'DENY', destinations: [] }, environmentAllowlist: [], github: { mode: 'NONE' },
  limits: { cpuMillis: 1000, memoryBytes: 1024, maxProcesses: 1, runtimeMillis: 1000, outputBytes: 1024 } };
const request = { version: 1, envelope, workerIdentity: identity, approvedPlanDigest: 'c'.repeat(64), capabilities };
envelope.payloadDigest = fingerprintDispatchPayload(builderDispatchPayload(request as never));
const dispatch: DispatchRecord = { version: 1, dispatchId: envelope.dispatchId,
  operationKey: envelope.operationKey, repository, issueNumber: 4, branch: envelope.branch,
  target: { targetId: envelope.targetId }, payloadSha256: envelope.payloadDigest,
  correlationId: envelope.correlationId, createdAt: envelope.issuedAt, updatedAt: envelope.issuedAt,
  state: 'INTENT_RECORDED' };
const grant: AuthorizationRecord = { version: 1, grantId: envelope.grantId, issuerId: 'issuer-1',
  issuerProvenance: 'fixture', actorId: 'actor-1', action: 'ASSIGNMENT', repository,
  target: { kind: 'issue', number: 4 }, issueNumber: 4, constraints: { maxUses: 1, purpose: 'issue-4' },
  issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt, revocationEpoch: 0,
  status: 'VERIFIED', createdAt: envelope.issuedAt, updatedAt: envelope.issuedAt,
  correlationId: envelope.correlationId, auditEvidenceRef: 'fixture-1' };
const binding = { version: 1, grantId: envelope.grantId, dispatchId: envelope.dispatchId,
  generation: 1, repository, issueNumber: 4, approvedPlanDigest: request.approvedPlanDigest,
  approvalEvidenceRef: 'approved-plan-4',
  baseCommit: identity.expectedBaseCommit, branch: envelope.branch, worktreeId: envelope.worktreeId,
  workspaceRoot: root, executablePath: capabilities.executable.absolutePath,
  executableSha256: capabilities.executable.sha256, policyDigest: fingerprintDispatchPayload(capabilities),
  fencingEpoch: 7, expiresAt: envelope.expiresAt };
const claims = { dispatch, grant, grantBinding: binding, currentAuthorizationEpoch: 0,
  consumedGrantIds: [], fence: { scopeId: 'KevoCodo/operis/issue-4', currentEpoch: 7,
    generation: 1, barrierReceiptId: 'barrier-7', durableEvidenceRef: 'durable-7' } };

describe('Builder trusted execution request claims', () => {
  it('accepts only the bounded versioned Builder fixture shape', () => {
    expect(parseBuilderExecutionRequest(request, now)).toEqual(request);
    expect(parseBuilderGrantBinding(binding)).toEqual(binding);
    expect(assessBuilderAdmission(request, claims, now)).toEqual([]);
    expect(verifyCurrentPermission({ action: 'ASSIGNMENT', actorId: 'actor-1', repository,
      target: { kind: 'issue', number: 4 }, issueNumber: 4 }).executable).toBe(false);
  });
  it('rejects unknown, missing, malformed, expired, and excessive requests', () => {
    const cases = [null, { ...request, version: 2 }, { ...request, unknown: true },
      { ...request, approvedPlanDigest: undefined }, { ...request, approvedPlanDigest: 'bad' },
      { ...request, envelope: { ...envelope, agentRole: 'TESTER' } },
      { ...request, envelope: { ...envelope, dispatchId: '123e4567-e89b-42d3-a456-426614174001' } },
      { ...request, workerIdentity: { ...identity, expectedBaseCommit: 'bad' } },
      { ...request, capabilities: { ...capabilities, network: { mode: 'ALLOWLIST', destinations: ['example.com:443'] } } },
      { ...request, capabilities: { ...capabilities, github: { mode: 'READ_ONLY', repository } } },
      { ...request, capabilities: { ...capabilities, limits: { ...capabilities.limits, maxProcesses: 17 } } }];
    for (const item of cases) expect(() => parseBuilderExecutionRequest(item, now)).toThrow();
    expect(() => parseBuilderExecutionRequest(request, new Date(envelope.expiresAt))).toThrow();
  });
  it.each([
    ['array containing a digest', [request.approvedPlanDigest]],
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['object', { digest: request.approvedPlanDigest }],
  ])('rejects approved plan digest of type %s', (_name, digest) => {
    expect(() => parseBuilderExecutionRequest({ ...request, approvedPlanDigest: digest }, now)).toThrow();
  });
  it.each([
    ['null envelope', { ...request, envelope: null }],
    ['array envelope', { ...request, envelope: [envelope] }],
    ['null worker identity', { ...request, workerIdentity: null }],
    ['array worker identity', { ...request, workerIdentity: [identity] }],
    ['array base commit', { ...request, workerIdentity: { ...identity, expectedBaseCommit: [identity.expectedBaseCommit] } }],
    ['null capabilities', { ...request, capabilities: null }],
    ['null executable', { ...request, capabilities: { ...capabilities, executable: null } }],
    ['array executable digest', { ...request, capabilities: { ...capabilities,
      executable: { ...capabilities.executable, sha256: [capabilities.executable.sha256] } } }],
    ['null workspace', { ...request, capabilities: { ...capabilities, workspaces: [null] } }],
    ['null network', { ...request, capabilities: { ...capabilities, network: null } }],
    ['array with unexpected property', { ...request, capabilities: { ...capabilities,
      workspaces: Object.assign([...capabilities.workspaces], { extra: true }) } }],
    ['operations array with unexpected property', { ...request, capabilities: { ...capabilities,
      workspaces: [{ ...capabilities.workspaces[0],
        operations: Object.assign([...capabilities.workspaces[0].operations], { extra: true }) }] } }],
  ])('rejects request with %s', (_name, candidate) => {
    expect(() => parseBuilderExecutionRequest(candidate, now)).toThrow();
  });
  it.each([
    ['extra field', { ...binding, extra: true }],
    ['invalid policy digest', { ...binding, policyDigest: 'bad' }],
    ['empty approval evidence reference', { ...binding, approvalEvidenceRef: '' }],
    ['traversal workspace root', { ...binding, workspaceRoot: 'E:\\Isolated\\..\\other' }],
    ['missing grant ID', { ...binding, grantId: undefined }],
    ['non-string grant ID', { ...binding, grantId: 123 }],
    ['missing repository owner', { ...binding, repository: { ...repository, owner: undefined } }],
  ])('rejects grant binding with %s', (_name, candidate) => {
    expect(() => parseBuilderGrantBinding(candidate)).toThrow();
  });
  it('rejects dispatch conflicts and replayed dispatch state', () => {
    for (const change of [{ dispatchId: 'other' }, { operationKey: 'other' },
      { payloadSha256: 'd'.repeat(64) }, { branch: 'other' }, { state: 'SUBMITTING' }])
      expect(assessBuilderAdmission(request, { ...claims, dispatch: { ...dispatch, ...change } }, now))
        .toContain('DISPATCH_MISMATCH');
    expect(assessBuilderAdmission({ ...request, envelope: { ...envelope, issueNumber: 5 },
      workerIdentity: { ...identity, issueNumber: 5 } }, claims, now)).toContain('PILOT_SCOPE_MISMATCH');
    expect(assessBuilderAdmission({ ...request, approvedPlanDigest: 'd'.repeat(64) }, claims, now))
      .toContain('PAYLOAD_MISMATCH');
  });
  it('rejects every grant scope and approved plan mismatch', () => {
    for (const change of [{ approvedPlanDigest: 'd'.repeat(64) }, { baseCommit: 'd'.repeat(40) },
      { executablePath: 'C:\\Other\\codex.exe' }, { executableSha256: 'd'.repeat(64) },
      { policyDigest: 'd'.repeat(64) }, { workspaceRoot: 'E:\\Other\\worker' },
      { branch: 'other' }, { generation: 2 }, { grantId: 'other' }, { fencingEpoch: 8 }])
      expect(assessBuilderAdmission(request, { ...claims, grantBinding: { ...binding, ...change } }, now))
        .toContain('GRANT_BINDING_MISMATCH');
    expect(assessBuilderAdmission(request, { ...claims, consumedGrantIds: ['grant-4'] }, now))
      .toContain('GRANT_REPLAYED');
    expect(assessBuilderAdmission(request, { ...claims, currentAuthorizationEpoch: 1 }, now))
      .toContain('GRANT_SCOPE_MISMATCH');
  });
  it('rejects an internally inconsistent grant as invalid structure', () => {
    expect(assessBuilderAdmission(request, { ...claims, grant: { ...grant, issueNumber: 5 } }, now))
      .toEqual(['INVALID_STRUCTURE']);
  });
  it('rejects a structurally valid grant for another issue as a scope mismatch', () => {
    expect(assessBuilderAdmission(request, { ...claims, grant: {
      ...grant, target: { kind: 'issue', number: 5 }, issueNumber: 5 } }, now))
      .toContain('GRANT_SCOPE_MISMATCH');
  });
  it('rejects issue-5 target despite matching dispatch and STOP fence claims for issue 4', () => {
    const wrongEnvelope = { ...envelope, targetId: 'issue-5' };
    const wrongRequest = { ...request, envelope: wrongEnvelope,
      workerIdentity: { ...identity, targetId: 'issue-5' } };
    wrongEnvelope.payloadDigest = fingerprintDispatchPayload(builderDispatchPayload(wrongRequest as never));
    const wrongClaims = { ...claims,
      dispatch: { ...dispatch, target: { targetId: 'issue-5' }, payloadSha256: wrongEnvelope.payloadDigest },
      fence: { ...claims.fence, scopeId: 'KevoCodo/operis/issue-5' } };
    expect(parseBuilderExecutionRequest(wrongRequest, now)).toEqual(wrongRequest);
    expect(assessBuilderAdmission(wrongRequest, wrongClaims, now)).toEqual([
      'PILOT_SCOPE_MISMATCH', 'GRANT_SCOPE_MISMATCH', 'GRANT_BINDING_MISMATCH',
    ]);
  });
  it('rejects stale STOP epochs and generations', () => {
    expect(assessBuilderAdmission(request, { ...claims, fence: { ...claims.fence, currentEpoch: 8 } }, now))
      .toContain('STALE_EPOCH');
    expect(assessBuilderAdmission(request, { ...claims, fence: { ...claims.fence, generation: 2 } }, now))
      .toContain('STALE_GENERATION');
  });
});
