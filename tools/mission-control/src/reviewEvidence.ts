import { appendNativeReviewObservation, readState, StateError } from './state.js';
import { assertTrustedAoAdapter, assertTrustedGithubAdapter } from './clients.js';
import type { ControllerClients, GithubPullRequestSearchPage } from './clients.js';
import type {
  ControllerConfig,
  GithubRequiredApprovalStatus,
  NativeReviewCorrectionPlan,
  NativeReviewDecision,
  NativeReviewFinding,
  NativeReviewObservation,
  NativeReviewRunStatus,
  NativeReviewVerdict,
  NativeReviewThread,
  PullRequestDetails,
  PullRequestIdentity,
  RepositoryIdentity,
  SessionIdentity
} from './types.js';

export interface NativeReviewEvidenceRequest {
  issueNumber: number;
  sessionId: string;
  branch: string;
  expectedHeadSha?: string;
  triggerAuthorized: boolean;
  correctionAuthorized: boolean;
  verifiedTriggerAuthorization?: boolean;
  verifiedCorrectionAuthorization?: boolean;
  stopActive?: boolean;
  stopReason?: string;
  maxCorrectionCycles?: number;
  maxPages?: number;
}

export interface NativeReviewEvidenceResult {
  observation: NativeReviewObservation;
  pullRequest: PullRequestDetails;
}

export class NativeReviewEvidenceError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'NativeReviewEvidenceError';
    this.code = code;
  }
}

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_CORRECTION_CYCLES = 2;

