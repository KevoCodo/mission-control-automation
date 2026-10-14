import { appendPullRequestTrackingObservation, readState, StateError } from './state.js';
import { assertTrustedGithubAdapter } from './clients.js';
import type { ControllerClients, GithubPullRequestChecksPage, GithubPullRequestSearchPage } from './clients.js';
import type {
  CheckObservationStatus,
  ControllerConfig,
  PullRequestCheckObservation,
  PullRequestCheckRun,
  PullRequestDetails,
  PullRequestIdentity,
  PullRequestReviewDecision,
  PullRequestTrackingObservation,
  PullRequestTrackingStatus,
  RepositoryIdentity,
  RequiredCheckRule,
  SessionIdentity
} from './types.js';

export interface PullRequestTrackingRequest {
  issueNumber: number;
  sessionId: string;
  branch: string;
  expectedHeadSha?: string;
  maxPages?: number;
  maxPolls?: number;
}

export interface PullRequestTrackingResult {
  observation: PullRequestTrackingObservation;
  pullRequest: PullRequestDetails;
}

export class PullRequestTrackingError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'PullRequestTrackingError';
    this.code = code;
  }
}

const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_POLLS = 3;
const DEFAULT_PAGE_SIZE = 50;

export async function trackPullRequestChecks(
  statePath: string,
  config: ControllerConfig,
  clients: ControllerClients,
  request: PullRequestTrackingRequest,
  now = new Date()
): Promise<PullRequestTrackingResult> {
  assertTrustedGithubAdapter(clients.github.adapterName);
  const maxPages = readBound(request.maxPages, DEFAULT_MAX_PAGES, 'maxPages');
  const maxPolls = readBound(request.maxPolls, DEFAULT_MAX_POLLS, 'maxPolls');
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

  let checks: PullRequestCheckRun[] = [];
  let checksComplete = false;
  let unavailable = false;
  let diagnosticCode: string | undefined;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const result = await collectCheckPages(clients, config.repository, pullRequest, maxPages);
      checks = result.checks;
      checksComplete = result.complete;
      unavailable = result.unavailable;
      diagnosticCode = result.diagnosticCode;
      if (checksComplete && !checks.some((check) => check.status === 'queued' || check.status === 'in_progress' || check.status === 'pending')) {
        break;
      }
    } catch (caught) {
      unavailable = true;
      diagnosticCode = 'CHECK_PROVIDER_UNAVAILABLE';
      break;
    }
  }

  const currentPullRequest = await getCurrentPullRequest(config.repository, clients, pullRequest);
  validatePullRequest(config, currentPullRequest, session, request);
  if (currentPullRequest.head.sha !== pullRequest.head.sha) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} head SHA was superseded before persistence.`, 'ESTALE_HEAD');
  }

  const required = await getRequiredChecks(clients, config.repository, pullRequest, unavailable);
  const candidate = buildObservation({
    request,
    pullRequest: currentPullRequest,
    checks,
    required,
    checksComplete,
    unavailable,
    diagnosticCode,
    dataSource: clients.github.adapterName === 'fixture-github-client' ? 'fixture-data' : 'github',
    now
  });

  const observation = await appendPullRequestTrackingObservation(statePath, config, candidate, now);
  return { observation, pullRequest };
}

async function readStateOrFail(statePath: string) {
  try {
    return await readState(statePath);
  } catch (error) {
    if (error instanceof StateError && error.code === 'ENOENT') {
      throw new PullRequestTrackingError('Durable assignment state is required for PR tracking.', 'EASSIGNMENT');
    }
    throw error;
  }
}

function requireIssue(config: ControllerConfig, issueNumber: number) {
  const issue = config.identities.issues.find((candidate) => candidate.number === issueNumber);
  if (!issue) {
    throw new PullRequestTrackingError(`Issue #${issueNumber} is not configured for PR tracking.`, 'EISSUE');
  }
  return issue;
}

function requireSession(state: Awaited<ReturnType<typeof readState>>, request: PullRequestTrackingRequest): SessionIdentity {
  const session = state.identities.sessions.find((candidate) => candidate.id === request.sessionId);
  if (!session) {
    throw new PullRequestTrackingError(`Session ${request.sessionId} is not configured for PR tracking.`, 'ESESSION');
  }
  if (session.issueNumber !== undefined && session.issueNumber !== request.issueNumber) {
    throw new PullRequestTrackingError(`Session ${request.sessionId} belongs to a different issue.`, 'ESESSION_ISSUE');
  }
  if (session.branch !== request.branch) {
    throw new PullRequestTrackingError(`Session ${request.sessionId} branch does not match tracking request.`, 'EBRANCH');
  }
  return session;
}

