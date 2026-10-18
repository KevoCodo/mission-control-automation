import { assessFence, parseExecutionEnvelope } from './executionProtocol.js';
import { parseWorkerIdentity } from './workerIdentity.js';

export type WorkerStage = 'PLANNED' | 'ADMISSION_PENDING' | 'AUTHORIZED' | 'STARTING' | 'RUNNING' |
  'RESULT_PENDING' | 'COMPLETED' | 'FAILED' | 'UNCERTAIN' | 'FENCED';
export type EvidenceKind = 'LOCAL_OBSERVATION' | 'EXTERNAL_PROCESS' | 'AUTHENTICATED_PROVIDER' | 'TRUSTED_AUTHORIZATION';
export interface LifecycleEvidence { kind: EvidenceKind; event: string; evidenceRef: string; dispatchId: string; workerExecutionId: string }
export interface WorkerFenceInput {
  stop: { active: boolean; durableEpoch: number; generation: number; barrierReceiptId: string; durableEvidenceRef: string };
  grant: { grantId: string; expiresAt: string; revoked: boolean };
  dispatchGeneration: number;
}
export interface WorkerAssessment { contractEligible: boolean; authoritative: false; executable: false; reasons: string[] }

const next: Record<WorkerStage, WorkerStage[]> = {
  PLANNED: ['ADMISSION_PENDING', 'UNCERTAIN'], ADMISSION_PENDING: ['AUTHORIZED', 'UNCERTAIN', 'FENCED'],
  AUTHORIZED: ['STARTING', 'UNCERTAIN', 'FENCED'], STARTING: ['RUNNING', 'UNCERTAIN', 'FENCED'],
  RUNNING: ['RESULT_PENDING', 'UNCERTAIN', 'FENCED'],
  RESULT_PENDING: ['COMPLETED', 'FAILED', 'UNCERTAIN', 'FENCED'],
  COMPLETED: [], FAILED: [], UNCERTAIN: [], FENCED: []
};
const evidenceFor: Partial<Record<WorkerStage, [EvidenceKind, string]>> = {
  ADMISSION_PENDING: ['LOCAL_OBSERVATION', 'ADMISSION_REQUESTED'],
  AUTHORIZED: ['TRUSTED_AUTHORIZATION', 'GRANT_VERIFIED'],
  STARTING: ['LOCAL_OBSERVATION', 'DURABLE_INTENT'],
  RUNNING: ['AUTHENTICATED_PROVIDER', 'PROCESS_STARTED'],
  RESULT_PENDING: ['EXTERNAL_PROCESS', 'PROCESS_EXITED'],
  COMPLETED: ['AUTHENTICATED_PROVIDER', 'RESULT_AND_CONTAINMENT_VERIFIED'],
  FAILED: ['AUTHENTICATED_PROVIDER', 'FAILURE_AND_CONTAINMENT_VERIFIED'],
  FENCED: ['AUTHENTICATED_PROVIDER', 'BARRIER_AND_DESCENDANTS_VERIFIED']
};
const record = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
  Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
  Object.keys(value).every((key) => 'value' in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const dense = (value: unknown): value is unknown[] => Array.isArray(value) &&
  Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
const denied = (reason: string): WorkerAssessment =>
  ({ contractEligible: false, authoritative: false, executable: false, reasons: [reason] });
const validAssessment = (value: unknown): value is WorkerAssessment => record(value) &&
  typeof value.contractEligible === 'boolean' && value.authoritative === false && value.executable === false &&
  dense(value.reasons) && value.reasons.every((reason: unknown) => typeof reason === 'string') &&
  (value.contractEligible ? value.reasons.length === 0 : value.reasons.length > 0);

/** Checks claims only. No supplied label or evidenceRef is authenticated here. */
export function assessWorkerFence(identityInput: unknown, envelopeInput: unknown, input: WorkerFenceInput, now: Date): WorkerAssessment {
  let identity;
  let envelope;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return denied('INVALID_CLOCK');
  try { envelope = parseExecutionEnvelope(envelopeInput); identity = parseWorkerIdentity(identityInput, envelope, now); }
  catch { return denied('INVALID_IDENTITY'); }
  if (!record(input) || !record(input.stop) || !record(input.grant)) return denied('MALFORMED_FENCE_INPUT');
  const reasons: string[] = [];
  if (input.stop.active !== false) reasons.push('STOP_ACTIVE_OR_UNKNOWN');
  if (!Number.isSafeInteger(input.stop.durableEpoch) || !nonempty(input.stop.barrierReceiptId) ||
    !nonempty(input.stop.durableEvidenceRef)) reasons.push('MISSING_BARRIER_EVIDENCE');
  if (Number.isSafeInteger(input.stop.durableEpoch) && nonempty(input.stop.barrierReceiptId) &&
    nonempty(input.stop.durableEvidenceRef)) {
    reasons.push(...assessFence(envelope, { scopeId: `${envelope.repository.owner}/${envelope.repository.name}/${envelope.targetId}`,
      currentEpoch: input.stop.durableEpoch, generation: input.stop.generation,
      barrierReceiptId: input.stop.barrierReceiptId, durableEvidenceRef: input.stop.durableEvidenceRef }, now));
  }
  if (input.dispatchGeneration !== identity.generation) reasons.push('DISPATCH_GENERATION_MISMATCH');
  if (input.grant.grantId !== identity.grantId) reasons.push('GRANT_MISMATCH');
  if (input.grant.revoked !== false) reasons.push('GRANT_REVOKED_OR_UNKNOWN');
  if (input.grant.expiresAt !== identity.expiresAt ||
    typeof input.grant.expiresAt !== 'string' || now.getTime() >= Date.parse(input.grant.expiresAt))
    reasons.push('GRANT_EXPIRED_OR_CONFLICTING');
  return { contractEligible: reasons.length === 0, authoritative: false, executable: false, reasons: [...new Set(reasons)] };
}

export function assessWorkerTransition(from: WorkerStage, to: WorkerStage, identity: { dispatchId: string; workerExecutionId: string },
  evidence: LifecycleEvidence | undefined, fence: WorkerAssessment): WorkerAssessment {
  if (!record(identity) || !nonempty(identity.dispatchId) || !nonempty(identity.workerExecutionId) ||
    !validAssessment(fence) || (evidence !== undefined && !record(evidence))) return denied('MALFORMED_TRANSITION_INPUT');
  const reasons: string[] = [];
  if (!next[from]?.includes(to)) reasons.push('INVALID_TRANSITION');
  if (!fence?.contractEligible && to !== 'UNCERTAIN' && to !== 'FENCED') reasons.push('FENCE_INELIGIBLE');
  if (to !== 'UNCERTAIN') {
    const required = evidenceFor[to];
    if (!required || !evidence || evidence.kind !== required[0] || evidence.event !== required[1] ||
      !nonempty(evidence.evidenceRef) || evidence.dispatchId !== identity.dispatchId ||
      evidence.workerExecutionId !== identity.workerExecutionId) reasons.push('MISSING_OR_CONFLICTING_EVIDENCE');
  }
  // Structural eligibility is not a verified transition, especially for terminal outcomes.
  return { contractEligible: reasons.length === 0, authoritative: false, executable: false, reasons };
}

/** A repeated worker ID or dispatch start is never eligible, even with identical claims. */
export function assessWorkerStartClaim(identity: { dispatchId: string; workerExecutionId: string },
  priorStarts: Array<{ dispatchId: string; workerExecutionId: string }>, fence: WorkerAssessment): WorkerAssessment {
  if (!record(identity) || !nonempty(identity.dispatchId) || !nonempty(identity.workerExecutionId) ||
    !dense(priorStarts) || !priorStarts.every((prior: unknown) => record(prior) &&
      nonempty(prior.dispatchId) && nonempty(prior.workerExecutionId)) || !validAssessment(fence))
    return denied('MALFORMED_START_INPUT');
  const reasons = [...(fence.contractEligible ? [] : ['FENCE_INELIGIBLE'])];
  if (priorStarts.some((prior) => prior.dispatchId === identity.dispatchId ||
    prior.workerExecutionId === identity.workerExecutionId)) reasons.push('DUPLICATE_WORKER_START');
  return { contractEligible: reasons.length === 0, authoritative: false, executable: false, reasons };
}

export type RecoveryCase = 'NEVER_ATTEMPTED' | 'ACKNOWLEDGMENT_LOST' | 'OBSERVED_RUNNING' |
  'EXIT_WITHOUT_CONTAINMENT' | 'TERMINATED_DESCENDANTS_UNKNOWN' | 'PROVIDER_RESTART' |
  'STALE_GENERATION' | 'MISSING_EVIDENCE' | 'CONFLICTING_EVIDENCE';
export function classifyWorkerRecovery(input: { intentRecorded: boolean; launchAttempted: boolean;
  acknowledgment: boolean; observedRunning: boolean; exited: boolean; terminated: boolean;
  descendantsContained: boolean; providerRestarted: boolean; staleGeneration: boolean;
  lifecycleEvidenceComplete: boolean }): { classification: RecoveryCase; retryEligible: false; retired: false } {
  const fields = ['intentRecorded', 'launchAttempted', 'acknowledgment', 'observedRunning', 'exited',
    'terminated', 'descendantsContained', 'providerRestarted', 'staleGeneration', 'lifecycleEvidenceComplete'] as const;
  if (!record(input) || fields.some((field) => typeof input[field] !== 'boolean'))
    return { classification: 'MISSING_EVIDENCE', retryEligible: false, retired: false };
  const conflicting = (input.launchAttempted && !input.intentRecorded) ||
    (!input.launchAttempted && (input.acknowledgment || input.observedRunning || input.exited || input.terminated)) ||
    (input.descendantsContained && !input.terminated && !input.exited);
  const classification: RecoveryCase = conflicting ? 'CONFLICTING_EVIDENCE' :
    input.staleGeneration ? 'STALE_GENERATION' :
    input.providerRestarted ? 'PROVIDER_RESTART' : !input.lifecycleEvidenceComplete ? 'MISSING_EVIDENCE' :
    !input.intentRecorded || !input.launchAttempted ? 'NEVER_ATTEMPTED' :
    !input.acknowledgment ? 'ACKNOWLEDGMENT_LOST' : input.terminated && !input.descendantsContained ?
      'TERMINATED_DESCENDANTS_UNKNOWN' : input.exited && !input.descendantsContained ?
      'EXIT_WITHOUT_CONTAINMENT' : input.observedRunning ? 'OBSERVED_RUNNING' : 'MISSING_EVIDENCE';
  return { classification, retryEligible: false, retired: false };
}