export async function collectNativeReviewEvidence(
  statePath: string,
  config: ControllerConfig,
  clients: ControllerClients,
  request: NativeReviewEvidenceRequest,
  now = new Date()
): Promise<NativeReviewEvidenceResult> {
  assertTrustedGithubAdapter(clients.github.adapterName);
  assertTrustedAoAdapter(clients.ao.adapterName);
  const maxPages = readBound(request.maxPages, DEFAULT_MAX_PAGES, 'maxPages');
  const maxCorrectionCycles = readBound(
    request.maxCorrectionCycles,
    Math.min(config.limits.correctionAttempts, DEFAULT_MAX_CORRECTION_CYCLES),
    'maxCorrectionCycles'
  );
  if (maxCorrectionCycles > DEFAULT_MAX_CORRECTION_CYCLES) {
    throw new NativeReviewEvidenceError('Native review correction cycles are capped at 2.', 'ELIMIT');
  }
  const issue = requireIssue(config, request.issueNumber);
  const state = await readStateOrFail(statePath);
  const session = requireSession(state, request);
  requireDurableAssignment(state, request);
  const pullRequest = await resolvePullRequest(config.repository, clients, {
    number: 0,
    id: `issue-${issue.number}`,
    branch: request.branch,
    issueNumber: issue.number
  }, maxPages);
  validatePullRequest(config, pullRequest, session, request);

  const currentPullRequest = await getCurrentPullRequest(config.repository, clients, pullRequest);
  validatePullRequest(config, currentPullRequest, session, request);
  if (currentPullRequest.head.sha !== pullRequest.head.sha) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} head SHA was superseded before review evidence persistence.`, 'ESTALE_HEAD');
  }

  const capability = clients.ao.getNativeReviewCapability
    ? await clients.ao.getNativeReviewCapability()
    : {
        supported: false,
        statusSupported: false,
        triggerSupported: false,
        triggerRequiresHumanAuthorization: true,
        reviewerIndependenceRequired: true
      };
  const reviewRequest = {
    repository: config.repository,
    pullRequestNumber: currentPullRequest.number,
    headSha: currentPullRequest.head.sha
  };
  const run = capability.statusSupported && clients.ao.getNativeReviewRun
    ? await clients.ao.getNativeReviewRun(reviewRequest).catch(() => ({
        pullRequestNumber: currentPullRequest.number,
        headSha: currentPullRequest.head.sha,
        status: 'unavailable' as NativeReviewRunStatus,
        diagnosticCode: 'AO_REVIEW_STATUS_UNAVAILABLE'
      }))
    : {
        pullRequestNumber: currentPullRequest.number,
        headSha: currentPullRequest.head.sha,
        status: 'unavailable' as NativeReviewRunStatus,
        diagnosticCode: 'AO_REVIEW_STATUS_UNAVAILABLE'
      };
  const findings = await readReviewFindings(clients, reviewRequest);
  const threads = await readReviewThreads(clients, reviewRequest);
  const githubRequiredApproval = await readRequiredApproval(clients, reviewRequest);
  const observation = buildObservation({
    request,
    pullRequest: currentPullRequest,
    capabilityVerified: capability.supported && capability.statusSupported,
    run,
    findings: findings.items,
    threads: threads.items,
    findingsComplete: findings.complete,
    threadsComplete: threads.complete,
    evidenceDiagnosticCode: findings.diagnosticCode ?? threads.diagnosticCode,
    githubRequiredApproval,
    maxCorrectionCycles,
    stopActive: state.nativeReviewControl.stopActive || state.nativeReviewTracking.some(
      (entry) => entry.pullRequestNumber === currentPullRequest.number && entry.stopState?.active === true
    ),
    stopReason: state.nativeReviewControl.reason,
    priorCycles: Math.max(
      0,
      ...state.nativeReviewTracking
        .filter((entry) => entry.pullRequestNumber === currentPullRequest.number)
        .map((entry) => entry.correctionRequest?.cycle ?? entry.correctionCycle ?? 0)
    ),
    now
  });

  const persisted = await appendNativeReviewObservation(statePath, config, observation, now);
  return { observation: persisted, pullRequest: currentPullRequest };
}

async function readReviewFindings(
  clients: ControllerClients,
  request: { repository: RepositoryIdentity; pullRequestNumber: number; headSha: string }
): Promise<{ items: NativeReviewFinding[]; complete: boolean; diagnosticCode?: string }> {
  if (!clients.github.listPullRequestReviewFindings) {
    return { items: [], complete: false, diagnosticCode: 'REVIEW_FINDINGS_CAPABILITY_MISSING' };
  }
  try {
    const result = await clients.github.listPullRequestReviewFindings(request);
    if (!result || !Array.isArray(result.findings) || result.complete !== true ||
      !result.findings.every((finding) => isRecord(finding) && typeof finding.id === 'string' &&
        typeof finding.threadId === 'string' && typeof finding.headSha === 'string' &&
        typeof finding.summary === 'string' && (finding.status === 'open' || finding.status === 'resolved') &&
        (finding.severity === 'critical' || finding.severity === 'major' || finding.severity === 'minor') &&
        (finding.duplicateOf === undefined || typeof finding.duplicateOf === 'string'))) {
      return { items: [], complete: false, diagnosticCode: 'REVIEW_FINDINGS_INCOMPLETE' };
    }
    return { items: result.findings, complete: true };
  } catch {
    return { items: [], complete: false, diagnosticCode: 'REVIEW_FINDINGS_UNAVAILABLE' };
  }
}

async function readReviewThreads(
  clients: ControllerClients,
  request: { repository: RepositoryIdentity; pullRequestNumber: number; headSha: string }
): Promise<{ items: NativeReviewThread[]; complete: boolean; diagnosticCode?: string }> {
  if (!clients.ao.listNativeReviewThreads) {
    return { items: [], complete: false, diagnosticCode: 'REVIEW_THREADS_CAPABILITY_MISSING' };
  }
  try {
    const result = await clients.ao.listNativeReviewThreads(request);
    if (!result || !Array.isArray(result.threads) || result.complete !== true ||
      !result.threads.every((thread) => isRecord(thread) && typeof thread.id === 'string' &&
        typeof thread.headSha === 'string' && (thread.status === 'open' || thread.status === 'resolved') &&
        Array.isArray(thread.findingIds) && thread.findingIds.every((id: unknown) => typeof id === 'string'))) {
      return { items: [], complete: false, diagnosticCode: 'REVIEW_THREADS_INCOMPLETE' };
    }
    return { items: result.threads, complete: true };
  } catch {
    return { items: [], complete: false, diagnosticCode: 'REVIEW_THREADS_UNAVAILABLE' };
  }
}

async function readRequiredApproval(
  clients: ControllerClients,
  request: { repository: RepositoryIdentity; pullRequestNumber: number; headSha: string }
): Promise<GithubRequiredApprovalStatus> {
  if (!clients.github.getRequiredReviewApproval) {
    return 'unknown';
  }
  try {
    return await clients.github.getRequiredReviewApproval(request);
  } catch {
    return 'unavailable';
  }
}

function buildObservation(input: {
  request: NativeReviewEvidenceRequest;
  pullRequest: PullRequestDetails;
  capabilityVerified: boolean;
  run: {
    runId?: string;
    headSha: string;
    status: NativeReviewRunStatus;
    verdict?: NativeReviewVerdict;
    reviewer?: NativeReviewObservation['reviewer'];
    diagnosticCode?: string;
  };
  findings: NativeReviewFinding[];
  threads: NativeReviewThread[];
  findingsComplete: boolean;
  threadsComplete: boolean;
  evidenceDiagnosticCode?: string;
  githubRequiredApproval: GithubRequiredApprovalStatus;
  maxCorrectionCycles: number;
  stopActive: boolean;
  stopReason: string;
  priorCycles: number;
  now: Date;
}): NativeReviewObservation {
  const stale =
    input.run.headSha !== input.pullRequest.head.sha ||
    input.findings.some((finding) => finding.headSha !== input.pullRequest.head.sha) ||
    input.threads.some((thread) => thread.headSha !== input.pullRequest.head.sha);
  const duplicateThreadIds = input.findings.filter((finding) => finding.duplicateOf).map((finding) => finding.threadId);
  const openFindings = input.findings.filter((finding) => finding.status === 'open' && !finding.duplicateOf);
  const criticalOpen = openFindings.some((finding) => finding.severity === 'critical');
  const unresolvedThreadIds = unique([
    ...openFindings.map((finding) => finding.threadId),
    ...input.threads.filter((thread) => thread.status === 'open').map((thread) => thread.id)
  ]);
  const independentReviewer = input.run.reviewer?.independent === true &&
    input.run.reviewer.type === 'ao-native-reviewer' &&
    (input.run.reviewer.provenance === 'explicit-runtime' || input.run.reviewer.provenance === 'fixture') &&
    input.run.reviewer.id !== input.request.sessionId;
  const runVerdict = input.run.verdict ?? 'unknown';
  const unavailable = !input.capabilityVerified || !input.findingsComplete || !input.threadsComplete ||
    input.run.status === 'failed' || input.run.status === 'unavailable' ||
    (input.run.status === 'completed' && runVerdict === 'unknown');
  const triggerAuthorization = buildAuthorization(input.request.triggerAuthorized || input.request.verifiedTriggerAuthorization === true);
  const correctionAuthorization = buildAuthorization(input.request.correctionAuthorized || input.request.verifiedCorrectionAuthorization === true);
  const stopState = {
    active: input.stopActive,
    reason: input.stopActive ? input.stopReason : undefined
  };
  const nativeReviewDecision = summarizeNativeReview({
    runStatus: input.run.status,
    stale,
    unavailable,
    independentReviewer,
    runVerdict,
    criticalOpen,
    unresolvedThreadIds
  });
  const correctionCycle = input.priorCycles;
  const correctionEscalated = unresolvedThreadIds.length > 0 && correctionCycle >= input.maxCorrectionCycles;
  const correctionPlan: NativeReviewCorrectionPlan | undefined = unresolvedThreadIds.length > 0 && !stale &&
    input.findingsComplete && input.threadsComplete
    ? {
        action: correctionEscalated ? 'escalate' : 'consider-corrections',
        cycle: Math.min(correctionCycle + 1, input.maxCorrectionCycles),
        executable: false,
        blockedReasons: correctionEscalated
          ? ['BUDGET_EXHAUSTED']
          : [...(stopState.active ? ['STOP_ACTIVE'] : []), 'HUMAN_AUTH_UNVERIFIED'],
        findingIds: openFindings.map((finding) => finding.id),
        threadIds: unresolvedThreadIds
      }
    : undefined;

  return {
    pullRequestNumber: input.pullRequest.number,
    issueNumber: input.request.issueNumber,
    sessionId: input.request.sessionId,
    branch: input.request.branch,
    headSha: input.pullRequest.head.sha,
    runId: input.run.runId,
    runStatus: input.run.status,
    runVerdict,
    nativeReviewDecision,
    githubRequiredApproval: input.githubRequiredApproval,
    capabilityVerified: input.capabilityVerified,
    triggerAuthorized: false,
    triggerAuthorization,
    correctionAuthorization,
    stopState,
    reviewer: input.run.reviewer,
    independentReviewer,
    findings: input.findings,
    findingsComplete: input.findingsComplete,
    threadsComplete: input.threadsComplete,
    unresolvedThreadIds,
    duplicateThreadIds: unique(duplicateThreadIds),
    stale,
    unavailable,
    correctionCycle,
    correctionEscalated,
    correctionPlan,
    observedAt: input.now.toISOString(),
    diagnosticCode: input.evidenceDiagnosticCode ?? input.run.diagnosticCode ??
      (input.run.status === 'completed' && runVerdict === 'unknown' ? 'AO_REVIEW_VERDICT_UNAVAILABLE' : undefined)
  };
}

function buildAuthorization(callerFlag: boolean) {
  if (callerFlag) {
    return { humanAuthorized: false, source: 'caller-flag' as const };
  }
  return { humanAuthorized: false, source: 'missing' as const };
}

function summarizeNativeReview(input: {
  runStatus: NativeReviewRunStatus;
  stale: boolean;
  unavailable: boolean;
  independentReviewer: boolean;
  runVerdict: NativeReviewVerdict;
  criticalOpen: boolean;
  unresolvedThreadIds: string[];
}): NativeReviewDecision {
  if (input.stale) {
    return 'stale';
  }
  if (input.unavailable) {
    return 'unavailable';
  }
  if (input.runStatus !== 'completed') {
    return 'unknown';
  }
  if (input.runVerdict === 'changes-requested') {
    return 'changes-requested';
  }
  if (!input.independentReviewer) {
    return 'unavailable';
  }
  if (input.runVerdict !== 'approved') {
    return 'unavailable';
  }
  if (input.criticalOpen || input.unresolvedThreadIds.length > 0) {
    return 'changes-requested';
  }
  return 'approved';
}

async function readStateOrFail(statePath: string) {
  try {
    return await readState(statePath);
  } catch (error) {
    if (error instanceof StateError && error.code === 'ENOENT') {
      throw new NativeReviewEvidenceError('Durable assignment state is required for native review evidence.', 'EASSIGNMENT');
    }
    throw error;
  }
}

function requireIssue(config: ControllerConfig, issueNumber: number) {
  const issue = config.identities.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new NativeReviewEvidenceError(`Issue #${issueNumber} is not configured for native review evidence.`, 'EISSUE');
  }
  return issue;
}

