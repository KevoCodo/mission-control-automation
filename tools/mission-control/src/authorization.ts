import { randomUUID } from 'node:crypto';
import { appendAuditEvent } from './audit.js';
import { withStateLock } from './locks.js';
import { readState, writeStateAtomic } from './state.js';
import type { AuthorizationAction, AuthorizationRecord, AuthorizationState, ControllerState } from './types.js';

export class AuthorizationError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'AuthorizationError'; }
}

export interface AuthorizationClaim { grantId?: string; assertedBy: string; assertion: string }
export interface IssuanceEvidence {
  grantId: string;
  issuerId: string;
  evidenceRef: string;
  verifiedAt: string;
  provenance: 'trusted-issuer' | 'test-fixture';
}
/** A future authority must verify issuance independently of the caller and consume the grant atomically. */
export interface TrustedAuthorizationAuthority {
  verifyIssuance(record: AuthorizationRecord): Promise<IssuanceEvidence>;
  currentRevocationEpoch(): Promise<number>;
}
export interface AuthorizationRequest {
  action: AuthorizationAction;
  actorId: string;
  repository: { owner: string; name: string };
  target: { kind: 'issue' | 'pullRequest'; number: number };
  issueNumber?: number;
  pullRequestNumber?: number;
  headSha?: string;
}
export interface AuthorizationDecision {
  grantId?: string;
  action: AuthorizationAction;
  actorId: string;
  target: AuthorizationRequest['target'];
  scopeValid: boolean;
  verifiedPermission: false;
  executable: false;
  reason: string;
  verificationProvenance: string;
  expired: boolean;
  revoked: boolean;
  correlationId?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA = /^[a-f0-9]{40}$/i;
const ACTIONS: AuthorizationAction[] = ['ASSIGNMENT', 'REVIEW', 'CORRECTION', 'MERGE', 'CLOSURE'];
const STATUSES = ['REQUESTED', 'UNVERIFIED', 'VERIFIED', 'REVOKED', 'EXPIRED'];
const own = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function parseAuthorizationRecord(value: unknown): AuthorizationRecord {
  const allowed = new Set(['version','grantId','issuerId','issuerProvenance','actorId','action','repository','target',
    'issueNumber','pullRequestNumber','headSha','constraints','issuedAt','expiresAt','revocationEpoch','status',
    'createdAt','updatedAt','correlationId','auditEvidenceRef']);
  if (!own(value) || value.version !== 1 || !validId(value.grantId) || !validId(value.issuerId) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !validId(value.issuerProvenance) || !validId(value.actorId) || !ACTIONS.includes(value.action as AuthorizationAction) ||
    !STATUSES.includes(String(value.status)) || !own(value.repository) || !validId(value.repository.owner) ||
    !validId(value.repository.name) || Object.keys(value.repository).some((key) => !['owner','name'].includes(key)) ||
    !own(value.target) || Object.keys(value.target).some((key) => !['kind','number'].includes(key)) ||
    !['issue', 'pullRequest'].includes(String(value.target.kind)) ||
    !positive(value.target.number) || !own(value.constraints) || value.constraints.maxUses !== 1 ||
    !validId(value.constraints.purpose) || Object.keys(value.constraints).some((key) => !['maxUses','purpose'].includes(key)) ||
    !validTime(value.issuedAt) || !validTime(value.expiresAt) ||
    !validTime(value.createdAt) || !validTime(value.updatedAt) || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) || !Number.isSafeInteger(value.revocationEpoch) ||
    Number(value.revocationEpoch) < 0 || !validId(value.correlationId) || !validId(value.auditEvidenceRef) ||
    (value.issueNumber !== undefined && !positive(value.issueNumber)) ||
    (value.pullRequestNumber !== undefined && !positive(value.pullRequestNumber)) ||
    (value.headSha !== undefined && (typeof value.headSha !== 'string' || !SHA.test(value.headSha))) ||
    (value.target.kind === 'issue' && (value.issueNumber !== value.target.number || value.pullRequestNumber !== undefined || value.headSha !== undefined)) ||
    (value.target.kind === 'pullRequest' && (value.pullRequestNumber !== value.target.number || !positive(value.issueNumber) || !SHA.test(String(value.headSha)))) ||
    (['REVIEW', 'CORRECTION', 'MERGE', 'CLOSURE'].includes(String(value.action)) && value.target.kind !== 'pullRequest') ||
    (value.action === 'ASSIGNMENT' && value.target.kind !== 'issue'))
    throw new AuthorizationError('Malformed authorization record.', 'EAUTHORIZATION_RECORD');
  return value as unknown as AuthorizationRecord;
}

