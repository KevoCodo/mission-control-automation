import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig } from '../config.js';
import { DisabledGithubMergeAdapter, evaluateIssueClosure, inspectGrantEnvelope, mergeIntentKey, planMergeAction, reconcileMergeIntent, stageMergeIntent } from '../mergeEngine.js';
import { evaluateMergePolicy, isSensitiveChange, type MergePolicyInput } from '../mergePolicy.js';
import { createInitialState } from '../state.js';
import type { OperationRecord } from '../types.js';

const SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);
const REPO = { owner: 'KevoCodo', name: 'ai-delivery-lab', defaultBranch: 'main' };
const DATE = '2026-01-01T00:00:00.000Z';

function fixture(): MergePolicyInput {
  const state = createInitialState({ ...defaultConfig, repository: REPO });
  state.nativeReviewControl = { stopActive: false, reason: '' };
  state.identities.sessions = [{ id: 'worker-20', issueNumber: 20, branch: 'ao/issue-20', worktreePath: 'E:\\worktree' }];
  state.operations = [{
    intent: { key: 'assignment', action: 'ao-spawn-worker', targetType: 'issue', targetId: 20,
      payload: { sessionId: 'worker-20', branch: 'ao/issue-20' } },
    status: 'succeeded', attempts: 1, createdAt: DATE, updatedAt: DATE,
    outcome: { provider: 'ao', externalId: 'worker-20' }
  }];
  const ci: MergePolicyInput['ci'] = {
    pullRequestNumber: 30, issueNumber: 20, sessionId: 'worker-20', branch: 'ao/issue-20',
    headSha: SHA, status: 'successful', reviewDecision: 'unknown', requiredChecksComplete: true,
    checks: [{ name: 'windows', status: 'successful', required: true, headSha: SHA, conclusion: 'success' }],
    stale: false, unavailable: false, generation: 1, dataSource: 'github', observedAt: DATE
  };
  const review: MergePolicyInput['review'] = {
    pullRequestNumber: 30, issueNumber: 20, sessionId: 'worker-20', branch: 'ao/issue-20', headSha: SHA,
    runId: 'review-1', runStatus: 'completed', runVerdict: 'approved', nativeReviewDecision: 'approved',
    githubRequiredApproval: 'approved', capabilityVerified: true, triggerAuthorized: false,
    triggerAuthorization: { humanAuthorized: false, source: 'missing' },
    correctionAuthorization: { humanAuthorized: false, source: 'missing' },
    stopState: { active: false }, reviewer: { id: 'reviewer-2', type: 'ao-native-reviewer', independent: true, provenance: 'explicit-runtime' },
    independentReviewer: true, findings: [], findingsComplete: true, threadsComplete: true,
    unresolvedThreadIds: [], duplicateThreadIds: [], stale: false, unavailable: false,
    correctionCycle: 0, correctionEscalated: false, observedAt: DATE
  };
  state.pullRequestTracking = [ci];
  state.nativeReviewTracking = [review];
  return {
    repository: REPO, issueNumber: 20, sessionId: 'worker-20', branch: 'ao/issue-20',
    pullRequestNumber: 30, headSha: SHA, baseBranch: 'main', headRepository: REPO, fork: false, draft: false,
    state, ci, review, risk: 'low',
    riskEvidence: { source: 'test-mock', assessorId: 'independent-risk-assessor', independent: true,
      headSha: SHA, enumerationComplete: true, declaredFileCount: 1,
      changes: [{ kind: 'modified', oldPath: 'src/App.tsx', newPath: 'src/App.tsx',
        oldContent: 'render view', newContent: 'render updated view', contentComplete: true, fileType: 'text' }] },
    acceptanceEvidence: { complete: true, headSha: SHA, issueNumber: 20, source: 'verified-provider' },
    protection: { verified: true, bypass: false, requiredApprovalsSatisfied: true, headSha: SHA, source: 'github' },
    stop: { active: false, historyComplete: true, generation: 1 }, mode: 'live'
  };
}

