export const STATE_VERSION = 2;
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
  discoveries: DiscoveryResult[];
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
