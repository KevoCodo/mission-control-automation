import { assessFence, matchesDispatchRecord, parseExecutionEnvelope, type ExecutionEnvelope,
  type FencingSnapshot } from './executionProtocol.js';
import { parseWorkerIdentity, type WorkerIdentity } from './workerIdentity.js';
import { assessWindowsPath, parseWorkerCapabilities, type WorkerCapabilities } from './workerIsolation.js';
import { parseAuthorizationRecord } from './authorization.js';
import { fingerprintDispatchPayload } from './dispatch.js';
import type { AuthorizationRecord, DispatchRecord } from './types.js';

/** Versioned claims for one Builder dispatch. This module has no launch or authority implementation. */
export const BUILDER_REQUEST_VERSION = 1 as const;
export interface BuilderExecutionRequest {
  version: 1;
  envelope: ExecutionEnvelope;
  workerIdentity: WorkerIdentity;
  approvedPlanDigest: string;
  capabilities: WorkerCapabilities;
}

/** Additional scope a future trusted issuer must bind to the existing grant ID. */
export interface BuilderGrantBinding {
  version: 1;
  grantId: string;
  dispatchId: string;
  generation: number;
  repository: ExecutionEnvelope['repository'];
  issueNumber: number;
  approvedPlanDigest: string;
  approvalEvidenceRef: string;
  baseCommit: string;
  branch: string;
  worktreeId: string;
  workspaceRoot: string;
  executablePath: string;
  executableSha256: string;
  policyDigest: string;
  fencingEpoch: number;
  expiresAt: string;
}

export interface BuilderAdmissionClaims {
  dispatch: DispatchRecord;
  grant: AuthorizationRecord;
  grantBinding: BuilderGrantBinding;
  currentAuthorizationEpoch: number;
  consumedGrantIds: readonly string[];
  fence: FencingSnapshot;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);
const canonicalIssueTargetId = (issueNumber: number): string => 'issue-' + issueNumber;
const own = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype &&
  Object.getOwnPropertySymbols(v).length === 0 && Object.getOwnPropertyNames(v).length === Object.keys(v).length &&
  Object.keys(v).every((k) => 'value' in (Object.getOwnPropertyDescriptor(v, k) ?? {}));
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  own(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const strictArray = (v: unknown): v is unknown[] => Array.isArray(v) &&
  Object.getPrototypeOf(v) === Array.prototype && Object.getOwnPropertySymbols(v).length === 0 &&
  Object.getOwnPropertyNames(v).length === v.length + 1 &&
  Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i) &&
    'value' in (Object.getOwnPropertyDescriptor(v, String(i)) ?? {})).every(Boolean);
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const bindingKeys = ['version', 'grantId', 'dispatchId', 'generation', 'repository', 'issueNumber',
  'approvedPlanDigest', 'approvalEvidenceRef', 'baseCommit', 'branch', 'worktreeId', 'workspaceRoot', 'executablePath',
  'executableSha256', 'policyDigest',
  'fencingEpoch', 'expiresAt'];

export function parseBuilderGrantBinding(value: unknown): BuilderGrantBinding {
  if (!exact(value, bindingKeys) || value.version !== 1 || !matches(value.grantId, ID) ||
    typeof value.dispatchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.dispatchId) ||
    !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
    !exact(value.repository, ['owner', 'name']) || !matches(value.repository.owner, ID) ||
    !matches(value.repository.name, ID) || !Number.isSafeInteger(value.issueNumber) ||
    Number(value.issueNumber) < 1 || !matches(value.approvedPlanDigest, SHA256) ||
    !matches(value.approvalEvidenceRef, ID) ||
    !matches(value.baseCommit, SHA1) || !matches(value.branch, ID) ||
    !matches(value.worktreeId, ID) || assessWindowsPath(value.workspaceRoot, value.workspaceRoot).length !== 0 ||
    assessWindowsPath(value.executablePath, value.executablePath).length !== 0 ||
    !matches(value.executableSha256, SHA256) ||
    !matches(value.policyDigest, SHA256) || !Number.isSafeInteger(value.fencingEpoch) ||
    Number(value.fencingEpoch) < 0 || !time(value.expiresAt))
    throw new Error('Invalid Builder grant binding claim.');
  return value as unknown as BuilderGrantBinding;
}