function requireSession(state: Awaited<ReturnType<typeof readState>>, request: NativeReviewEvidenceRequest): SessionIdentity {
  const session = state.identities.sessions.find((candidate) => candidate.id === request.sessionId);
  if (!session) {
    throw new NativeReviewEvidenceError(`Session ${request.sessionId} is not configured for native review evidence.`, 'ESESSION');
  }
  if (session.issueNumber !== undefined && session.issueNumber !== request.issueNumber) {
    throw new NativeReviewEvidenceError(`Session ${request.sessionId} belongs to a different issue.`, 'ESESSION_ISSUE');
  }
  if (session.branch !== request.branch) {
    throw new NativeReviewEvidenceError(`Session ${request.sessionId} branch does not match review evidence request.`, 'EBRANCH');
  }
  return session;
}

function requireDurableAssignment(state: Awaited<ReturnType<typeof readState>>, request: NativeReviewEvidenceRequest): void {
  const matches = state.operations.filter((operation) => {
    if (operation.intent.action !== 'ao-spawn-worker' || operation.intent.targetType !== 'issue' || operation.status !== 'succeeded') {
      return false;
    }
    if (String(operation.intent.targetId) !== String(request.issueNumber)) {
      return false;
    }
    const payload = isRecord(operation.intent.payload) ? operation.intent.payload : {};
    const outcome = operation.outcome;
    return (
      payload.sessionId === request.sessionId &&
      payload.branch === request.branch &&
      (outcome?.externalId === undefined || outcome.externalId === request.sessionId)
    );
  });
  if (matches.length !== 1) {
    throw new NativeReviewEvidenceError('Native review evidence requires exactly one verified durable issue/session assignment.', 'EASSIGNMENT');
  }
}

