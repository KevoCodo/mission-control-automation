import { fingerprintDispatchPayload } from './dispatch.js';
import type { AuthorizationAction, DispatchRecord } from './types.js';

/** Pure protocol claims. No transport, issuer, or provider verifier is installed here. */
export const EXECUTION_PROTOCOL_VERSION = 1 as const;
export type AgentRole = 'ORCHESTRATOR' | 'BUILDER' | 'TESTER' | 'REVIEWER' | 'CORRECTOR' | 'MERGER';
export type ReceiptDecision = 'ACCEPTED' | 'REJECTED' | 'EXECUTION_STARTED' | 'COMPLETED' | 'RETIRED' | 'UNKNOWN';
export interface ExecutionEnvelope {
  protocolVersion: 1;
  dispatchId: string;
  operationKey: string;
  repository: { owner: string; name: string };
  issueNumber: number;
  targetId: string;
  branch: string;
  worktreeId?: string;
  agentRole: AgentRole;
  generation: number;
  actionScope: AuthorizationAction;
  payloadDigest: string;
  digestAlgorithm: 'SHA-256-CANONICAL-JSON';
  grantId: string;
  issuedAt: string;
  expiresAt: string;
  fencingEpoch: number;
  correlationId: string;
}
export interface ProviderReceipt {
  protocolVersion: 1;
  dispatchId: string;
  payloadDigest: string;
  providerId: string;
  repository: ExecutionEnvelope['repository'];
  issueNumber: number;
  targetId: string;
  generation: number;
  grantId: string;
  fencingEpoch: number;
  sequence: number;
  decision: ReceiptDecision;
  timestamp: string;
  evidenceRef: string;
  authentication: { method: string; keyId: string; proofRef: string };
}
export interface FencingSnapshot {
  scopeId: string;
  currentEpoch: number;
  generation: number;
  barrierReceiptId: string;
  durableEvidenceRef: string;
}
export interface ReceiptAssessment {
  structurallyValid: boolean;
  matchingClaims: boolean;
  authoritative: false;
  reasons: string[];
}
export interface HistoryAssessment {
  claimedOutcome: 'ACCEPTED' | 'REJECTED' | 'EXECUTING' | 'COMPLETED' | 'RETIRED' | 'UNCERTAIN';
  authoritative: false;
  reasons: string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const ROLES: AgentRole[] = ['ORCHESTRATOR', 'BUILDER', 'TESTER', 'REVIEWER', 'CORRECTOR', 'MERGER'];
const ACTIONS: AuthorizationAction[] = ['ASSIGNMENT', 'REVIEW', 'CORRECTION', 'MERGE', 'CLOSURE'];
const DECISIONS: ReceiptDecision[] = ['ACCEPTED', 'REJECTED', 'EXECUTION_STARTED', 'COMPLETED', 'RETIRED', 'UNKNOWN'];
const ENVELOPE_KEYS = ['protocolVersion', 'dispatchId', 'operationKey', 'repository', 'issueNumber', 'targetId',
  'branch', 'agentRole', 'generation', 'actionScope', 'payloadDigest', 'digestAlgorithm', 'grantId',
  'issuedAt', 'expiresAt', 'fencingEpoch', 'correlationId'];
const RECEIPT_KEYS = ['protocolVersion', 'dispatchId', 'payloadDigest', 'providerId', 'repository',
  'issueNumber', 'targetId', 'generation', 'grantId', 'fencingEpoch', 'sequence', 'decision',
  'timestamp', 'evidenceRef', 'authentication'];
const own = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype && Object.getOwnPropertySymbols(v).length === 0 &&
  Object.getOwnPropertyNames(v).length === Object.keys(v).length &&
  Object.keys(v).every((k) => 'value' in (Object.getOwnPropertyDescriptor(v, k) ?? {}));
const exact = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  own(v) && required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const epoch = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const repository = (v: unknown): v is ExecutionEnvelope['repository'] => exact(v, ['owner', 'name']) && id(v.owner) && id(v.name);
const auth = (v: unknown): boolean => exact(v, ['method', 'keyId', 'proofRef']) && id(v.method) && id(v.keyId) && id(v.proofRef);

export function parseExecutionEnvelope(value: unknown): ExecutionEnvelope {
  if (!exact(value, ENVELOPE_KEYS, ['worktreeId']) || value.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    !uuid(value.dispatchId) || !id(value.operationKey) || !repository(value.repository) ||
    !positive(value.issueNumber) || !id(value.targetId) || !id(value.branch) ||
    (value.worktreeId !== undefined && !id(value.worktreeId)) || !ROLES.includes(value.agentRole as AgentRole) ||
    !positive(value.generation) || !ACTIONS.includes(value.actionScope as AuthorizationAction) ||
    typeof value.payloadDigest !== 'string' || !DIGEST.test(value.payloadDigest) ||
    value.digestAlgorithm !== 'SHA-256-CANONICAL-JSON' || !id(value.grantId) ||
    !time(value.issuedAt) || !time(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
    !epoch(value.fencingEpoch) || !id(value.correlationId))
    throw new Error('Invalid or unsupported execution envelope.');
  return value as unknown as ExecutionEnvelope;
}

export function matchesDispatchRecord(envelope: ExecutionEnvelope, record: DispatchRecord): boolean {
  return envelope.dispatchId === record.dispatchId && envelope.operationKey === record.operationKey &&
    envelope.repository.owner === record.repository.owner && envelope.repository.name === record.repository.name &&
    envelope.issueNumber === record.issueNumber && envelope.branch === record.branch &&
    envelope.targetId === record.target?.targetId && envelope.payloadDigest === record.payloadSha256 &&
    envelope.correlationId === record.correlationId;
}

/** The caller supplies payload bytes; a digest is never accepted as proof of executable content. */
export function matchesCanonicalPayload(envelope: ExecutionEnvelope, payload: unknown): boolean {
  return fingerprintDispatchPayload(payload) === envelope.payloadDigest;
}

/** Compare every immutable binding in a fixed order without exposing its value. */
function envelopeIdentity(envelope: ExecutionEnvelope): string {
  return JSON.stringify([envelope.protocolVersion, envelope.dispatchId, envelope.operationKey,
    envelope.repository.owner, envelope.repository.name, envelope.issueNumber, envelope.targetId,
    envelope.branch, envelope.worktreeId ?? null, envelope.agentRole, envelope.generation,
    envelope.actionScope, envelope.payloadDigest, envelope.digestAlgorithm, envelope.grantId,
    envelope.issuedAt, envelope.expiresAt, envelope.fencingEpoch, envelope.correlationId]);
}

/** Rejects reused IDs, including an identical duplicate in one batch. */
export function assessEnvelopeIdentities(inputs: unknown[]): string[] {
  const reasons: string[] = [];
  const seen = new Map<string, ExecutionEnvelope>();
  for (const input of inputs) {
    let envelope: ExecutionEnvelope;
    try { envelope = parseExecutionEnvelope(input); }
    catch { reasons.push('INVALID_STRUCTURE'); continue; }
    const prior = seen.get(envelope.dispatchId);
    if (prior) reasons.push(envelopeIdentity(prior) === envelopeIdentity(envelope) ?
      'DUPLICATE_DISPATCH_ID' : 'CONFLICTING_DISPATCH_ID');
    else seen.set(envelope.dispatchId, envelope);
  }
  return reasons;
}

export function parseProviderReceipt(value: unknown): ProviderReceipt {
  if (!exact(value, RECEIPT_KEYS) || value.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    !uuid(value.dispatchId) || typeof value.payloadDigest !== 'string' || !DIGEST.test(value.payloadDigest) ||
    !id(value.providerId) || !repository(value.repository) || !positive(value.issueNumber) ||
    !id(value.targetId) || !positive(value.generation) || !id(value.grantId) ||
    !epoch(value.fencingEpoch) || !positive(value.sequence) ||
    !DECISIONS.includes(value.decision as ReceiptDecision) || !time(value.timestamp) ||
    !id(value.evidenceRef) || !auth(value.authentication))
    throw new Error('Invalid or unsupported provider receipt claim.');
  return value as unknown as ProviderReceipt;
}

export function assessReceipt(envelopeInput: unknown, receiptInput: unknown, now: Date): ReceiptAssessment {
  let envelope: ExecutionEnvelope;
  let receipt: ProviderReceipt;
  try { envelope = parseExecutionEnvelope(envelopeInput); receipt = parseProviderReceipt(receiptInput); }
  catch { return { structurallyValid: false, matchingClaims: false, authoritative: false, reasons: ['INVALID_STRUCTURE'] }; }
  const reasons: string[] = [];
  if (!Number.isFinite(now.getTime())) reasons.push('INVALID_CLOCK');
  if (receipt.dispatchId !== envelope.dispatchId) reasons.push('DISPATCH_MISMATCH');
  if (receipt.payloadDigest !== envelope.payloadDigest) reasons.push('DIGEST_MISMATCH');
  if (receipt.repository.owner !== envelope.repository.owner || receipt.repository.name !== envelope.repository.name)
    reasons.push('REPOSITORY_MISMATCH');
  if (receipt.issueNumber !== envelope.issueNumber || receipt.targetId !== envelope.targetId) reasons.push('TARGET_MISMATCH');
  if (receipt.generation !== envelope.generation) reasons.push('GENERATION_MISMATCH');
  if (receipt.grantId !== envelope.grantId) reasons.push('GRANT_MISMATCH');
  if (receipt.fencingEpoch !== envelope.fencingEpoch) reasons.push('EPOCH_MISMATCH');
  // This checks historical claims. Current grant validity is checked by assessFence.
  if (Date.parse(receipt.timestamp) < Date.parse(envelope.issuedAt) ||
    Date.parse(receipt.timestamp) > now.getTime()) reasons.push('RECEIPT_TIME_MISMATCH');
  if (receipt.decision === 'ACCEPTED' || receipt.decision === 'EXECUTION_STARTED') {
    if (Date.parse(receipt.timestamp) >= Date.parse(envelope.expiresAt)) reasons.push('RECEIPT_AFTER_EXPIRY');
  }
  return { structurallyValid: true, matchingClaims: reasons.length === 0, authoritative: false, reasons };
}

export function parseFencingSnapshot(value: unknown): FencingSnapshot {
  if (!exact(value, ['scopeId', 'currentEpoch', 'generation', 'barrierReceiptId', 'durableEvidenceRef']) ||
    !id(value.scopeId) || !epoch(value.currentEpoch) || !positive(value.generation) ||
    !id(value.barrierReceiptId) || !id(value.durableEvidenceRef)) throw new Error('Invalid fencing claim.');
  return value as unknown as FencingSnapshot;
}

export function assessFence(envelopeInput: unknown, snapshotInput: unknown, now: Date): string[] {
  let envelope: ExecutionEnvelope;
  let fence: FencingSnapshot;
  try { envelope = parseExecutionEnvelope(envelopeInput); fence = parseFencingSnapshot(snapshotInput); }
  catch { return ['INVALID_STRUCTURE']; }
  const reasons: string[] = [];
  if (fence.scopeId !== `${envelope.repository.owner}/${envelope.repository.name}/${envelope.targetId}`) reasons.push('SCOPE_MISMATCH');
  if (envelope.fencingEpoch < fence.currentEpoch) reasons.push('STALE_EPOCH');
  if (envelope.fencingEpoch > fence.currentEpoch) reasons.push('CONFLICTING_EPOCH');
  if (envelope.generation !== fence.generation) reasons.push('STALE_GENERATION');
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(envelope.issuedAt)) reasons.push('FUTURE_ENVELOPE');
  if (now.getTime() >= Date.parse(envelope.expiresAt)) reasons.push('EXPIRED_GRANT');
  return reasons;
}

/** A retirement claim must be bound to a later barrier; this is not authentication. */
export function assessRetirementClaim(envelopeInput: unknown, receiptInput: unknown,
  snapshotInput: unknown, now: Date): string[] {
  const base = assessReceipt(envelopeInput, receiptInput, now);
  if (!base.structurallyValid) return base.reasons;
  const reasons = [...base.reasons];
  let envelope: ExecutionEnvelope;
  let receipt: ProviderReceipt;
  let fence: FencingSnapshot;
  try { envelope = parseExecutionEnvelope(envelopeInput); receipt = parseProviderReceipt(receiptInput); fence = parseFencingSnapshot(snapshotInput); }
  catch { return [...new Set([...reasons, 'INVALID_STRUCTURE'])]; }
  if (receipt.decision !== 'RETIRED') reasons.push('NOT_RETIREMENT');
  if (fence.scopeId !== `${envelope.repository.owner}/${envelope.repository.name}/${envelope.targetId}`)
    reasons.push('SCOPE_MISMATCH');
  if (fence.generation !== envelope.generation) reasons.push('STALE_GENERATION');
  if (fence.currentEpoch <= envelope.fencingEpoch) reasons.push('MISSING_LATER_BARRIER');
  if (receipt.evidenceRef !== fence.barrierReceiptId) reasons.push('BARRIER_MISMATCH');
  return [...new Set(reasons)];
}

/** Classifies claims only. Missing or contradictory history remains uncertain. */
export function assessReceiptHistory(envelopeInput: unknown, receiptInputs: unknown[], now: Date,
  lookup?: { result: 'FOUND' | 'NOT_FOUND'; complete: boolean; excludesDelayedDelivery: boolean },
  retirementFence?: unknown): HistoryAssessment {
  const reasons: string[] = [];
  if (!Array.isArray(receiptInputs) || receiptInputs.length === 0) reasons.push('MISSING_HISTORY');
  let lastSequence = 0;
  let lastTime = -Infinity;
  let last: ReceiptDecision | undefined;
  let provider: string | undefined;
  const allowed: Record<ReceiptDecision, ReceiptDecision[]> = {
    ACCEPTED: ['EXECUTION_STARTED', 'RETIRED'], REJECTED: [], EXECUTION_STARTED: ['COMPLETED', 'RETIRED'],
    COMPLETED: [], RETIRED: [], UNKNOWN: []
  };
  for (const input of receiptInputs ?? []) {
    const assessment = assessReceipt(envelopeInput, input, now);
    if (!assessment.structurallyValid || !assessment.matchingClaims) { reasons.push(...assessment.reasons); continue; }
    const receipt = parseProviderReceipt(input);
    if (receipt.decision === 'RETIRED') reasons.push(...(retirementFence === undefined ?
      ['MISSING_LATER_BARRIER'] : assessRetirementClaim(envelopeInput, input, retirementFence, now)));
    if (provider !== undefined && receipt.providerId !== provider) reasons.push('PROVIDER_CONFLICT');
    if (!last && !['ACCEPTED', 'REJECTED', 'UNKNOWN'].includes(receipt.decision)) reasons.push('MISSING_INITIAL_DECISION');
    if (receipt.sequence <= lastSequence) reasons.push('REPLAYED_SEQUENCE');
    if (Date.parse(receipt.timestamp) < lastTime) reasons.push('TIME_ORDER');
    if (last && !allowed[last].includes(receipt.decision)) reasons.push('OUTCOME_CONFLICT');
    provider = receipt.providerId;
    lastSequence = receipt.sequence;
    lastTime = Date.parse(receipt.timestamp);
    last = receipt.decision;
  }
  if (lookup?.result === 'NOT_FOUND' && (!lookup.complete || !lookup.excludesDelayedDelivery)) reasons.push('INCOMPLETE_LOOKUP');
  if (lookup?.result === 'NOT_FOUND' && receiptInputs.length) reasons.push('LOOKUP_CONFLICT');
  // Even a complete lookup claim is caller-controlled until a trusted verifier exists.
  const claimedOutcome = reasons.length ? 'UNCERTAIN' : last === 'EXECUTION_STARTED' ? 'EXECUTING' :
    last === 'UNKNOWN' || !last ? 'UNCERTAIN' : last;
  return { claimedOutcome, authoritative: false, reasons: [...new Set(reasons)] };
}

/** Role labels are descriptive. Only a separately verified grant can confer an action. */
export function roleMayRequestAction(role: AgentRole, action: AuthorizationAction): boolean {
  const scopes: Record<AgentRole, AuthorizationAction[]> = {
    ORCHESTRATOR: ['ASSIGNMENT'], BUILDER: ['ASSIGNMENT'], TESTER: ['ASSIGNMENT'],
    REVIEWER: ['REVIEW'], CORRECTOR: ['CORRECTION'], MERGER: ['MERGE']
  };
  return scopes[role]?.includes(action) ?? false;
}
