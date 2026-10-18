import { describe, expect, it } from 'vitest';
import { fingerprintDispatchPayload } from '../dispatch.js';
import { assessEnvelopeIdentities, assessFence, assessReceipt, assessReceiptHistory, assessRetirementClaim,
  matchesCanonicalPayload, parseExecutionEnvelope, parseProviderReceipt, roleMayRequestAction } from '../executionProtocol.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const payload = { instruction: 'fixture only', sequence: [1, true, null] };
const envelope = {
  protocolVersion: 1, dispatchId: '123e4567-e89b-42d3-a456-426614174000', operationKey: 'fixture/23',
  repository: { owner: 'KevoCodo', name: 'ai-delivery-lab' }, issueNumber: 23, targetId: 'target-1',
  branch: 'issue-23', worktreeId: 'worktree-1', agentRole: 'BUILDER', generation: 3,
  actionScope: 'ASSIGNMENT', payloadDigest: fingerprintDispatchPayload(payload),
  digestAlgorithm: 'SHA-256-CANONICAL-JSON', grantId: 'grant-1',
  issuedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-10-17T13:00:00.000Z',
  fencingEpoch: 7, correlationId: 'correlation-1'
};
const receipt = {
  protocolVersion: 1, dispatchId: envelope.dispatchId, payloadDigest: envelope.payloadDigest,
  providerId: 'provider-1', repository: envelope.repository, issueNumber: 23, targetId: 'target-1',
  generation: 3, grantId: 'grant-1', fencingEpoch: 7, sequence: 1, decision: 'ACCEPTED',
  timestamp: '2026-10-17T11:30:00.000Z', evidenceRef: 'event-1',
  authentication: { method: 'signature', keyId: 'key-1', proofRef: 'proof-1' }
};
const fence = { scopeId: 'KevoCodo/ai-delivery-lab/target-1', currentEpoch: 7, generation: 3,
  barrierReceiptId: 'barrier-1', durableEvidenceRef: 'durable-1' };
const changed = (field: string, value: unknown) => ({ ...envelope, [field]: value });
const claim = (field: string, value: unknown) => ({ ...receipt, [field]: value });

