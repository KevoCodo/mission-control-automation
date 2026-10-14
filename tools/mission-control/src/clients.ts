import type {
  ControllerConfig,
  DiscoveryIssue,
  DiscoveryPullRequest,
  DiscoverySession,
  IssueDependencyReference,
  IssueIdentity,
  PullRequestIdentity,
  PullRequestCheckRun,
  PullRequestDetails,
  RepositoryIdentity,
  RequiredCheckDiscovery,
  SessionIdentity
} from './types.js';

export const TRUSTED_GITHUB_ADAPTERS = ['fixture-github-client', 'ao-github-client'] as const;
export type TrustedGithubAdapterName = (typeof TRUSTED_GITHUB_ADAPTERS)[number];

export interface GithubIssueDiscoveryRequest {
  repository: RepositoryIdentity;
  epicIssue: IssueIdentity;
}

export interface GithubIssueDiscoveryPage {
  pageInfo: {
    page: number;
    hasNextPage: boolean;
  };
  issues: DiscoveryIssue[];
}

export interface GithubClient {
  adapterName?: string;
  getIssue(identity: IssueIdentity): Promise<DiscoveryIssue>;
  getPullRequest(identity: PullRequestIdentity): Promise<DiscoveryPullRequest>;
  listEpicChildren?(request: GithubIssueDiscoveryRequest): AsyncIterable<GithubIssueDiscoveryPage>;
  findPullRequestsForBranch?(request: GithubPullRequestSearchRequest): AsyncIterable<GithubPullRequestSearchPage>;
  getPullRequestDetails?(identity: PullRequestIdentity): Promise<PullRequestDetails>;
  listPullRequestChecks?(request: GithubPullRequestChecksRequest): AsyncIterable<GithubPullRequestChecksPage>;
  getRequiredChecks?(request: GithubRequiredChecksRequest): Promise<RequiredCheckDiscovery>;
}

export interface GithubPullRequestSearchRequest {
  repository: RepositoryIdentity;
  branch: string;
}

export interface GithubPullRequestSearchPage {
  pageInfo: {
    page: number;
    hasNextPage: boolean;
  };
  pullRequests: PullRequestDetails[];
}

export interface GithubPullRequestChecksRequest {
  repository: RepositoryIdentity;
  pullRequestNumber: number;
  headSha: string;
  pageSize: number;
}

export interface GithubPullRequestChecksPage {
  pageInfo: {
    page: number;
    hasNextPage: boolean;
    rateLimited?: boolean;
  };
  checks: PullRequestCheckRun[];
}

export interface GithubRequiredChecksRequest {
  repository: RepositoryIdentity;
  branch: string;
}

export const TRUSTED_AO_ADAPTERS = ['fixture-ao-client', 'ao-cli-client'] as const;
export type TrustedAoAdapterName = (typeof TRUSTED_AO_ADAPTERS)[number];

export interface AoCapabilityReport {
  adapterName: string;
  version: string;
  commands: {
    spawn: boolean;
    session: boolean;
    report: boolean;
  };
}

export interface AoSpawnWorkerRequest {
  projectId: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  prompt: string;
  maxAiUsage: number;
  dryRun: boolean;
}

export interface AoSpawnWorkerResult {
  sessionId?: string;
  branch?: string;
  worktreePath?: string;
  uncertain?: boolean;
}

export interface AoSessionQuery {
  issueNumber?: number;
  branch?: string;
}

export interface AoClient {
  adapterName?: string;
  getCapabilities?(): Promise<AoCapabilityReport>;
  getSession(identity: SessionIdentity): Promise<DiscoverySession>;
  listSessions?(query?: AoSessionQuery): Promise<SessionIdentity[]>;
  spawnWorker?(request: AoSpawnWorkerRequest): Promise<AoSpawnWorkerResult>;
  report?(message: string): Promise<void>;
}

export interface ControllerClients {
  github: GithubClient;
  ao: AoClient;
}

export interface ReadOnlyCallLog {
  githubReads: string[];
  githubMutations: string[];
  aoReads: string[];
  aoMutations: string[];
}