export function parseBuilderExecutionRequest(value: unknown, now: Date): BuilderExecutionRequest {
  if (!exact(value, ['version', 'envelope', 'workerIdentity', 'approvedPlanDigest', 'capabilities']) ||
    value.version !== BUILDER_REQUEST_VERSION || !matches(value.approvedPlanDigest, SHA256) ||
    !own(value.workerIdentity) || !matches(value.workerIdentity.expectedBaseCommit, SHA1) ||
    !own(value.capabilities) || !own(value.capabilities.executable) ||
    !matches(value.capabilities.executable.sha256, SHA256) ||
    !strictArray(value.capabilities.workspaces) ||
    value.capabilities.workspaces.some((scope) => !own(scope) || !strictArray(scope.operations)) ||
    !own(value.capabilities.network) || !strictArray(value.capabilities.network.destinations) ||
    !strictArray(value.capabilities.environmentAllowlist))
    throw new Error('Invalid Builder execution request.');
  const envelope = parseExecutionEnvelope(value.envelope);
  const workerIdentity = parseWorkerIdentity(value.workerIdentity, envelope, now);
  const capabilities = parseWorkerCapabilities(value.capabilities);
  const limits = capabilities.limits;
  if (envelope.agentRole !== 'BUILDER' || envelope.actionScope !== 'ASSIGNMENT' || !envelope.worktreeId ||
    capabilities.role !== 'BUILDER' || capabilities.workspaces.length !== 1 ||
    capabilities.workspaces[0].root !== workerIdentity.workspaceRoot ||
    capabilities.workspaces[0].operations.length !== 2 ||
    !capabilities.workspaces[0].operations.includes('READ') ||
    !capabilities.workspaces[0].operations.includes('WRITE') ||
    capabilities.network.mode !== 'DENY' || capabilities.github.mode !== 'NONE' ||
    capabilities.environmentAllowlist.length !== 0 ||
    limits.runtimeMillis > 4 * 60 * 60 * 1000 || limits.cpuMillis > 4 * 60 * 60 * 1000 ||
    limits.memoryBytes > 16 * 1024 ** 3 || limits.maxProcesses > 16 ||
    limits.outputBytes > 64 * 1024 ** 2)
    throw new Error('Builder request exceeds the source policy.');
  return value as unknown as BuilderExecutionRequest;
}

/** Exact B2 payload to record under the existing operation key before any future handoff. */
export function builderDispatchPayload(request: BuilderExecutionRequest): object {
  const { envelope: e, workerIdentity: w, capabilities: c } = request;
  return { version: 1, kind: 'BUILDER', dispatchId: e.dispatchId, operationKey: e.operationKey,
    repository: e.repository, issueNumber: e.issueNumber, targetId: e.targetId,
    generation: e.generation, branch: e.branch, worktreeId: e.worktreeId,
    grantId: e.grantId, fencingEpoch: e.fencingEpoch, expiresAt: e.expiresAt,
    workerExecutionId: w.workerExecutionId, approvedPlanDigest: request.approvedPlanDigest,
    baseCommit: w.expectedBaseCommit, workspaceRoot: w.workspaceRoot, capabilities: c };
}