describe('provider independent execution protocol claims', () => {
  it('accepts strict versioned structure and B2 canonical payloads', () => {
    expect(parseExecutionEnvelope(envelope)).toEqual(envelope);
    expect(parseProviderReceipt(receipt)).toEqual(receipt);
    expect(matchesCanonicalPayload(parseExecutionEnvelope(envelope), { sequence: [1, true, null], instruction: 'fixture only' })).toBe(true);
    expect(matchesCanonicalPayload(parseExecutionEnvelope(envelope), { instruction: 'changed' })).toBe(false);
  });
  it('rejects unsupported versions, missing and unknown fields, malformed IDs and target bindings', () => {
    for (const value of [changed('protocolVersion', 2), changed('dispatchId', 'bad'), changed('targetId', ''),
      changed('generation', 0), changed('worktreeId', ''), changed('extension', true),
      Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'grantId'))])
      expect(() => parseExecutionEnvelope(value)).toThrow();
    for (const value of [claim('protocolVersion', 2), claim('authentication', { method: 'signature' }),
      claim('extra', true), claim('sequence', 0)]) expect(() => parseProviderReceipt(value)).toThrow();
  });
  it('distinguishes exact duplicates from every immutable identity conflict', () => {
    expect(assessEnvelopeIdentities([envelope, { ...envelope, repository: { ...envelope.repository } }]))
      .toEqual(['DUPLICATE_DISPATCH_ID']);
    const variants = [
      changed('operationKey', 'other/23'), changed('repository', { owner: 'other', name: envelope.repository.name }),
      changed('repository', { owner: envelope.repository.owner, name: 'other' }),
      changed('issueNumber', 24), changed('targetId', 'target-2'), changed('branch', 'other-branch'),
      changed('worktreeId', 'worktree-2'), Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'worktreeId')),
      changed('agentRole', 'REVIEWER'), changed('generation', 4), changed('actionScope', 'REVIEW'),
      changed('payloadDigest', 'a'.repeat(64)), changed('grantId', 'grant-2'),
      changed('issuedAt', '2026-10-17T10:00:00.000Z'), changed('expiresAt', '2026-10-17T14:00:00.000Z'),
      changed('fencingEpoch', 8), changed('correlationId', 'correlation-2')
    ];
    for (const variant of variants) {
      expect(assessEnvelopeIdentities([envelope, variant])).toEqual(['CONFLICTING_DISPATCH_ID']);
      expect(assessEnvelopeIdentities([variant, envelope])).toEqual(['CONFLICTING_DISPATCH_ID']);
    }
    expect(assessEnvelopeIdentities([envelope, variants[0], envelope]))
      .toEqual(['CONFLICTING_DISPATCH_ID', 'DUPLICATE_DISPATCH_ID']);
    expect(assessEnvelopeIdentities([envelope, changed('payloadDigest', 'a'.repeat(64))]).join(' '))
      .not.toContain(envelope.payloadDigest);
  });
  it('rejects wrong repository, issue, target, generation, grant, digest, and epoch claims', () => {
    const cases: Array<[unknown, string]> = [
      [claim('repository', { owner: 'other', name: 'ai-delivery-lab' }), 'REPOSITORY_MISMATCH'],
      [claim('issueNumber', 12), 'TARGET_MISMATCH'], [claim('targetId', 'other'), 'TARGET_MISMATCH'],
      [claim('generation', 4), 'GENERATION_MISMATCH'], [claim('grantId', 'other'), 'GRANT_MISMATCH'],
      [claim('payloadDigest', 'a'.repeat(64)), 'DIGEST_MISMATCH'], [claim('fencingEpoch', 8), 'EPOCH_MISMATCH'],
      [claim('dispatchId', '123e4567-e89b-42d3-a456-426614174001'), 'DISPATCH_MISMATCH']
    ];
    for (const [value, reason] of cases) expect(assessReceipt(envelope, value, now).reasons).toContain(reason);
  });
  it('checks historical receipt timing without renewing an expired grant', () => {
    expect(assessReceipt(changed('issuedAt', '2026-10-17T12:30:00.000Z'), receipt, now).reasons).toContain('RECEIPT_TIME_MISMATCH');
    expect(assessReceipt(changed('expiresAt', '2026-10-17T11:45:00.000Z'), receipt, now).matchingClaims).toBe(true);
    expect(assessReceipt(envelope, receipt, new Date('2026-10-18T12:00:00.000Z')))
      .toMatchObject({ matchingClaims: true, authoritative: false });
    expect(assessFence(envelope, fence, new Date('2026-10-18T12:00:00.000Z'))).toContain('EXPIRED_GRANT');
    expect(assessReceipt(envelope, claim('timestamp', envelope.expiresAt), new Date('2026-10-18T12:00:00.000Z')).reasons)
      .toContain('RECEIPT_AFTER_EXPIRY');
    expect(assessReceipt(envelope, claim('timestamp', '2026-10-17T12:01:00.000Z'), now).reasons).toContain('RECEIPT_TIME_MISMATCH');
  });
  it('rejects stale and conflicting fences, generations, and expired grants', () => {
    expect(assessFence(envelope, { ...fence, currentEpoch: 8 }, now)).toContain('STALE_EPOCH');
    expect(assessFence(envelope, { ...fence, currentEpoch: 6 }, now)).toContain('CONFLICTING_EPOCH');
    expect(assessFence(envelope, { ...fence, generation: 4 }, now)).toContain('STALE_GENERATION');
    expect(assessFence(changed('expiresAt', '2026-10-17T11:45:00.000Z'), fence, now)).toContain('EXPIRED_GRANT');
  });
  it('never authenticates forged acceptance or retirement claims', () => {
    const accepted = assessReceipt(envelope, receipt, now);
    expect(accepted).toMatchObject({ structurallyValid: true, matchingClaims: true, authoritative: false });
    const retired = { ...receipt, decision: 'RETIRED', sequence: 2, evidenceRef: 'barrier-1' };
    expect(assessRetirementClaim(envelope, retired, { ...fence, currentEpoch: 8 }, now)).toEqual([]);
    expect(assessReceipt(envelope, retired, now).authoritative).toBe(false);
    expect(assessRetirementClaim(envelope, retired, fence, now)).toContain('MISSING_LATER_BARRIER');
    expect(assessRetirementClaim(envelope, claim('decision', 'RETIRED'), { ...fence, currentEpoch: 8 }, now)).toContain('BARRIER_MISMATCH');
    const delayed = new Date('2026-10-18T12:00:00.000Z');
    expect(assessRetirementClaim(envelope, { ...retired, timestamp: '2026-10-17T14:00:00.000Z' },
      { ...fence, currentEpoch: 8 }, delayed)).toEqual([]);
    expect(assessRetirementClaim(envelope, retired, { ...fence, currentEpoch: 8, scopeId: 'other/repo/target-1' }, delayed))
      .toContain('SCOPE_MISMATCH');
    expect(assessRetirementClaim(envelope, retired, { ...fence, currentEpoch: 8, generation: 4 }, delayed))
      .toContain('STALE_GENERATION');
    expect(assessRetirementClaim(envelope, { ...retired, fencingEpoch: 6 }, { ...fence, currentEpoch: 8 }, delayed))
      .toContain('EPOCH_MISMATCH');
    expect(assessRetirementClaim(envelope, { ...retired, dispatchId: '123e4567-e89b-42d3-a456-426614174001' },
      { ...fence, currentEpoch: 8 }, delayed)).toContain('DISPATCH_MISMATCH');
    expect(assessReceiptHistory(envelope, [receipt, retired], delayed).claimedOutcome).toBe('UNCERTAIN');
    expect(assessReceiptHistory(envelope, [receipt, retired], delayed).reasons).toContain('MISSING_LATER_BARRIER');
    expect(assessReceiptHistory(envelope, [receipt, retired], delayed, undefined, { ...fence, currentEpoch: 8 }))
      .toMatchObject({ claimedOutcome: 'RETIRED', authoritative: false });
    expect(assessReceiptHistory(envelope, [receipt, retired], delayed, undefined, fence).reasons)
      .toContain('MISSING_LATER_BARRIER');
  });
  it('quarantines replay, contradiction, missing history, duplicate completion and incomplete NOT_FOUND', () => {
    const started = { ...receipt, decision: 'EXECUTION_STARTED', sequence: 2 };
    const completed = { ...receipt, decision: 'COMPLETED', sequence: 3 };
    expect(assessReceiptHistory(envelope, [receipt, started, completed], now))
      .toMatchObject({ claimedOutcome: 'COMPLETED', authoritative: false });
    expect(assessReceiptHistory(envelope, [receipt, started,
      { ...completed, timestamp: '2026-10-17T14:00:00.000Z' }], new Date('2026-10-18T12:00:00.000Z')))
      .toMatchObject({ claimedOutcome: 'COMPLETED', authoritative: false });
    expect(assessReceiptHistory(envelope, [receipt, receipt], now)).toMatchObject({ claimedOutcome: 'UNCERTAIN' });
    expect(assessReceiptHistory(envelope, [receipt, receipt], now).reasons).toContain('REPLAYED_SEQUENCE');
    expect(assessReceiptHistory(envelope, [receipt, { ...receipt, decision: 'REJECTED', sequence: 2 }], now).reasons).toContain('OUTCOME_CONFLICT');
    expect(assessReceiptHistory(envelope, [receipt, started, completed, { ...completed, sequence: 4 }], now).reasons).toContain('OUTCOME_CONFLICT');
    expect(assessReceiptHistory(envelope, [receipt, { ...receipt, decision: 'RETIRED', sequence: 2,
      evidenceRef: 'barrier-1' }, completed], now, undefined, { ...fence, currentEpoch: 8 }).reasons)
      .toContain('OUTCOME_CONFLICT');
    expect(assessReceiptHistory(envelope, [], now).claimedOutcome).toBe('UNCERTAIN');
    expect(assessReceiptHistory(envelope, [], now, { result: 'NOT_FOUND', complete: false, excludesDelayedDelivery: false }).reasons).toContain('INCOMPLETE_LOOKUP');
    expect(assessReceiptHistory(envelope, [], now, { result: 'NOT_FOUND', complete: true, excludesDelayedDelivery: true }).claimedOutcome).toBe('UNCERTAIN');
  });
  it('keeps a delayed pre-STOP claim uncertain and role separate from action permission', () => {
    expect(assessFence(envelope, { ...fence, currentEpoch: 8 }, now)).toContain('STALE_EPOCH');
    expect(roleMayRequestAction('BUILDER', 'MERGE')).toBe(false);
    expect(roleMayRequestAction('REVIEWER', 'CORRECTION')).toBe(false);
    expect(roleMayRequestAction('TESTER', 'REVIEW')).toBe(false);
    expect(roleMayRequestAction('MERGER', 'MERGE')).toBe(true);
    expect(assessReceipt(envelope, receipt, now).authoritative).toBe(false);
  });
  it('rejects malformed payload values through B2 canonical JSON', () => {
    for (const value of [undefined, NaN, Infinity, BigInt(1), new Date(), { value: undefined }, [1, , 3]])
      expect(() => fingerprintDispatchPayload(value)).toThrow();
  });
});
