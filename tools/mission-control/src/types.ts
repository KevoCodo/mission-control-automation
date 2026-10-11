export const STATE_VERSION = 1;

export type ExecutionMode = 'dry-run';

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
}

export interface ControllerState {
  version: typeof STATE_VERSION;
  repository: RepositoryIdentity;
  project: ProjectIdentity;
  identities: IdentityMap;
  discoveries: DiscoveryResult[];
  updatedAt: string;
}