async function resolvePullRequest(
  repository: RepositoryIdentity,
  clients: ControllerClients,
  identity: PullRequestIdentity,
  maxPages: number
): Promise<PullRequestDetails> {
  if (!clients.github.findPullRequestsForBranch) {
    if (!clients.github.getPullRequestDetails) {
      throw new NativeReviewEvidenceError('Trusted GitHub adapter does not expose PR details.', 'EGITHUB_CAPABILITY');
    }
    return clients.github.getPullRequestDetails(identity);
  }

  const matches = await collectSearchPages(clients, repository, identity.branch, maxPages);
  if (matches.length === 0) {
    throw new NativeReviewEvidenceError(`No pull request found for branch ${identity.branch}.`, 'EPR_MISSING');
  }
  if (matches.length > 1) {
    throw new NativeReviewEvidenceError(`Multiple pull requests found for branch ${identity.branch}; reconcile explicitly.`, 'EPR_DUPLICATE');
  }
  return matches[0];
}

async function getCurrentPullRequest(
  repository: RepositoryIdentity,
  clients: ControllerClients,
  pullRequest: PullRequestDetails
): Promise<PullRequestDetails> {
  if (!clients.github.getPullRequestDetails) {
    throw new NativeReviewEvidenceError('Trusted GitHub adapter does not expose authoritative current PR details.', 'EGITHUB_CAPABILITY');
  }
  return clients.github.getPullRequestDetails({
    id: pullRequest.id,
    number: pullRequest.number,
    branch: pullRequest.branch,
    repository
  });
}