export function createFixtureClients(config: ControllerConfig, calls: ReadOnlyCallLog = createCallLog()): ControllerClients {
  return {
    github: {
      adapterName: 'fixture-github-client',
      async getIssue(identity) {
        calls.githubReads.push(`issue:${identity.number}`);
        return {
          id: identity.id,
          number: identity.number,
          title: identity.title ?? `Issue ${identity.number}`,
          state: 'open'
        };
      },
      async *listEpicChildren(request) {
        assertTrustedGithubAdapter('fixture-github-client');
        calls.githubReads.push(`epicChildren:${request.epicIssue.number}`);
        const issues = config.identities.issues
          .map((identity) => ({
            id: identity.id,
            number: identity.number,
            title: identity.title ?? `Issue ${identity.number}`,
            state: identity.number === 4 ? 'closed' : 'open',
            body: '',
            completionVerified: identity.number === 4,
            nativeDependencies: [] satisfies IssueDependencyReference[]
          }))
          .sort((left, right) => left.number - right.number);

        yield {
          pageInfo: {
            page: 1,
            hasNextPage: false
          },
          issues
        };
      },
      async getPullRequest(identity) {
        calls.githubReads.push(`pullRequest:${identity.number}`);
        return {
          id: identity.id,
          number: identity.number,
          branch: identity.branch,
          state: identity.number === 0 ? 'pending' : 'open'
        };
      },
      async *findPullRequestsForBranch(request) {
        calls.githubReads.push(`pullRequestsForBranch:${request.branch}`);
        yield {
          pageInfo: { page: 1, hasNextPage: false },
          pullRequests: config.identities.pullRequests
            .filter((identity) => identity.branch === request.branch)
            .map((identity) => toFixturePullRequestDetails(config, identity))
        };
      },
      async getPullRequestDetails(identity) {
        calls.githubReads.push(`pullRequestDetails:${identity.number}`);
        return toFixturePullRequestDetails(config, identity);
      },
      async *listPullRequestChecks(request) {
        calls.githubReads.push(`pullRequestChecks:${request.pullRequestNumber}:${request.headSha}`);
        yield {
          pageInfo: { page: 1, hasNextPage: false },
          checks: [
            {
              name: 'test',
              status: 'completed',
              conclusion: 'success',
              headSha: request.headSha
            }
          ]
        };
      },
      async getRequiredChecks(request) {
        calls.githubReads.push(`requiredChecks:${request.branch}`);
        return {
          complete: true,
          rules: [{ name: 'test', trusted: true }]
        };
      }
    },
    ao: {
      adapterName: 'fixture-ao-client',
      async getCapabilities() {
        calls.aoReads.push('capabilities');
        return {
          adapterName: 'fixture-ao-client',
          version: 'fixture',
          commands: {
            spawn: true,
            session: true,
            report: true
          }
        };
      },
      async getSession(identity) {
        calls.aoReads.push(`session:${identity.id}`);
        return {
          id: identity.id,
          branch: identity.branch,
          status: config.executionMode
        };
      },
      async listSessions(query) {
        calls.aoReads.push(`sessions:${query?.issueNumber ?? query?.branch ?? 'all'}`);
        return config.identities.sessions.filter(
          (session) =>
            (query?.issueNumber === undefined || session.issueNumber === query.issueNumber) &&
            (query?.branch === undefined || session.branch === query.branch)
        );
      }
    }
  };
}

function toFixturePullRequestDetails(config: ControllerConfig, identity: PullRequestIdentity): PullRequestDetails {
  const session = config.identities.sessions.find((candidate) => candidate.branch === identity.branch);
  return {
    id: identity.id,
    number: identity.number,
    branch: identity.branch,
    state: identity.number === 0 ? 'pending' : 'open',
    baseBranch: config.repository.defaultBranch,
    draft: false,
    closed: false,
    head: {
      sha: `fixture-head-${identity.number}`,
      branch: identity.branch,
      repository: identity.repository ?? config.repository,
      fork: false
    },
    association: {
      issueNumber: identity.issueNumber ?? session?.issueNumber,
      sessionId: session?.id
    }
  };
}

export function createCallLog(): ReadOnlyCallLog {
  return {
    githubReads: [],
    githubMutations: [],
    aoReads: [],
    aoMutations: []
  };
}

export function assertTrustedGithubAdapter(adapterName: string | undefined): asserts adapterName is TrustedGithubAdapterName {
  if (!adapterName || !TRUSTED_GITHUB_ADAPTERS.includes(adapterName as TrustedGithubAdapterName)) {
    throw new Error(`Untrusted GitHub adapter: ${adapterName ?? 'unknown'}.`);
  }
}

export function assertTrustedAoAdapter(adapterName: string | undefined): asserts adapterName is TrustedAoAdapterName {
  if (!adapterName || !TRUSTED_AO_ADAPTERS.includes(adapterName as TrustedAoAdapterName)) {
    throw new Error(`Untrusted AO adapter: ${adapterName ?? 'unknown'}.`);
  }
}

export async function listTrustedEpicChildren(
  client: GithubClient,
  request: GithubIssueDiscoveryRequest
): Promise<DiscoveryIssue[]> {
  assertTrustedGithubAdapter(client.adapterName);
  if (!client.listEpicChildren) {
    throw new Error(`Trusted GitHub adapter ${client.adapterName} does not support Epic child discovery.`);
  }

  const pages: GithubIssueDiscoveryPage[] = [];
  try {
    for await (const page of client.listEpicChildren(request)) {
      pages.push(page);
    }
  } catch (error) {
    throw new Error(`GitHub Epic child discovery failed: ${redactForLog(error instanceof Error ? error.message : String(error))}`);
  }

  return pages
    .sort((left, right) => left.pageInfo.page - right.pageInfo.page)
    .flatMap((page) => page.issues)
    .sort((left, right) => left.number - right.number);
}

export function redactForLog(value: string): string {
  return value.replace(/(token|password|secret|authorization|apiKey)=?[:\s]*[^\s,;]+/gi, '$1=[REDACTED]');
}
