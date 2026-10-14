import type { ControllerState, NativeReviewObservation, PullRequestTrackingObservation, RepositoryIdentity } from './types.js';

export const MERGE_POLICY_VERSION = 1;

export type MergeBlockCode =
  | 'UNKNOWN_INPUT' | 'ISSUE_10_EXCLUDED' | 'REPOSITORY_MISMATCH' | 'ASSIGNMENT_UNVERIFIED'
  | 'PR_IDENTITY' | 'HEAD_STALE' | 'CI_UNTRUSTED' | 'CI_UNSUCCESSFUL'
  | 'REVIEW_UNVERIFIED' | 'GITHUB_APPROVAL_MISSING' | 'FINDINGS_OPEN'
  | 'ACCEPTANCE_MISSING' | 'RISK_NOT_LOW' | 'SENSITIVE_CHANGE'
  | 'RISK_EVIDENCE_UNVERIFIED'
  | 'PROTECTION_UNVERIFIED' | 'STOP_ACTIVE' | 'STOP_HISTORY_UNVERIFIED'
  | 'AUTHORITY_UNAVAILABLE' | 'DRY_RUN';

export interface MergePolicyInput {
  repository: RepositoryIdentity;
  issueNumber: number;
  sessionId: string;
  branch: string;
  pullRequestNumber: number;
  headSha: string;
  baseBranch: string;
  headRepository: RepositoryIdentity;
  fork: boolean;
  draft: boolean;
  state: ControllerState;
  ci: PullRequestTrackingObservation;
  review: NativeReviewObservation;
  riskEvidence: ChangedFileEvidence;
  risk: 'low' | 'medium' | 'high' | 'unknown';
  acceptanceEvidence: { complete: boolean; headSha: string; issueNumber: number; source: 'verified-provider' | 'fixture' | 'unknown' };
  protection: { verified: boolean; bypass: boolean; requiredApprovalsSatisfied: boolean; headSha: string; source: 'github' | 'fixture' | 'unknown' };
  stop: { active: boolean; historyComplete: boolean; generation: number };
  mode: 'dry-run' | 'live';
}

/** Test-only evidence shape. No production issuer exists; this cannot authorize an action. */
export interface ChangedFileEvidence {
  source: 'test-mock' | 'unknown';
  assessorId: string;
  independent: boolean;
  headSha: string;
  enumerationComplete: boolean;
  declaredFileCount: number;
  changes: Array<{
    kind: 'added' | 'modified' | 'renamed' | 'deleted' | 'unknown';
    oldPath?: string;
    newPath?: string;
    oldContent?: string;
    newContent?: string;
    contentComplete: boolean;
    fileType: 'text' | 'binary' | 'unknown';
  }>;
}

export interface PolicyEligibility { eligible: boolean; reasons: MergeBlockCode[] }
export interface ActionPermission { permitted: boolean; reasons: MergeBlockCode[]; authority: 'none' | 'external-verified' }
export interface MergePolicyDecision {
  policyVersion: typeof MERGE_POLICY_VERSION;
  eligibility: PolicyEligibility;
  actionPermission: ActionPermission;
  result: 'blocked' | 'eligible-awaiting-authorization';
  headSha: string;
  pullRequestNumber: number;
}

