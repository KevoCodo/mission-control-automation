export const STATE_VERSION = 4;
export const MIN_SUPPORTED_STATE_VERSION = 1;

export type ExecutionMode = 'dry-run';
export type AssignmentMode = 'dry-run' | 'live';

export interface RepositoryIdentity {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface ProjectIdentity {
  id: string;
}

export interface IssueIdentity {
  id: string | number;
  number: number;
  title?: string;
}

export interface SessionIdentity {
  id: string;
  branch: string;
  worktreePath: string;
  issueNumber?: number;
}

export interface PullRequestIdentity {
  id: string | number;
  number: number;
  branch: string;
  issueNumber?: number;
  repository?: RepositoryIdentity;
}

export interface IdentityMap {
  issues: IssueIdentity[];
  sessions: SessionIdentity[];
  pullRequests: PullRequestIdentity[];
}

export type OperationStatus = 'pending' | 'succeeded' | 'failed' | 'uncertain';

export interface OperationIntent {
  key: string;
  action: 'assign-issue' | 'create-pr' | 'merge-pr' | 'discover' | string;
  targetType: 'issue' | 'session' | 'pullRequest' | 'repository' | string;
  targetId: string | number;
  payload?: unknown;
}

export interface OperationOutcome {
  provider: 'github' | 'ao' | 'controller' | string;
  externalId?: string | number;
  data?: unknown;
}

export interface OperationRecord {
  intent: OperationIntent;
  status: OperationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  outcome?: OperationOutcome;
  lastError?: string;
}

export type DispatchState = 'INTENT_RECORDED' | 'SUBMITTING' | 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN' | 'RETIRED' | 'COMPLETED';
export type DispatchEvidenceKind = 'acceptance' | 'rejection' | 'retirement' | 'outcome';
export interface DispatchEvidence {
  kind: DispatchEvidenceKind;
  dispatchId: string;
  providerReceiptRef: string;
  provenance: 'fixture';
  verified: true;
  durable?: true;
  observedAt: string;
}
export interface DispatchRecord {
  version: 1;
  dispatchId: string;
  operationKey: string;
  repository: { owner: string; name: string };
  issueNumber: number;
  branch: string;
  target?: { targetId?: string; sessionId?: string };
  payloadSha256: string;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  state: DispatchState;
  providerReceiptRef?: string;
  evidence?: DispatchEvidence;
  quarantineReason?: string;
}

export type AuthorizationAction = 'ASSIGNMENT' | 'REVIEW' | 'CORRECTION' | 'MERGE' | 'CLOSURE';
export type AuthorizationStatus = 'REQUESTED' | 'UNVERIFIED' | 'VERIFIED' | 'REVOKED' | 'EXPIRED';
export interface AuthorizationRecord {
  version: 1;
  grantId: string;
  issuerId: string;
  issuerProvenance: string;
  actorId: string;
  action: AuthorizationAction;
  repository: { owner: string; name: string };
  target: { kind: 'issue' | 'pullRequest'; number: number };
  issueNumber?: number;
  pullRequestNumber?: number;
  headSha?: string;
  constraints: { maxUses: 1; purpose: string };
  issuedAt: string;
  expiresAt: string;
  revocationEpoch: number;
  status: AuthorizationStatus;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
  auditEvidenceRef: string;
}
export interface AuthorizationRevocation {
  grantId: string;
  epoch: number;
  revokedAt: string;
  correlationId: string;
  auditEvidenceRef: string;
  /** Legacy events omit initiator metadata; absence never implies a verified initiator. */
  initiatorProvenance?: 'unverified';
  initiatorClaimedActorId?: string;
}
export interface AuthorizationState {
  grants: AuthorizationRecord[];
  revocations: AuthorizationRevocation[];
  consumedGrantIds: string[];
  revocationEpoch: number;
}

export interface StateSchemaMetadata {
  createdVersion: number;
  previousVersion?: number;
}

export interface ControllerLimits {
  maxBuilders: number;
  correctionAttempts: number;
  maxRetries: number;
  maxAiUsage: number;
}

export interface ControllerConfig {
  repository: RepositoryIdentity;
  project: ProjectIdentity;
  worktreeRoot: string;
  executionMode: ExecutionMode;
  deploy: false;
  limits: ControllerLimits;
  identities: IdentityMap;
}

export interface DiscoveryIssue {
  id: string | number;
  number: number;
  title: string;
  state: string;
  body?: string;
  completionVerified?: boolean;
  nativeDependencies?: IssueDependencyReference[];
}

export interface DiscoverySession {
  id: string;
  branch: string;
  status: string;
}

export interface DiscoveryPullRequest {
  id: string | number;
  number: number;
  branch: string;
  state: string;
}

export type PullRequestReviewDecision = 'unknown' | 'pending' | 'changes-requested' | 'stale' | 'unavailable';

export type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral' | 'timed-out' | 'action-required';
export type CheckStatus = 'queued' | 'in_progress' | 'completed' | 'pending' | 'unavailable';
export type CheckObservationStatus = 'pending' | 'failed' | 'successful' | 'stale' | 'skipped' | 'missing' | 'unavailable';
export type PullRequestTrackingStatus = 'pending' | 'failed' | 'successful' | 'stale' | 'unavailable';

export interface PullRequestHeadIdentity {
  sha: string;
  branch: string;
  repository: RepositoryIdentity;
  fork: boolean;
}

export interface PullRequestAssociation {
  issueNumber?: number;
  sessionId?: string;
}

export interface PullRequestDetails extends DiscoveryPullRequest {
  baseBranch: string;
  head: PullRequestHeadIdentity;
  draft: boolean;
  closed: boolean;
  association?: PullRequestAssociation;
}

export interface PullRequestCheckRun {
  name: string;
  status: CheckStatus;
  conclusion?: CheckConclusion;
  headSha: string;
}

export interface RequiredCheckRule {
  name: string;
  trusted: boolean;
  allowedConclusions?: CheckConclusion[];
}

export interface RequiredCheckDiscovery {
  rules: RequiredCheckRule[];
  complete: boolean;
}

export interface PullRequestCheckObservation {
  name: string;
  status: CheckObservationStatus;
  required: boolean;
  headSha: string;
  conclusion?: CheckConclusion;
  allowedByPolicy?: boolean;
}

export interface PullRequestTrackingObservation {
  pullRequestNumber: number;
  issueNumber: number;
  sessionId: string;
  branch: string;
  headSha: string;
  status: PullRequestTrackingStatus;
  reviewDecision: PullRequestReviewDecision;
  checks: PullRequestCheckObservation[];
  requiredChecksComplete: boolean;
  stale: boolean;
  unavailable: boolean;
  generation: number;
  dataSource: 'fixture-data' | 'github';
  observedAt: string;
  diagnosticCode?: string;
}

export type NativeReviewRunStatus = 'not-started' | 'running' | 'completed' | 'failed' | 'unavailable';
export type NativeReviewVerdict = 'approved' | 'changes-requested' | 'unknown';
export type NativeReviewDecision = 'unknown' | 'approved' | 'changes-requested' | 'stale' | 'unavailable';
export type GithubRequiredApprovalStatus = 'approved' | 'missing' | 'changes-requested' | 'unknown' | 'unavailable';
export type ReviewFindingSeverity = 'critical' | 'major' | 'minor';
export type ReviewFindingStatus = 'open' | 'resolved';

export interface NativeReviewReviewerIdentity {
  id: string;
  displayName?: string;
  type: 'ao-native-reviewer' | 'worker' | 'human' | 'unknown';
  independent: boolean;
  provenance?: 'explicit-runtime' | 'fixture' | 'unsupported';
}

export interface NativeReviewFinding {
  id: string;
  threadId: string;
  headSha: string;
  severity: ReviewFindingSeverity;
  status: ReviewFindingStatus;
  summary: string;
  duplicateOf?: string;
}

export interface NativeReviewThread {
  id: string;
  headSha: string;
  status: ReviewFindingStatus;
  findingIds: string[];
  resolvedAfterPushSha?: string;
}

export interface NativeReviewCorrectionRequest {
  issueNumber: number;
  sessionId: string;
  pullRequestNumber: number;
  headSha: string;
  cycle: number;
  action: 'request-corrections' | 'escalate';
  findings: NativeReviewFinding[];
  threadIds: string[];
  requiresHumanAuthorization: boolean;
  verifiedPublicationRequired: boolean;
  reason: string;
}

export interface NativeReviewAuthorizationState {
  humanAuthorized: boolean;
  source: 'verified-human' | 'caller-flag' | 'missing';
}

export interface NativeReviewStopState {
  active: boolean;
  reason?: string;
}

export interface NativeReviewControlState {
  stopActive: boolean;
  reason: string;
}

export interface NativeReviewCorrectionPlan {
  action: 'consider-corrections' | 'escalate';
  cycle: number;
  executable: false;
  blockedReasons: string[];
  findingIds: string[];
  threadIds: string[];
}

export interface NativeReviewObservation {
  pullRequestNumber: number;
  issueNumber: number;
  sessionId: string;
  branch: string;
  headSha: string;
  runId?: string;
  runStatus: NativeReviewRunStatus;
  runVerdict: NativeReviewVerdict;
  nativeReviewDecision: NativeReviewDecision;
  githubRequiredApproval: GithubRequiredApprovalStatus;
  capabilityVerified: boolean;
  triggerAuthorized: boolean;
  triggerAuthorization: NativeReviewAuthorizationState;
  correctionAuthorization: NativeReviewAuthorizationState;
  stopState: NativeReviewStopState;
  reviewer?: NativeReviewReviewerIdentity;
  independentReviewer: boolean;
  findings: NativeReviewFinding[];
  findingsComplete: boolean;
  threadsComplete: boolean;
  unresolvedThreadIds: string[];
  duplicateThreadIds: string[];
  stale: boolean;
  unavailable: boolean;
  correctionCycle: number;
  correctionEscalated: boolean;
  correctionRequest?: NativeReviewCorrectionRequest;
  correctionPlan?: NativeReviewCorrectionPlan;
  observedAt: string;
  diagnosticCode?: string;
}

export interface DiscoveryResult {
  mode: ExecutionMode;
  repository: string;
  project: string;
  issues: DiscoveryIssue[];
  sessions: DiscoverySession[];
  pullRequests: DiscoveryPullRequest[];
  dependencyGraph?: DependencyGraph;
}

export interface ControllerState {
  version: typeof STATE_VERSION;
  schema: StateSchemaMetadata;
  repository: RepositoryIdentity;
  project: ProjectIdentity;
  identities: IdentityMap;
  operations: OperationRecord[];
  dispatches: DispatchRecord[];
  authorization: AuthorizationState;
  discoveries: DiscoveryResult[];
  pullRequestTracking: PullRequestTrackingObservation[];
  nativeReviewTracking: NativeReviewObservation[];
  nativeReviewControl: NativeReviewControlState;
  updatedAt: string;
}

export interface IssueDependencyReference {
  owner: string;
  name: string;
  number: number;
  source: 'body' | 'native';
}

export type IssueCompletionStatus = 'open' | 'closed-unverified' | 'complete';

export interface DependencyGraphNode {
  id: string | number;
  owner: string;
  name: string;
  number: number;
  title: string;
  state: string;
  completionStatus: IssueCompletionStatus;
  dependencies: IssueDependencyReference[];
  blocked: boolean;
  eligible: boolean;
}

export interface DependencyGraph {
  repository: string;
  epicIssueNumber: number;
  nodes: DependencyGraphNode[];
  order: number[];
  open: number[];
  blocked: number[];
  unverified: number[];
}