function requireDurableAssignment(state: Awaited<ReturnType<typeof readState>>, request: PullRequestTrackingRequest): void {
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
    throw new PullRequestTrackingError('PR tracking requires exactly one verified durable issue/session assignment.', 'EASSIGNMENT');
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
      throw new PullRequestTrackingError('Trusted GitHub adapter does not expose PR details.', 'EGITHUB_CAPABILITY');
    }
    return clients.github.getPullRequestDetails(identity);
  }

  const matches = await collectSearchPages(clients, repository, identity.branch, maxPages);
  if (matches.length === 0) {
    throw new PullRequestTrackingError(`No pull request found for branch ${identity.branch}.`, 'EPR_MISSING');
  }
  if (matches.length > 1) {
    throw new PullRequestTrackingError(`Multiple pull requests found for branch ${identity.branch}; reconcile explicitly.`, 'EPR_DUPLICATE');
  }
  return matches[0];
}

async function getCurrentPullRequest(
  repository: RepositoryIdentity,
  clients: ControllerClients,
  pullRequest: PullRequestDetails
): Promise<PullRequestDetails> {
  if (!clients.github.getPullRequestDetails) {
    throw new PullRequestTrackingError('Trusted GitHub adapter does not expose authoritative current PR details.', 'EGITHUB_CAPABILITY');
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
      throw new PullRequestTrackingError('Pull request search exceeded bounded pagination.', 'EPAGE_LIMIT');
    }
    if (page.pageInfo.page !== expectedPage) {
      throw new PullRequestTrackingError('Pull request search returned malformed pagination.', 'EPAGE_MALFORMED');
    }
    pages.push(page);
    expectedPage += 1;
    lastHadNext = page.pageInfo.hasNextPage;
    if (!page.pageInfo.hasNextPage) {
      break;
    }
  }
  if (pages.length === 0 || lastHadNext) {
    throw new PullRequestTrackingError('Pull request search ended before authoritative pagination completion.', 'EPAGE_TRUNCATED');
  }
  return pages
    .sort((left, right) => left.pageInfo.page - right.pageInfo.page)
    .flatMap((page) => page.pullRequests);
}

function validatePullRequest(
  config: ControllerConfig,
  pullRequest: PullRequestDetails,
  session: SessionIdentity,
  request: PullRequestTrackingRequest
): void {
  if (pullRequest.closed || pullRequest.state === 'closed') {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} is closed.`, 'EPR_CLOSED');
  }
  if (pullRequest.draft) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} is a draft.`, 'EPR_DRAFT');
  }
  if (pullRequest.branch !== request.branch || pullRequest.head.branch !== request.branch || pullRequest.branch !== session.branch) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} branch does not match the session branch.`, 'EBRANCH');
  }
  if (!sameRepository(pullRequest.head.repository, config.repository) || pullRequest.head.fork) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} head repository is not the configured repository.`, 'EREPOSITORY');
  }
  if (pullRequest.association?.issueNumber !== undefined && pullRequest.association.issueNumber !== request.issueNumber) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} is associated with a different issue.`, 'EISSUE');
  }
  if (pullRequest.association?.sessionId !== undefined && pullRequest.association.sessionId !== request.sessionId) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} is associated with a different session.`, 'ESESSION');
  }
  if (request.expectedHeadSha !== undefined && pullRequest.head.sha !== request.expectedHeadSha) {
    throw new PullRequestTrackingError(`Pull request #${pullRequest.number} head SHA is stale.`, 'ESTALE_HEAD');
  }
}

async function collectCheckPages(
  clients: ControllerClients,
  repository: RepositoryIdentity,
  pullRequest: PullRequestDetails,
  maxPages: number
): Promise<{ checks: PullRequestCheckRun[]; complete: boolean; unavailable: boolean; diagnosticCode?: string }> {
  if (!clients.github.listPullRequestChecks) {
    return { checks: [], complete: false, unavailable: true, diagnosticCode: 'CHECKS_UNAVAILABLE' };
  }

  const pages: GithubPullRequestChecksPage[] = [];
  let count = 0;
  for await (const page of clients.github.listPullRequestChecks({
    repository,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
    pageSize: DEFAULT_PAGE_SIZE
  })) {
    count += 1;
    if (count > maxPages) {
      return { checks: pages.flatMap((entry) => entry.checks), complete: false, unavailable: true, diagnosticCode: 'CHECK_PAGINATION_LIMIT' };
    }
    pages.push(page);
    if (page.pageInfo.rateLimited) {
      return { checks: pages.flatMap((entry) => entry.checks), complete: false, unavailable: true, diagnosticCode: 'CHECK_RATE_LIMITED' };
    }
    if (!page.pageInfo.hasNextPage) {
      break;
    }
  }

  return {
    checks: pages.sort((left, right) => left.pageInfo.page - right.pageInfo.page).flatMap((page) => page.checks),
    complete: pages.at(-1)?.pageInfo.hasNextPage === false,
    unavailable: false
  };
}

async function getRequiredChecks(
  clients: ControllerClients,
  repository: RepositoryIdentity,
  pullRequest: PullRequestDetails,
  unavailable: boolean
) {
  if (unavailable || !clients.github.getRequiredChecks) {
    return { rules: [] satisfies RequiredCheckRule[], complete: false };
  }
  try {
    return await clients.github.getRequiredChecks({ repository, branch: pullRequest.baseBranch });
  } catch (error) {
    return {
      rules: [] satisfies RequiredCheckRule[],
      complete: false,
      diagnosticCode: 'REQUIRED_CHECKS_UNAVAILABLE'
    };
  }
}