/** Structural comparison only. A supervisor must authenticate inputs and consume the grant atomically. */
export function assessBuilderAdmission(value: unknown, claims: BuilderAdmissionClaims, now: Date): string[] {
  let request: BuilderExecutionRequest;
  let binding: BuilderGrantBinding;
  try {
    if (!claims || !claims.dispatch || !Number.isSafeInteger(claims.currentAuthorizationEpoch) ||
      claims.currentAuthorizationEpoch < 0 || !Array.isArray(claims.consumedGrantIds) ||
      claims.consumedGrantIds.some((id) => typeof id !== 'string')) throw new Error('Invalid admission context.');
    request = parseBuilderExecutionRequest(value, now);
    binding = parseBuilderGrantBinding(claims.grantBinding);
    parseAuthorizationRecord(claims.grant);
  }
  catch { return ['INVALID_STRUCTURE']; }
  const { envelope: e, workerIdentity: w, capabilities: c } = request;
  const { dispatch: d, grant: g } = claims;
  const reasons: string[] = [];
  if (d.state !== 'INTENT_RECORDED' || !matchesDispatchRecord(e, d)) reasons.push('DISPATCH_MISMATCH');
  if (fingerprintDispatchPayload(builderDispatchPayload(request)) !== e.payloadDigest)
    reasons.push('PAYLOAD_MISMATCH');
  if (e.repository.owner !== 'KevoCodo' || e.repository.name !== 'operis' || e.issueNumber !== 4 ||
    e.targetId !== canonicalIssueTargetId(e.issueNumber))
    reasons.push('PILOT_SCOPE_MISMATCH');
  if (g.grantId !== e.grantId || g.action !== 'ASSIGNMENT' || g.target.kind !== 'issue' ||
    g.target.number !== e.issueNumber || g.issueNumber !== e.issueNumber ||
    e.targetId !== canonicalIssueTargetId(g.target.number) ||
    g.repository.owner !== e.repository.owner || g.repository.name !== e.repository.name ||
    g.status !== 'VERIFIED' || g.constraints.maxUses !== 1 ||
    g.revocationEpoch !== claims.currentAuthorizationEpoch || g.correlationId !== e.correlationId ||
    Date.parse(g.issuedAt) > Date.parse(e.issuedAt) || Date.parse(g.expiresAt) < Date.parse(e.expiresAt) ||
    !Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(g.expiresAt)) reasons.push('GRANT_SCOPE_MISMATCH');
  if (!Array.isArray(claims.consumedGrantIds) || claims.consumedGrantIds.includes(e.grantId))
    reasons.push('GRANT_REPLAYED');
  if (binding.grantId !== e.grantId || binding.dispatchId !== e.dispatchId ||
    binding.generation !== e.generation || binding.repository.owner !== e.repository.owner ||
    binding.repository.name !== e.repository.name || binding.issueNumber !== e.issueNumber ||
    e.targetId !== canonicalIssueTargetId(binding.issueNumber) ||
    binding.approvedPlanDigest !== request.approvedPlanDigest || binding.baseCommit !== w.expectedBaseCommit ||
    binding.branch !== e.branch || binding.worktreeId !== e.worktreeId ||
    binding.workspaceRoot !== w.workspaceRoot || binding.executablePath !== c.executable.absolutePath ||
    binding.executableSha256 !== c.executable.sha256 ||
    binding.policyDigest !== fingerprintDispatchPayload(c) ||
    binding.fencingEpoch !== e.fencingEpoch || binding.expiresAt !== e.expiresAt)
    reasons.push('GRANT_BINDING_MISMATCH');
  reasons.push(...assessFence(e, claims.fence, now));
  return [...new Set(reasons)];
}

/** Supervisor-owned, authenticated events must be durable and ordered for one exact dispatch. */
export interface SupervisorExecutionEvidence {
  dispatchId: string;
  payloadDigest: string;
  workerExecutionId: string;
  grantId: string;
  generation: number;
  fencingEpoch: number;
  sequence: number;
  event: 'REJECTED' | 'RESERVED' | 'GRANT_CONSUMED' | 'PROCESS_STARTED' | 'STOP_BARRIER' |
    'PROCESS_EXITED' | 'DESCENDANTS_CONTAINED' | 'UNCERTAIN';
  timestamp: string;
  executableSha256: string;
  workspaceRoot: string;
  process?: { pid: number; creationTime: string; jobId: string };
  evidenceRef: string;
  authentication: { method: string; keyId: string; proofRef: string };
}

/** Contract only. No implementation is registered in this checkout. */
export interface TrustedBuilderSupervisor {
  /** Atomically authenticate scope, consume a one-use grant, and reserve against STOP before start. */
  admit(request: BuilderExecutionRequest): Promise<{ decision: 'REJECTED' | 'RESERVED'; evidence: SupervisorExecutionEvidence }>;
  /** Exact-ID read with complete retention; gaps or failed authentication remain uncertain. */
  lookupEvidence(dispatchId: string): Promise<{ status: 'FOUND' | 'UNCERTAIN'; authenticated: boolean;
    complete: boolean; events: readonly SupervisorExecutionEvidence[] }>;
  /** Durable monotonic barrier across all start ingress, then terminate the whole process tree. */
  stop(scope: { dispatchId: string; repository: ExecutionEnvelope['repository']; issueNumber: number;
    targetId: string; generation: number; expectedEpoch: number }): Promise<{ newEpoch: number;
      barrier: SupervisorExecutionEvidence;
      descendantsContained: boolean }>;
  /** Restart and lost acknowledgments never imply a retry or retirement. */
  recover(dispatchId: string): Promise<{ status: 'QUARANTINED' | 'RECONCILED';
    events: readonly SupervisorExecutionEvidence[] }>;
}