async function collectSearchPages(
  clients: ControllerClients,
  repository: RepositoryIdentity,
  branch: string,
  maxPages: number
): Promise<PullRequestDetails[]> {
  const pages: GithubPullRequestSearchPage[] = [];
  let count = 0;
  let expectedPage = 1;
  let lastHadNext = false;
  for await (const page of clients.github.findPullRequestsForBranch!({ repository, branch })) {
    count += 1;
    if (count > maxPages) {
      throw new NativeReviewEvidenceError('Pull request search exceeded bounded pagination.', 'EPAGE_LIMIT');
    }
    if (page.pageInfo.page !== expectedPage) {
      throw new NativeReviewEvidenceError('Pull request search returned malformed pagination.', 'EPAGE_MALFORMED');
    }
    pages.push(page);
    expectedPage += 1;
    lastHadNext = page.pageInfo.hasNextPage;
    if (!page.pageInfo.hasNextPage) {
      break;
    }
  }
  if (pages.length === 0 || lastHadNext) {
    throw new NativeReviewEvidenceError('Pull request search ended before authoritative pagination completion.', 'EPAGE_TRUNCATED');
  }
  return pages
    .sort((left, right) => left.pageInfo.page - right.pageInfo.page)
    .flatMap((page) => page.pullRequests);
}

function validatePullRequest(
  config: ControllerConfig,
  pullRequest: PullRequestDetails,
  session: SessionIdentity,
  request: NativeReviewEvidenceRequest
): void {
  if (pullRequest.closed || pullRequest.state === 'closed') {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} is closed.`, 'EPR_CLOSED');
  }
  if (pullRequest.draft) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} is a draft.`, 'EPR_DRAFT');
  }
  if (pullRequest.branch !== request.branch || pullRequest.head.branch !== request.branch || pullRequest.branch !== session.branch) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} branch does not match the session branch.`, 'EBRANCH');
  }
  if (!sameRepository(pullRequest.head.repository, config.repository) || pullRequest.head.fork) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} head repository is not the configured repository.`, 'EREPOSITORY');
  }
  if (pullRequest.association?.issueNumber !== undefined && pullRequest.association.issueNumber !== request.issueNumber) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} is associated with a different issue.`, 'EISSUE');
  }
  if (pullRequest.association?.sessionId !== undefined && pullRequest.association.sessionId !== request.sessionId) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} is associated with a different session.`, 'ESESSION');
  }
  if (request.expectedHeadSha !== undefined && pullRequest.head.sha !== request.expectedHeadSha) {
    throw new NativeReviewEvidenceError(`Pull request #${pullRequest.number} head SHA is stale.`, 'ESTALE_HEAD');
  }
}

function readBound(value: number | undefined, defaultValue: number, label: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 25) {
    throw new NativeReviewEvidenceError(`${label} must be a positive bounded integer.`, 'ELIMIT');
  }
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
