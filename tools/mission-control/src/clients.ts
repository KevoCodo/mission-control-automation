import type {
  ControllerConfig,
  DiscoveryIssue,
  DiscoveryPullRequest,
  DiscoverySession,
  IssueDependencyReference,
  IssueIdentity,
  PullRequestIdentity,
  RepositoryIdentity,
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
}

export interface AoClient {
  getSession(identity: SessionIdentity): Promise<DiscoverySession>;
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
      }
    },
    ao: {
      async getSession(identity) {
        calls.aoReads.push(`session:${identity.id}`);
        return {
          id: identity.id,
          branch: identity.branch,
          status: config.executionMode
        };
      }
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