/** Pure assessment. It never turns caller data or configuration into side-effect authority. */
export function evaluateMergePolicy(input: MergePolicyInput): MergePolicyDecision {
  const reasons: MergeBlockCode[] = [];
  const add = (code: MergeBlockCode) => { if (!reasons.includes(code)) reasons.push(code); };
  if (!validNumber(input.issueNumber) || !validNumber(input.pullRequestNumber) || !validSha(input.headSha) ||
      !input.repository?.owner || !input.repository?.name || !input.sessionId || !input.branch ||
      !input.riskEvidence || !Array.isArray(input.riskEvidence.changes)) add('UNKNOWN_INPUT');
  if (input.issueNumber === 10) add('ISSUE_10_EXCLUDED');
  if (!sameRepository(input.repository, input.state?.repository) || !sameRepository(input.repository, input.headRepository)) add('REPOSITORY_MISMATCH');
  const assignments = input.state?.operations?.filter((operation) => operation.intent.action === 'ao-spawn-worker' &&
    operation.intent.targetType === 'issue' && String(operation.intent.targetId) === String(input.issueNumber) &&
    operation.status === 'succeeded' && isRecord(operation.intent.payload) &&
    operation.intent.payload.sessionId === input.sessionId && operation.intent.payload.branch === input.branch &&
    (operation.outcome?.externalId === undefined || operation.outcome.externalId === input.sessionId)) ?? [];
  const session = input.state?.identities?.sessions?.find((candidate) => candidate.id === input.sessionId);
  if (assignments.length !== 1 || !session || session.issueNumber !== input.issueNumber || session.branch !== input.branch) add('ASSIGNMENT_UNVERIFIED');
  if (input.branch === input.repository.defaultBranch || input.baseBranch !== input.repository.defaultBranch ||
    input.fork || input.draft || !validNumber(input.pullRequestNumber)) add('PR_IDENTITY');
  if (input.ci?.pullRequestNumber !== input.pullRequestNumber || input.ci?.headSha !== input.headSha ||
    input.ci?.issueNumber !== input.issueNumber || input.ci?.sessionId !== input.sessionId ||
    input.ci?.branch !== input.branch || input.review?.pullRequestNumber !== input.pullRequestNumber ||
    input.review?.headSha !== input.headSha || input.review?.issueNumber !== input.issueNumber ||
    input.review?.sessionId !== input.sessionId || input.review?.branch !== input.branch ||
    input.protection?.headSha !== input.headSha) add('HEAD_STALE');
  const latestCi = input.state?.pullRequestTracking?.filter((entry) => entry.pullRequestNumber === input.pullRequestNumber).at(-1);
  const latestReview = input.state?.nativeReviewTracking?.filter((entry) => entry.pullRequestNumber === input.pullRequestNumber).at(-1);
  if (!latestCi || !latestReview || latestCi.headSha !== input.headSha || latestReview.headSha !== input.headSha ||
    latestCi.generation !== input.ci?.generation || latestCi.observedAt !== input.ci?.observedAt ||
    latestReview.observedAt !== input.review?.observedAt) add('HEAD_STALE');
  if (input.ci?.dataSource !== 'github' || input.ci?.requiredChecksComplete !== true || input.ci?.unavailable === true ||
    !Array.isArray(input.ci?.checks) || input.ci.checks.filter((check) => check.required).length === 0) add('CI_UNTRUSTED');
  if (input.ci?.status !== 'successful' || input.ci?.stale || input.ci?.checks?.some((check) =>
    check.required && (check.headSha !== input.headSha || check.status !== 'successful' || check.conclusion !== 'success'))) add('CI_UNSUCCESSFUL');
  const reviewer = input.review?.reviewer;
  if (input.review?.nativeReviewDecision !== 'approved' || input.review?.runStatus !== 'completed' ||
    input.review?.runVerdict !== 'approved' || !input.review?.capabilityVerified || !input.review?.independentReviewer ||
    input.review?.stale || input.review?.unavailable || reviewer?.type !== 'ao-native-reviewer' ||
    reviewer.provenance !== 'explicit-runtime' || !reviewer.independent || reviewer.id === input.sessionId) add('REVIEW_UNVERIFIED');
  if (input.review?.githubRequiredApproval !== 'approved' || input.protection?.requiredApprovalsSatisfied !== true) add('GITHUB_APPROVAL_MISSING');
  if (!input.review?.findingsComplete || !input.review?.threadsComplete ||
    input.review?.findings?.some((finding) => finding.status !== 'resolved' || finding.headSha !== input.headSha) ||
    input.review?.unresolvedThreadIds?.length || input.review?.duplicateThreadIds?.length) add('FINDINGS_OPEN');
  if (input.acceptanceEvidence?.complete !== true || input.acceptanceEvidence.headSha !== input.headSha ||
    input.acceptanceEvidence.issueNumber !== input.issueNumber || input.acceptanceEvidence.source !== 'verified-provider') add('ACCEPTANCE_MISSING');
  if (input.risk !== 'low') add('RISK_NOT_LOW');
  const riskEvidence = input.riskEvidence;
  if (riskEvidence?.source !== 'test-mock' || !riskEvidence.assessorId || riskEvidence.assessorId === input.sessionId ||
    riskEvidence.independent !== true || riskEvidence.headSha !== input.headSha ||
    riskEvidence.enumerationComplete !== true || !Number.isSafeInteger(riskEvidence.declaredFileCount) ||
    riskEvidence.declaredFileCount < 1 || riskEvidence.declaredFileCount !== riskEvidence.changes?.length ||
    riskEvidence.changes?.some((change) => change.contentComplete !== true || change.fileType !== 'text' ||
      !['added', 'modified'].includes(change.kind) || typeof change.newContent !== 'string' ||
      !change.newPath || (change.kind === 'modified' && (!change.oldPath || typeof change.oldContent !== 'string')))) add('RISK_EVIDENCE_UNVERIFIED');
  if (riskEvidence?.changes?.some((change) =>
    (change.oldPath !== undefined && isSensitiveChange(change.oldPath, change.oldContent)) ||
    (change.newPath !== undefined && isSensitiveChange(change.newPath, change.newContent)))) add('SENSITIVE_CHANGE');
  if (input.protection?.verified !== true || input.protection?.bypass !== false || input.protection?.source !== 'github') add('PROTECTION_UNVERIFIED');
  if (input.stop?.active !== false || input.state?.nativeReviewControl?.stopActive !== false || input.review?.stopState?.active !== false) add('STOP_ACTIVE');
  if (input.stop?.historyComplete !== true || !Number.isSafeInteger(input.stop?.generation) || input.stop.generation < 1) add('STOP_HISTORY_UNVERIFIED');
  const eligibility = { eligible: reasons.length === 0, reasons };
  const permissionReasons: MergeBlockCode[] = [...reasons, ...(input.mode === 'dry-run' ? ['DRY_RUN' as const] : []), 'AUTHORITY_UNAVAILABLE'];
  return {
    policyVersion: MERGE_POLICY_VERSION,
    eligibility,
    actionPermission: { permitted: false, reasons: [...new Set(permissionReasons)], authority: 'none' },
    result: eligibility.eligible ? 'eligible-awaiting-authorization' : 'blocked',
    headSha: input.headSha,
    pullRequestNumber: input.pullRequestNumber
  };
}

