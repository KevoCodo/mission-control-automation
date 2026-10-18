import { describe, expect, it } from 'vitest';
import { planSupervisedAdmission, type SupervisedAdmissionInput } from '../supervisedAdmission.js';

const now = '2026-10-17T12:00:00.000Z';
const repository = { owner: 'KevoCodo', name: 'ai-delivery-lab' };
function input(): SupervisedAdmissionInput {
  const grant = {
    version: 1 as const, grantId: 'grant-1', issuerId: 'fixture-issuer', issuerProvenance: 'test-fixture',
    actorId: 'builder-1', action: 'ASSIGNMENT' as const, repository,
    target: { kind: 'issue' as const, number: 23 }, issueNumber: 23,
    constraints: { maxUses: 1 as const, purpose: 'issue-23' },
    issuedAt: '2026-10-17T11:00:00.000Z', expiresAt: '2026-10-17T13:00:00.000Z',
    revocationEpoch: 0, status: 'VERIFIED' as const,
    createdAt: '2026-10-17T11:00:00.000Z', updatedAt: '2026-10-17T11:00:00.000Z',
    correlationId: 'corr-1', auditEvidenceRef: 'evidence-1'
  };
  return {
    now,
    request: { role: 'BUILDER', action: 'ASSIGNMENT', actorId: 'builder-1', repository,
      issueNumber: 23, branch: 'issue-23', dispatchId: 'dispatch-1', generation: 2 },
    stop: { active: false, generation: 2 },
    target: { repository, issueNumber: 23, branch: 'issue-23', generation: 2 },
    dispatches: [{ dispatchId: 'dispatch-1', repository, issueNumber: 23,
      branch: 'issue-23', state: 'INTENT_RECORDED' }],
    grant,
    issuanceEvidence: { grantId: 'grant-1', issuerId: 'fixture-issuer', evidenceRef: 'evidence-1',
      verifiedAt: now, provenance: 'test-fixture' },
    authorizationState: { grants: [grant], revocations: [], consumedGrantIds: [], revocationEpoch: 0 },
    dependencies: { status: 'satisfied', evidenceRef: 'graph-1' },
    capacity: { limit: 2, active: 0, reserved: 1, evidenceRef: 'capacity-1' }
  };
}

describe('pure supervised admission planning', () => {
  it('returns fixture planning eligibility without any execution authority or side effects', () => {
    const candidate = input();
    const before = JSON.stringify(candidate);
    expect(planSupervisedAdmission(candidate)).toEqual({ status: 'eligible',
      reason: 'PLANNING_SCOPE_VALID_FIXTURE_ONLY', eligibleForPlanning: true,
      productionAuthorized: false, executable: false });
    expect(JSON.stringify(candidate)).toBe(before);
  });
  it.each([
    ['STOP active', (x: SupervisedAdmissionInput) => { x.stop.active = true; }, 'STOP_ACTIVE'],
    ['STOP missing', (x: SupervisedAdmissionInput) => { (x as unknown as Record<string, unknown>).stop = undefined; }, 'MALFORMED_INPUT'],
    ['grant missing', (x: SupervisedAdmissionInput) => { (x as unknown as Record<string, unknown>).grant = undefined; }, 'GRANT_MISSING'],
    ['grant unverified', (x: SupervisedAdmissionInput) => { x.grant.status = 'UNVERIFIED'; x.authorizationState.grants[0].status = 'UNVERIFIED'; }, 'GRANT_UNVERIFIED'],
    ['issuer unverified', (x: SupervisedAdmissionInput) => { x.issuanceEvidence.provenance = 'trusted-issuer'; }, 'ISSUER_UNVERIFIED'],
    ['grant expired', (x: SupervisedAdmissionInput) => { x.now = '2026-10-17T13:00:00.000Z'; }, 'GRANT_EXPIRED'],
    ['repository mismatch', (x: SupervisedAdmissionInput) => { x.grant.repository = { owner: 'other', name: 'repo' }; x.authorizationState.grants[0].repository = x.grant.repository; }, 'REPOSITORY_MISMATCH'],
    ['action mismatch', (x: SupervisedAdmissionInput) => { x.grant.action = 'REVIEW'; x.grant.target = { kind: 'pullRequest', number: 23 }; x.grant.pullRequestNumber = 23; x.grant.headSha = 'a'.repeat(40); }, 'ACTION_MISMATCH'],
    ['wrong role', (x: SupervisedAdmissionInput) => { x.request.role = 'REVIEWER'; }, 'UNSUPPORTED_ROLE_OR_ACTION'],
    ['unsupported action', (x: SupervisedAdmissionInput) => { x.request.action = 'REVIEW'; }, 'UNSUPPORTED_ROLE_OR_ACTION'],
    ['stale generation', (x: SupervisedAdmissionInput) => { x.target.generation = 1; }, 'STALE_TARGET_BINDING'],
    ['uncertain dispatch', (x: SupervisedAdmissionInput) => { x.dispatches[0].state = 'UNCERTAIN'; }, 'UNCERTAIN_DISPATCH'],
    ['duplicate active dispatch', (x: SupervisedAdmissionInput) => { x.dispatches.push({ ...x.dispatches[0], dispatchId: 'dispatch-2' }); }, 'CONFLICTING_DISPATCH'],
    ['missing dependency evidence', (x: SupervisedAdmissionInput) => { delete x.dependencies.evidenceRef; }, 'DEPENDENCY_EVIDENCE_MISSING'],
    ['capacity exhausted', (x: SupervisedAdmissionInput) => { x.capacity.active = 1; }, 'CAPACITY_EXHAUSTED'],
    ['missing capacity evidence', (x: SupervisedAdmissionInput) => { delete x.capacity.evidenceRef; }, 'CAPACITY_EVIDENCE_MISSING'],
    ['contradictory policy inputs', (x: SupervisedAdmissionInput) => { x.stop.generation = 3; }, 'STALE_TARGET_BINDING'],
    ['malformed inputs', (x: SupervisedAdmissionInput) => { x.capacity.active = -1; }, 'MALFORMED_INPUT']
  ] as const)('%s is denied or unknown', (_name, change, reason) => {
    const candidate = input();
    change(candidate);
    expect(planSupervisedAdmission(candidate)).toMatchObject({ reason, eligibleForPlanning: false,
      productionAuthorized: false, executable: false });
  });
  it('rejects absent and non-object inputs', () => {
    for (const candidate of [undefined, null, {}, [], 'eligible'])
      expect(planSupervisedAdmission(candidate)).toMatchObject({ status: 'blocked',
        eligibleForPlanning: false, productionAuthorized: false, executable: false });
  });
});