export function parseAuthorizationState(value: unknown): AuthorizationState {
  if (!own(value) || !Array.isArray(value.grants) || !Array.isArray(value.revocations) ||
    !Array.isArray(value.consumedGrantIds) || !Number.isSafeInteger(value.revocationEpoch) || Number(value.revocationEpoch) < 0)
    throw new AuthorizationError('Malformed authorization state.', 'EAUTHORIZATION_STATE');
  const grants = value.grants.map(parseAuthorizationRecord);
  if (value.revocations.some((event) => !own(event)))
    throw new AuthorizationError('Malformed authorization revocation.', 'EAUTHORIZATION_STATE');
  const revocations = value.revocations as Array<Record<string, unknown>>;
  const ids = grants.map((grant) => grant.grantId);
  const grantById = new Map(grants.map((grant) => [grant.grantId, grant]));
  const epochs = revocations.map((event) => event.epoch);
  const correlations = revocations.map((event) => event.correlationId);
  const evidenceRefs = revocations.map((event) => event.auditEvidenceRef);
  if (new Set(ids).size !== ids.length || value.consumedGrantIds.some((id) => !validId(id)) ||
    new Set(value.consumedGrantIds).size !== value.consumedGrantIds.length ||
    value.consumedGrantIds.some((id) => !ids.includes(id)) ||
    grants.some((grant) => grant.revocationEpoch > Number(value.revocationEpoch)) ||
    value.revocations.some((event) =>
      Object.keys(event).some((key) => !['grantId','epoch','revokedAt','correlationId','auditEvidenceRef',
        'initiatorClaimedActorId','initiatorProvenance'].includes(key)) ||
      !validId(event.grantId) || !positive(event.epoch) ||
      !validTime(event.revokedAt) || !validId(event.correlationId) || !validId(event.auditEvidenceRef) ||
      (event.initiatorProvenance !== undefined && event.initiatorProvenance !== 'unverified') ||
      (event.initiatorClaimedActorId !== undefined && (!validId(event.initiatorClaimedActorId) ||
        event.initiatorProvenance !== 'unverified')) ||
      Number(event.epoch) > Number(value.revocationEpoch) ||
      !grantById.has(String(event.grantId)) ||
      grantById.get(String(event.grantId))?.status !== 'REVOKED' ||
      Number(event.epoch) <= Number(grantById.get(String(event.grantId))?.revocationEpoch) ||
      grantById.get(String(event.grantId))?.updatedAt !== event.revokedAt) ||
    new Set(value.revocations.map((event) => (event as { grantId: string }).grantId)).size !== value.revocations.length ||
    new Set(epochs).size !== epochs.length || new Set(correlations).size !== correlations.length ||
    new Set(evidenceRefs).size !== evidenceRefs.length ||
    Number(value.revocationEpoch) !== revocations.length ||
    epochs.some((epoch) => !Number.isSafeInteger(epoch) || Number(epoch) < 1 || Number(epoch) > revocations.length) ||
    grants.some((grant) => grant.status === 'REVOKED' && !revocations.some((event) => event.grantId === grant.grantId)))
    throw new AuthorizationError('Duplicate or malformed authorization identity.', 'EAUTHORIZATION_STATE');
  return value as unknown as AuthorizationState;
}

