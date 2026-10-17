import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateAuthorization, parseAuthorizationRecord, parseAuthorizationState, recordAuthorizationClaim, recordAuthorizationDecision, revokeAuthorization,
  verifyCurrentPermission, type AuthorizationRequest, type IssuanceEvidence } from '../authorization.js';
import { parseAuditLog } from '../audit.js';
import { defaultConfig } from '../config.js';
import { generateAuditReport } from '../report.js';
import { createInitialState, parseState, readState, writeStateAtomic } from '../state.js';
import type { AuthorizationRecord, AuthorizationState, DispatchRecord } from '../types.js';

const at = new Date('2026-10-17T12:00:00.000Z');
const sha = 'a'.repeat(40);
const repository = { owner: 'KevoCodo', name: 'ai-delivery-lab' };
const request: AuthorizationRequest = { action: 'MERGE', actorId: 'reviewer-1', repository,
  target: { kind: 'pullRequest', number: 23 }, issueNumber: 23, pullRequestNumber: 23, headSha: sha };
const grant = (changes: Partial<AuthorizationRecord> = {}): AuthorizationRecord => ({
  version: 1, grantId: 'grant-1', issuerId: 'authority-1', issuerProvenance: 'independent-verification',
  actorId: request.actorId, action: 'MERGE', repository, target: request.target,
  issueNumber: 23, pullRequestNumber: 23, headSha: sha, constraints: { maxUses: 1, purpose: 'issue-23' },
  issuedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-10-17T13:00:00.000Z',
  revocationEpoch: 0, status: 'VERIFIED', createdAt: '2026-10-17T11:00:00.000Z',
  updatedAt: '2026-10-17T11:00:00.000Z', correlationId: 'corr-1', auditEvidenceRef: 'evidence-1', ...changes
});
const evidence: IssuanceEvidence = { grantId: 'grant-1', issuerId: 'authority-1', evidenceRef: 'evidence-1',
  verifiedAt: at.toISOString(), provenance: 'test-fixture' };
const state = (record = grant()): AuthorizationState => ({ grants: [record], revocations: [], consumedGrantIds: [], revocationEpoch: 0 });
let dir: string;
let statePath: string;
let auditPath: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'mc-auth-')); statePath = path.join(dir, 'state.json');
  auditPath = path.join(dir, 'audit.jsonl'); await writeStateAtomic(statePath, createInitialState(defaultConfig, at)); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('scoped authorization policy', () => {
  it('separates a fixture scope result from verified permission and execution', () => {
    expect(evaluateAuthorization(grant(), evidence, request, state(), at)).toMatchObject({ scopeValid: true,
      verifiedPermission: false, executable: false, reason: 'SCOPE_VALID_FIXTURE_ONLY' });
    expect(verifyCurrentPermission(request, { grantId: 'grant-1', assertedBy: 'human', assertion: 'approved' }))
      .toMatchObject({ verifiedPermission: false, executable: false, reason: 'TRUSTED_ISSUER_UNAVAILABLE' });
  });
  it('audits a production denial with scope and provenance, without promoting the claim', async () => {
    const decision = verifyCurrentPermission(request, { grantId: 'grant-1', assertedBy: 'caller', assertion: 'approved' });
    await recordAuthorizationDecision(auditPath, request, decision, 'corr-1', at);
    expect(parseAuditLog(await readFile(auditPath, 'utf8'))[0]).toMatchObject({
      authorization: 'denied', actor: { id: 'reviewer-1' }, pullRequestNumber: 23,
      data: { requestedAction: 'MERGE', decision: 'DENIED', denialReason: 'TRUSTED_ISSUER_UNAVAILABLE',
        verificationProvenance: 'none', correlationId: 'corr-1' } });
  });
  it.each([
    ['missing', undefined, undefined, request, state(), at, 'AUTHORIZATION_MISSING'],
    ['malformed', { ...grant(), token: 'secret' }, evidence, request, state(), at, 'AUTHORIZATION_MALFORMED'],
    ['unknown issuer', grant(), undefined, request, state(), at, 'ISSUER_UNVERIFIED'],
    ['unverified issuer evidence', grant(), { ...evidence, issuerId: 'other' }, request, state(), at, 'ISSUER_UNVERIFIED'],
    ['wrong actor', grant(), evidence, { ...request, actorId: 'other' }, state(), at, 'ACTOR_MISMATCH'],
    ['wrong repository', grant(), evidence, { ...request, repository: { owner: 'other', name: repository.name } }, state(), at, 'REPOSITORY_MISMATCH'],
    ['wrong action', grant(), evidence, { ...request, action: 'CLOSURE' }, state(), at, 'ACTION_MISMATCH'],
    ['wrong issue', grant(), evidence, { ...request, issueNumber: 24 }, state(), at, 'TARGET_MISMATCH'],
    ['wrong PR', grant(), evidence, { ...request, target: { kind: 'pullRequest', number: 24 }, pullRequestNumber: 24 }, state(), at, 'TARGET_MISMATCH'],
    ['stale head', grant(), evidence, { ...request, headSha: 'b'.repeat(40) }, state(), at, 'HEAD_MISMATCH'],
    ['expired', grant(), evidence, request, state(), new Date('2026-10-17T13:00:00.000Z'), 'GRANT_EXPIRED'],
    ['future issuance', grant({ issuedAt: '2026-10-17T12:30:00.000Z' }), evidence, request, state(), at, 'ISSUED_IN_FUTURE'],
    ['revoked', grant({ status: 'REVOKED' }), evidence, request, state(), at, 'GRANT_REVOKED'],
    ['stale epoch', grant(), evidence, request, { ...state(), revocationEpoch: 1 }, at, 'REVOCATION_EPOCH_STALE'],
    ['replay', grant(), evidence, request, { ...state(), consumedGrantIds: ['grant-1'] }, at, 'GRANT_REPLAYED']
  ] as const)('%s denies', (_name, record, proof, action, snapshot, clock, reason) => {
    expect(evaluateAuthorization(record, proof, action as AuthorizationRequest, snapshot, clock)).toMatchObject({
      scopeValid: false, verifiedPermission: false, executable: false, reason });
  });
  it('keeps REVIEW and CORRECTION separate', () => {
    const review = grant({ action: 'REVIEW' });
    expect(evaluateAuthorization(review, evidence, { ...request, action: 'CORRECTION' }, state(review), at).reason).toBe('ACTION_MISMATCH');
  });
  it('keeps MERGE and CLOSURE separate', () => {
    expect(evaluateAuthorization(grant(), evidence, { ...request, action: 'CLOSURE' }, state(), at).reason).toBe('ACTION_MISMATCH');
  });
  it('rejects duplicate and conflicting IDs when loading state', () => {
    for (const duplicate of [grant(), grant({ actorId: 'other' })])
      expect(() => parseState({ ...createInitialState(defaultConfig), authorization: { ...state(), grants: [grant(), duplicate] } })).toThrow();
  });
});