const SAFE_PATH = /^(src\/|public\/)[A-Za-z0-9_./-]+\.(?:tsx?|css|svg|png|jpe?g)$/i;
const SENSITIVE_PATH = /(^|\/)(?:\.github|\.env|auth|security|secret|credential|token|crypto|cipher|privilege|permission|exec|deploy|infra|migration|gate|merge|policy|stop|ci|workflow)(?:[./_-]|$)/i;
const SENSITIVE_CONTENT = /\b(?:cryptography|cryptographic|crypto|cipher|encrypt|decrypt|hash|sign|verify|createHmac|scrypt|pbkdf2|generateKey|privateKey|publicKey|x509|jwt|jwe|jws|oauth|openid|saml|session|cookie|csrf|acl|rbac|sudo|child_process|eval|auth|authentication|authorization|permissions|privilege|exec|spawn|secret|token|credential|password|deploy|migration|workflow|merge|branch protection|stop)\b/i;

export function isSensitiveChange(path: unknown, content: unknown): boolean {
  if (typeof path !== 'string' || typeof content !== 'string' || !path || path.includes('\\') ||
      path.includes('..') || path.startsWith('/') || !SAFE_PATH.test(path)) return true;
  return SENSITIVE_PATH.test(path) || SENSITIVE_CONTENT.test(content);
}

function validSha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value); }
function validNumber(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function sameRepository(left: RepositoryIdentity | undefined, right: RepositoryIdentity | undefined): boolean {
  return !!left && !!right && left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() && left.defaultBranch === right.defaultBranch;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