/** Fixture evidence permits scope testing only. No issuer is registered in production. */
export function evaluateAuthorization(record: unknown, evidence: IssuanceEvidence | undefined,
  request: AuthorizationRequest, state: AuthorizationState, now: Date): AuthorizationDecision {
  let grant: AuthorizationRecord | undefined;
  try { if (record !== undefined) grant = parseAuthorizationRecord(record); } catch { /* fail closed */ }
  const expired = !!grant && now.getTime() >= Date.parse(grant.expiresAt);
  const revoked = !!grant && (grant.status === 'REVOKED' || state.revocations.some((item) => item.grantId === grant!.grantId));
  const base = { grantId: grant?.grantId, action: request.action, actorId: request.actorId, target: request.target,
    verifiedPermission: false as const, executable: false as const, expired, revoked,
    verificationProvenance: evidence?.provenance ?? 'unverified', correlationId: grant?.correlationId };
  let reason = 'AUTHORIZATION_MISSING';
  if (record !== undefined && !grant) reason = 'AUTHORIZATION_MALFORMED';
  else if (grant) {
    if (!evidence || evidence.provenance !== 'test-fixture' || evidence.grantId !== grant.grantId ||
      evidence.issuerId !== grant.issuerId || evidence.evidenceRef !== grant.auditEvidenceRef || !validTime(evidence.verifiedAt)) reason = 'ISSUER_UNVERIFIED';
    else if (revoked) reason = 'GRANT_REVOKED';
    else if (grant.status === 'EXPIRED') reason = 'GRANT_EXPIRED';
    else if (grant.status !== 'VERIFIED') reason = 'GRANT_UNVERIFIED';
    else if (grant.actorId !== request.actorId) reason = 'ACTOR_MISMATCH';
    else if (grant.repository.owner !== request.repository.owner || grant.repository.name !== request.repository.name) reason = 'REPOSITORY_MISMATCH';
    else if (grant.action !== request.action) reason = 'ACTION_MISMATCH';
    else if (grant.target.kind !== request.target.kind || grant.target.number !== request.target.number ||
      grant.issueNumber !== request.issueNumber || grant.pullRequestNumber !== request.pullRequestNumber) reason = 'TARGET_MISMATCH';
    else if (grant.headSha !== request.headSha) reason = 'HEAD_MISMATCH';
    else if (Date.parse(grant.issuedAt) > now.getTime()) reason = 'ISSUED_IN_FUTURE';
    else if (expired) reason = 'GRANT_EXPIRED';
    else if (grant.revocationEpoch !== state.revocationEpoch) reason = 'REVOCATION_EPOCH_STALE';
    else if (state.consumedGrantIds.includes(grant.grantId)) reason = 'GRANT_REPLAYED';
    else reason = 'SCOPE_VALID_FIXTURE_ONLY';
  }
  return { ...base, scopeValid: reason === 'SCOPE_VALID_FIXTURE_ONLY', reason };
}

/** Production never promotes a caller claim, a stored record, or fixture evidence to permission. */
export function verifyCurrentPermission(request: AuthorizationRequest, _claim?: AuthorizationClaim,
  _state?: ControllerState, _now?: Date): AuthorizationDecision {
  return { action: request.action, actorId: request.actorId, target: request.target, scopeValid: false,
    verifiedPermission: false, executable: false, reason: 'TRUSTED_ISSUER_UNAVAILABLE',
    verificationProvenance: 'none', expired: false, revoked: false };
}

/** Recording a denial is evidence of the decision, never permission to act. */
export async function recordAuthorizationDecision(auditPath: string, request: AuthorizationRequest,
  decision: AuthorizationDecision, correlationId: string, now = new Date()): Promise<void> {
  if (!validId(correlationId) || decision.action !== request.action || decision.actorId !== request.actorId ||
    decision.target.kind !== request.target.kind || decision.target.number !== request.target.number ||
    decision.verifiedPermission !== false || decision.executable !== false)
    throw new AuthorizationError('Invalid authorization denial.', 'EAUTHORIZATION_DECISION');
  await appendAuditEvent(auditPath, { type: 'authorization.decision', timestamp: now.toISOString(),
    correlationId, actor: { id: request.actorId }, issueNumber: request.issueNumber,
    pullRequestNumber: request.pullRequestNumber, headSha: request.headSha,
    authorization: 'denied', category: 'observation', provenance: { source: 'controller' },
    data: { grantId: decision.grantId ?? 'missing', requestedAction: request.action,
      repository: request.repository, target: request.target, decision: 'DENIED', denialReason: decision.reason,
      verificationProvenance: decision.verificationProvenance, expired: decision.expired,
      revoked: decision.revoked, correlationId } });
}

