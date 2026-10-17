import { DispatchError } from '../dispatch.js';
import type { DispatchEvidence, DispatchRecord, DispatchState } from '../types.js';

export function verifiedDispatchFixture(kind: DispatchEvidence['kind'], dispatchId: string, providerReceiptRef: string,
  observedAt: string, durable = false): DispatchEvidence {
  if (!dispatchId || !providerReceiptRef || !Number.isFinite(Date.parse(observedAt)))
    throw new DispatchError('Invalid fixture evidence.', 'EDISPATCH_EVIDENCE');
  return { kind, dispatchId, providerReceiptRef, provenance: 'fixture', verified: true,
    ...(durable ? { durable: true as const } : {}), observedAt };
}

const transitions: Record<DispatchState, DispatchState[]> = {
  INTENT_RECORDED: ['SUBMITTING', 'UNCERTAIN'],
  SUBMITTING: ['ACCEPTED', 'REJECTED', 'UNCERTAIN'],
  ACCEPTED: ['COMPLETED', 'UNCERTAIN'],
  REJECTED: [],
  UNCERTAIN: ['ACCEPTED', 'REJECTED', 'RETIRED', 'COMPLETED'],
  RETIRED: [], COMPLETED: []
};
const evidenceKind: Partial<Record<DispatchState, DispatchEvidence['kind']>> = {
  ACCEPTED: 'acceptance', REJECTED: 'rejection', RETIRED: 'retirement', COMPLETED: 'outcome'
};

/** Pure model used by tests. It has no state path or persistence access. */
export function evaluateDispatchFixture(previous: DispatchRecord, next: DispatchState,
  now = new Date(), evidence?: DispatchEvidence,
  reason?: 'acknowledgment-lost' | 'reconciliation-blocked' | 'attempt-interrupted'): DispatchRecord {
  if (!transitions[previous.state].includes(next))
    throw new DispatchError('Illegal dispatch lifecycle transition.', 'EDISPATCH_TRANSITION');
  const required = evidenceKind[next];
  if (required && (!evidence || evidence.kind !== required || evidence.dispatchId !== previous.dispatchId ||
    evidence.provenance !== 'fixture' || evidence.verified !== true || !evidence.providerReceiptRef ||
    (next === 'RETIRED' && evidence.durable !== true)))
    throw new DispatchError('Matching provider fixture evidence is required.', 'EDISPATCH_EVIDENCE');
  if (!required && evidence) throw new DispatchError('Unexpected provider evidence.', 'EDISPATCH_EVIDENCE');
  return { ...previous, state: next, updatedAt: now.toISOString(),
    ...(evidence ? { evidence } : {}),
    ...(['INTENT_RECORDED', 'SUBMITTING', 'UNCERTAIN'].includes(next)
      ? { quarantineReason: reason ?? 'Provider reconciliation blocked or delivery uncertain.' }
      : { quarantineReason: undefined }) };
}
