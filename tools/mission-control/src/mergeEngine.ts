import type { ControllerConfig, OperationRecord, RepositoryIdentity } from './types.js';
import type { MergePolicyDecision } from './mergePolicy.js';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withAuditFileTransaction } from './audit.js';

/** Contract for a future trusted control plane, not an authority implementation. */
export interface ScopedActionGrant {
  issuer: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  action: 'merge-pr' | 'close-issue';
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface GrantVerificationRequest {
  grant: ScopedActionGrant;
  repository: RepositoryIdentity;
  pullRequestNumber: number;
  headSha: string;
  action: ScopedActionGrant['action'];
  now: Date;
  stopGeneration: number;
}

/** Must verify issuer identity, signature, scope, TTL, revocation, nonce consumption and STOP outside caller/config control. */
export interface TrustedGrantVerifier {
  verifyAndConsume(request: GrantVerificationRequest): Promise<{ verified: true; auditId: string }>;
}

/** Preliminary scope checks only. Even a well-formed envelope has no authority. */
export function inspectGrantEnvelope(request: GrantVerificationRequest): { plausible: boolean; authorized: false; reasons: string[] } {
  const { grant, repository, pullRequestNumber, headSha, action, now } = request;
  const reasons: string[] = [];
  if (!grant || !grant.issuer || !grant.signature || !grant.nonce) reasons.push('GRANT_FORGED_OR_MISSING');
  if (grant?.repository?.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase() ||
      grant?.pullRequestNumber !== pullRequestNumber || grant?.headSha !== headSha || grant?.action !== action) reasons.push('GRANT_WRONG_SCOPE');
  const issued = Date.parse(grant?.issuedAt ?? '');
  const expires = Date.parse(grant?.expiresAt ?? '');
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now.getTime() ||
      expires <= now.getTime() || expires - issued > 15 * 60_000) reasons.push('GRANT_EXPIRED_OR_INVALID_TTL');
  reasons.push('ISSUER_REVOCATION_SINGLE_USE_UNVERIFIED');
  return { plausible: reasons.length === 1, authorized: false, reasons };
}

export interface MergeActionResult {
  status: 'blocked' | 'ready-for-external-authorization' | 'already-merged' | 'uncertain';
  executable: false;
  reason: string;
  intentKey: string;
}

export interface ProviderMergeTruth {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  merged: boolean;
  mergeCommitSha?: string;
  complete: boolean;
}

export function mergeIntentKey(repository: RepositoryIdentity, pullRequestNumber: number, headSha: string): string {
  return `merge-pr:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}:${pullRequestNumber}:${headSha.toLowerCase()}`;
}

/** Records one informational event, never a pending operation. Dry runs are read-only. */
export async function stageMergeIntent(
  _statePath: string, auditPath: string, config: ControllerConfig, decision: MergePolicyDecision,
  mode: 'dry-run' | 'live', now = new Date()
): Promise<MergeActionResult> {
  const plan = planMergeAction(decision, config.repository);
  if (mode === 'dry-run' || !decision.eligibility.eligible) return plan;
  await withAuditFileTransaction(auditPath, 'stage-informational-merge-plan', async () => {
    let raw: string;
    try { raw = await readFile(auditPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = '';
    }
    if (raw && !raw.endsWith('\n')) throw new Error('AUDIT_LOG_INCOMPLETE');
    const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string; data?: { intentKey?: string } });
    if (events.some((event) => event.type === 'mergePolicy.planObserved' && event.data?.intentKey === plan.intentKey)) return;
    await mkdir(path.dirname(auditPath), { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({
      type: 'mergePolicy.planObserved', timestamp: now.toISOString(),
      data: { policyVersion: decision.policyVersion, intentKey: plan.intentKey,
        pullRequestNumber: decision.pullRequestNumber, headSha: decision.headSha,
        executable: false, reason: plan.reason }
    })}\n`, 'utf8');
  });
  return plan;
}

/** Provider truth is checked before any retry; pending or uncertain is never interpreted as retry permission. */
export function reconcileMergeIntent(record: OperationRecord | undefined, truth: ProviderMergeTruth | undefined,
  repository: RepositoryIdentity, pullRequestNumber: number, headSha: string): MergeActionResult {
  const intentKey = mergeIntentKey(repository, pullRequestNumber, headSha);
  if (record?.intent.key !== intentKey || record.intent.action !== 'merge-pr' || record.intent.targetType !== 'pullRequest') {
    return { status: 'blocked', executable: false, reason: 'DURABLE_INTENT_MISSING', intentKey };
  }
  if (!truth?.complete || truth.repository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase() ||
    truth.pullRequestNumber !== pullRequestNumber || truth.headSha !== headSha) {
    return { status: 'uncertain', executable: false, reason: 'PROVIDER_TRUTH_UNVERIFIED', intentKey };
  }
  if (truth.merged && /^[a-f0-9]{40}$/i.test(truth.mergeCommitSha ?? '')) {
    return { status: 'already-merged', executable: false, reason: 'PROVIDER_CONFIRMED_MERGED', intentKey };
  }
  return { status: 'blocked', executable: false, reason: 'REAUTHORIZATION_REQUIRED', intentKey };
}

export interface ClosureEvidence {
  originatingIssueNumber: number;
  issueNumber: number;
  pullRequestNumber: number;
  headSha: string;
  mergeCommitSha: string;
  mergeReconciled: boolean;
  completionEvidenceVerified: boolean;
  issueState: 'open' | 'closed' | 'unknown';
  providerVerified: boolean;
}

export function evaluateIssueClosure(evidence: ClosureEvidence): { eligible: boolean; executable: false; reason: string } {
  const eligible = evidence.originatingIssueNumber > 0 && evidence.issueNumber === evidence.originatingIssueNumber &&
    evidence.pullRequestNumber > 0 && /^[a-f0-9]{40}$/i.test(evidence.headSha) &&
    /^[a-f0-9]{40}$/i.test(evidence.mergeCommitSha) && evidence.mergeReconciled === true &&
    evidence.completionEvidenceVerified === true && evidence.providerVerified === true && evidence.issueState === 'open';
  return { eligible, executable: false, reason: eligible ? 'SEPARATE_CLOSE_AUTHORIZATION_REQUIRED' : 'CLOSURE_EVIDENCE_UNVERIFIED' };
}

/** The production adapter stays disabled until a separately reviewed trusted runtime exists. */
export class DisabledGithubMergeAdapter {
  readonly enabled = false;
  readonly method = 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge';
  readonly requiredPermission = 'contents:write';

  async merge(_request: { repository: RepositoryIdentity; pullRequestNumber: number; expectedHeadSha: string; grant: ScopedActionGrant }): Promise<never> {
    throw new Error('MERGE_ADAPTER_DISABLED: trusted grant verifier and side-effect revalidation are unavailable');
  }
}

/** No queue worker or caller-supplied flag may promote this plan into a side effect. */
export function planMergeAction(decision: MergePolicyDecision, repository: RepositoryIdentity): MergeActionResult {
  const intentKey = mergeIntentKey(repository, decision.pullRequestNumber, decision.headSha);
  return decision.eligibility.eligible
    ? { status: 'ready-for-external-authorization', executable: false, reason: 'TRUSTED_RUNTIME_UNAVAILABLE', intentKey }
    : { status: 'blocked', executable: false, reason: decision.eligibility.reasons[0] ?? 'POLICY_BLOCKED', intentKey };
}