/** Store a claim for review only. An audit failure leaves state unchanged. */
export async function recordAuthorizationClaim(statePath: string, auditPath: string, input: unknown, now = new Date()): Promise<AuthorizationRecord> {
  const grant = parseAuthorizationRecord(input);
  if (!['REQUESTED', 'UNVERIFIED'].includes(grant.status) || grant.issuerProvenance === 'test-fixture')
    throw new AuthorizationError('Production cannot persist a verified or fixture authorization.', 'EAUTHORIZATION_UNTRUSTED');
  return withStateLock(statePath, 'authorization-claim', 60000, async () => {
    const state = await readState(statePath);
    if (state.repository.owner !== grant.repository.owner || state.repository.name !== grant.repository.name)
      throw new AuthorizationError('Repository mismatch.', 'EAUTHORIZATION_SCOPE');
    if (state.authorization.grants.some((item) => item.grantId === grant.grantId))
      throw new AuthorizationError('Grant ID already exists.', 'EAUTHORIZATION_DUPLICATE');
    await appendAuditEvent(auditPath, { type: 'authorization.claim.recorded', timestamp: now.toISOString(),
      correlationId: grant.correlationId, evidenceRef: grant.auditEvidenceRef, actor: { id: grant.actorId },
      issueNumber: grant.issueNumber, pullRequestNumber: grant.pullRequestNumber, headSha: grant.headSha,
      authorization: 'caller-claimed', category: 'observation', provenance: { source: 'caller' },
      data: { grantId: grant.grantId, action: grant.action, target: grant.target, decision: 'UNVERIFIED',
        denialReason: 'TRUSTED_ISSUER_UNAVAILABLE', issuerProvenance: grant.issuerProvenance,
        expiresAt: grant.expiresAt, revocationEpoch: grant.revocationEpoch } });
    await writeStateAtomic(statePath, { ...state, authorization: { ...state.authorization,
      grants: [...state.authorization.grants, grant] }, updatedAt: now.toISOString() });
    return grant;
  });
}

export async function revokeAuthorization(statePath: string, auditPath: string, grantId: string,
  correlationId: string, now = new Date(), initiatorClaimedActorId?: string): Promise<number> {
  if (!validId(grantId) || !validId(correlationId) ||
    (initiatorClaimedActorId !== undefined && !validId(initiatorClaimedActorId)))
    throw new AuthorizationError('Invalid revocation identity.', 'EAUTHORIZATION_INPUT');
  return withStateLock(statePath, 'authorization-revoke', 60000, async () => {
    const state = await readState(statePath);
    const grant = state.authorization.grants.find((item) => item.grantId === grantId);
    if (!grant) throw new AuthorizationError('Grant missing.', 'EAUTHORIZATION_MISSING');
    if (grant.status === 'REVOKED') return state.authorization.revocationEpoch;
    if (state.authorization.revocations.some((event) => event.correlationId === correlationId))
      throw new AuthorizationError('Revocation correlation ID already exists.', 'EAUTHORIZATION_DUPLICATE');
    const epoch = state.authorization.revocationEpoch + 1;
    const auditEvidenceRef = randomUUID();
    await appendAuditEvent(auditPath, { type: 'authorization.revoked', timestamp: now.toISOString(),
      correlationId, evidenceRef: auditEvidenceRef,
      ...(initiatorClaimedActorId ? { actor: { id: initiatorClaimedActorId, provenance: 'caller-claimed; unverified' } } : {}),
      issueNumber: grant.issueNumber,
      pullRequestNumber: grant.pullRequestNumber, headSha: grant.headSha, authorization: 'denied',
      category: 'observation', provenance: { source: 'controller' },
      data: { grantId, grantHolderActorId: grant.actorId, initiatorClaimedActorId: initiatorClaimedActorId ?? null,
        initiatorProvenance: 'unverified', action: grant.action, target: grant.target, decision: 'REVOKED',
        denialReason: 'GRANT_REVOKED', issuerProvenance: grant.issuerProvenance,
        expiresAt: grant.expiresAt, revocationEpoch: epoch } });
    await writeStateAtomic(statePath, { ...state, authorization: {
      ...state.authorization, revocationEpoch: epoch,
      grants: state.authorization.grants.map((item) => item.grantId === grantId ? { ...item, status: 'REVOKED' as const, updatedAt: now.toISOString() } : item),
      revocations: [...state.authorization.revocations, { grantId, epoch, revokedAt: now.toISOString(),
        correlationId, auditEvidenceRef, initiatorProvenance: 'unverified' as const,
        ...(initiatorClaimedActorId ? { initiatorClaimedActorId } : {}) }]
    }, updatedAt: now.toISOString() });
    return epoch;
  });
}