function codes(input: MergePolicyInput) { return evaluateMergePolicy(input).eligibility.reasons; }
function mutation(change: (input: MergePolicyInput) => void) { const input = fixture(); change(input); return input; }
function record(): OperationRecord { return {
  intent: { key: mergeIntentKey(REPO, 30, SHA), action: 'merge-pr', targetType: 'pullRequest', targetId: 30 },
  status: 'uncertain', attempts: 1, createdAt: DATE, updatedAt: DATE
}; }
const truth = { repository: 'KevoCodo/ai-delivery-lab', pullRequestNumber: 30, headSha: SHA, merged: true, mergeCommitSha: MERGE_SHA, complete: true };

describe('fail-closed merge policy', () => {
  it('separates eligibility from permission and result', () => {
    const decision = evaluateMergePolicy(fixture());
    expect(decision.policyVersion).toBe(1);
    expect(decision.eligibility).toEqual({ eligible: true, reasons: [] });
    expect(decision.actionPermission).toMatchObject({ permitted: false, authority: 'none', reasons: ['AUTHORITY_UNAVAILABLE'] });
    expect(decision.result).toBe('eligible-awaiting-authorization');
  });
  it('blocks Issue #10 itself', () => expect(codes(mutation(x => { x.issueNumber = 10; }))).toContain('ISSUE_10_EXCLUDED'));
  it('blocks unknown SHA', () => expect(codes(mutation(x => { x.headSha = ''; }))).toContain('UNKNOWN_INPUT'));
  it('blocks repository mismatch', () => expect(codes(mutation(x => { x.headRepository = { ...REPO, owner: 'other' }; }))).toContain('REPOSITORY_MISMATCH'));
  it('blocks missing assignment', () => expect(codes(mutation(x => { x.state.operations = []; }))).toContain('ASSIGNMENT_UNVERIFIED'));
  it('blocks duplicate assignment', () => expect(codes(mutation(x => { x.state.operations.push(x.state.operations[0]); }))).toContain('ASSIGNMENT_UNVERIFIED'));
  it('blocks main direct changes', () => expect(codes(mutation(x => { x.branch = 'main'; }))).toContain('PR_IDENTITY'));
  it('blocks fork heads', () => expect(codes(mutation(x => { x.fork = true; }))).toContain('PR_IDENTITY'));
  it('blocks a stale CI head', () => expect(codes(mutation(x => { x.ci = { ...x.ci, headSha: MERGE_SHA }; }))).toContain('HEAD_STALE'));
  it('blocks a newer persisted head generation', () => expect(codes(mutation(x => { x.state.pullRequestTracking[0] = { ...x.ci, headSha: MERGE_SHA, generation: 2 }; }))).toContain('HEAD_STALE'));
  it('blocks fixture CI', () => expect(codes(mutation(x => { x.ci.dataSource = 'fixture-data'; }))).toContain('CI_UNTRUSTED'));
  it('blocks missing required CI', () => expect(codes(mutation(x => { x.ci.checks = []; }))).toContain('CI_UNTRUSTED'));
  it('blocks failed CI', () => expect(codes(mutation(x => { x.ci.status = 'failed'; }))).toContain('CI_UNSUCCESSFUL'));
  it('blocks stale individual checks', () => expect(codes(mutation(x => { x.ci.checks[0].headSha = MERGE_SHA; }))).toContain('CI_UNSUCCESSFUL'));
  it('blocks internal review without verified runtime provenance', () => expect(codes(mutation(x => { x.review.reviewer!.provenance = 'fixture'; }))).toContain('REVIEW_UNVERIFIED'));
  it('blocks self approval', () => expect(codes(mutation(x => { x.review.reviewer!.id = x.sessionId; }))).toContain('REVIEW_UNVERIFIED'));
  it('requires GitHub approval independently', () => expect(codes(mutation(x => { x.review.githubRequiredApproval = 'missing'; }))).toContain('GITHUB_APPROVAL_MISSING'));
  it('requires all protection approvals', () => expect(codes(mutation(x => { x.protection.requiredApprovalsSatisfied = false; }))).toContain('GITHUB_APPROVAL_MISSING'));
  it('blocks unresolved critical findings', () => expect(codes(mutation(x => { x.review.findings.push({ id: 'f', threadId: 't', headSha: SHA, severity: 'critical', status: 'open', summary: 'issue' }); }))).toContain('FINDINGS_OPEN'));
  it('blocks unresolved threads', () => expect(codes(mutation(x => { x.review.unresolvedThreadIds = ['t']; }))).toContain('FINDINGS_OPEN'));
  it('blocks missing acceptance evidence', () => expect(codes(mutation(x => { x.acceptanceEvidence.complete = false; }))).toContain('ACCEPTANCE_MISSING'));
  it('blocks high and unknown risk', () => { for (const risk of ['high', 'unknown'] as const) expect(codes(mutation(x => { x.risk = risk; }))).toContain('RISK_NOT_LOW'); });
  it('blocks sensitive infrastructure and policy paths', () => { for (const path of ['.github/workflows/ci.yml', 'src/security/auth.ts', 'tools/mission-control/src/mergePolicy.ts']) expect(isSensitiveChange(path, 'render view')).toBe(true); });
  it('blocks secret-bearing content', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].newContent = 'const token = value'; }))).toContain('SENSITIVE_CHANGE'));
  it('blocks unknown paths', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].newPath = 'mystery.bin'; }))).toContain('SENSITIVE_CHANGE'));
  it('blocks cryptographic files even when the content has no obvious keyword', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].newPath = 'src/crypto.ts'; }))).toContain('SENSITIVE_CHANGE'));
  it('blocks cryptographic API content in an ordinary filename', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].newContent = 'createHmac(value)'; }))).toContain('SENSITIVE_CHANGE'));
  it('does not trust a caller claim of low risk', () => expect(codes(mutation(x => { x.riskEvidence.source = 'unknown'; x.risk = 'low'; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('fails closed on missing risk evidence', () => expect(codes(mutation(x => { x.riskEvidence = undefined as never; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('fails closed on malformed risk evidence', () => expect(codes(mutation(x => { x.riskEvidence.changes = undefined as never; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('requires independent risk provenance', () => expect(codes(mutation(x => { x.riskEvidence.assessorId = x.sessionId; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('requires complete file enumeration', () => expect(codes(mutation(x => { x.riskEvidence.enumerationComplete = false; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('rejects a truncated file count', () => expect(codes(mutation(x => { x.riskEvidence.declaredFileCount = 2; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('requires complete old and new content', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].oldContent = undefined; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('blocks renamed paths after inspecting both names', () => { const x = mutation(x => { x.riskEvidence.changes[0].kind = 'renamed'; x.riskEvidence.changes[0].oldPath = 'src/auth.ts'; }); expect(codes(x)).toEqual(expect.arrayContaining(['RISK_EVIDENCE_UNVERIFIED', 'SENSITIVE_CHANGE'])); });
  it('blocks deletions', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].kind = 'deleted'; x.riskEvidence.changes[0].newPath = undefined; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('blocks unknown file types', () => expect(codes(mutation(x => { x.riskEvidence.changes[0].fileType = 'unknown'; }))).toContain('RISK_EVIDENCE_UNVERIFIED'));
  it('allows low-risk eligibility only from complete independent test mock evidence', () => expect(evaluateMergePolicy(fixture())).toMatchObject({ eligibility: { eligible: true }, actionPermission: { permitted: false } }));
  it('blocks protection bypass', () => expect(codes(mutation(x => { x.protection.bypass = true; }))).toContain('PROTECTION_UNVERIFIED'));
  it('blocks STOP before effect', () => expect(codes(mutation(x => { x.stop.active = true; }))).toContain('STOP_ACTIVE'));
  it('blocks incomplete STOP history', () => expect(codes(mutation(x => { x.stop.historyComplete = false; }))).toContain('STOP_HISTORY_UNVERIFIED'));
  it('keeps dry run nonexecutable', () => { const x = mutation(x => { x.mode = 'dry-run'; }); expect(evaluateMergePolicy(x).actionPermission.reasons).toContain('DRY_RUN'); expect(planMergeAction(evaluateMergePolicy(x), REPO).executable).toBe(false); });
  it('rejects queued head race before action', () => { const x = fixture(); const queued = evaluateMergePolicy(x); x.state.pullRequestTracking[0] = { ...x.ci, headSha: MERGE_SHA, generation: 2 }; expect(queued.eligibility.eligible).toBe(true); expect(codes(x)).toContain('HEAD_STALE'); });
  it('rejects queued STOP race before action', () => { const x = fixture(); const queued = evaluateMergePolicy(x); x.state.nativeReviewControl.stopActive = true; expect(queued.eligibility.eligible).toBe(true); expect(codes(x)).toContain('STOP_ACTIVE'); });
  it('does not promote caller flags or config into authority', () => { const x = fixture() as MergePolicyInput & { authorized?: boolean }; x.authorized = true; expect(evaluateMergePolicy(x).actionPermission.permitted).toBe(false); });
  it('keeps the GitHub adapter disabled and pins the expected SHA contract', async () => { const adapter = new DisabledGithubMergeAdapter(); expect(adapter.enabled).toBe(false); await expect(adapter.merge({ repository: REPO, pullRequestNumber: 30, expectedHeadSha: SHA, grant: {} as never })).rejects.toThrow('MERGE_ADAPTER_DISABLED'); });
  it('uses stable merge intent keys across restart', () => expect(mergeIntentKey(REPO, 30, SHA)).toBe(mergeIntentKey({ ...REPO }, 30, SHA)));
  it('never retries an uncertain response without provider truth', () => expect(reconcileMergeIntent(record(), undefined, REPO, 30, SHA)).toMatchObject({ status: 'uncertain', executable: false }));
  it('recognizes merged provider truth without duplicate merge', () => expect(reconcileMergeIntent(record(), truth, REPO, 30, SHA)).toMatchObject({ status: 'already-merged', executable: false }));
  it('does not remerge when provider says unmerged', () => expect(reconcileMergeIntent(record(), { ...truth, merged: false }, REPO, 30, SHA)).toMatchObject({ status: 'blocked', reason: 'REAUTHORIZATION_REQUIRED' }));
  it('requires a matching durable intent', () => expect(reconcileMergeIntent(undefined, truth, REPO, 30, SHA).reason).toBe('DURABLE_INTENT_MISSING'));
  it('requires separate closure authorization after verified merge', () => expect(evaluateIssueClosure({ originatingIssueNumber: 20, issueNumber: 20, pullRequestNumber: 30, headSha: SHA, mergeCommitSha: MERGE_SHA, mergeReconciled: true, completionEvidenceVerified: true, issueState: 'open', providerVerified: true })).toEqual({ eligible: true, executable: false, reason: 'SEPARATE_CLOSE_AUTHORIZATION_REQUIRED' }));
  it('blocks closing another issue or duplicate closure', () => { for (const [issueNumber, issueState] of [[21, 'open'], [20, 'closed']] as const) expect(evaluateIssueClosure({ originatingIssueNumber: 20, issueNumber, pullRequestNumber: 30, headSha: SHA, mergeCommitSha: MERGE_SHA, mergeReconciled: true, completionEvidenceVerified: true, issueState, providerVerified: true }).eligible).toBe(false); });
  it('does not dispatch review or merge side effects', () => { const decision = evaluateMergePolicy(fixture()); expect(planMergeAction(decision, REPO)).toMatchObject({ executable: false, status: 'ready-for-external-authorization' }); });
  it('keeps forged grants unauthorized', () => expect(inspectGrantEnvelope(grantRequest({ signature: '' })).reasons).toContain('GRANT_FORGED_OR_MISSING'));
  it('keeps expired grants unauthorized', () => expect(inspectGrantEnvelope(grantRequest({ expiresAt: '2025-12-31T00:00:00.000Z' })).reasons).toContain('GRANT_EXPIRED_OR_INVALID_TTL'));
  it('keeps wrong-scope grants unauthorized', () => expect(inspectGrantEnvelope(grantRequest({ headSha: MERGE_SHA })).reasons).toContain('GRANT_WRONG_SCOPE'));
  it('keeps revocation and single-use unresolved without trusted runtime', () => expect(inspectGrantEnvelope(grantRequest()).reasons).toContain('ISSUER_REVOCATION_SINGLE_USE_UNVERIFIED'));
  it('stages one durable informational plan but no recoverable operation', async () => {
    const dir = await mkdtemp(path.join(process.cwd(), '.tmp-merge-policy-'));
    try {
      const statePath = path.join(dir, 'state.json'); const auditPath = path.join(dir, 'audit.jsonl');
      const decision = evaluateMergePolicy(fixture());
      const config = { ...defaultConfig, repository: REPO };
      await stageMergeIntent(statePath, auditPath, config, decision, 'live');
      await stageMergeIntent(statePath, auditPath, config, decision, 'live');
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
      const audit = await readFile(auditPath, 'utf8');
      expect(audit).toContain('mergePolicy.planObserved');
      expect(audit.trim().split('\n')).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not mutate state or audit during dry run', async () => {
    const dir = await mkdtemp(path.join(process.cwd(), '.tmp-merge-policy-'));
    try {
      const statePath = path.join(dir, 'state.json'); const auditPath = path.join(dir, 'audit.jsonl');
      await stageMergeIntent(statePath, auditPath, { ...defaultConfig, repository: REPO }, evaluateMergePolicy(fixture()), 'dry-run');
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not persist grant secrets in intent or audit', async () => {
    const dir = await mkdtemp(path.join(process.cwd(), '.tmp-merge-policy-'));
    try {
      const statePath = path.join(dir, 'state.json'); const auditPath = path.join(dir, 'audit.jsonl');
      const decision = evaluateMergePolicy(fixture()) as ReturnType<typeof evaluateMergePolicy> & { grant?: unknown };
      decision.grant = { signature: 'ghp_supersecret', nonce: 'private-nonce' };
      await stageMergeIntent(statePath, auditPath, { ...defaultConfig, repository: REPO }, decision, 'live');
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
      const raw = await readFile(auditPath, 'utf8');
      expect(raw).not.toContain('ghp_supersecret');
      expect(raw).not.toContain('private-nonce');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('cannot promote a forged grant into an executable operation', async () => {
    const dir = await mkdtemp(path.join(process.cwd(), '.tmp-merge-policy-'));
    try {
      const statePath = path.join(dir, 'state.json'); const auditPath = path.join(dir, 'audit.jsonl');
      const decision = evaluateMergePolicy(fixture()) as ReturnType<typeof evaluateMergePolicy> & { grant?: unknown };
      decision.grant = grantRequest({ signature: 'forged' }).grant;
      expect((await stageMergeIntent(statePath, auditPath, { ...defaultConfig, repository: REPO }, decision, 'live')).executable).toBe(false);
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

function grantRequest(override: Partial<Parameters<typeof inspectGrantEnvelope>[0]['grant']> = {}): Parameters<typeof inspectGrantEnvelope>[0] {
  return {
    repository: REPO, pullRequestNumber: 30, headSha: SHA, action: 'merge-pr',
    now: new Date('2026-01-01T00:05:00.000Z'), stopGeneration: 1,
    grant: { issuer: 'external', repository: 'KevoCodo/ai-delivery-lab', pullRequestNumber: 30,
      headSha: SHA, action: 'merge-pr', issuedAt: DATE, expiresAt: '2026-01-01T00:10:00.000Z',
      nonce: 'nonce-1', signature: 'opaque', ...override }
  };
}