function buildObservation(input: {
  request: PullRequestTrackingRequest;
  pullRequest: PullRequestDetails;
  checks: PullRequestCheckRun[];
  required: { rules: RequiredCheckRule[]; complete: boolean; diagnosticCode?: string };
  checksComplete: boolean;
  unavailable: boolean;
  diagnosticCode: string | undefined;
  dataSource: 'fixture-data' | 'github';
  now: Date;
}): PullRequestTrackingObservation {
  const stale = input.checks.some((check) => check.headSha !== input.pullRequest.head.sha);
  const observations = reconcileChecks(input.checks, input.required.rules, input.pullRequest.head.sha, !input.required.complete || !input.checksComplete);
  const reviewDecision: PullRequestReviewDecision = stale || input.request.expectedHeadSha !== undefined && input.request.expectedHeadSha !== input.pullRequest.head.sha
    ? 'stale'
    : input.unavailable || !input.required.complete
      ? 'unavailable'
      : observations.some((check) => check.status === 'failed')
        ? 'changes-requested'
        : observations.some((check) => check.status === 'pending')
          ? 'pending'
          : 'unknown';
  const status = summarizeStatus(observations, stale, input.unavailable || !input.required.complete || !input.checksComplete);
  return {
    pullRequestNumber: input.pullRequest.number,
    issueNumber: input.request.issueNumber,
    sessionId: input.request.sessionId,
    branch: input.request.branch,
    headSha: input.pullRequest.head.sha,
    status,
    reviewDecision,
    checks: observations,
    requiredChecksComplete: input.required.complete,
    stale,
    unavailable: input.unavailable || !input.required.complete || !input.checksComplete,
    generation: 0,
    dataSource: input.dataSource,
    observedAt: input.now.toISOString(),
    diagnosticCode: input.diagnosticCode ?? input.required.diagnosticCode
  };
}

function reconcileChecks(
  checks: PullRequestCheckRun[],
  required: RequiredCheckRule[],
  headSha: string,
  failClosed: boolean
): PullRequestCheckObservation[] {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const requiredObservations = required.map((rule) => {
    const check = byName.get(rule.name);
    if (!rule.trusted) {
      return observeMissing(rule.name, headSha, true, 'unavailable');
    }
    if (!check) {
      return observeMissing(rule.name, headSha, true, failClosed ? 'unavailable' : 'missing');
    }
    return observeCheck(check, true, headSha, rule);
  });
  const optionalObservations = checks
    .filter((check) => !required.some((rule) => rule.name === check.name))
    .map((check) => observeCheck(check, false, headSha));
  return [...requiredObservations, ...optionalObservations].sort((left, right) => left.name.localeCompare(right.name));
}

function observeCheck(
  check: PullRequestCheckRun,
  required: boolean,
  expectedHeadSha: string,
  rule?: RequiredCheckRule
): PullRequestCheckObservation {
  if (check.headSha !== expectedHeadSha) {
    return { name: check.name, status: 'stale', required, headSha: check.headSha, conclusion: check.conclusion };
  }
  const allowedByPolicy =
    check.status === 'completed' &&
    check.conclusion !== undefined &&
    rule?.allowedConclusions?.includes(check.conclusion) === true;
  return {
    name: check.name,
    status: mapCheckStatus(check, allowedByPolicy),
    required,
    headSha: check.headSha,
    conclusion: check.conclusion,
    allowedByPolicy: allowedByPolicy || undefined
  };
}

function observeMissing(
  name: string,
  headSha: string,
  required: boolean,
  status: CheckObservationStatus
): PullRequestCheckObservation {
  return { name, status, required, headSha };
}

function mapCheckStatus(check: PullRequestCheckRun, allowedByPolicy: boolean): CheckObservationStatus {
  if (check.status === 'unavailable') {
    return 'unavailable';
  }
  if (check.status !== 'completed') {
    return 'pending';
  }
  if (check.conclusion === 'success' || check.conclusion === 'neutral' || allowedByPolicy) {
    return 'successful';
  }
  if (check.conclusion === 'skipped') {
    return 'failed';
  }
  return 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeStatus(
  checks: PullRequestCheckObservation[],
  stale: boolean,
  unavailable: boolean
): PullRequestTrackingStatus {
  if (stale || checks.some((check) => check.status === 'stale')) {
    return 'stale';
  }
  if (unavailable || checks.some((check) => check.required && check.status === 'unavailable')) {
    return 'unavailable';
  }
  if (checks.some((check) => check.required && (check.status === 'failed' || check.status === 'missing'))) {
    return 'failed';
  }
  if (checks.some((check) => check.required && check.status === 'pending')) {
    return 'pending';
  }
  if (checks.filter((check) => check.required).every((check) => check.status === 'successful')) {
    return 'successful';
  }
  return 'pending';
}

function readBound(value: number | undefined, defaultValue: number, label: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 25) {
    throw new PullRequestTrackingError(`${label} must be a positive bounded integer.`, 'ELIMIT');
  }
  return value;
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase();
}