describe('durable claims and revocation', () => {
  const claim = () => grant({ status: 'UNVERIFIED', issuerProvenance: 'caller-claim' });
  it('rejects verified and fixture grants through production entry points', async () => {
    await expect(recordAuthorizationClaim(statePath, auditPath, grant(), at)).rejects.toMatchObject({ code: 'EAUTHORIZATION_UNTRUSTED' });
    await expect(recordAuthorizationClaim(statePath, auditPath, claimWithFixture(), at)).rejects.toMatchObject({ code: 'EAUTHORIZATION_UNTRUSTED' });
    await expect(writeStateAtomic(statePath, { ...createInitialState(defaultConfig), authorization: state() })).rejects.toMatchObject({ code: 'EAUTHORIZATION_UNTRUSTED' });
  });
  it('serializes concurrent claims and rejects duplicate and conflicting contents', async () => {
    const results = await Promise.allSettled([recordAuthorizationClaim(statePath, auditPath, claim(), at),
      recordAuthorizationClaim(statePath, auditPath, claim(), at)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await readState(statePath)).authorization.grants).toHaveLength(1);
    await expect(recordAuthorizationClaim(statePath, auditPath, claimWithOtherActor(), at))
      .rejects.toMatchObject({ code: 'EAUTHORIZATION_DUPLICATE' });
  });
  it('persists revocation across restart, with an auditable epoch', async () => {
    await recordAuthorizationClaim(statePath, auditPath, claim(), at);
    expect(await revokeAuthorization(statePath, auditPath, 'grant-1', 'corr-revoke', at)).toBe(1);
    const persisted = await readState(statePath);
    expect(persisted.authorization).toMatchObject({ revocationEpoch: 1,
      grants: [{ status: 'REVOKED' }], revocations: [{ grantId: 'grant-1', epoch: 1 }] });
    expect(parseAuditLog(await readFile(auditPath, 'utf8')).map((event) => event.type))
      .toEqual(['authorization.claim.recorded', 'authorization.revoked']);
    expect((await generateAuditReport(auditPath, statePath)).state?.authorization).toMatchObject({
      revocationEpoch: 1, grants: [{ grantId: 'grant-1', status: 'REVOKED', revoked: true,
        verificationProvenance: 'unverified' }] });
    expect(evaluateAuthorization(grant(), evidence, request, persisted.authorization, at).reason).toBe('GRANT_REVOKED');
    const revokedAudit = parseAuditLog(await readFile(auditPath, 'utf8'))[1];
    expect(revokedAudit.actor).toBeUndefined();
    expect(revokedAudit).toMatchObject({ authorization: 'denied', provenance: { source: 'controller' },
      data: { grantHolderActorId: 'reviewer-1', initiatorClaimedActorId: null, initiatorProvenance: 'unverified' } });
    expect(persisted.authorization.revocations[0]).toMatchObject({ initiatorProvenance: 'unverified' });
  });
  it('records a caller-claimed revocation initiator without attributing it to the grant holder', async () => {
    await recordAuthorizationClaim(statePath, auditPath, claim(), at);
    await revokeAuthorization(statePath, auditPath, 'grant-1', 'corr-revoke', at, 'operator-2');
    const event = parseAuditLog(await readFile(auditPath, 'utf8'))[1];
    expect(event.actor).toEqual({ id: 'operator-2', provenance: 'caller-claimed; unverified' });
    expect(event.data).toMatchObject({ grantHolderActorId: 'reviewer-1',
      initiatorClaimedActorId: 'operator-2', initiatorProvenance: 'unverified' });
    expect((await readState(statePath)).authorization.revocations[0]).toMatchObject({
      initiatorClaimedActorId: 'operator-2', initiatorProvenance: 'unverified' });
  });
  it('rejects malformed and contradictory revocation state', () => {
    const revoked = grant({ status: 'REVOKED', updatedAt: at.toISOString() });
    const event = { grantId: 'grant-1', epoch: 1, revokedAt: at.toISOString(),
      correlationId: 'revoke-1', auditEvidenceRef: 'revoke-evidence-1' };
    const valid: AuthorizationState = { grants: [revoked], revocations: [event],
      consumedGrantIds: [], revocationEpoch: 1 };
    expect(parseAuthorizationState(valid)).toEqual(valid); // persisted B3A events have no initiator metadata
    const other = grant({ grantId: 'grant-2', status: 'REVOKED', updatedAt: at.toISOString() });
    const cases: unknown[] = [
      { ...valid, grants: [grant()] }, // event for an active grant
      { ...valid, revocations: [] }, // revoked grant without event
      { ...valid, revocations: [event, event], revocationEpoch: 2 },
      { ...valid, revocations: [{ ...event, epoch: 0 }] },
      { ...valid, revocations: [{ ...event, epoch: 2 }] },
      { ...valid, revocations: [{ ...event, epoch: 2 }], revocationEpoch: 2 }, // missing epoch 1
      { ...valid, grants: [revoked, other], revocations: [event, { ...event, grantId: 'grant-2', epoch: 2 }], revocationEpoch: 2 }, // duplicate correlation and evidence
      { ...valid, grants: [revoked, other], revocations: [event, { ...event, grantId: 'grant-2', epoch: 2,
        correlationId: 'revoke-2' }], revocationEpoch: 2 }, // duplicate evidence
      { ...valid, revocations: [{ ...event, revokedAt: '2026-10-17T12:01:00.000Z' }] },
      { ...valid, grants: [grant({ status: 'REVOKED', revocationEpoch: 1, updatedAt: at.toISOString() })] },
      { ...valid, revocations: [{ ...event, initiatorProvenance: 'verified' }] },
      { ...valid, revocations: [{ ...event, initiatorClaimedActorId: 'operator-2' }] },
      { ...valid, revocations: [null] }
    ];
    for (const invalid of cases)
      expect(() => parseAuthorizationState(invalid)).toThrowError();
  });
  it('leaves state unchanged if the audit write fails', async () => {
    const before = await readFile(statePath, 'utf8');
    await expect(recordAuthorizationClaim(statePath, dir, claim(), at)).rejects.toThrow();
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });
  it('migrates v3 with a populated B2 dispatch intact and no invented authorization', () => {
    const current = createInitialState(defaultConfig);
    const { authorization: _unused, ...legacy } = current;
    const dispatch: DispatchRecord = { version: 1, dispatchId: 'dispatch-23', operationKey: 'assign-23',
      repository, issueNumber: 23, branch: 'issue-23', target: { targetId: 'issue-23', sessionId: 'session-23' },
      payloadSha256: 'b'.repeat(64), correlationId: 'dispatch-corr-23',
      createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:01:00.000Z',
      state: 'UNCERTAIN', quarantineReason: 'acknowledgment-lost' };
    const migrated = parseState({ ...legacy, version: 3, schema: { createdVersion: 3 }, dispatches: [dispatch] });
    expect(migrated).toMatchObject({ version: 4, schema: { previousVersion: 3 },
      authorization: { grants: [], revocations: [], consumedGrantIds: [], revocationEpoch: 0 } });
    expect(migrated.dispatches).toEqual([dispatch]);
    expect(() => parseState({ ...legacy, version: 3, schema: { createdVersion: 3 },
      authorization: { grants: [claim()], revocations: [], consumedGrantIds: [], revocationEpoch: 0 } }))
      .toThrow(/unexpected authorization evidence/);
  });
});
function claimWithFixture() { return grant({ status: 'UNVERIFIED', issuerProvenance: 'test-fixture' }); }
function claimWithOtherActor() { return grant({ status: 'UNVERIFIED', issuerProvenance: 'caller-claim', actorId: 'other' }); }
